import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const TEST_PORT = 19101;
const TEST_PASSWORD = 'e2e-registry-password';
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: ChildProcess;
let screenshotDir: string;
let workspaceRoot: string;

// Clone the repo into the fixture workspace so it appears as cloned
function gitInit(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
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
  ab(`click 'button[type="submit"]'`);
  ab('wait 1000');
}

// Seeded via REPOS env — will be cloned in the fixture workspace
const SEED_REPO_NAME = 'seed-repo';
const SEED_REPO_URL = 'https://github.com/example/seed-repo.git';

// A second registry repo that is NOT cloned (no .git on disk)
const GHOST_REPO_NAME = 'ghost-repo';
const GHOST_REPO_URL = 'https://github.com/example/ghost-repo.git';

beforeAll(async () => {
  screenshotDir = mkdtempSync(join(tmpdir(), 'cp-registry-e2e-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-registry-ws-'));

  // Create a cloned fixture for seed-repo
  const repoPath = join(workspaceRoot, SEED_REPO_NAME);
  mkdirSync(join(repoPath, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(repoPath, 'README.md'), '# seed repo');
  gitInit(repoPath);

  // ghost-repo only in the registry, no .git on disk

  const tsxPath = join(__dirname, '../../node_modules/.bin/tsx');
  const srcIndex = join(__dirname, '../../src/index.ts');

  // Pass both repos via REPOS env
  const reposEnv = [
    `${SEED_REPO_NAME}=${SEED_REPO_URL}#main`,
    `${GHOST_REPO_NAME}=${GHOST_REPO_URL}#main`,
  ].join(',');

  serverProcess = spawn(tsxPath, [srcIndex], {
    env: {
      ...process.env,
      CONTROL_PLANE_PORT: String(TEST_PORT),
      CONTROL_PLANE_PASSWORD: TEST_PASSWORD,
      SESSION_SECRET: 'e2e-registry-session-secret-long-enough',
      WORKSPACE_ROOT: workspaceRoot,
      HOST: '127.0.0.1',
      REPOS: reposEnv,
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

// ── API tests ──────────────────────────────────────────────────────────

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

describe('registry: GET /api/repos returns registry entries', () => {
  it('includes seeded repos with gitUrl and source fields', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos`, { headers: { cookie } });
    expect(res.ok).toBe(true);
    const body = await res.json() as Array<{
      name: string;
      gitUrl: string;
      source: string;
      registryStatus: string;
      cloned: boolean;
    }>;
    expect(Array.isArray(body)).toBe(true);
    const names = body.map(r => r.name);
    expect(names).toContain(SEED_REPO_NAME);
    expect(names).toContain(GHOST_REPO_NAME);

    const seeded = body.find(r => r.name === SEED_REPO_NAME)!;
    expect(seeded.gitUrl).toBe(SEED_REPO_URL);
    expect(seeded.source).toBe('seed');
    expect(seeded.registryStatus).toBe('active');
    expect(seeded.cloned).toBe(true);
  });

  it('marks the ghost repo as not cloned', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/repos`, { headers: { cookie } });
    const body = await res.json() as Array<{ name: string; cloned: boolean }>;
    const ghost = body.find(r => r.name === GHOST_REPO_NAME)!;
    expect(ghost).toBeDefined();
    expect(ghost.cloned).toBe(false);
  });
});

describe('registry: Overview view lists registry repos (agent-browser)', () => {
  it('Overview shows both seeded repos', () => {
    login();
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain(SEED_REPO_NAME.toLowerCase());
    expect(snapshot.toLowerCase()).toContain(GHOST_REPO_NAME.toLowerCase());

    const screenshotPath = join(screenshotDir, '01-overview-registry.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });
});
