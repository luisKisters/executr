import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyExecution,
  findRelatedProcess,
  claudeProjectSlug,
  readPlanStatus,
  readProgressLogTail,
  getProgressFileMtime,
  readCodexAttemptClassification,
  findLatestTranscriptMtime,
  collectObservationContext,
  ObserverPoller,
  type ObservationContext,
  type ProcessEntry,
} from '../../src/observer';
import { openDatabase, insertExecution, getRunningExecutions, updateExecutionClassification } from '../../src/db';

const NOW = 1_700_000_000_000;
const AGE_10MIN = 10 * 60 * 1000;
const AGE_1MIN = 1 * 60 * 1000;

// ── Helpers ────────────────────────────────────────────────────────────────

function baseCtx(overrides: Partial<ObservationContext> = {}): ObservationContext {
  return {
    repo: 'myrepo',
    planSlug: 'my-plan',
    provider: 'claude-code',
    createdAtMs: NOW - AGE_10MIN,
    nowMs: NOW,
    hasActiveProcess: false,
    latestTranscriptMtimeMs: null,
    latestProgressMtimeMs: null,
    progressLogTail: '',
    planStatus: 'none',
    codexAttemptClassification: null,
    hasDirtyTree: false,
    hasDirtySourceFiles: false,
    ...overrides,
  };
}

// ── classifyExecution unit tests ───────────────────────────────────────────

describe('classifyExecution — completed plan', () => {
  it('returns healthy for completed plan-state', () => {
    expect(classifyExecution(baseCtx({ planStatus: 'completed' }))).toBe('healthy');
  });

  it('returns healthy for completed plan even with active process', () => {
    expect(classifyExecution(baseCtx({ planStatus: 'completed', hasActiveProcess: true }))).toBe('healthy');
  });
});

describe('classifyExecution — no active process', () => {
  it('returns dead_loop for failed plan with no process', () => {
    expect(classifyExecution(baseCtx({ planStatus: 'failed' }))).toBe('dead_loop');
  });

  it('returns dead_loop for old none-status with no process', () => {
    expect(classifyExecution(baseCtx({ planStatus: 'none', createdAtMs: NOW - AGE_10MIN }))).toBe('dead_loop');
  });

  it('returns healthy for fresh execution with no process (just queued)', () => {
    expect(classifyExecution(baseCtx({ planStatus: 'none', createdAtMs: NOW - AGE_1MIN }))).toBe('healthy');
  });
});

describe('classifyExecution — progress log signals', () => {
  it('returns rate_limited on rate limit in log', () => {
    expect(classifyExecution(baseCtx({ progressLogTail: 'Error: rate limit exceeded', hasActiveProcess: true }))).toBe('rate_limited');
  });

  it('returns rate_limited on 429 in log', () => {
    expect(classifyExecution(baseCtx({ progressLogTail: 'HTTP 429 too many requests', hasActiveProcess: true }))).toBe('rate_limited');
  });

  it('returns rate_limited on quota exceeded in log', () => {
    expect(classifyExecution(baseCtx({ progressLogTail: 'quota exceeded for model', hasActiveProcess: true }))).toBe('rate_limited');
  });

  it('returns auth_missing on auth missing in log', () => {
    expect(classifyExecution(baseCtx({ progressLogTail: 'auth missing: no valid api key', hasActiveProcess: true }))).toBe('auth_missing');
  });

  it('returns auth_missing on openai_api_key in log', () => {
    expect(classifyExecution(baseCtx({ progressLogTail: 'openai_api_key is not set', hasActiveProcess: true }))).toBe('auth_missing');
  });

  it('returns failed_finalize on push failed in log', () => {
    expect(classifyExecution(baseCtx({ progressLogTail: 'git push failed: non-fast-forward', hasActiveProcess: true }))).toBe('failed_finalize');
  });

  it('returns failed_finalize on failed_finalize keyword in log', () => {
    expect(classifyExecution(baseCtx({ progressLogTail: 'status: failed_finalize', hasActiveProcess: true }))).toBe('failed_finalize');
  });

  it('returns tool_missing on command not found in log', () => {
    expect(classifyExecution(baseCtx({ progressLogTail: 'command not found: ralphex', hasActiveProcess: true }))).toBe('tool_missing');
  });
});

