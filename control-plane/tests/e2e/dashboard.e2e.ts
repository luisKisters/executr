import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const TEST_PORT = 19096;
const TEST_PASSWORD = 'e2e-dashboard-password';
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
  screenshotDir = mkdtempSync(join(tmpdir(), 'cp-dashboard-e2e-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-dashboard-ws-'));

  const repoPath = join(workspaceRoot, 'dashrepo');
  mkdirSync(join(repoPath, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(repoPath, '.ralphex', 'plan-state'), { recursive: true });
  mkdirSync(join(repoPath, '.ralphex', 'progress'), { recursive: true });

  writeFileSync(join(repoPath, 'docs', 'plans', 'sample-plan.md'), SAMPLE_PLAN);
  writeFileSync(join(repoPath, '.ralphex', 'plan-state', 'sample-plan.md_.sha256'), 'feedcafe');
  writeFileSync(
    join(repoPath, '.ralphex', 'progress', 'progress-sample-plan.txt'),
    'Step 1 done\nvalidation: passed\n'
  );
  gitInit(repoPath);

  const tsxPath = join(__dirname, '../../node_modules/.bin/tsx');
  const srcIndex = join(__dirname, '../../src/index.ts');

  serverProcess = spawn(tsxPath, [srcIndex], {
    env: {
      ...process.env,
      CONTROL_PLANE_PORT: String(TEST_PORT),
      CONTROL_PLANE_PASSWORD: TEST_PASSWORD,
      SESSION_SECRET: 'e2e-dashboard-session-secret-32ch!',
      WORKSPACE_ROOT: workspaceRoot,
      HOST: '127.0.0.1',
      REPOS: 'dashrepo=https://github.com/x/dashrepo.git#main',
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

describe('Overview view (agent-browser)', () => {
  it('shows repo in the overview table', () => {
    login();
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('dashrepo');
    expect(snapshot).toContain('Health');

    const screenshotPath = join(screenshotDir, '01-overview.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('overview has health and last-progress columns', () => {
    ab(`open "${BASE_URL}/"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    expect(snapshot).toContain('Last progress');
    expect(snapshot).toContain('Last transcript');
  });
});

describe('Plans view (agent-browser)', () => {
  it('renders the plans list with sample-plan', () => {
    ab(`open "${BASE_URL}/plans"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('sample-plan');
    expect(snapshot).toContain('Plans');

    const screenshotPath = join(screenshotDir, '02-plans.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('renders the per-repo plans list via /repos/:repo/plans', () => {
    ab(`open "${BASE_URL}/repos/dashrepo/plans"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('sample-plan');
    expect(snapshot.toLowerCase()).toContain('dashrepo');

    const screenshotPath = join(screenshotDir, '03-repo-plans.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });
});

describe('Plan detail view (agent-browser)', () => {
  it('renders plan detail with tasks, commits, and validation state', () => {
    ab(`open "${BASE_URL}/repos/dashrepo/plans/sample-plan"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('sample-plan');
    expect(snapshot).toContain('Bootstrap');
    expect(snapshot).toContain('Implement');

    const screenshotPath = join(screenshotDir, '04-plan-detail.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('plan detail shows progress log content', () => {
    ab(`open "${BASE_URL}/repos/dashrepo/plans/sample-plan"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    expect(snapshot).toContain('Step 1 done');
  });

  it('plan detail shows validation state', () => {
    ab(`open "${BASE_URL}/repos/dashrepo/plans/sample-plan"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('passed');
  });

  it('unknown plan returns 404', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/repos/dashrepo/plans/nonexistent-plan`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(404);
  });
});

describe('New plan form (agent-browser)', () => {
  it('renders the form with live preview element', () => {
    ab(`open "${BASE_URL}/plans/new"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('new plan');
    expect(snapshot.toLowerCase()).toContain('provider');
    expect(snapshot.toLowerCase()).toContain('preview');

    const screenshotPath = join(screenshotDir, '05-new-plan.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('live preview shows generated ralphex markdown', () => {
    ab(`open "${BASE_URL}/plans/new"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    // Preview should contain "# Plan:" from the JS-generated preview
    expect(snapshot).toContain('# Plan:');
    expect(snapshot).toContain('## Validation Commands');
  });

  it('provider selector has claude-code, codex, and auto options', () => {
    ab(`open "${BASE_URL}/plans/new"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    expect(snapshot).toContain('claude-code');
    expect(snapshot).toContain('codex');
    expect(snapshot).toContain('auto');
  });
});

describe('Activity / Timeline view (agent-browser)', () => {
  it('renders the activity page even with no events', () => {
    ab(`open "${BASE_URL}/activity"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    expect(snapshot).toContain('Activity');
    expect(snapshot.toLowerCase()).toContain('no activity');

    const screenshotPath = join(screenshotDir, '06-activity.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });
});

describe('Sessions view (agent-browser)', () => {
  it('renders the sessions page with empty state', () => {
    ab(`open "${BASE_URL}/sessions"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    expect(snapshot).toContain('Session');
    expect(snapshot.toLowerCase()).toContain('telegram');

    const screenshotPath = join(screenshotDir, '07-sessions.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });
});
