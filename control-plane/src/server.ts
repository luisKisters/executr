import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import type { Config } from './config';
import {
  renderLoginPage,
  renderOverviewPage,
  renderPlansPage,
  renderRepoPlansPage,
  renderNewPlanPage,
  renderPlanDetailPage,
  renderActivityPage,
  renderSessionsPage,
} from './views';
import { openDatabase, listExecutions, listApprovalRequests, type OrchestratorDB } from './db';
import {
  listRepos,
  listPlansForRepo,
  getPlanDetail,
  listNormalizedExecutions,
} from './discovery';
import { createPlan, type PlanProvider } from './planCreation';

const SESSION_COOKIE = 'cp_session';
const SESSION_VALUE = 'authenticated';

export async function createServer(config: Config, db?: OrchestratorDB): Promise<FastifyInstance> {
  const _db = db ?? openDatabase(config.orchestratorDbPath);
  const app = Fastify({ logger: false });

  await app.register(cookie, {
    secret: config.sessionSecret || 'default-insecure-secret-change-me',
  });
  await app.register(formbody);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const pathname = getPathname(request.url);
    if (isPublicPath(pathname)) return;

    const raw = request.cookies[SESSION_COOKIE];
    if (raw) {
      const result = request.unsignCookie(raw);
      if (result.valid && result.value === SESSION_VALUE) return;
    }

    if (pathname.startsWith('/api/')) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    return reply.redirect('/login');
  });

  // ── Public routes ──────────────────────────────────────────────────

  app.get('/healthz', async (_request, reply) => {
    return reply.send({ status: 'ok' });
  });

  app.get('/login', async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE];
    if (raw) {
      const result = request.unsignCookie(raw);
      if (result.valid && result.value === SESSION_VALUE) {
        return reply.redirect('/');
      }
    }
    return reply.type('text/html').send(renderLoginPage());
  });

  app.post('/login', async (request, reply) => {
    const body = request.body as { password?: string };
    const password = body?.password ?? '';

    if (config.password && password === config.password) {
      reply.setCookie(SESSION_COOKIE, SESSION_VALUE, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        signed: true,
        maxAge: 60 * 60 * 24 * 7,
      });
      return reply.redirect('/');
    }

    const errorMsg = config.password ? 'Invalid password' : 'Server not configured: CONTROL_PLANE_PASSWORD not set';
    return reply.type('text/html').send(renderLoginPage(errorMsg));
  });

  app.get('/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/login');
  });

  // ── UI routes ──────────────────────────────────────────────────────

  app.get('/', async (_request, reply) => {
    const repos = listRepos(config.workspaceRoot);
    const executions = listNormalizedExecutions(_db);
    return reply.type('text/html').send(renderOverviewPage(repos, executions));
  });

  app.get('/plans', async (request, reply) => {
    const { created } = request.query as { created?: string };
    const repos = listRepos(config.workspaceRoot);
    const plans: Record<string, ReturnType<typeof listPlansForRepo>> = {};
    for (const repo of repos) {
      plans[repo.name] = listPlansForRepo(config.workspaceRoot, repo.name);
    }
    return reply.type('text/html').send(
      renderPlansPage(repos, plans, created ? `Plan "${created}" created successfully.` : undefined)
    );
  });

  app.get('/repos/:repo/plans', async (request, reply) => {
    const { repo } = request.params as { repo: string };
    const plans = listPlansForRepo(config.workspaceRoot, repo);
    return reply.type('text/html').send(renderRepoPlansPage(repo, plans));
  });

  app.get('/repos/:repo/plans/:plan', async (request, reply) => {
    const { repo, plan } = request.params as { repo: string; plan: string };
    const detail = getPlanDetail(config.workspaceRoot, repo, plan);
    if (!detail) {
      return reply.status(404).type('text/html').send(
        page404(`Plan "${plan}" not found in repo "${repo}"`)
      );
    }
    return reply.type('text/html').send(renderPlanDetailPage(detail, repo));
  });

  app.get('/plans/new', async (_request, reply) => {
    const repos = listRepos(config.workspaceRoot);
    return reply.type('text/html').send(renderNewPlanPage(repos));
  });

  app.post('/plans/new', async (request, reply) => {
    const form = request.body as {
      repo?: string;
      title?: string;
      body?: string;
      validationCommands?: string;
      provider?: string;
    };

    const repos = listRepos(config.workspaceRoot);

    const outcome = createPlan({
      workspaceRoot: config.workspaceRoot,
      claimsDir: config.claimsDir,
      repo: form?.repo ?? '',
      input: {
        title: form?.title ?? '',
        body: form?.body ?? '',
        validationCommands: form?.validationCommands ?? '',
        provider: (form?.provider as PlanProvider) ?? 'claude-code',
      },
    });

    if (!outcome.ok) {
      return reply.type('text/html').send(
        renderNewPlanPage(repos, { error: outcome.error, values: form })
      );
    }

    return reply.redirect(`/plans?created=${encodeURIComponent(outcome.planName)}`);
  });

  app.get('/activity', async (_request, reply) => {
    const executions = listNormalizedExecutions(_db);
    const approvalRequests = listApprovalRequests(_db);
    return reply.type('text/html').send(renderActivityPage(executions, approvalRequests));
  });

  app.get('/sessions', async (_request, reply) => {
    return reply.type('text/html').send(renderSessionsPage());
  });

  // ── Debug / legacy ─────────────────────────────────────────────────

  app.get('/api/_debug/contracts', async (_request, reply) => {
    const executions = listExecutions(_db);
    const approvalRequests = listApprovalRequests(_db);
    return reply.send({ executions, approvalRequests });
  });

  // ── Task 3: read-only discovery API ───────────────────────────────

  app.get('/api/repos', async (_request, reply) => {
    const repos = listRepos(config.workspaceRoot);
    return reply.send(repos);
  });

  app.get('/api/repos/:repo/plans', async (request, reply) => {
    const { repo } = request.params as { repo: string };
    const plans = listPlansForRepo(config.workspaceRoot, repo);
    return reply.send(plans);
  });

  app.get('/api/repos/:repo/plans/:plan', async (request, reply) => {
    const { repo, plan } = request.params as { repo: string; plan: string };
    const detail = getPlanDetail(config.workspaceRoot, repo, plan);
    if (!detail) {
      return reply.status(404).send({ error: 'Plan not found' });
    }
    return reply.send(detail);
  });

  app.get('/api/executions', async (_request, reply) => {
    const executions = listNormalizedExecutions(_db);
    return reply.send(executions);
  });

  // ── Task 4: plan creation API ─────────────────────────────────────────

  app.post('/api/repos/:repo/plans', async (request, reply) => {
    const { repo } = request.params as { repo: string };
    const body = request.body as {
      title?: string;
      body?: string;
      validationCommands?: string;
      provider?: string;
    };

    const outcome = createPlan({
      workspaceRoot: config.workspaceRoot,
      claimsDir: config.claimsDir,
      repo,
      input: {
        title: body?.title ?? '',
        body: body?.body ?? '',
        validationCommands: body?.validationCommands ?? '',
        provider: (body?.provider as PlanProvider) ?? 'claude-code',
      },
    });

    if (!outcome.ok) {
      return reply.status(outcome.statusCode).send({ error: outcome.error });
    }
    return reply.status(201).send({
      planName: outcome.planName,
      fileName: outcome.fileName,
      planHash: outcome.planHash,
    });
  });

  return app;
}

function getPathname(url: string): string {
  const qi = url.indexOf('?');
  return qi >= 0 ? url.slice(0, qi) : url;
}

function isPublicPath(pathname: string): boolean {
  return pathname === '/healthz' || pathname === '/login' || pathname === '/logout';
}

function page404(message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Not Found</title></head><body><h1>404 Not Found</h1><p>${message}</p><a href="/">Back to overview</a></body></html>`;
}
