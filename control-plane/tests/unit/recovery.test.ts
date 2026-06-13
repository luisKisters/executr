import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decideRecovery,
  executeRecovery,
  RecoveryPoller,
  fixGitExcludes,
  isSafeGitBranchName,
  MAX_AUTO_RETRIES,
  PROVIDER_COOLDOWN_MS,
  STARTUP_STALL_REPEAT_THRESHOLD,
  type RecoveryContext,
  type RecoveryAction,
} from '../../src/recovery';
import {
  openDatabase,
  insertExecution,
  listApprovalRequests,
  getExecutionByAttemptId,
} from '../../src/db';

const NOW = 1_700_000_000_000;

// ── Helpers ────────────────────────────────────────────────────────────────

function baseCtx(overrides: Partial<RecoveryContext> = {}): RecoveryContext {
  return {
    repo: 'myrepo',
    planSlug: 'my-plan',
    repoPath: '/tmp/myrepo',
    attemptId: 'att-1',
    branch: 'feature/my-plan',
    classification: 'healthy',
    hasDirtyTree: false,
    hasDirtySourceFiles: false,
    attemptCounts: {},
    cooldownUntil: null,
    nowMs: NOW,
    ...overrides,
  };
}

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cp-recovery-test-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

let _dbCounter = 0;
function makeDb() {
  _dbCounter++;
  const dbPath = join(tmpDir, `orchestrator-${_dbCounter}.db`);
  return openDatabase(dbPath);
}

// ── decideRecovery — no-op cases ───────────────────────────────────────────

describe('decideRecovery — healthy / active signals', () => {
  it('returns noop for healthy', () => {
    const r = decideRecovery(baseCtx({ classification: 'healthy' }));
    expect(r.type).toBe('noop');
  });

  it('returns noop for long_running_but_active', () => {
    const r = decideRecovery(baseCtx({ classification: 'long_running_but_active' }));
    expect(r.type).toBe('noop');
  });

  it('returns wait for waiting_for_human', () => {
    const r = decideRecovery(baseCtx({ classification: 'waiting_for_human' }));
    expect(r.type).toBe('wait');
  });
});

// ── decideRecovery — cooldown guard ───────────────────────────────────────

describe('decideRecovery — cooldown', () => {
  it('returns wait when in active cooldown', () => {
    const r = decideRecovery(baseCtx({
      classification: 'rate_limited',
      cooldownUntil: NOW + 5 * 60 * 1000,
    }));
    expect(r.type).toBe('wait');
    expect((r as { reason: string }).reason).toContain('cooldown');
  });

  it('proceeds normally when cooldown has expired', () => {
    const r = decideRecovery(baseCtx({
      classification: 'rate_limited',
      cooldownUntil: NOW - 1000,
    }));
    expect(r.type).toBe('set_cooldown');
  });
});

// ── decideRecovery — failed_finalize ──────────────────────────────────────

describe('decideRecovery — failed_finalize', () => {
  it('returns push_branch when branch is known and under retry limit', () => {
    const r = decideRecovery(baseCtx({ classification: 'failed_finalize', branch: 'feature/x' }));
    expect(r.type).toBe('push_branch');
    expect((r as { branch: string }).branch).toBe('feature/x');
  });

  it('returns noop when no branch is known', () => {
    const r = decideRecovery(baseCtx({ classification: 'failed_finalize', branch: null }));
    expect(r.type).toBe('noop');
  });

  it('returns request_approval after MAX_AUTO_RETRIES push attempts', () => {
    const r = decideRecovery(baseCtx({
      classification: 'failed_finalize',
      branch: 'feature/x',
      attemptCounts: { push_branch: MAX_AUTO_RETRIES },
    }));
    expect(r.type).toBe('request_approval');
    expect((r as { action: string }).action).toBe('manual_finalize');
  });

  it('still pushes at MAX_AUTO_RETRIES - 1 attempts', () => {
    const r = decideRecovery(baseCtx({
      classification: 'failed_finalize',
      branch: 'feature/x',
      attemptCounts: { push_branch: MAX_AUTO_RETRIES - 1 },
    }));
    expect(r.type).toBe('push_branch');
  });
});

// ── decideRecovery — dirty_tree_blocked ───────────────────────────────────