describe('classifyExecution — known_startup_stall (must NEVER recommend kill)', () => {
  it('returns known_startup_stall for claude-code with no transcript and age > 5 min', () => {
    const signal = classifyExecution(baseCtx({
      provider: 'claude-code',
      hasActiveProcess: true,
      latestTranscriptMtimeMs: null,
      createdAtMs: NOW - 6 * 60 * 1000, // 6 min old
    }));
    expect(signal).toBe('known_startup_stall');
  });

  it('does NOT return known_startup_stall for claude-code within warmup period', () => {
    const signal = classifyExecution(baseCtx({
      provider: 'claude-code',
      hasActiveProcess: true,
      latestTranscriptMtimeMs: null,
      createdAtMs: NOW - 2 * 60 * 1000, // only 2 min old
    }));
    // Should be long_running_but_active (still in warmup)
    expect(signal).toBe('long_running_but_active');
  });

  it('does NOT return known_startup_stall if transcript exists', () => {
    const signal = classifyExecution(baseCtx({
      provider: 'claude-code',
      hasActiveProcess: true,
      latestTranscriptMtimeMs: NOW - 60_000, // written 1 min ago
      createdAtMs: NOW - AGE_10MIN,
    }));
    expect(signal).not.toBe('known_startup_stall');
  });

  it('does NOT recommend kill — classification is purely informational', () => {
    // The classifier returns known_startup_stall; it is the CALLER (Task 9) that
    // decides on actions. We verify here that the classifier itself never returns
    // an action-implying signal for this state.
    const signal = classifyExecution(baseCtx({
      provider: 'claude-code',
      hasActiveProcess: true,
      latestTranscriptMtimeMs: null,
      createdAtMs: NOW - 35 * 60 * 1000, // 35 min — past the 30m self-heal threshold
    }));
    // Must still be known_startup_stall, not dead_loop or anything that implies a kill
    expect(signal).toBe('known_startup_stall');
    expect(signal).not.toBe('dead_loop');
  });
});

describe('classifyExecution — long_running_but_active', () => {
  it('returns long_running_but_active with recent transcript', () => {
    expect(classifyExecution(baseCtx({
      hasActiveProcess: true,
      latestTranscriptMtimeMs: NOW - 60_000,
    }))).toBe('long_running_but_active');
  });

  it('returns long_running_but_active with recent progress', () => {
    expect(classifyExecution(baseCtx({
      hasActiveProcess: true,
      latestProgressMtimeMs: NOW - 60_000,
    }))).toBe('long_running_but_active');
  });

  it('returns long_running_but_active with active process even if quiet', () => {
    expect(classifyExecution(baseCtx({
      hasActiveProcess: true,
      // no transcript, no progress, but within warmup period
      createdAtMs: NOW - AGE_1MIN,
    }))).toBe('long_running_but_active');
  });
});

describe('classifyExecution — dirty_tree_blocked', () => {
  it('returns dirty_tree_blocked when source files are dirty and process is active', () => {
    expect(classifyExecution(baseCtx({
      hasActiveProcess: true,
      hasDirtyTree: true,
      hasDirtySourceFiles: true,
    }))).toBe('dirty_tree_blocked');
  });

  it('does NOT return dirty_tree_blocked for runtime-only dirty tree', () => {
    const signal = classifyExecution(baseCtx({
      hasActiveProcess: true,
      hasDirtyTree: true,
      hasDirtySourceFiles: false, // only runtime files
      latestProgressMtimeMs: NOW - 60_000,
    }));
    expect(signal).not.toBe('dirty_tree_blocked');
  });
});

describe('classifyExecution — codex provider', () => {
  it('uses codexAttemptClassification when available', () => {
    expect(classifyExecution(baseCtx({
      provider: 'codex',
      hasActiveProcess: false,
      codexAttemptClassification: 'rate_limited',
    }))).toBe('rate_limited');
  });

  it('falls back to dead_loop for failed codex with no attempt result', () => {
    expect(classifyExecution(baseCtx({
      provider: 'codex',
      planStatus: 'failed',
      hasActiveProcess: false,
      codexAttemptClassification: null,
    }))).toBe('dead_loop');
  });

  it('returns healthy for completed codex plan', () => {
    expect(classifyExecution(baseCtx({
      provider: 'codex',
      planStatus: 'completed',
      codexAttemptClassification: 'healthy',
    }))).toBe('healthy');
  });
});

// ── findRelatedProcess ─────────────────────────────────────────────────────

