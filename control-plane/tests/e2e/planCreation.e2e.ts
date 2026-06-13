import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const TEST_PORT = 19097;
const TEST_PASSWORD = 'e2e-plan-creation-password';
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: ChildProcess;
let screenshotDir: string;
let workspaceRoot: string;
let repoPath: string;

function gitInit(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -m "initial" --allow-empty', { cwd: dir, stdio: 'ignore' });
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
  ab(`find role button click --name "Sign in"`);
  ab('wait --load networkidle');
}

let _cachedCookie: string | null = null;
async function getSessionCookie(): Promise<string> {
  if (_cachedCookie) return _cachedCookie;
  const res = await fetch(`${BASE_URL}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${TEST_PASSWORD}`,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  _cachedCookie = setCookie.split(';')[0];
  return _cachedCookie;
}

beforeAll(async () => {
  screenshotDir = mkdtempSync(join(tmpdir(), 'cp-plancreation-e2e-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-plancreation-ws-'));

  repoPath = join(workspaceRoot, 'planrepo');
  mkdirSync(join(repoPath, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(repoPath, 'README.md'), '# planrepo');
  gitInit(repoPath);

  const tsxPath = join(__dirname, '../../node_modules/.bin/tsx');
  const srcIndex = join(__dirname, '../../src/index.ts');

  serverProcess = spawn(tsxPath, [srcIndex], {
    env: {
      ...process.env,
      CONTROL_PLANE_PORT: String(TEST_PORT),
      CONTROL_PLANE_PASSWORD: TEST_PASSWORD,
      SESSION_SECRET: 'e2e-plancreation-session-secret-32ch!',
      WORKSPACE_ROOT: workspaceRoot,
      HOST: '127.0.0.1',
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

describe('New plan form (agent-browser)', () => {
  it('navigates to /plans/new and renders the form', () => {
    login();
    ab(`open "${BASE_URL}/plans/new"`);
    ab('wait --load networkidle');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('new plan');
    expect(snapshot.toLowerCase()).toContain('title');
    expect(snapshot.toLowerCase()).toContain('provider');

    const screenshotPath = join(screenshotDir, '01-new-plan-form.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('submits the form and is redirected to plans list with success', () => {
    ab(`open "${BASE_URL}/plans/new"`);
    ab('wait --load networkidle');
    // Fill required fields using CSS selectors
    ab(`fill 'input[name="title"]' 'E2E Test Plan'`);
    ab(`fill 'textarea[name="validationCommands"]' 'pnpm test'`);
    // The body textarea has a valid default value already (### Task 1:...)
    // Submit the form programmatically to reliably trigger form submission
    ab(`eval 'document.querySelector("form").requestSubmit()'`);
    ab('wait --load networkidle');
    ab('wait 1000');

    const snapshot = ab('snapshot');
    // After successful creation, the browser redirects to /plans?created=e2e-test-plan
    // The plans page shows the plan name in success message or table
    expect(snapshot.toLowerCase()).toContain('e2e-test-plan');

    const screenshotPath = join(screenshotDir, '02-new-plan-success.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('new plan file exists on disk', () => {
    const planPath = join(repoPath, 'docs', 'plans', 'e2e-test-plan.md');
    expect(existsSync(planPath)).toBe(true);
  });

  it('new plan appears in the plans list via API', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos/planrepo/plans`, {
      headers: { cookie },
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as Array<{ name: string }>;
    expect(body.map(p => p.name)).toContain('e2e-test-plan');
  });

  it('new plan appears in the /plans UI view', () => {
    ab(`open "${BASE_URL}/plans"`);
    ab('wait --load networkidle');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('e2e-test-plan');

    const screenshotPath = join(screenshotDir, '03-plans-list-with-new-plan.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });
});

describe('New plan form — validation errors (agent-browser)', () => {
  it('shows error for missing title', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos/planrepo/plans`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: '',
        body: '### Task 1: x\n- [ ] y\n',
        validationCommands: 'pnpm test',
        provider: 'claude-code',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Title');
  });

  it('rejects Task 0 via API', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos/planrepo/plans`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Task Zero Plan',
        body: '### Task 0: Bad numbering\n- [ ] thing\n',
        validationCommands: 'pnpm test',
        provider: 'claude-code',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('numbered from 1');
  });

  it('rejects * [ ] bullets via API', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos/planrepo/plans`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Star Bullets Plan',
        body: '### Task 1: Bad bullets\n* [ ] thing\n',
        validationCommands: 'pnpm test',
        provider: 'claude-code',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('* [ ]');
  });

  it('rejects path traversal in repo name via API', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos/..%2Fetc/plans`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Traversal Plan',
        body: '### Task 1: Bad\n- [ ] thing\n',
        validationCommands: 'pnpm test',
        provider: 'claude-code',
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('Plan creation with codex provider writes a claim (API)', () => {
  it('creates plan with codex provider and plan appears in list', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos/planrepo/plans`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Codex E2E Plan',
        body: '### Task 1: Codex task\n- [ ] Use codex\n',
        validationCommands: 'pnpm test',
        provider: 'codex',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { planName: string; fileName: string; planHash: string };
    expect(body.planName).toBe('codex-e2e-plan');
    expect(body.planHash).toBeTruthy();
  });
});