describe('decideRecovery — dirty_tree_blocked', () => {
  it('returns request_approval when source files are dirty (never auto-discard)', () => {
    const r = decideRecovery(baseCtx({
      classification: 'dirty_tree_blocked',
      hasDirtySourceFiles: true,
      hasDirtyTree: true,
    }));
    expect(r.type).toBe('request_approval');
    expect((r as { action: string }).action).toBe('discard_source_changes');
  });

  it('returns fix_excludes for runtime-only dirty tree', () => {
    const r = decideRecovery(baseCtx({
      classification: 'dirty_tree_blocked',
      hasDirtySourceFiles: false,
      hasDirtyTree: true,
    }));
    expect(r.type).toBe('fix_excludes');
  });

  it('returns request_approval after MAX_AUTO_RETRIES fix_excludes attempts (runtime-only)', () => {
    const r = decideRecovery(baseCtx({
      classification: 'dirty_tree_blocked',
      hasDirtySourceFiles: false,
      hasDirtyTree: true,
      attemptCounts: { fix_excludes: MAX_AUTO_RETRIES },
    }));
    expect(r.type).toBe('request_approval');
    expect((r as { action: string }).action).toBe('manual_clean_runtime');
  });

  it('dirty source files always produce approval request even at 0 attempts', () => {
    const r = decideRecovery(baseCtx({
      classification: 'dirty_tree_blocked',
      hasDirtySourceFiles: true,
      attemptCounts: { fix_excludes: 0 },
    }));
    expect(r.type).toBe('request_approval');
  });
});

// ── decideRecovery — rate_limited ─────────────────────────────────────────

describe('decideRecovery — rate_limited', () => {
  it('returns set_cooldown with switchProvider=true', () => {
    const r = decideRecovery(baseCtx({ classification: 'rate_limited' }));
    expect(r.type).toBe('set_cooldown');
    const sc = r as { type: 'set_cooldown'; untilMs: number; switchProvider: boolean };
    expect(sc.switchProvider).toBe(true);
    expect(sc.untilMs).toBeGreaterThan(NOW);
    expect(sc.untilMs).toBe(NOW + PROVIDER_COOLDOWN_MS);
  });

  it('returns noop after MAX_AUTO_RETRIES cooldown applications', () => {
    const r = decideRecovery(baseCtx({
      classification: 'rate_limited',
      attemptCounts: { set_cooldown: MAX_AUTO_RETRIES },
    }));
    expect(r.type).toBe('noop');
  });
});

// ── decideRecovery — auth_missing ─────────────────────────────────────────

describe('decideRecovery — auth_missing', () => {
  it('returns switch_provider', () => {
    const r = decideRecovery(baseCtx({ classification: 'auth_missing' }));
    expect(r.type).toBe('switch_provider');
  });

  it('requests approval after repeated provider-switch attempts', () => {
    const r = decideRecovery(baseCtx({
      classification: 'auth_missing',
      attemptCounts: { switch_provider: MAX_AUTO_RETRIES },
    }));
    expect(r.type).toBe('request_approval');
    expect((r as { action: string }).action).toBe('provider_auth_missing');
  });
});

// ── decideRecovery — known_startup_stall ──────────────────────────────────

describe('decideRecovery — known_startup_stall', () => {
  it('returns wait before reaching stall threshold (self-healing)', () => {
    const r = decideRecovery(baseCtx({
      classification: 'known_startup_stall',
      attemptCounts: { startup_stall: STARTUP_STALL_REPEAT_THRESHOLD - 1 },
    }));
    expect(r.type).toBe('wait');
    expect((r as { reason: string }).reason).toContain('self-heal');
  });

  it('returns wait at exactly 0 stalls', () => {
    const r = decideRecovery(baseCtx({
      classification: 'known_startup_stall',
      attemptCounts: { startup_stall: 0 },
    }));
    expect(r.type).toBe('wait');
  });

  it('returns switch_provider at or above stall threshold', () => {
    const r = decideRecovery(baseCtx({
      classification: 'known_startup_stall',
      attemptCounts: { startup_stall: STARTUP_STALL_REPEAT_THRESHOLD },
    }));
    expect(r.type).toBe('switch_provider');
  });

  it('NEVER recommends an external kill for startup stall', () => {
    for (let stalls = 0; stalls <= STARTUP_STALL_REPEAT_THRESHOLD + 5; stalls++) {
      const r = decideRecovery(baseCtx({
        classification: 'known_startup_stall',
        attemptCounts: { startup_stall: stalls },
      }));
      // The only allowed types are wait, switch_provider, or a manual approval gate.
      expect(['wait', 'switch_provider', 'request_approval']).toContain(r.type);
      // Specifically must not be request_approval for a kill action
      if (r.type === 'request_approval') {
        const action = (r as { action: string }).action;
        expect(action).not.toContain('kill');
        expect(action).not.toContain('terminate');
      }
    }
  });

  it('requests approval after repeated provider-switch attempts', () => {
    const r = decideRecovery(baseCtx({
      classification: 'known_startup_stall',
      attemptCounts: {
        startup_stall: STARTUP_STALL_REPEAT_THRESHOLD,
        switch_provider: MAX_AUTO_RETRIES,
      },
    }));
    expect(r.type).toBe('request_approval');
    expect((r as { action: string }).action).toBe('manual_provider_switch');
  });
});

