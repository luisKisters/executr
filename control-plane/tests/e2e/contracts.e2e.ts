import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { openDatabase, insertExecution, insertApprovalRequest } from '../../src/db';

const TEST_PORT = 19098;
const TEST_PASSWORD = 'contracts-e2e-password';
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: ChildProcess;
let workspaceRoot: string;

async function waitForServer(maxMs = 15000): Promise<void> {
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

async function fetchWithAuth(path: string, cookieStr?: string) {
  return fetch(`${BASE_URL}${path}`, {
    headers: cookieStr ? { cookie: cookieStr } : {},
  });
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${TEST_PASSWORD}`,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0];
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-contracts-ws-'));
  const dbPath = join(workspaceRoot, '.executr', 'orchestrator.db');

  // Pre-seed the DB with one execution and one approval request
  mkdirSync(join(workspaceRoot, '.executr'), { recursive: true });
  const db = openDatabase(dbPath);
  const now = Date.now();
  insertExecution(db, {
    repo: 'seed-repo',
    planFile: 'docs/plans/seed-plan.md',
    planHash: 'seedhash',
    attemptId: 'seed-attempt-1',
    providerRequested: 'claude-code',
    providerUsed: 'claude-code',
    model: 'claude-opus-4',
    branch: 'feature/seed-plan',
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
  insertApprovalRequest(db, {
    id: 'approval-seed-1',
    repo: 'seed-repo',
    plan: 'seed-plan.md',
    action: 'force-push branch',
    context: 'branch diverged',
    status: 'pending',
    channel: 'ui',
    decidedBy: null,
    createdAt: now,
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
      SESSION_SECRET: 'contracts-e2e-session-secret-long-enough',
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
  serverProcess?.kill('SIGTERM');
});

describe('/api/_debug/contracts (agent-browser via fetch)', () => {
  it('requires authentication', async () => {
    const res = await fetchWithAuth('/api/_debug/contracts');
    expect(res.status).toBe(401);
  });

  it('returns seeded execution and approval request when authenticated', async () => {
    const cookie = await login();
    const res = await fetchWithAuth('/api/_debug/contracts', cookie);
    expect(res.status).toBe(200);

    const data = await res.json() as { executions: unknown[]; approvalRequests: unknown[] };
    expect(data.executions).toHaveLength(1);
    expect(data.approvalRequests).toHaveLength(1);

    const exec = data.executions[0] as Record<string, unknown>;
    expect(exec['repo']).toBe('seed-repo');
    expect(exec['attemptId']).toBe('seed-attempt-1');
    expect(exec['providerRequested']).toBe('claude-code');
    expect(exec['classification']).toBe('healthy');

    const approval = data.approvalRequests[0] as Record<string, unknown>;
    expect(approval['id']).toBe('approval-seed-1');
    expect(approval['status']).toBe('pending');
    expect(approval['action']).toBe('force-push branch');
  });

  it('renders the overview page showing the contracts debug link', async () => {
    const cookie = await login();
    const res = await fetchWithAuth('/', cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain('overview');
  });
});