describe('findRelatedProcess', () => {
  const processes: ProcessEntry[] = [
    { pid: 1, cmd: 'fya --plan docs/plans/my-plan.md', cwd: '/workspace/myrepo' },
    { pid: 2, cmd: 'node dist/index.js', cwd: '/workspace/executr' },
    { pid: 3, cmd: 'ralphex docs/plans/other.md', cwd: '/workspace/otherrepo' },
    { pid: 4, cmd: 'claude --version', cwd: null },
  ];

  it('finds fya process by cwd and keyword', () => {
    const p = findRelatedProcess(processes, '/workspace/myrepo');
    expect(p?.pid).toBe(1);
  });

  it('does not match process in different repo', () => {
    const p = findRelatedProcess(processes, '/workspace/myrepo');
    expect(p?.pid).not.toBe(3);
  });

  it('returns null when no matching process', () => {
    expect(findRelatedProcess(processes, '/workspace/norepo')).toBeNull();
  });

  it('does not match non-agent process', () => {
    expect(findRelatedProcess(processes, '/workspace/executr')).toBeNull();
  });
});

// ── claudeProjectSlug ──────────────────────────────────────────────────────

describe('claudeProjectSlug', () => {
  it('converts /workspace/myrepo to -workspace-myrepo', () => {
    expect(claudeProjectSlug('/workspace/myrepo')).toBe('-workspace-myrepo');
  });

  it('converts /workspace/foo/bar to -workspace-foo-bar', () => {
    expect(claudeProjectSlug('/workspace/foo/bar')).toBe('-workspace-foo-bar');
  });
});

// ── Filesystem helpers ─────────────────────────────────────────────────────

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'observer-test-'));
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('readPlanStatus', () => {
  it('returns none when status file missing', () => {
    const repoPath = join(tmpRoot, 'repo-status-none');
    mkdirSync(join(repoPath, '.ralphex', 'plan-state'), { recursive: true });
    expect(readPlanStatus(repoPath, 'my-plan')).toBe('none');
  });

  it('returns completed when status file contains completed', () => {
    const repoPath = join(tmpRoot, 'repo-status-done');
    mkdirSync(join(repoPath, '.ralphex', 'plan-state'), { recursive: true });
    writeFileSync(join(repoPath, '.ralphex', 'plan-state', 'my-plan.md_.status'), 'completed');
    expect(readPlanStatus(repoPath, 'my-plan')).toBe('completed');
  });

  it('returns failed when status file contains failed', () => {
    const repoPath = join(tmpRoot, 'repo-status-fail');
    mkdirSync(join(repoPath, '.ralphex', 'plan-state'), { recursive: true });
    writeFileSync(join(repoPath, '.ralphex', 'plan-state', 'my-plan.md_.status'), 'failed');
    expect(readPlanStatus(repoPath, 'my-plan')).toBe('failed');
  });
});

describe('readProgressLogTail', () => {
  it('returns empty string when file missing', () => {
    const repoPath = join(tmpRoot, 'repo-progress-none');
    expect(readProgressLogTail(repoPath, 'my-plan')).toBe('');
  });

  it('returns last lines of progress log', () => {
    const repoPath = join(tmpRoot, 'repo-progress-ok');
    mkdirSync(join(repoPath, '.ralphex', 'progress'), { recursive: true });
    writeFileSync(
      join(repoPath, '.ralphex', 'progress', 'progress-my-plan.txt'),
      'line1\nline2\nline3\n'
    );
    const tail = readProgressLogTail(repoPath, 'my-plan');
    expect(tail).toContain('line3');
  });
});

describe('getProgressFileMtime', () => {
  it('returns null when file missing', () => {
    expect(getProgressFileMtime(join(tmpRoot, 'no-repo'), 'no-plan')).toBeNull();
  });

  it('returns mtime when file exists', () => {
    const repoPath = join(tmpRoot, 'repo-mtime');
    mkdirSync(join(repoPath, '.ralphex', 'progress'), { recursive: true });
    writeFileSync(join(repoPath, '.ralphex', 'progress', 'progress-myplan.txt'), 'data');
    const mtime = getProgressFileMtime(repoPath, 'myplan');
    expect(typeof mtime).toBe('number');
    expect(mtime).toBeGreaterThan(0);
  });
});