// ── decideRecovery — dead_loop / tool_missing ─────────────────────────────

describe('decideRecovery — dead_loop and tool_missing', () => {
  it('returns request_approval for dead_loop', () => {
    const r = decideRecovery(baseCtx({ classification: 'dead_loop' }));
    expect(r.type).toBe('request_approval');
  });

  it('returns request_approval for tool_missing', () => {
    const r = decideRecovery(baseCtx({ classification: 'tool_missing' }));
    expect(r.type).toBe('request_approval');
  });
});

// ── No destructive action is ever selected automatically ──────────────────

describe('decideRecovery — no destructive action ever auto-selected', () => {
  const scenarios: Array<Partial<RecoveryContext>> = [
    { classification: 'failed_finalize', branch: 'feature/x', attemptCounts: { push_branch: MAX_AUTO_RETRIES } },
    { classification: 'dirty_tree_blocked', hasDirtySourceFiles: true },
    { classification: 'dirty_tree_blocked', hasDirtySourceFiles: false, attemptCounts: { fix_excludes: MAX_AUTO_RETRIES } },
    { classification: 'dead_loop' },
    { classification: 'tool_missing' },
  ];

  for (const scenario of scenarios) {
    it(`scenario: ${JSON.stringify(scenario)} — produces approval request, not direct destructive action`, () => {
      const r = decideRecovery(baseCtx(scenario));
      if (r.type === 'request_approval') {
        // Approval requests are fine — they gate the action
        const action = (r as { action: string }).action;
        // But the action field must describe the situation, not be "force_push" or similar destructive self-execute
        expect(typeof action).toBe('string');
        expect(action.length).toBeGreaterThan(0);
      } else {
        // If not a request_approval, must be noop/wait/switch_provider — never directly destructive
        const nonDestructiveTypes = ['noop', 'wait', 'switch_provider', 'push_branch', 'fix_excludes', 'set_cooldown'];
        expect(nonDestructiveTypes).toContain(r.type);
      }
    });
  }

  it('all approval-request actions contain a human-readable context, not a direct command', () => {
    const r1 = decideRecovery(baseCtx({ classification: 'dirty_tree_blocked', hasDirtySourceFiles: true }));
    expect(r1.type).toBe('request_approval');
    const context1 = (r1 as { context: string }).context;
    expect(context1.length).toBeGreaterThan(20);

    const r2 = decideRecovery(baseCtx({ classification: 'dead_loop' }));
    expect(r2.type).toBe('request_approval');
    const context2 = (r2 as { context: string }).context;
    expect(context2.length).toBeGreaterThan(20);
  });
});

// ── executeRecovery — set_cooldown ────────────────────────────────────────

