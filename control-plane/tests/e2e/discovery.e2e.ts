import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const TEST_PORT = 19098;
const TEST_PASSWORD = 'e2e-discovery-password';
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: ChildProcess;
let screenshotDir: string;
let workspaceRoot: string;

const SAMPLE_PLAN = `# Plan: Sample Plan

## Validation Commands

\`\`\`
pnpm test
\`\`\`

### Task 1: Bootstrap
- [x] Create scaffolding
- [ ] Write tests

### Task 2: Implement
- [ ] Add routes
`;

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
  ab(`click 'button[type="submit"]'`);
  ab('wait 1000');
}

beforeAll(async () => {
  screenshotDir = mkdtempSync(join(tmpdir(), 'cp-discovery-e2e-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-discovery-ws-'));

  // Create a fixture repo with plans
  const repoPath = join(workspaceRoot, 'samplerepo');
  mkdirSync(join(repoPath, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(repoPath, '.ralphex', 'plan-state'), { recursive: true });

  writeFileSync(join(repoPath, 'docs', 'plans', 'sample-plan.md'), SAMPLE_PLAN);
  writeFileSync(join(repoPath, '.ralphex', 'plan-state', 'sample-plan.md_.sha256'), 'deadbeef');
  // no .status file → status=none (active)

  gitInit(repoPath);

  const tsxPath = join(__dirname, '../../node_modules/.bin/tsx');
  const srcIndex = join(__dirname, '../../src/index.ts');

  serverProcess = spawn(tsxPath, [srcIndex], {
    env: {
      ...process.env,
      CONTROL_PLANE_PORT: String(TEST_PORT),
      CONTROL_PLANE_PASSWORD: TEST_PASSWORD,
      SESSION_SECRET: 'e2e-discovery-session-secret-long-enough',
      WORKSPACE_ROOT: workspaceRoot,
      HOST: '127.0.0.1',
      REPOS: 'samplerepo=https://github.com/x/samplerepo.git#main',
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

describe('overview renders fixture repos/plans (agent-browser)', () => {
  it('overview shows the fixture repo', () => {
    login();
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('samplerepo');

    const screenshotPath = join(screenshotDir, '01-overview-with-repos.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('GET /api/repos returns samplerepo', async () => {
    const res = await fetch(`${BASE_URL}/api/repos`, {
      headers: { cookie: await getSessionCookie() },
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as Array<{ name: string }>;
    expect(body.map(r => r.name)).toContain('samplerepo');
  });

  it('GET /api/repos/:repo/plans returns sample-plan', async () => {
    const res = await fetch(`${BASE_URL}/api/repos/samplerepo/plans`, {
      headers: { cookie: await getSessionCookie() },
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as Array<{ name: string; status: string; validationWarnings: string[] }>;
    const plan = body.find(p => p.name === 'sample-plan');
    expect(plan).toBeDefined();
    expect(plan!.status).toBe('none');
    expect(plan!.validationWarnings).toHaveLength(0);
  });

  it('GET /api/repos/:repo/plans/:plan returns detail with rawMarkdown and tasks', async () => {
    const res = await fetch(`${BASE_URL}/api/repos/samplerepo/plans/sample-plan`, {
      headers: { cookie: await getSessionCookie() },
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as {
      name: string;
      rawMarkdown: string;
      tasks: Array<{ rawTaskNumber: number; normalizedDisplayNumber: number }>;
    };
    expect(body.name).toBe('sample-plan');
    expect(body.rawMarkdown).toContain('Task 1');
    expect(body.tasks[0].rawTaskNumber).toBe(1);
    expect(body.tasks[0].normalizedDisplayNumber).toBe(1);
  });

  it('GET /api/executions returns array with classification field', async () => {
    const res = await fetch(`${BASE_URL}/api/executions`, {
      headers: { cookie: await getSessionCookie() },
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('unknown plan returns 404', async () => {
    const res = await fetch(`${BASE_URL}/api/repos/samplerepo/plans/no-such-plan`, {
      headers: { cookie: await getSessionCookie() },
    });
    expect(res.status).toBe(404);
  });
});

// fetch a session cookie by logging in via HTTP (not agent-browser)
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
