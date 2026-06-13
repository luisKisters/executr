import { describe, it, expect } from 'vitest';
import { createServer } from '../../src/server';
import type { Config } from '../../src/config';

const baseConfig: Config = {
  workspaceRoot: '/tmp/test-workspace',
  orchestratorDbPath: '/tmp/test-workspace/.executr/orchestrator.db',
  claimsDir: '/tmp/test-workspace/.executr/claims',
  password: 'testpassword',
  sessionSecret: 'test-session-secret-32chars-padded!',
  port: 0,
  host: '127.0.0.1',
};

function parseCookieHeader(header: string | string[] | undefined): string {
  if (!header) return '';
  const val = Array.isArray(header) ? header[0] : header;
  return val.split(';')[0];
}

describe('/healthz', () => {
  it('is publicly accessible without auth', async () => {
    const app = await createServer(baseConfig);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });
});

describe('GET /login', () => {
  it('is publicly accessible', async () => {
    const app = await createServer(baseConfig);
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('shows password input', async () => {
    const app = await createServer(baseConfig);
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.body).toContain('input');
    expect(res.body).toContain('password');
  });
});

describe('POST /login', () => {
  it('rejects wrong password', async () => {
    const app = await createServer(baseConfig);
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'password=wrongpassword',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Invalid password');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects empty password', async () => {
    const app = await createServer(baseConfig);
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'password=',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Invalid');
  });

  it('sets signed session cookie on correct password', async () => {
    const app = await createServer(baseConfig);
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'password=testpassword',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookieHeader = res.headers['set-cookie'];
    expect(cookieHeader).toBeDefined();
    expect(String(cookieHeader)).toContain('cp_session');
    expect(String(cookieHeader)).toContain('HttpOnly');
  });

  it('returns error when CONTROL_PLANE_PASSWORD not configured', async () => {
    const noPassConfig: Config = { ...baseConfig, password: '' };
    const app = await createServer(noPassConfig);
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'password=anything',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('not configured');
  });
});

describe('auth middleware', () => {
  it('redirects unauthenticated GET / to /login', async () => {
    const app = await createServer(baseConfig);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 401 for unauthenticated /api/* requests', async () => {
    const app = await createServer(baseConfig);
    const res = await app.inject({ method: 'GET', url: '/api/repos' });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
  });

  it('allows access with valid signed session cookie', async () => {
    const app = await createServer(baseConfig);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'password=testpassword',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(loginRes.statusCode).toBe(302);

    const cookieStr = parseCookieHeader(loginRes.headers['set-cookie']);
    const protectedRes = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: cookieStr },
    });
    expect(protectedRes.statusCode).toBe(200);
    expect(protectedRes.body).toContain('Overview');
  });

  it('rejects tampered cookie', async () => {
    const app = await createServer(baseConfig);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: 'cp_session=authenticated.invalidsignature' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('does not accept any session cookie when password auth is disabled', async () => {
    const app = await createServer({ ...baseConfig, password: '', sessionSecret: '' });
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: 'cp_session=authenticated.anything' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('redirects /login back to / when already authenticated', async () => {
    const app = await createServer(baseConfig);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'password=testpassword',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cookieStr = parseCookieHeader(loginRes.headers['set-cookie']);

    const loginPageRes = await app.inject({
      method: 'GET',
      url: '/login',
      headers: { cookie: cookieStr },
    });
    expect(loginPageRes.statusCode).toBe(302);
    expect(loginPageRes.headers.location).toBe('/');
  });
});
