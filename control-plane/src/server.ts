import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import type { Config } from './config';
import { renderLoginPage, renderOverviewPage } from './views';

const SESSION_COOKIE = 'cp_session';
const SESSION_VALUE = 'authenticated';

export async function createServer(config: Config): Promise<FastifyInstance> {
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

  app.get('/', async (_request, reply) => {
    return reply.type('text/html').send(renderOverviewPage());
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
