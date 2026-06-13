import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { execSync as syncExec } from 'child_process';

const TEST_PORT = 19094;
const TEST_PASSWORD = 'container-smoke-password';
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: ChildProcess;
let screenshotDir: string;
let workspaceRoot: string;
let repoPath: string;

function gitInit(dir: string): void {
  syncExec('git init', { cwd: dir, stdio: 'ignore' });
  syncExec('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  syncExec('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  syncExec('git add -A', { cwd: dir, stdio: 'ignore' });
  syncExec('git commit -m "initial" --allow-empty', { cwd: dir, stdio: 'ignore' });
}

async function waitForServer(maxMs = 20000): Promise<void> {
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

function ab(cmd: string): string {
  return execSync(`agent-browser ${cmd}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function login(): void {
  ab(`open "${BASE_URL}/login"`);
  ab(`fill 'input[name="password"]' '${TEST_PASSWORD}'`);
  ab(`click 'button[type="submit"]'`);
  ab('wait 1000');
}

beforeAll(async () => {
  screenshotDir = mkdtempSync(join(tmpdir(), 'cp-container-smoke-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-container-ws-'));

  repoPath = join(workspaceRoot, 'smokerepo');
  mkdirSync(join(repoPath, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(repoPath, 'README.md'), '# smoke test repo');
  gitInit(repoPath);

  const tsxPath = join(__dirname, '../../node_modules/.bin/tsx');
  const srcIndex = join(__dirname, '../../src/index.ts');

  serverProcess = spawn(tsxPath, [srcIndex], {
    env: {
      ...process.env,
      CONTROL_PLANE_PORT: String(TEST_PORT),
      CONTROL_PLANE_PASSWORD: TEST_PASSWORD,
      SESSION_SECRET: 'container-smoke-session-secret-32!!',
      WORKSPACE_ROOT: workspaceRoot,
      HOST: '127.0.0.1',
      TELEGRAM_ALLOWLIST: '123456',
      REPOS: 'smokerepo=https://github.com/x/smokerepo.git#main',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.error('[server]', msg);
  });

  await waitForServer();
});

afterAll(() => {
  try { ab('close'); } catch { /* ignore */ }
  serverProcess?.kill('SIGTERM');
});

describe('container smoke — login gate', () => {
  it('unauthenticated / redirects to login page', () => {
    ab(`open "${BASE_URL}/"`);
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('password');

    const screenshotPath = join(screenshotDir, '01-login.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('login with correct password reaches overview', () => {
    login();
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('overview');

    const screenshotPath = join(screenshotDir, '02-overview.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });
});

describe('container smoke — overview shows repos', () => {
  it('overview lists the fixture repo', () => {
    ab(`open "${BASE_URL}/"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('smokerepo');

    const screenshotPath = join(screenshotDir, '03-overview-repos.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });
});

describe('container smoke — create plan via form', () => {
  it('new plan form renders with repo picker, title, body, provider', () => {
    ab(`open "${BASE_URL}/plans/new"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('new plan');
    expect(snapshot.toLowerCase()).toContain('provider');

    const screenshotPath = join(screenshotDir, '04-new-plan-form.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('submit new plan form → plan lands in docs/plans/ and appears in list', () => {
    ab(`open "${BASE_URL}/plans/new"`);
    ab('wait --load networkidle');
    ab(`fill 'input[name="title"]' 'Container Smoke Plan'`);
    ab(`fill 'textarea[name="validationCommands"]' 'pnpm test'`);
    ab(`eval 'document.querySelector("form").requestSubmit()'`);
    ab('wait --load networkidle');
    ab('wait 1000');

    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('container-smoke-plan');

    const screenshotPath = join(screenshotDir, '05-plan-created.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('plan file exists on disk', () => {
    const planPath = join(repoPath, 'docs', 'plans', 'container-smoke-plan.md');
    expect(existsSync(planPath)).toBe(true);
  });

  it('plan appears in list via API', async () => {
    const res = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${TEST_PASSWORD}`,
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(';')[0];

    const listRes = await fetch(`${BASE_URL}/api/repos/smokerepo/plans`, {
      headers: { cookie },
    });
    expect(listRes.status).toBe(200);
    const body = await listRes.json() as Array<{ name: string }>;
    expect(body.map(p => p.name)).toContain('container-smoke-plan');
  });

  it('plan appears in the /plans UI view', () => {
    ab(`open "${BASE_URL}/plans"`);
    ab('wait --load networkidle');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('container-smoke-plan');

    const screenshotPath = join(screenshotDir, '06-plans-list.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });
});