describe('readCodexAttemptClassification', () => {
  it('returns null when file missing', () => {
    expect(readCodexAttemptClassification(join(tmpRoot, 'no-repo'), 'no-plan')).toBeNull();
  });

  it('returns classification from attempt JSON', () => {
    const repoPath = join(tmpRoot, 'repo-codex-attempt');
    mkdirSync(join(repoPath, '.ralphex'), { recursive: true });
    writeFileSync(
      join(repoPath, '.ralphex', 'attempt-my-plan.json'),
      JSON.stringify({ classification: 'rate_limited', status: 'failed' })
    );
    expect(readCodexAttemptClassification(repoPath, 'my-plan')).toBe('rate_limited');
  });

  it('returns null for malformed JSON', () => {
    const repoPath = join(tmpRoot, 'repo-codex-bad');
    mkdirSync(join(repoPath, '.ralphex'), { recursive: true });
    writeFileSync(join(repoPath, '.ralphex', 'attempt-bad.json'), 'not-json');
    expect(readCodexAttemptClassification(repoPath, 'bad')).toBeNull();
  });
});

describe('findLatestTranscriptMtime', () => {
  it('returns null when project dir missing', () => {
    expect(findLatestTranscriptMtime('/nonexistent', '/workspace/myrepo')).toBeNull();
  });

  it('returns mtime of most recent jsonl file', () => {
    const homeDir = join(tmpRoot, 'home-transcript');
    const projectDir = join(homeDir, '.claude', 'projects', '-workspace-myrepo');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'session1.jsonl'), '{}');
    const mtime = findLatestTranscriptMtime(homeDir, '/workspace/myrepo');
    expect(mtime).not.toBeNull();
    expect(typeof mtime).toBe('number');
  });

  it('returns null when project dir exists but has no jsonl files', () => {
    const homeDir = join(tmpRoot, 'home-empty-transcript');
    const projectDir = join(homeDir, '.claude', 'projects', '-workspace-myrepo');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'not-a-transcript.txt'), 'data');
    expect(findLatestTranscriptMtime(homeDir, '/workspace/myrepo')).toBeNull();
  });
});

// ── collectObservationContext ──────────────────────────────────────────────

describe('collectObservationContext', () => {
  it('collects context from fixture filesystem', () => {
    const workspaceRoot = join(tmpRoot, 'ws-collect');
    const repoPath = join(workspaceRoot, 'testrepo');
    mkdirSync(join(repoPath, '.ralphex', 'plan-state'), { recursive: true });
    mkdirSync(join(repoPath, '.ralphex', 'progress'), { recursive: true });
    writeFileSync(join(repoPath, '.ralphex', 'plan-state', 'my-plan.md_.status'), 'completed');
    writeFileSync(
      join(repoPath, '.ralphex', 'progress', 'progress-my-plan.txt'),
      'Task 1 done\n'
    );

    const fakeExecution = {
      id: 1,
      repo: 'testrepo',
      planFile: 'my-plan.md',
      planHash: 'abc123',
      attemptId: 'att-1',
      providerRequested: 'claude-code' as const,
      providerUsed: 'claude-code' as const,
      model: null,
      branch: null,
      worktree: null,
      status: 'running' as const,
      latestProgressTs: null,
      latestTranscriptTs: null,
      rateLimitCooldownUntil: null,
      lastRecoveryAction: null,
      classification: null,
      createdAt: NOW - AGE_10MIN,
      updatedAt: NOW - AGE_10MIN,
    };

    const ctx = collectObservationContext(fakeExecution, {
      workspaceRoot,
      homeDir: join(tmpRoot, 'home-nonexistent'),
      processes: [],
      nowMs: NOW,
    });

    expect(ctx.repo).toBe('testrepo');
    expect(ctx.planSlug).toBe('my-plan');
    expect(ctx.planStatus).toBe('completed');
    expect(ctx.hasActiveProcess).toBe(false);
    expect(ctx.progressLogTail).toContain('Task 1 done');
  });
});

// ── DB helpers ────────────────────────────────────────────────────────────

