import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

const TEST_PORT = 19103;
const TEST_PASSWORD = 'e2e-reposlist-password';
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: ChildProcess;
let workspaceRoot: string;
let screenshotDir: string;

// Source repo we can git-clone via file:// URL
let sourceRepoUrl: string;

function gitInit(dir: string, defaultBranch = 'main'): void {
  execSync(`git -c init.defaultBranch=${defaultBranch} init`, { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  execSync('git add -A && git commit -m "initial" --allow-empty', { cwd: dir, stdio: 'ignore' });
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

const SEED_REPO_NAME = 'seed-repo';

beforeAll(async () => {
  screenshotDir = mkdtempSync(join(tmpdir(), 'cp-reposlist-e2e-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-reposlist-ws-'));

  // Create a seeded repo in the fixture workspace
  const seedRepoPath = join(workspaceRoot, SEED_REPO_NAME);
  mkdirSync(join(seedRepoPath, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(seedRepoPath, 'README.md'), '# seed');
  gitInit(seedRepoPath);

  // Create a source repo we can clone from via file://
  const sourceDir = mkdtempSync(join(tmpdir(), 'cp-reposlist-src-'));
  writeFileSync(join(sourceDir, 'README.md'), '# source');
  gitInit(sourceDir);
  sourceRepoUrl = `file://${sourceDir}`;

  const tsxPath = join(__dirname, '../../node_modules/.bin/tsx');
  const srcIndex = join(__dirname, '../../src/index.ts');

  serverProcess = spawn(tsxPath, [srcIndex], {
    env: {
      ...process.env,
      CONTROL_PLANE_PORT: String(TEST_PORT),
      CONTROL_PLANE_PASSWORD: TEST_PASSWORD,
      SESSION_SECRET: 'e2e-reposlist-session-secret-long-enough',
      WORKSPACE_ROOT: workspaceRoot,
      HOST: '127.0.0.1',
      REPOS: `${SEED_REPO_NAME}=https://github.com/example/${SEED_REPO_NAME}.git#main`,
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

// ── repos.list file management ────────────────────────────────────────

describe('repos.list: written on startup from registry seed', () => {
  it('repos.list exists after server startup', () => {
    const listPath = join(workspaceRoot, '.executr', 'repos.list');
    expect(existsSync(listPath)).toBe(true);
  });

  it('repos.list contains the seeded repo entry', () => {
    const listPath = join(workspaceRoot, '.executr', 'repos.list');
    const content = readFileSync(listPath, 'utf8');
    expect(content).toContain(SEED_REPO_NAME + '=');
    expect(content).toContain('github.com/example');
  });

  it('repos.list has one entry per line in name=URL#branch format', () => {
    const listPath = join(workspaceRoot, '.executr', 'repos.list');
    const content = readFileSync(listPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // Each line must match name=URL#branch pattern
    for (const line of lines) {
      expect(line).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*=.+#.+$/);
    }
  });
});

describe('repos.list: updated when a repo is added via API', () => {
  const NEW_REPO_NAME = 'loop-test-repo';

  it('adds the repo via API', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: NEW_REPO_NAME, gitUrl: sourceRepoUrl, branch: 'main' }),
    });
    expect(res.status).toBe(201);
  });

  it('repos.list now includes the newly-added repo', () => {
    const listPath = join(workspaceRoot, '.executr', 'repos.list');
    const content = readFileSync(listPath, 'utf8');
    expect(content).toContain(NEW_REPO_NAME + '=');
  });

  it('repos.list still contains the original seeded repo', () => {
    const listPath = join(workspaceRoot, '.executr', 'repos.list');
    const content = readFileSync(listPath, 'utf8');
    expect(content).toContain(SEED_REPO_NAME + '=');
  });

  it('repos.list has two entries after adding one more repo', () => {
    const listPath = join(workspaceRoot, '.executr', 'repos.list');
    const content = readFileSync(listPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });
});

describe('repos.list: updated when a repo is archived via API', () => {
  it('archives the newly-added repo', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos/loop-test-repo`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.ok).toBe(true);
  });

  it('repos.list no longer contains the archived repo', () => {
    const listPath = join(workspaceRoot, '.executr', 'repos.list');
    const content = readFileSync(listPath, 'utf8');
    expect(content).not.toContain('loop-test-repo=');
  });

  it('repos.list still contains the original seeded repo', () => {
    const listPath = join(workspaceRoot, '.executr', 'repos.list');
    const content = readFileSync(listPath, 'utf8');
    expect(content).toContain(SEED_REPO_NAME + '=');
  });
});

// ── agent-browser: add repo in UI → repos.list updated + loop discovers it ──

describe('UI: add repo via form → repos.list updated and repo is discoverable by loop', () => {
  const UI_REPO_NAME = 'ui-loop-repo';

  it('Overview shows Add repo form', () => {
    login();
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('add repo');

    const screenshotPath = join(screenshotDir, '01-overview-before-add.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('submitting Add repo form updates repos.list so the loop would pick it up', () => {
    ab(`open "${BASE_URL}/"`);
    ab('wait --load networkidle');
    ab(`find text "Add repo" click`);
    ab('wait 500');

    ab(`fill 'input[name="name"]' '${UI_REPO_NAME}'`);
    ab(`fill 'input[name="gitUrl"]' '${sourceRepoUrl}'`);
    ab(`fill 'input[name="branch"]' 'main'`);
    ab(`find role button click --name "Clone & register"`);
    ab('wait --load networkidle');

    // repos.list should now contain the new repo — the loop would pick this up
    // within one POLL_SECONDS cycle without a restart or env edit.
    const listPath = join(workspaceRoot, '.executr', 'repos.list');
    const content = readFileSync(listPath, 'utf8');
    expect(content).toContain(UI_REPO_NAME + '=');

    const screenshotPath = join(screenshotDir, '02-overview-after-add.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('Overview shows the new repo as cloned', () => {
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain(UI_REPO_NAME.toLowerCase());

    const screenshotPath = join(screenshotDir, '03-overview-with-new-repo.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });
});
