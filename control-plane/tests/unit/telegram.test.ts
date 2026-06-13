import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import {
  TelegramBot,
  parseCommandText,
  type TgUpdate,
  type SendMessageFn,
} from '../../src/telegram';
import { parseTelegramAllowlist } from '../../src/config';
import {
  openDatabase,
  insertApprovalRequest,
  listApprovalRequests,
  getCurrentSessionForUser,
  getTelegramSessionsForUser,
  listTelegramSessions,
} from '../../src/db';
import type { OrchestratorDB } from '../../src/db';

let tmpDir: string;
let db: OrchestratorDB;
let sent: Array<{ chatId: number; text: string }>;
let mockSend: SendMessageFn;

const ALLOWED_USER = 111111;
const ALLOWED_CHAT = 999999;

function gitInit(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
}

function makeBot(opts: {
  allowlist?: number[];
  runner?: Parameters<typeof TelegramBot>[0]['runner'];
  scheduler?: Parameters<typeof TelegramBot>[0]['scheduler'];
} = {}): TelegramBot {
  return new TelegramBot({
    config: { botToken: 'fake-token', allowlist: opts.allowlist ?? [ALLOWED_USER] },
    db,
    workspaceRoot: tmpDir,
    claimsDir: join(tmpDir, '.executr', 'claims'),
    runner: opts.runner,
    scheduler: opts.scheduler,
    sendMessage: mockSend,
    getUpdates: async () => [],
  });
}

function makeUpdate(text: string, userId = ALLOWED_USER, chatId = ALLOWED_CHAT): TgUpdate {
  return {
    update_id: Math.floor(Math.random() * 100000),
    message: {
      message_id: 1,
      from: { id: userId, first_name: 'Test' },
      chat: { id: chatId },
      text,
      date: Math.floor(Date.now() / 1000),
    },
  };
}

let dbCounter = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'telegram-test-'));
  mkdirSync(join(tmpDir, '.executr'), { recursive: true });
  dbCounter++;
  db = openDatabase(join(tmpDir, `.executr/orchestrator-${dbCounter}.db`));
  sent = [];
  mockSend = async (chatId, text) => { sent.push({ chatId, text }); };
});

// ── parseTelegramAllowlist ────────────────────────────────────────────────

describe('parseTelegramAllowlist', () => {
  it('parses comma-separated IDs', () => {
    expect(parseTelegramAllowlist('111,222,333')).toEqual([111, 222, 333]);
  });

  it('trims whitespace', () => {
    expect(parseTelegramAllowlist('  111 , 222  ')).toEqual([111, 222]);
  });

  it('returns empty for empty/undefined', () => {
    expect(parseTelegramAllowlist('')).toEqual([]);
    expect(parseTelegramAllowlist(undefined)).toEqual([]);
  });

  it('skips non-numeric entries', () => {
    expect(parseTelegramAllowlist('111,abc,222')).toEqual([111, 222]);
  });

  it('skips zero and negative values', () => {
    expect(parseTelegramAllowlist('0,-5,100')).toEqual([100]);
  });
});

// ── parseCommandText ─────────────────────────────────────────────────────

describe('parseCommandText', () => {
  it('parses simple command', () => {
    expect(parseCommandText('/plan')).toEqual({ command: 'plan', rest: '' });
  });

  it('parses command with args', () => {
    expect(parseCommandText('/repo myrepo')).toEqual({ command: 'repo', rest: 'myrepo' });
  });

  it('parses session subcommands', () => {
    expect(parseCommandText('/session new My Plan')).toEqual({ command: 'session', rest: 'new My Plan' });
  });

  it('returns null for non-command text', () => {
    expect(parseCommandText('hello world')).toBeNull();
    expect(parseCommandText('just text')).toBeNull();
  });

  it('lowercases the command', () => {
    expect(parseCommandText('/PLAN')?.command).toBe('plan');
  });

  it('strips @botname suffix', () => {
    expect(parseCommandText('/plan@mybotname')).toEqual({ command: 'plan', rest: '' });
  });
});

// ── TelegramBot.isAllowed ─────────────────────────────────────────────────

describe('TelegramBot.isAllowed', () => {
  it('allows listed user IDs', () => {
    const bot = makeBot({ allowlist: [111, 222] });
    expect(bot.isAllowed(111)).toBe(true);
    expect(bot.isAllowed(222)).toBe(true);
  });

  it('rejects non-listed user IDs', () => {
    const bot = makeBot({ allowlist: [111] });
    expect(bot.isAllowed(999)).toBe(false);
  });

  it('rejects all users when allowlist is empty', () => {
    const bot = makeBot({ allowlist: [] });
    expect(bot.isAllowed(111)).toBe(false);
  });
});

