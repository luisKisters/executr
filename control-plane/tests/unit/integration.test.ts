import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

const TEST_PORT = 19085;
const TEST_PASSWORD = 'integration-test-password';
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: ChildProcess;
let workspaceRoot: string;
let repoPath: string;

async function waitForServer(maxMs = 15000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Server at ${BASE_URL} not ready after ${maxMs}ms`);
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-integration-ws-'));
  repoPath = join(workspaceRoot, 'myrepo');
  mkdirSync(join(repoPath, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(repoPath, 'README.md'), '# integration test repo');

  const tsxPath = join(__dirname, '../../node_modules/.bin/tsx');
  const srcIndex = join(__dirname, '../../src/index.ts');

  serverProcess = spawn(tsxPath, [srcIndex], {
    env: {
      ...process.env,
      CONTROL_PLANE_PORT: String(TEST_PORT),
      CONTROL_PLANE_PASSWORD: TEST_PASSWORD,
      SESSION_SECRET: 'integration-session-secret-32chars!',
      WORKSPACE_ROOT: workspaceRoot,
      CONTROL_PLANE_PORT_DEFAULT: '8090',
      HOST: '127.0.0.1',
      TELEGRAM_ALLOWLIST: '111,222',
      TELEGRAM_BOT_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) process.stderr.write(`[server] ${msg}\n`);
  });

  await waitForServer();
});

afterAll(() => {
  serverProcess?.kill('SIGTERM');
});

describe('container wiring — /healthz (public)', () => {
  it('returns 200 OK', async () => {
    const res = await fetch(`${BASE_URL}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });
});

describe('container wiring — auth gate', () => {
  it('returns 401 for /api/repos without auth', async () => {
    const res = await fetch(`${BASE_URL}/api/repos`, { redirect: 'manual' });
    expect(res.status === 401 || res.status === 302).toBe(true);
  });

  it('returns 401 for /api/executions without auth', async () => {
    const res = await fetch(`${BASE_URL}/api/executions`, { redirect: 'manual' });
    expect(res.status === 401 || res.status === 302).toBe(true);
  });
});

describe('container wiring — authed API routes', () => {
  let sessionCookie: string;

  beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${TEST_PASSWORD}`,
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    sessionCookie = setCookie.split(';')[0];
    expect(sessionCookie).toBeTruthy();
  });

  it('GET /api/repos returns array', async () => {
    const res = await fetch(`${BASE_URL}/api/repos`, {
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /api/executions returns array', async () => {
    const res = await fetch(`${BASE_URL}/api/executions`, {
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /api/repos/:repo/plans returns array for known repo', async () => {
    const res = await fetch(`${BASE_URL}/api/repos/myrepo/plans`, {
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('wrong password does not grant access (shows error or redirects to login)', async () => {
    const res = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=wrongpassword',
      redirect: 'manual',
    });
    // Server either re-renders login with error (200 + "invalid" body) or
    // redirects back to /login (302). Either way the session cookie must not be set.
    const setCookie = res.headers.get('set-cookie') ?? '';
    if (res.status === 200) {
      const body = await res.text();
      expect(body.toLowerCase()).toContain('invalid');
    } else {
      // redirect back to login — no session issued
      expect(res.status).toBe(302);
      expect(setCookie).not.toContain('session=');
    }
  });
});