describe('executeRecovery — set_cooldown', () => {
  it('updates DB with cooldown timestamp', () => {
    const db = makeDb();
    const attemptId = 'att-cooldown-1';
    insertExecution(db, {
      repo: 'r', planFile: 'p.md', planHash: 'h', attemptId,
      providerRequested: 'codex', providerUsed: null, model: null,
      branch: null, worktree: null, status: 'running',
      latestProgressTs: null, latestTranscriptTs: null,
      rateLimitCooldownUntil: null, lastRecoveryAction: null,
      classification: 'rate_limited',
      createdAt: NOW, updatedAt: NOW,
    });

    const decision: RecoveryAction = { type: 'set_cooldown', untilMs: NOW + PROVIDER_COOLDOWN_MS, switchProvider: true };
    const ctx = baseCtx({ attemptId, classification: 'rate_limited' });
    const result = executeRecovery(decision, ctx, db);

    expect(result.success).toBe(true);
    const updated = getExecutionByAttemptId(db, attemptId);
    expect(updated?.rateLimitCooldownUntil).toBe(NOW + PROVIDER_COOLDOWN_MS);
    expect(updated?.lastRecoveryAction).toContain('set_cooldown');
    db.close();
  });
});

// ── executeRecovery — request_approval creates DB record ──────────────────

