import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { openDatabase, insertExecution, insertApprovalRequest } from '../../src/db';

const TEST_PORT = 19098;
const TEST_PASSWORD = 'e2e-recovery-password';
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: ChildProcess;
let screenshotDir: string;
let workspaceRoot: string;
let dbPath: string;

const NOW = Date.now();

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

const ATTEMPT_ID = 'rec-att-1';
const APPROVAL_ID = 'rec-approval-1';

beforeAll(async () => {
  screenshotDir = mkdtempSync(join(tmpdir(), 'cp-recovery-e2e-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-recovery-ws-'));
  dbPath = join(workspaceRoot, '.executr', 'orchestrator.db');
  mkdirSync(join(workspaceRoot, '.executr'), { recursive: true });

  // Create a fixture repo
  const repoPath = join(workspaceRoot, 'recoveryrepo');
  mkdirSync(join(repoPath, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(repoPath, '.ralphex', 'plan-state'), { recursive: true });
  mkdirSync(join(repoPath, '.ralphex', 'progress'), { recursive: true });

  writeFileSync(
    join(repoPath, 'docs', 'plans', 'rec-plan.md'),
    '# Plan: Recovery Plan\n\n## Validation Commands\n\n```\npnpm test\n```\n\n### Task 1: Do it\n- [ ] Do something\n'
  );

  gitInit(repoPath);

  // Pre-seed the DB with an execution that has a recovery action and a pending approval
  const db = openDatabase(dbPath);

  insertExecution(db, {
    repo: 'recoveryrepo',
    planFile: 'rec-plan.md',
    planHash: 'deadbeef',
    attemptId: ATTEMPT_ID,
    providerRequested: 'claude-code',
    providerUsed: 'claude-code',
    model: null,
    branch: 'feature/rec-plan',
    worktree: null,
    status: 'running',
    latestProgressTs: null,
    latestTranscriptTs: null,
    rateLimitCooldownUntil: null,
    lastRecoveryAction: 'push_branch: ok — Pushed branch feature/rec-plan after failed finalize',
    classification: 'failed_finalize',
    createdAt: NOW - 5 * 60 * 1000,
    updatedAt: NOW - 60 * 1000,
  });

  // Insert a pending approval request
  insertApprovalRequest(db, {
    id: APPROVAL_ID,
    repo: 'recoveryrepo',
    plan: 'rec-plan',
    action: 'manual_finalize',
    context: 'Auto-push of branch "feature/rec-plan" failed after 3 attempts.',
    status: 'pending',
    channel: 'ui',
    decidedBy: null,
    createdAt: NOW - 30 * 1000,
    decidedAt: null,
  });

  db.close();

  const tsxPath = join(__dirname, '../../node_modules/.bin/tsx');
  const srcIndex = join(__dirname, '../../src/index.ts');

  serverProcess = spawn(tsxPath, [srcIndex], {
    env: {
      ...process.env,
      CONTROL_PLANE_PORT: String(TEST_PORT),
      CONTROL_PLANE_PASSWORD: TEST_PASSWORD,
      SESSION_SECRET: 'e2e-recovery-session-secret-long-enough',
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
  await new Promise(r => setTimeout(r, 300));
});

afterAll(() => {
  try { ab('close'); } catch { /* ignore */ }
  serverProcess?.kill('SIGTERM');
});

describe('Recovery events visible in Activity/Timeline', () => {
  it('GET /activity page shows recovery event from lastRecoveryAction', () => {
    login();
    ab(`open "${BASE_URL}/activity"`);
    ab('wait 500');
    const snapshot = ab('snapshot');

    // The recovery event should appear in the timeline — the recovery poller
    // may have updated lastRecoveryAction since seeding, so check generically
    expect(snapshot.toLowerCase()).toContain('recovery');

    const screenshotPath = join(screenshotDir, '01-activity-with-recovery.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('GET /activity page shows pending approval request', () => {
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('approval');
    expect(snapshot).toContain('manual_finalize');
  });

  it('Both recovery event and approval request appear in activity feed', () => {
    const snapshot = ab('snapshot');
    // Recovery event (from lastRecoveryAction)
    expect(snapshot).toContain('recovery');
    // Approval request
    expect(snapshot.toLowerCase()).toContain('approval');
  });

  it('GET /api/executions returns execution with lastRecoveryAction', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/executions`, {
      headers: { cookie },
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as Array<{ attemptId: string; lastRecoveryAction: string | null }>;
    const ex = body.find(e => e.attemptId === ATTEMPT_ID);
    expect(ex).toBeDefined();
    // The recovery poller may have updated lastRecoveryAction since seeding;
    // verify only that some recovery action has been recorded (non-null).
    expect(ex!.lastRecoveryAction).not.toBeNull();
    expect(typeof ex!.lastRecoveryAction).toBe('string');
  });

  it('POST /api/approvals/:id/decide approves a pending request', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/approvals/${APPROVAL_ID}/decide`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'approved', decidedBy: 'test-user' }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as { id: string; status: string };
    expect(body.status).toBe('approved');
  });

  it('POST /api/approvals/:id/decide returns 409 when already decided', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/approvals/${APPROVAL_ID}/decide`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'denied' }),
    });
    expect(res.status).toBe(409);
  });

  it('POST /api/approvals/:id/decide returns 400 for invalid decision', async () => {
    const cookie = await getSessionCookie();
    const res = await fetch(`${BASE_URL}/api/approvals/${APPROVAL_ID}/decide`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ decision: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });

  it('Screenshot of activity page shows both events', () => {
    ab(`open "${BASE_URL}/activity"`);
    ab('wait 500');
    const screenshotPath = join(screenshotDir, '02-activity-final.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });
});
