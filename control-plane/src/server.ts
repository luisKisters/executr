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
  type PlanProviderInfo,
  type SessionRow,
} from './views';
import { openDatabase, listExecutions, listApprovalRequests, updateApprovalRequestStatus, listTelegramSessions, seedReposRegistry, type OrchestratorDB } from './db';
import { ObserverPoller } from './observer';
import { RecoveryPoller } from './recovery';
import { TelegramBot } from './telegram';
import {
  listRepos,
  listReposFromRegistry,
  listPlansForRepo,
  getPlanDetail,
  listNormalizedExecutions,
} from './discovery';
import { createPlan, hashContent, type PlanProvider } from './planCreation';
import { readClaim, isActiveClaim } from './claims';
import { addRepo, archiveRepo } from './repoManager';
import { writeReposListFile } from './reposList';
import {
  DEFAULT_PROVIDER_POLICY,
  type ProviderPolicy,
  type ProviderSwitchTrigger,
} from './providers';

const SESSION_COOKIE = 'cp_session';
const SESSION_VALUE = 'authenticated';

// In-memory provider policy store (persisted across requests within a process lifetime).
let _providerPolicy: ProviderPolicy = { ...DEFAULT_PROVIDER_POLICY };

export async function createServer(
  config: Config,
  db?: OrchestratorDB,
  startObserver = true
): Promise<FastifyInstance> {
  const _db = db ?? openDatabase(config.orchestratorDbPath);
  seedReposRegistry(_db, config.reposEnv);
  // Write the loop-readable repos.list so the watch loop picks up the seeded registry.
  try { writeReposListFile(_db, config.workspaceRoot); } catch { /* non-fatal */ }
  const app = Fastify({ logger: false });

  const poller = new ObserverPoller(_db, { workspaceRoot: config.workspaceRoot });
  const recoveryPoller = new RecoveryPoller(_db, { workspaceRoot: config.workspaceRoot });
  let telegramBot: TelegramBot | null = null;
  if (config.telegramBotToken) {
    telegramBot = new TelegramBot({
      config: { botToken: config.telegramBotToken, allowlist: config.telegramAllowlist },
      db: _db,
      workspaceRoot: config.workspaceRoot,
      claimsDir: config.claimsDir,
    });
  }
  if (startObserver) {
    app.addHook('onReady', async () => {
      poller.start();
      recoveryPoller.start();
      telegramBot?.start();
    });
    app.addHook('onClose', async () => {
      poller.stop();
      recoveryPoller.stop();
      telegramBot?.stop();
    });
  }

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

  app.get('/', async (request, reply) => {
    const { added, archived, error } = request.query as {
      added?: string; archived?: string; error?: string;
    };
    const repos = listReposFromRegistry(_db, config.workspaceRoot);
    const executions = listNormalizedExecutions(_db);
    let msg: { type: 'success' | 'error'; text: string } | undefined;
    if (added) msg = { type: 'success', text: `Repo "${added}" added successfully.` };
    else if (archived) msg = { type: 'success', text: `Repo "${archived}" archived.` };
    else if (error) msg = { type: 'error', text: decodeURIComponent(error) };
    return reply.type('text/html').send(renderOverviewPage(repos, executions, msg));
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

    const providerInfo: PlanProviderInfo = {
      claimedProvider: null,
      usedProvider: null,
      requestedProvider: null,
    };

    // Use the hash from plan-state if available; fall back to hashing the raw markdown
    // so newly-created plans (not yet run) can still resolve their claim.
    const hashForClaim = detail.contentHash ?? hashContent(detail.rawMarkdown);
    const claim = readClaim(config.claimsDir, repo, hashForClaim);
    if (claim && isActiveClaim(claim)) {
      providerInfo.claimedProvider = claim.provider;
    }

    const executions = listNormalizedExecutions(_db).filter(
      e => e.repo === repo && e.planFile === `${plan}.md`
    );
    const latest = executions[0] ?? null;
    if (latest) {
      providerInfo.usedProvider = latest.providerUsed;
      providerInfo.requestedProvider = latest.providerRequested;
    }

    return reply.type('text/html').send(renderPlanDetailPage(detail, repo, providerInfo));
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
    const sessions = listTelegramSessions(_db).map((s): SessionRow => ({
      id: s.id,
      name: s.sessionName,
      targetRepo: s.targetRepo,
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
    return reply.type('text/html').send(renderSessionsPage(sessions));
  });

  app.get('/api/sessions', async (_request, reply) => {
    const sessions = listTelegramSessions(_db);
    return reply.send(sessions);
  });

  // ── Debug / legacy ─────────────────────────────────────────────────

  app.get('/api/_debug/contracts', async (_request, reply) => {
    const executions = listExecutions(_db);
    const approvalRequests = listApprovalRequests(_db);
    return reply.send({ executions, approvalRequests });
  });

  // ── Task 3: read-only discovery API ───────────────────────────────

  app.get('/api/repos', async (_request, reply) => {
    const repos = listReposFromRegistry(_db, config.workspaceRoot);
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

  // ── Task 6: provider policy API ───────────────────────────────────────

  app.get('/api/provider-policy', async (_request, reply) => {
    return reply.send(_providerPolicy);
  });

  app.put('/api/provider-policy', async (request, reply) => {
    const body = request.body as Partial<ProviderPolicy> | null;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Body must be a JSON object' });
    }

    const allowed: ProviderPolicy['prefer'][] = ['claude-code', 'codex'];

    if (body.prefer !== undefined) {
      if (!allowed.includes(body.prefer)) {
        return reply.status(400).send({ error: 'prefer must be "claude-code" or "codex"' });
      }
      _providerPolicy = { ..._providerPolicy, prefer: body.prefer };
    }

    if (body.fallback_order !== undefined) {
      if (!Array.isArray(body.fallback_order) || body.fallback_order.some(p => !allowed.includes(p))) {
        return reply.status(400).send({ error: 'fallback_order must be an array of valid provider names' });
      }
      _providerPolicy = { ..._providerPolicy, fallback_order: body.fallback_order };
    }

    if (body.switch_on !== undefined) {
      const validTriggers: ProviderSwitchTrigger[] = [
        'provider_rate_limited', 'provider_auth_unavailable',
        'startup_stall_repeated', 'transient_timeout_repeated',
      ];
      const keys = Object.keys(body.switch_on);
      if (keys.some(k => !validTriggers.includes(k as ProviderSwitchTrigger))) {
        return reply.status(400).send({ error: 'switch_on contains unknown trigger keys' });
      }
      _providerPolicy = { ..._providerPolicy, switch_on: { ..._providerPolicy.switch_on, ...body.switch_on } };
    }

    return reply.send(_providerPolicy);
  });

  // ── Task 9: approval decision API ────────────────────────────────────────

  app.post('/api/approvals/:id/decide', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { decision?: string; decidedBy?: string };
    const decision = body?.decision;
    if (decision !== 'approved' && decision !== 'denied') {
      return reply.status(400).send({ error: 'decision must be "approved" or "denied"' });
    }
    const requests = listApprovalRequests(_db);
    const existing = requests.find(r => r.id === id);
    if (!existing) {
      return reply.status(404).send({ error: 'Approval request not found' });
    }
    if (existing.status !== 'pending') {
      return reply.status(409).send({ error: 'Approval request is already decided' });
    }
    updateApprovalRequestStatus(_db, id, decision, body?.decidedBy ?? 'ui');
    return reply.send({ id, status: decision });
  });

  // ── Task 13: add / archive repo — UI form handlers ──────────────────────

  app.post('/repos', async (request, reply) => {
    const form = request.body as { name?: string; gitUrl?: string; branch?: string };
    const result = addRepo(config.workspaceRoot, _db, {
      name: form?.name ?? '',
      gitUrl: form?.gitUrl ?? '',
      branch: form?.branch,
    });
    if (!result.ok) {
      return reply.redirect(`/?error=${encodeURIComponent(result.error)}`);
    }
    try { writeReposListFile(_db, config.workspaceRoot); } catch { /* non-fatal */ }
    return reply.redirect(`/?added=${encodeURIComponent((form?.name ?? '').trim())}`);
  });

  app.post('/repos/:repo/archive', async (request, reply) => {
    const { repo } = request.params as { repo: string };
    const result = archiveRepo(config.workspaceRoot, _db, repo);
    if (!result.ok) {
      return reply.redirect(`/?error=${encodeURIComponent(result.error)}`);
    }
    try { writeReposListFile(_db, config.workspaceRoot); } catch { /* non-fatal */ }
    return reply.redirect(`/?archived=${encodeURIComponent(repo)}`);
  });

  // ── Task 13: add / archive repo — API endpoints ──────────────────────────

  app.post('/api/repos', async (request, reply) => {
    const body = request.body as { name?: string; gitUrl?: string; branch?: string };
    const result = addRepo(config.workspaceRoot, _db, {
      name: body?.name ?? '',
      gitUrl: body?.gitUrl ?? '',
      branch: body?.branch,
    });
    if (!result.ok) {
      return reply.status(result.statusCode).send({ error: result.error });
    }
    try { writeReposListFile(_db, config.workspaceRoot); } catch { /* non-fatal */ }
    return reply.status(result.alreadyExisted ? 200 : 201).send({
      name: (body?.name ?? '').trim(),
      alreadyExisted: result.alreadyExisted,
    });
  });

  app.delete('/api/repos/:repo', async (request, reply) => {
    const { repo } = request.params as { repo: string };
    const result = archiveRepo(config.workspaceRoot, _db, repo);
    if (!result.ok) {
      return reply.status(result.statusCode).send({
        error: result.error,
        ...(result.hasUncommittedWork ? { hasUncommittedWork: true } : {}),
      });
    }
    try { writeReposListFile(_db, config.workspaceRoot); } catch { /* non-fatal */ }
    return reply.send({ archived: true, name: repo });
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
