import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const TEST_PORT = 19102;
const TEST_PASSWORD = 'e2e-add-repo-password';
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: ChildProcess;
let screenshotDir: string;
let workspaceRoot: string;

// A source repo with a commit that we can git clone from using file:// URL
let sourceRepoUrl: string;
const NEW_REPO_NAME = 'added-repo';

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

// Pre-existing seed repo in the fixture workspace
const SEED_REPO_NAME = 'seed-repo';

beforeAll(async () => {
  screenshotDir = mkdtempSync(join(tmpdir(), 'cp-addrepo-e2e-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-addrepo-ws-'));

  // Create a seeded repo in the fixture workspace
  const seedRepoPath = join(workspaceRoot, SEED_REPO_NAME);
  mkdirSync(join(seedRepoPath, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(seedRepoPath, 'README.md'), '# seed');
  gitInit(seedRepoPath);

  // Create a regular git repo (with a commit) that we can clone from via file://
  const sourceRepoDir = mkdtempSync(join(tmpdir(), 'cp-addrepo-src-'));
  writeFileSync(join(sourceRepoDir, 'README.md'), '# source repo');
  gitInit(sourceRepoDir);
  sourceRepoUrl = `file://${sourceRepoDir}`;

  const tsxPath = join(__dirname, '../../node_modules/.bin/tsx');
  const srcIndex = join(__dirname, '../../src/index.ts');

  serverProcess = spawn(tsxPath, [srcIndex], {
    env: {
      ...process.env,
      CONTROL_PLANE_PORT: String(TEST_PORT),
      CONTROL_PLANE_PASSWORD: TEST_PASSWORD,
      SESSION_SECRET: 'e2e-addrepo-session-secret-long-enough',
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

// ── API: POST /api/repos ───────────────────────────────────────────────

describe('POST /api/repos: add a new repo', () => {
  it('rejects missing name', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ gitUrl: sourceRepoUrl }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/name/i);
  });

  it('rejects invalid name (path traversal)', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '../escape', gitUrl: sourceRepoUrl }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/invalid|traversal/i);
  });

  it('rejects invalid gitUrl', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'newrepo', gitUrl: 'not-a-url' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/url/i);
  });

  it('clones a new repo and returns 201', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: NEW_REPO_NAME, gitUrl: sourceRepoUrl, branch: 'main' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { name: string; alreadyExisted: boolean };
    expect(body.name).toBe(NEW_REPO_NAME);
    expect(body.alreadyExisted).toBe(false);

    // Clone should exist on disk
    expect(existsSync(join(workspaceRoot, NEW_REPO_NAME, '.git'))).toBe(true);
  });

  it('re-fetches when repo already cloned (returns 200)', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: NEW_REPO_NAME, gitUrl: sourceRepoUrl, branch: 'main' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { alreadyExisted: boolean };
    expect(body.alreadyExisted).toBe(true);
  });
});

// ── API: DELETE /api/repos/:repo ───────────────────────────────────────

describe('DELETE /api/repos/:repo: archive a repo', () => {
  it('returns 404 for unknown repo', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos/ghost-repo`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('archives the newly-added repo', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos/${NEW_REPO_NAME}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as { archived: boolean; name: string };
    expect(body.archived).toBe(true);
    expect(body.name).toBe(NEW_REPO_NAME);
  });

  it('is idempotent: archiving an already-archived repo returns ok', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos/${NEW_REPO_NAME}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.ok).toBe(true);
  });

  it('archived repo disappears from GET /api/repos', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos`, { headers: { cookie } });
    const repos = await res.json() as Array<{ name: string }>;
    const names = repos.map(r => r.name);
    expect(names).not.toContain(NEW_REPO_NAME);
  });
});

// ── agent-browser: add-repo form → new repo appears in Overview ────────

describe('UI: Add-repo form', () => {
  const UI_REPO_NAME = 'ui-added-repo';

  it('Add-repo form is visible on Overview', () => {
    login();
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('add repo');
    const screenshotPath = join(screenshotDir, '01-overview-before-add.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('submitting Add-repo form clones the repo and shows it in Overview', () => {
    ab(`open "${BASE_URL}/"`);
    ab('wait --load networkidle');
    // Open the Add repo details/form
    ab(`find text "Add repo" click`);
    ab('wait 500');

    ab(`fill 'input[name="name"]' '${UI_REPO_NAME}'`);
    ab(`fill 'input[name="gitUrl"]' '${sourceRepoUrl}'`);
    ab(`fill 'input[name="branch"]' 'main'`);
    ab(`find role button click --name "Clone & register"`);
    ab('wait --load networkidle');

    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain(UI_REPO_NAME.toLowerCase());
    // Should show Cloned status
    expect(snapshot.toLowerCase()).toContain('cloned');

    const screenshotPath = join(screenshotDir, '02-overview-after-add.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('archive button is visible per repo row', () => {
    ab(`open "${BASE_URL}/"`);
    ab('wait --load networkidle');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('archive');
  });
});