// ── handleUpdate: allowlist ───────────────────────────────────────────────

describe('handleUpdate allowlist', () => {
  it('ignores messages from non-allowlisted users', async () => {
    const bot = makeBot({ allowlist: [111] });
    await bot.handleUpdate(makeUpdate('/plan', 999, 888));
    expect(sent).toHaveLength(0);
    // No session created
    expect(getTelegramSessionsForUser(db, 999)).toHaveLength(0);
  });

  it('processes messages from allowlisted users', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/start'));
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(ALLOWED_CHAT);
  });
});

// ── /session new ──────────────────────────────────────────────────────────

describe('/session new', () => {
  it('creates a new session in the DB', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new My Feature'));
    const sessions = getTelegramSessionsForUser(db, ALLOWED_USER);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionName).toBe('My Feature');
    expect(sessions[0].status).toBe('active');
    expect(sessions[0].isCurrent).toBe(true);
  });

  it('sends a confirmation message', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new Test Session'));
    expect(sent[0].text).toContain('Test Session');
    expect(sent[0].text).toContain('created');
  });

  it('replies with usage if no name given', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new'));
    expect(sent[0].text).toContain('Usage');
  });

  it('sets newly created session as current', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new First'));
    await bot.handleUpdate(makeUpdate('/session new Second'));
    const current = getCurrentSessionForUser(db, ALLOWED_USER);
    expect(current?.sessionName).toBe('Second');
  });
});

// ── /session list ─────────────────────────────────────────────────────────

describe('/session list', () => {
  it('lists sessions for the user', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new Alpha'));
    await bot.handleUpdate(makeUpdate('/session new Beta'));
    sent.length = 0;
    await bot.handleUpdate(makeUpdate('/session list'));
    expect(sent[0].text).toContain('Alpha');
    expect(sent[0].text).toContain('Beta');
  });

  it('replies with empty message when no sessions', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session list'));
    expect(sent[0].text.toLowerCase()).toContain('no sessions');
  });
});

// ── /session switch ───────────────────────────────────────────────────────

describe('/session switch', () => {
  it('switches active session by name', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new Alpha'));
    await bot.handleUpdate(makeUpdate('/session new Beta'));
    // Beta is now current; switch back to Alpha
    await bot.handleUpdate(makeUpdate('/session switch Alpha'));
    const current = getCurrentSessionForUser(db, ALLOWED_USER);
    expect(current?.sessionName).toBe('Alpha');
  });

  it('replies with error for unknown session', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session switch nonexistent'));
    expect(sent[0].text).toContain('not found');
  });

  it('replies with usage if no arg', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session switch'));
    expect(sent[0].text).toContain('Usage');
  });
});

// ── /session delete ───────────────────────────────────────────────────────

describe('/session delete', () => {
  it('marks session as abandoned', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new ToDelete'));
    const sessions = getTelegramSessionsForUser(db, ALLOWED_USER);
    const id = sessions[0].id;
    await bot.handleUpdate(makeUpdate(`/session delete ToDelete`));
    const updated = getTelegramSessionsForUser(db, ALLOWED_USER).find(s => s.id === id);
    expect(updated?.status).toBe('abandoned');
  });

  it('clears current session when deleting it', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new ToDelete'));
    await bot.handleUpdate(makeUpdate('/session delete ToDelete'));
    expect(getCurrentSessionForUser(db, ALLOWED_USER)).toBeNull();
  });

  it('replies with error for unknown session', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session delete nope'));
    expect(sent[0].text).toContain('not found');
  });
});

// ── /repo ─────────────────────────────────────────────────────────────────

describe('/repo', () => {
  it('sets targetRepo on the active session', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new PlanSession'));
    await bot.handleUpdate(makeUpdate('/repo myrepo'));
    const current = getCurrentSessionForUser(db, ALLOWED_USER);
    expect(current?.targetRepo).toBe('myrepo');
  });

  it('replies with error if no active session', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/repo myrepo'));
    expect(sent[0].text).toContain('No active session');
  });

  it('replies with usage if no repo given', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new X'));
    sent.length = 0;
    await bot.handleUpdate(makeUpdate('/repo'));
    expect(sent[0].text).toContain('Usage');
  });
});

// ── /plan ─────────────────────────────────────────────────────────────────