describe('getRunningExecutions and updateExecutionClassification', () => {
  it('getRunningExecutions returns only running rows', () => {
    const dbPath = join(tmpRoot, 'obs-db-test.db');
    const db = openDatabase(dbPath);

    insertExecution(db, {
      repo: 'r1', planFile: 'p1.md', planHash: 'h1', attemptId: 'a1',
      providerRequested: 'claude-code', providerUsed: null, model: null,
      branch: null, worktree: null, status: 'running',
      latestProgressTs: null, latestTranscriptTs: null,
      rateLimitCooldownUntil: null, lastRecoveryAction: null,
      classification: null, createdAt: NOW, updatedAt: NOW,
    });
    insertExecution(db, {
      repo: 'r2', planFile: 'p2.md', planHash: 'h2', attemptId: 'a2',
      providerRequested: 'claude-code', providerUsed: null, model: null,
      branch: null, worktree: null, status: 'completed',
      latestProgressTs: null, latestTranscriptTs: null,
      rateLimitCooldownUntil: null, lastRecoveryAction: null,
      classification: 'healthy', createdAt: NOW, updatedAt: NOW,
    });

    const running = getRunningExecutions(db);
    expect(running).toHaveLength(1);
    expect(running[0].attemptId).toBe('a1');
    db.close();
  });

  it('updateExecutionClassification updates classification and timestamps', () => {
    const dbPath = join(tmpRoot, 'obs-db-update.db');
    const db = openDatabase(dbPath);

    insertExecution(db, {
      repo: 'r1', planFile: 'p1.md', planHash: 'h1', attemptId: 'att-upd',
      providerRequested: 'claude-code', providerUsed: null, model: null,
      branch: null, worktree: null, status: 'running',
      latestProgressTs: null, latestTranscriptTs: null,
      rateLimitCooldownUntil: null, lastRecoveryAction: null,
      classification: null, createdAt: NOW, updatedAt: NOW,
    });

    updateExecutionClassification(db, 'att-upd', 'known_startup_stall', 1000, 2000);

    const rows = getRunningExecutions(db);
    expect(rows[0].classification).toBe('known_startup_stall');
    expect(rows[0].latestProgressTs).toBe(1000);
    expect(rows[0].latestTranscriptTs).toBe(2000);
    db.close();
  });

  it('updateExecutionClassification works with only classification (no timestamps)', () => {
    const dbPath = join(tmpRoot, 'obs-db-update2.db');
    const db = openDatabase(dbPath);

    insertExecution(db, {
      repo: 'r1', planFile: 'p1.md', planHash: 'h1', attemptId: 'att-upd2',
      providerRequested: 'claude-code', providerUsed: null, model: null,
      branch: null, worktree: null, status: 'running',
      latestProgressTs: null, latestTranscriptTs: null,
      rateLimitCooldownUntil: null, lastRecoveryAction: null,
      classification: null, createdAt: NOW, updatedAt: NOW,
    });

    updateExecutionClassification(db, 'att-upd2', 'dead_loop');

    const rows = getRunningExecutions(db);
    expect(rows[0].classification).toBe('dead_loop');
    db.close();
  });
});

// ── ObserverPoller integration ────────────────────────────────────────────

describe('ObserverPoller', () => {
  it('polls and updates classification for running executions', () => {
    const workspaceRoot = join(tmpRoot, 'ws-poller');
    const repoPath = join(workspaceRoot, 'pollrepo');
    mkdirSync(join(repoPath, '.ralphex', 'plan-state'), { recursive: true });
    mkdirSync(join(repoPath, '.ralphex', 'progress'), { recursive: true });
    // Completed plan
    writeFileSync(join(repoPath, '.ralphex', 'plan-state', 'poll-plan.md_.status'), 'completed');

    const dbPath = join(tmpRoot, 'poller-db.db');
    const db = openDatabase(dbPath);

    insertExecution(db, {
      repo: 'pollrepo', planFile: 'poll-plan.md', planHash: 'ph1', attemptId: 'poll-att1',
      providerRequested: 'claude-code', providerUsed: 'claude-code', model: null,
      branch: null, worktree: null, status: 'running',
      latestProgressTs: null, latestTranscriptTs: null,
      rateLimitCooldownUntil: null, lastRecoveryAction: null,
      classification: null, createdAt: NOW - AGE_10MIN, updatedAt: NOW - AGE_10MIN,
    });

    const poller = new ObserverPoller(db, {
      workspaceRoot,
      homeDir: join(tmpRoot, 'home-nop'),
      intervalMs: 60_000, // large interval, we'll poll manually
    });

    poller.poll();

    const rows = getRunningExecutions(db);
    // completed plan → healthy
    expect(rows[0].classification).toBe('healthy');

    db.close();
  });

  it('start/stop does not throw', () => {
    const dbPath = join(tmpRoot, 'poller-ss.db');
    const db = openDatabase(dbPath);
    const poller = new ObserverPoller(db, {
      workspaceRoot: tmpRoot,
      intervalMs: 999_999,
    });
    expect(() => poller.start()).not.toThrow();
    expect(() => poller.stop()).not.toThrow();
    db.close();
  });
});
