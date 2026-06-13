import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { openDatabase, insertTelegramSession, insertApprovalRequest } from '../../src/db';
import type { TelegramSessionRow } from '../../src/db';
import { randomUUID } from 'crypto';

const TEST_PORT = 19095;
const TEST_PASSWORD = 'e2e-telegram-password';
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: ChildProcess;
let screenshotDir: string;
let dbPath: string;

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

let workspaceRoot: string;
const NOW = Date.now();

beforeAll(async () => {
  screenshotDir = mkdtempSync(join(tmpdir(), 'cp-telegram-e2e-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-telegram-ws-'));
  dbPath = join(workspaceRoot, '.executr', 'orchestrator.db');

  // Seed the DB before starting the server
  const { mkdirSync } = await import('fs');
  mkdirSync(join(workspaceRoot, '.executr'), { recursive: true });

  const db = openDatabase(dbPath);

  // Seed two telegram sessions
  const session1: TelegramSessionRow = {
    id: randomUUID(),
    telegramUserId: 111111,
    telegramChatId: 999001,
    sessionName: 'Login Feature',
    targetRepo: 'myrepo',
    transcript: ['I want to add OAuth login', 'Use GitHub as provider'],
    draftPlan: null,
    status: 'active',
    isCurrent: true,
    createdAt: NOW - 60000,
    updatedAt: NOW - 30000,
  };
  const session2: TelegramSessionRow = {
    id: randomUUID(),
    telegramUserId: 222222,
    telegramChatId: 999002,
    sessionName: 'Dashboard Redesign',
    targetRepo: 'frontend',
    transcript: ['Redesign the main dashboard'],
    draftPlan: '# Plan: Dashboard Redesign\n\n## Validation Commands\n\n```\npnpm test\n```\n\n### Task 1: Redesign\n\n- [ ] Redesign it\n',
    status: 'submitted',
    isCurrent: false,
    createdAt: NOW - 120000,
    updatedAt: NOW - 10000,
  };
  insertTelegramSession(db, session1);
  insertTelegramSession(db, session2);

  // Seed an approval request decided via Telegram
  insertApprovalRequest(db, {
    id: 'tg-approval-001',
    repo: 'myrepo',
    plan: 'some-plan',
    action: 'force-push branch after conflict',
    context: 'Branch has diverged from main',
    status: 'approved',
    channel: 'telegram',
    decidedBy: 'telegram:111111',
    createdAt: NOW - 45000,
    decidedAt: NOW - 20000,
  });

  db.close?.();

  const tsxPath = join(__dirname, '../../node_modules/.bin/tsx');
  const srcIndex = join(__dirname, '../../src/index.ts');

  serverProcess = spawn(tsxPath, [srcIndex], {
    env: {
      ...process.env,
      CONTROL_PLANE_PORT: String(TEST_PORT),
      CONTROL_PLANE_PASSWORD: TEST_PASSWORD,
      SESSION_SECRET: 'telegram-e2e-session-secret-padded!',
      WORKSPACE_ROOT: workspaceRoot,
      ORCHESTRATOR_DB_PATH: dbPath,
      HOST: '127.0.0.1',
      // No TELEGRAM_BOT_TOKEN — bot won't start but sessions still render
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

describe('Sessions UI (agent-browser)', () => {
  it('Sessions page loads after login', () => {
    login();
    ab(`open "${BASE_URL}/sessions"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('session');

    const screenshotPath = join(screenshotDir, '01-sessions.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('Sessions page shows bot-created sessions', () => {
    ab(`open "${BASE_URL}/sessions"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    expect(snapshot).toContain('Login Feature');
    expect(snapshot).toContain('Dashboard Redesign');
  });

  it('Sessions page shows submission status', () => {
    ab(`open "${BASE_URL}/sessions"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('active');
    expect(snapshot.toLowerCase()).toContain('submitted');
  });

  it('/api/sessions returns sessions JSON', async () => {
    const loginRes = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${TEST_PASSWORD}`,
      redirect: 'manual',
    });
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];

    const res = await fetch(`${BASE_URL}/api/sessions`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const data = await res.json() as unknown[];
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(2);
  });
});

describe('Activity/Timeline: Telegram-decided approval (agent-browser)', () => {
  it('Activity page shows approval decided via Telegram', () => {
    ab(`open "${BASE_URL}/activity"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    // Should show the approval request
    expect(snapshot.toLowerCase()).toContain('approval');

    const screenshotPath = join(screenshotDir, '02-activity-telegram-approval.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('Activity shows the telegram-approved action', () => {
    ab(`open "${BASE_URL}/activity"`);
    ab('wait 500');
    const snapshot = ab('snapshot');
    // The approval action text or "approved" badge should be visible
    expect(snapshot.toLowerCase()).toMatch(/approv/);
  });
});