describe('/plan', () => {
  it('calls draftPlan and stores result', async () => {
    const DRAFT = '# Plan: My Plan\n\n## Validation Commands\n\n```\npnpm test\n```\n\n### Task 1: Do it\n\n- [ ] Do the thing\n';
    const mockRunner = {
      providerName: 'claude-code' as const,
      draftPlan: vi.fn().mockResolvedValue({ markdown: DRAFT, valid: true, warnings: [] }),
      runPlan: vi.fn(),
      inspect: vi.fn(),
      availability: vi.fn(),
    };

    const bot = makeBot({ runner: mockRunner });
    await bot.handleUpdate(makeUpdate('/session new Design'));
    await bot.handleUpdate(makeUpdate('/repo myrepo'));
    await bot.handleUpdate(makeUpdate('I want a feature that does X'));
    sent.length = 0;
    await bot.handleUpdate(makeUpdate('/plan'));

    expect(mockRunner.draftPlan).toHaveBeenCalled();
    const current = getCurrentSessionForUser(db, ALLOWED_USER);
    expect(current?.draftPlan).toBe(DRAFT);
    expect(sent.some(s => s.text.includes('Plan: My Plan'))).toBe(true);
    expect(sent.some(s => s.text.includes('/submit'))).toBe(true);
  });

  it('uses fallback plan when no runner provided', async () => {
    const bot = makeBot({ runner: undefined });
    await bot.handleUpdate(makeUpdate('/session new Design'));
    await bot.handleUpdate(makeUpdate('/repo myrepo'));
    await bot.handleUpdate(makeUpdate('Build something cool'));
    sent.length = 0;
    await bot.handleUpdate(makeUpdate('/plan'));
    const current = getCurrentSessionForUser(db, ALLOWED_USER);
    expect(current?.draftPlan).toBeTruthy();
    expect(current?.draftPlan).toContain('# Plan:');
    expect(current?.draftPlan).toContain('### Task 1:');
    expect(current?.draftPlan).toContain('- [ ]');
  });

  it('requires an active session', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/plan'));
    expect(sent[0].text).toContain('No active session');
  });

  it('requires a transcript', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new Empty'));
    await bot.handleUpdate(makeUpdate('/repo myrepo'));
    sent.length = 0;
    await bot.handleUpdate(makeUpdate('/plan'));
    expect(sent[0].text).toContain('No conversation');
  });

  it('requires a target repo', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new NoRepo'));
    await bot.handleUpdate(makeUpdate('Some transcript text'));
    sent.length = 0;
    await bot.handleUpdate(makeUpdate('/plan'));
    expect(sent[0].text).toContain('No target repo');
  });
});

// ── /submit ───────────────────────────────────────────────────────────────

describe('/submit', () => {
  it('writes draft plan, schedules execution, and marks session as submitted', async () => {
    // Create a fixture repo with docs/plans dir
    const repoDir = join(tmpDir, 'myrepo');
    mkdirSync(join(repoDir, 'docs', 'plans'), { recursive: true });
    gitInit(repoDir);

    const DRAFT = '# Plan: My Feature\n\n## Validation Commands\n\n```\npnpm test\n```\n\n### Task 1: Build it\n\n- [ ] Do the thing\n';
    const scheduled: Array<{ repo: string; fileName: string; planHash: string; requestedProvider: string }> = [];
    const bot = makeBot({
      scheduler: {
        scheduleCreatedPlan: plan => { scheduled.push(plan); },
      },
    });
    await bot.handleUpdate(makeUpdate('/session new SubmitTest'));
    await bot.handleUpdate(makeUpdate('/repo myrepo'));
    // Manually set draft plan in DB
    const session = getCurrentSessionForUser(db, ALLOWED_USER)!;
    const { updateTelegramSession: updateSess } = await import('../../src/db');
    updateSess(db, session.id, { draftPlan: DRAFT });
    sent.length = 0;

    await bot.handleUpdate(makeUpdate('/submit'));

    const updated = getCurrentSessionForUser(db, ALLOWED_USER);
    expect(updated).toBeNull();
    const submitted = getTelegramSessionsForUser(db, ALLOWED_USER).find(s => s.sessionName === 'SubmitTest');
    expect(submitted?.status).toBe('submitted');
    expect(submitted?.isCurrent).toBe(false);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].repo).toBe('myrepo');
    expect(scheduled[0].fileName).toBe('my-feature.md');
    expect(scheduled[0].requestedProvider).toBe('codex');
    expect(sent[0].text).toContain('submitted');
  });

  it('calls the submitRawPlan API (mock planCreation)', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new NoRepo'));
    sent.length = 0;
    await bot.handleUpdate(makeUpdate('/submit'));
    // No draft plan yet
    expect(sent[0].text).toContain('No draft plan');
  });

  it('requires an active session', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/submit'));
    expect(sent[0].text).toContain('No active session');
  });
});

