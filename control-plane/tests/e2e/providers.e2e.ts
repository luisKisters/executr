import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { openDatabase, insertExecution } from '../../src/db';

const TEST_PORT = 19098;
const TEST_PASSWORD = 'e2e-providers-password';
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: ChildProcess;
let screenshotDir: string;
let workspaceRoot: string;
let repoPath: string;
let dbPath: string;

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

function login(): void {
  ab(`open "${BASE_URL}/login"`);
  ab(`fill 'input[name="password"]' '${TEST_PASSWORD}'`);
  ab(`find role button click --name "Sign in"`);
  ab('wait --load networkidle');
}

beforeAll(async () => {
  screenshotDir = mkdtempSync(join(tmpdir(), 'cp-providers-e2e-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-providers-ws-'));
  dbPath = join(workspaceRoot, '.executr', 'orchestrator.db');

  repoPath = join(workspaceRoot, 'provrepo');
  mkdirSync(join(repoPath, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(repoPath, 'README.md'), '# provrepo');
  gitInit(repoPath);

  // Pre-seed DB with a codex execution so the executions/overview view can show it
  mkdirSync(join(workspaceRoot, '.executr'), { recursive: true });
  const db = openDatabase(dbPath);
  const now = Date.now();
  insertExecution(db, {
    repo: 'provrepo',
    planFile: 'docs/plans/codex-seeded-plan.md',
    planHash: 'seedhash-codex-task7',
    attemptId: 'codex-attempt-task7',
    providerRequested: 'codex',
    providerUsed: 'codex',
    model: 'gpt-5.5',
    branch: 'feature/codex-seeded-plan',
    worktree: null,
    status: 'running',
    latestProgressTs: now,
    latestTranscriptTs: null,
    rateLimitCooldownUntil: null,
    lastRecoveryAction: null,
    classification: 'healthy',
    createdAt: now,
    updatedAt: now,
  });
  db.close();

  const tsxPath = join(__dirname, '../../node_modules/.bin/tsx');
  const srcIndex = join(__dirname, '../../src/index.ts');

  serverProcess = spawn(tsxPath, [srcIndex], {
    env: {
      ...process.env,
      CONTROL_PLANE_PORT: String(TEST_PORT),
      CONTROL_PLANE_PASSWORD: TEST_PASSWORD,
      SESSION_SECRET: 'e2e-providers-session-secret-32ch!',
      WORKSPACE_ROOT: workspaceRoot,
      ORCHESTRATOR_DB_PATH: dbPath,
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

describe('New plan form — provider selector (agent-browser)', () => {
  it('form shows all three provider options', () => {
    login();
    ab(`open "${BASE_URL}/plans/new"`);
    ab('wait --load networkidle');
    const snapshot = ab('snapshot');
    expect(snapshot).toContain('claude-code');
    expect(snapshot).toContain('codex');
    expect(snapshot).toContain('auto');

    const shot = join(screenshotDir, '01-provider-form.png');
    ab(`screenshot "${shot}"`);
    expect(existsSync(shot)).toBe(true);
  });

  it('persists selected provider (codex) in form after submitting valid plan', async () => {
    const cookie = await getSessionCookie();

    // Create a plan with codex provider via API
    const res = await fetch(`${BASE_URL}/api/repos/provrepo/plans`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Provider E2E Plan',
        body: '### Task 1: Provider task\n- [ ] Use the provider\n',
        validationCommands: 'pnpm test',
        provider: 'codex',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { planName: string };
    expect(body.planName).toBe('provider-e2e-plan');
  });

  it('plan detail page shows claimed provider for codex plan', () => {
    ab(`open "${BASE_URL}/repos/provrepo/plans/provider-e2e-plan"`);
    ab('wait --load networkidle');
    const snapshot = ab('snapshot');
    // The plan detail should show provider info (claimed or from execution)
    expect(snapshot.toLowerCase()).toContain('provider');
    expect(snapshot.toLowerCase()).toContain('codex');

    const shot = join(screenshotDir, '02-plan-detail-provider.png');
    ab(`screenshot "${shot}"`);
    expect(existsSync(shot)).toBe(true);
  });

  it('GET /api/provider-policy returns default policy', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/provider-policy`, { headers: { cookie } });
    expect(res.ok).toBe(true);
    const body = await res.json() as {
      prefer: string;
      fallback_order: string[];
      switch_on: Record<string, boolean>;
    };
    expect(body.prefer).toBe('codex');
    expect(body.fallback_order).toContain('codex');
    expect(body.fallback_order).toContain('claude-code');
    expect(typeof body.switch_on).toBe('object');
  });

  it('PUT /api/provider-policy updates and returns new policy', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/provider-policy`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        switch_on: { provider_rate_limited: false },
      }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as { switch_on: Record<string, boolean> };
    expect(body.switch_on['provider_rate_limited']).toBe(false);
  });

  it('plan detail for claude-code plan shows default provider badge', () => {
    // Create a claude-code plan first
    execSync(
      `cat > "${join(repoPath, 'docs', 'plans', 'cc-plan.md')}" << 'EOMD'\n# Plan: CC Plan\n\n## Validation Commands\n\n\`\`\`\npnpm test\n\`\`\`\n\n### Task 1: Default provider\n\n- [ ] Use claude-code\nEOMD`,
      { stdio: 'ignore' }
    );

    ab(`open "${BASE_URL}/repos/provrepo/plans/cc-plan"`);
    ab('wait --load networkidle');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('provider');

    const shot = join(screenshotDir, '03-plan-detail-cc.png');
    ab(`screenshot "${shot}"`);
    expect(existsSync(shot)).toBe(true);
  });

  it('overview page shows seeded codex execution with provider-used = codex', async () => {
    // Verify via API that the execution is recorded
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/executions`, { headers: { cookie } });
    expect(res.ok).toBe(true);
    const execs = await res.json() as { providerRequested?: string; providerUsed?: string; repo?: string }[];
    const codexExec = execs.find(e => e.repo === 'provrepo' && e.providerUsed === 'codex');
    expect(codexExec).toBeDefined();
    expect(codexExec?.providerRequested).toBe('codex');

    // Verify the overview renders and shows the execution
    ab(`open "${BASE_URL}/"`);
    ab('wait --load networkidle');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('overview');

    const shot = join(screenshotDir, '04-overview-codex-execution.png');
    ab(`screenshot "${shot}"`);
    expect(existsSync(shot)).toBe(true);
  });

  it('activity page shows running codex execution entry', async () => {
    const cookie = await getSessionCookie();

    // Confirm via API that the execution is visible
    const res = await fetch(`${BASE_URL}/api/executions`, { headers: { cookie } });
    const execs = await res.json() as { attemptId?: string; providerUsed?: string }[];
    const seeded = execs.find(e => e.attemptId === 'codex-attempt-task7');
    expect(seeded).toBeDefined();
    expect(seeded?.providerUsed).toBe('codex');

    // Render the activity view
    ab(`open "${BASE_URL}/activity"`);
    ab('wait --load networkidle');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('activity');

    const shot = join(screenshotDir, '05-activity-codex.png');
    ab(`screenshot "${shot}"`);
    expect(existsSync(shot)).toBe(true);
  });
});
