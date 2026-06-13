import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { openDatabase, insertExecution } from '../../src/db';

const TEST_PORT = 19099;
const TEST_PASSWORD = 'e2e-observer-password';
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: ChildProcess;
let screenshotDir: string;
let workspaceRoot: string;
let dbPath: string;

const NOW = Date.now();
const AGE_10MIN = 10 * 60 * 1000;

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
  screenshotDir = mkdtempSync(join(tmpdir(), 'cp-observer-e2e-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-observer-ws-'));
  dbPath = join(workspaceRoot, '.executr', 'orchestrator.db');
  mkdirSync(join(workspaceRoot, '.executr'), { recursive: true });

  // Create a fixture repo
  const repoPath = join(workspaceRoot, 'observedrepo');
  mkdirSync(join(repoPath, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(repoPath, '.ralphex', 'plan-state'), { recursive: true });
  mkdirSync(join(repoPath, '.ralphex', 'progress'), { recursive: true });

  writeFileSync(
    join(repoPath, 'docs', 'plans', 'obs-plan.md'),
    '# Plan: Observed Plan\n\n## Validation Commands\n\n```\npnpm test\n```\n\n### Task 1: Do it\n- [ ] Do something\n'
  );
  // Plan is "completed" so the observer will classify it as healthy
  writeFileSync(join(repoPath, '.ralphex', 'plan-state', 'obs-plan.md_.sha256'), 'deadbeef');
  writeFileSync(join(repoPath, '.ralphex', 'plan-state', 'obs-plan.md_.status'), 'completed');

  gitInit(repoPath);

  // Pre-seed the DB with a running execution that has no classification yet
  const db = openDatabase(dbPath);
  insertExecution(db, {
    repo: 'observedrepo',
    planFile: 'obs-plan.md',
    planHash: 'deadbeef',
    attemptId: 'obs-att-1',
    providerRequested: 'claude-code',
    providerUsed: 'claude-code',
    model: null,
    branch: 'feature/obs-plan',
    worktree: null,
    status: 'running',
    latestProgressTs: null,
    latestTranscriptTs: null,
    rateLimitCooldownUntil: null,
    lastRecoveryAction: null,
    classification: null,
    createdAt: NOW - AGE_10MIN,
    updatedAt: NOW - AGE_10MIN,
  });
  db.close();

  const tsxPath = join(__dirname, '../../node_modules/.bin/tsx');
  const srcIndex = join(__dirname, '../../src/index.ts');

  serverProcess = spawn(tsxPath, [srcIndex], {
    env: {
      ...process.env,
      CONTROL_PLANE_PORT: String(TEST_PORT),
      CONTROL_PLANE_PASSWORD: TEST_PASSWORD,
      SESSION_SECRET: 'e2e-observer-session-secret-long-enough',
      WORKSPACE_ROOT: workspaceRoot,
      ORCHESTRATOR_DB_PATH: dbPath,
      HOST: '127.0.0.1',
      REPOS: 'observedrepo=https://github.com/x/observedrepo.git#main',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.error('[server]', msg);
  });

  await waitForServer();

  // Give the observer a moment to run its first poll
  await new Promise(r => setTimeout(r, 500));
});

afterAll(() => {
  try { ab('close'); } catch { /* ignore */ }
  serverProcess?.kill('SIGTERM');
});

describe('Observer classification visible in API + UI', () => {
  it('GET /api/executions returns execution with classification field', async () => {
    const res = await fetch(`${BASE_URL}/api/executions`, {
      headers: { cookie: await getSessionCookie() },
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as Array<{ attemptId: string; classification: string }>;
    expect(Array.isArray(body)).toBe(true);

    const obs = body.find(e => e.attemptId === 'obs-att-1');
    expect(obs).toBeDefined();
    // The observer should have classified the completed plan as healthy
    expect(obs!.classification).toBe('healthy');
  });

  it('Overview page renders health classification badge', () => {
    login();
    const snapshot = ab('snapshot');

    // The observer classified the execution as healthy — badge should show
    expect(snapshot.toLowerCase()).toContain('observedrepo');

    const screenshotPath = join(screenshotDir, '01-overview-with-classification.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('Overview page shows health badge for the classified execution', () => {
    const snapshot = ab('snapshot');
    // The Healthy badge should be rendered (badge-green)
    expect(snapshot).toContain('Healthy');
  });
});