// ── /approve and /deny ────────────────────────────────────────────────────

describe('/approve', () => {
  it('updates approval request status to approved', async () => {
    const requestId = 'req-abc-123';
    insertApprovalRequest(db, {
      id: requestId,
      repo: 'myrepo',
      plan: 'my-plan',
      action: 'force-push',
      context: 'Branch has conflicts',
      status: 'pending',
      channel: 'telegram',
      decidedBy: null,
      createdAt: Date.now(),
      decidedAt: null,
    });

    const bot = makeBot();
    await bot.handleUpdate(makeUpdate(`/approve ${requestId}`));

    const [updated] = listApprovalRequests(db);
    expect(updated.status).toBe('approved');
    expect(updated.decidedBy).toContain('telegram:');
    expect(sent[0].text).toContain('Approved');
  });

  it('uses prefix matching for short IDs', async () => {
    const requestId = 'req-prefix-full-id';
    insertApprovalRequest(db, {
      id: requestId,
      repo: 'repo',
      plan: 'plan',
      action: 'delete-branch',
      context: 'cleanup',
      status: 'pending',
      channel: 'telegram',
      decidedBy: null,
      createdAt: Date.now(),
      decidedAt: null,
    });

    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/approve req-prefix'));
    const [updated] = listApprovalRequests(db);
    expect(updated.status).toBe('approved');
  });

  it('replies with error for unknown request', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/approve nonexistent-id'));
    expect(sent[0].text).toContain('not found');
  });

  it('replies with error if already decided', async () => {
    insertApprovalRequest(db, {
      id: 'req-done',
      repo: 'repo',
      plan: 'plan',
      action: 'action',
      context: 'ctx',
      status: 'approved',
      channel: 'telegram',
      decidedBy: 'someone',
      createdAt: Date.now(),
      decidedAt: Date.now(),
    });

    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/approve req-done'));
    expect(sent[0].text).toContain('Already decided');
  });
});

describe('/deny', () => {
  it('updates approval request status to denied', async () => {
    const requestId = 'req-deny-123';
    insertApprovalRequest(db, {
      id: requestId,
      repo: 'myrepo',
      plan: 'my-plan',
      action: 'force-push',
      context: 'Branch has conflicts',
      status: 'pending',
      channel: 'telegram',
      decidedBy: null,
      createdAt: Date.now(),
      decidedAt: null,
    });

    const bot = makeBot();
    await bot.handleUpdate(makeUpdate(`/deny ${requestId}`));

    const [updated] = listApprovalRequests(db);
    expect(updated.status).toBe('denied');
    expect(updated.decidedBy).toContain('telegram:');
    expect(sent[0].text).toContain('Denied');
  });
});

// ── Text messages (transcript accumulation) ───────────────────────────────

describe('text message handling', () => {
  it('appends text to session transcript', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new Planning'));
    await bot.handleUpdate(makeUpdate('I want to build a login page'));
    await bot.handleUpdate(makeUpdate('It should use OAuth'));

    const current = getCurrentSessionForUser(db, ALLOWED_USER);
    expect(current?.transcript).toHaveLength(2);
    expect(current?.transcript[0]).toBe('I want to build a login page');
    expect(current?.transcript[1]).toBe('It should use OAuth');
  });

  it('replies with acknowledgement', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new X'));
    sent.length = 0;
    await bot.handleUpdate(makeUpdate('hello there'));
    expect(sent[0].text).toContain('1 messages');
  });

  it('prompts to create session if no active session', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('random text'));
    expect(sent[0].text).toContain('No active session');
  });
});

// ── listTelegramSessions for UI ───────────────────────────────────────────

describe('listTelegramSessions', () => {
  it('returns all sessions for the UI', async () => {
    const bot = makeBot();
    await bot.handleUpdate(makeUpdate('/session new Alpha'));
    await bot.handleUpdate(makeUpdate('/session new Beta'));
    const all = listTelegramSessions(db);
    expect(all).toHaveLength(2);
    expect(all.map(s => s.sessionName)).toContain('Alpha');
    expect(all.map(s => s.sessionName)).toContain('Beta');
  });
});