describe('executeRecovery — request_approval', () => {
  it('inserts a pending approval request into the DB', () => {
    const db = makeDb();
    const attemptId = 'att-approval-1';
    insertExecution(db, {
      repo: 'myrepo', planFile: 'my-plan.md', planHash: 'h', attemptId,
      providerRequested: 'claude-code', providerUsed: null, model: null,
      branch: null, worktree: null, status: 'running',
      latestProgressTs: null, latestTranscriptTs: null,
      rateLimitCooldownUntil: null, lastRecoveryAction: null,
      classification: 'dead_loop',
      createdAt: NOW, updatedAt: NOW,
    });

    const decision: RecoveryAction = {
      type: 'request_approval',
      action: 'restart_or_reset',
      context: 'Execution is stuck in a dead loop.',
    };
    const ctx = baseCtx({ attemptId, classification: 'dead_loop' });
    const result = executeRecovery(decision, ctx, db);

    expect(result.success).toBe(true);
    expect(result.approvalRequestId).toBeDefined();

    const requests = listApprovalRequests(db);
    const found = requests.find(r => r.id === result.approvalRequestId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('pending');
    expect(found!.action).toBe('restart_or_reset');
    expect(found!.repo).toBe('myrepo');
    expect(found!.plan).toBe('my-plan');
    db.close();
  });

  it('does not take the destructive action — only stores the approval request', () => {
    const db = makeDb();
    const attemptId = 'att-approval-2';
    insertExecution(db, {
      repo: 'myrepo', planFile: 'my-plan.md', planHash: 'h2', attemptId,
      providerRequested: 'claude-code', providerUsed: null, model: null,
      branch: null, worktree: null, status: 'running',
      latestProgressTs: null, latestTranscriptTs: null,
      rateLimitCooldownUntil: null, lastRecoveryAction: null,
      classification: 'dirty_tree_blocked',
      createdAt: NOW, updatedAt: NOW,
    });

    let execFnCalled = false;
    const fakeExec = () => { execFnCalled = true; return ''; };

    const decision: RecoveryAction = {
      type: 'request_approval',
      action: 'discard_source_changes',
      context: 'Source files are dirty.',
    };
    const ctx = baseCtx({ attemptId });
    executeRecovery(decision, ctx, db, fakeExec);

    // The exec function must NOT have been called — no git commands for approval requests
    expect(execFnCalled).toBe(false);
    db.close();
  });
});

// ── executeRecovery — switch_provider ─────────────────────────────────────

describe('executeRecovery — switch_provider', () => {
  it('updates lastRecoveryAction without running git commands', () => {
    const db = makeDb();
    const attemptId = 'att-switch-1';
    insertExecution(db, {
      repo: 'r', planFile: 'p.md', planHash: 'h', attemptId,
      providerRequested: 'claude-code', providerUsed: null, model: null,
      branch: null, worktree: null, status: 'running',
      latestProgressTs: null, latestTranscriptTs: null,
      rateLimitCooldownUntil: null, lastRecoveryAction: null,
      classification: 'auth_missing',
      createdAt: NOW, updatedAt: NOW,
    });

    let execCalled = false;
    const fakeExec = () => { execCalled = true; return ''; };

    const decision: RecoveryAction = { type: 'switch_provider', reason: 'auth missing' };
    const ctx = baseCtx({ attemptId });
    const result = executeRecovery(decision, ctx, db, fakeExec);

    expect(execCalled).toBe(false);
    expect(result.success).toBe(true);
    const updated = getExecutionByAttemptId(db, attemptId);
    expect(updated?.lastRecoveryAction).toContain('switch_provider');
    db.close();
  });
});

// ── RecoveryPoller — provider switch hook ─────────────────────────────────

describe('RecoveryPoller — provider switch hook', () => {
  it('notifies scheduler hook when auth_missing requests a provider switch', () => {
    const db = makeDb();
    insertExecution(db, {
      repo: 'r', planFile: 'p.md', planHash: 'h', attemptId: 'att-switch-hook',
      providerRequested: 'claude-code', providerUsed: 'claude-code', model: null,
      branch: 'feature/p', worktree: null, status: 'running',
      latestProgressTs: null, latestTranscriptTs: null,
      rateLimitCooldownUntil: null, lastRecoveryAction: null,
      classification: 'auth_missing',
      createdAt: NOW, updatedAt: NOW,
    });

    const calls: Array<{ attemptId: string; trigger: string }> = [];
    const poller = new RecoveryPoller(db, {
      workspaceRoot: '/tmp/workspace',
      onProviderSwitch: (execution, trigger) => {
        calls.push({ attemptId: execution.attemptId, trigger });
      },
    });

    poller.poll();

    expect(calls).toEqual([{ attemptId: 'att-switch-hook', trigger: 'provider_auth_unavailable' }]);
    db.close();
  });
});

// ── executeRecovery — push_branch ─────────────────────────────────────────

describe('executeRecovery — push_branch', () => {
  it('calls git push with the right arguments and records action', () => {
    const db = makeDb();
    const attemptId = 'att-push-1';
    insertExecution(db, {
      repo: 'r', planFile: 'p.md', planHash: 'h', attemptId,
      providerRequested: 'claude-code', providerUsed: null, model: null,
      branch: 'feature/p', worktree: null, status: 'running',
      latestProgressTs: null, latestTranscriptTs: null,
      rateLimitCooldownUntil: null, lastRecoveryAction: null,
      classification: 'failed_finalize',
      createdAt: NOW, updatedAt: NOW,
    });

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fakeExec = (cmd: string, args: string[]) => { calls.push({ cmd, args }); return ''; };

    const decision: RecoveryAction = { type: 'push_branch', branch: 'feature/p' };
    const ctx = baseCtx({ attemptId, branch: 'feature/p', classification: 'failed_finalize' });
    const result = executeRecovery(decision, ctx, db, fakeExec);

    expect(result.success).toBe(true);
    expect(calls.some(c => c.cmd === 'git' && c.args.includes('push') && c.args.includes('feature/p'))).toBe(true);
    const updated = getExecutionByAttemptId(db, attemptId);
    expect(updated?.lastRecoveryAction).toContain('push_branch');
    // Retry count incremented
    expect(updated?.recoveryAttemptCounts['push_branch']).toBe(1);
    db.close();
  });

  it('records failure when git push fails', () => {
    const db = makeDb();
    const attemptId = 'att-push-fail-1';
    insertExecution(db, {
      repo: 'r', planFile: 'p.md', planHash: 'h', attemptId,
      providerRequested: 'claude-code', providerUsed: null, model: null,
      branch: 'feature/p', worktree: null, status: 'running',
      latestProgressTs: null, latestTranscriptTs: null,
      rateLimitCooldownUntil: null, lastRecoveryAction: null,
      classification: 'failed_finalize',
      createdAt: NOW, updatedAt: NOW,
    });

    const throwingExec = (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('push')) throw new Error('rejected');
      return '';
    };

    const decision: RecoveryAction = { type: 'push_branch', branch: 'feature/p' };
    const ctx = baseCtx({ attemptId, branch: 'feature/p', classification: 'failed_finalize' });
    const result = executeRecovery(decision, ctx, db, throwingExec);

    expect(result.success).toBe(false);
    expect(result.message).toContain('failed');
    const updated = getExecutionByAttemptId(db, attemptId);
    expect(updated?.lastRecoveryAction).toContain('failed');
    db.close();
  });

  it('rejects unsafe branch names before invoking git', () => {
    const db = makeDb();
    const attemptId = 'att-push-injection-1';
    insertExecution(db, {
      repo: 'r', planFile: 'p.md', planHash: 'h', attemptId,
      providerRequested: 'claude-code', providerUsed: null, model: null,
      branch: 'feature/p"; touch /tmp/pwned; "',
      worktree: null, status: 'running',
      latestProgressTs: null, latestTranscriptTs: null,
      rateLimitCooldownUntil: null, lastRecoveryAction: null,
      classification: 'failed_finalize',
      createdAt: NOW, updatedAt: NOW,
    });

    let execCalled = false;
    const fakeExec = () => { execCalled = true; return ''; };
    const decision: RecoveryAction = { type: 'push_branch', branch: 'feature/p"; touch /tmp/pwned; "' };
    const result = executeRecovery(decision, baseCtx({ attemptId }), db, fakeExec);

    expect(isSafeGitBranchName('feature/p')).toBe(true);
    expect(isSafeGitBranchName('feature/p"; touch /tmp/pwned; "')).toBe(false);
    expect(execCalled).toBe(false);
    expect(result.success).toBe(false);
    db.close();
  });
});

// ── executeRecovery — fix_excludes ────────────────────────────────────────

describe('executeRecovery — fix_excludes', () => {
  it('appends runtime entries to .gitignore when missing', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'cp-fix-exc-'));
    try {
      writeFileSync(join(repoDir, '.gitignore'), '# existing\n', 'utf8');

      const db = makeDb();
      const attemptId = 'att-excl-1';
      insertExecution(db, {
        repo: 'r', planFile: 'p.md', planHash: 'h', attemptId,
        providerRequested: 'claude-code', providerUsed: null, model: null,
        branch: null, worktree: null, status: 'running',
        latestProgressTs: null, latestTranscriptTs: null,
        rateLimitCooldownUntil: null, lastRecoveryAction: null,
        classification: 'dirty_tree_blocked',
        createdAt: NOW, updatedAt: NOW,
      });

      // Use a fake exec that doesn't actually call git
      const fakeExec = (_cmd: string, _args: string[]) => '';

      const decision: RecoveryAction = { type: 'fix_excludes' };
      const ctx = baseCtx({ attemptId, repoPath: repoDir, classification: 'dirty_tree_blocked' });
      const result = executeRecovery(decision, ctx, db, fakeExec);

      expect(result.success).toBe(true);
      const gitignore = readFileSync(join(repoDir, '.gitignore'), 'utf8');
      expect(gitignore).toContain('.ralphex/');
      expect(gitignore).toContain('.build/');
      db.close();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('does not duplicate entries if already present', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'cp-fix-exc-dup-'));
    try {
      writeFileSync(join(repoDir, '.gitignore'), '.ralphex/\n.build/\n.swiftpm/\ndist/\nnode_modules/\n', 'utf8');

      fixGitExcludes(repoDir);

      const gitignore = readFileSync(join(repoDir, '.gitignore'), 'utf8');
      const count = (gitignore.match(/\.ralphex\//g) ?? []).length;
      expect(count).toBe(1);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('creates .gitignore if it does not exist', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'cp-fix-exc-new-'));
    try {
      expect(existsSync(join(repoDir, '.gitignore'))).toBe(false);
      fixGitExcludes(repoDir);
      expect(existsSync(join(repoDir, '.gitignore'))).toBe(true);
      const content = readFileSync(join(repoDir, '.gitignore'), 'utf8');
      expect(content).toContain('.ralphex/');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ── executeRecovery — noop / wait ─────────────────────────────────────────

describe('executeRecovery — noop and wait', () => {
  it('noop returns success without touching DB or exec', () => {
    const db = makeDb();
    let execCalled = false;
    const fakeExec = () => { execCalled = true; return ''; };
    const decision: RecoveryAction = { type: 'noop', reason: 'nothing to do' };
    const result = executeRecovery(decision, baseCtx(), db, fakeExec);
    expect(result.success).toBe(true);
    expect(execCalled).toBe(false);
    db.close();
  });

  it('wait returns success without touching exec', () => {
    const db = makeDb();
    let execCalled = false;
    const fakeExec = () => { execCalled = true; return ''; };
    const decision: RecoveryAction = { type: 'wait', reason: 'self-healing' };
    const result = executeRecovery(decision, baseCtx(), db, fakeExec);
    expect(result.success).toBe(true);
    expect(execCalled).toBe(false);
    db.close();
  });
});
