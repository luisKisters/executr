import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  openDatabase,
  insertExecution,
  insertApprovalRequest,
  listExecutions,
  listApprovalRequests,
} from '../../src/db';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cp-db-test-'));
  dbPath = join(tmpDir, '.executr', 'orchestrator.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('creates the database file and parent directories', () => {
    const db = openDatabase(dbPath);
    expect(db).toBeInstanceOf(DatabaseSync);
    db.close();
  });

  it('creates the executions table on first open', () => {
    const db = openDatabase(dbPath);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='executions'").get();
    expect(row).toBeDefined();
    db.close();
  });

  it('creates the approval_requests table on first open', () => {
    const db = openDatabase(dbPath);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='approval_requests'").get();
    expect(row).toBeDefined();
    db.close();
  });

  it('records schema version 1', () => {
    const db = openDatabase(dbPath);
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
    expect(row?.version).toBe(1);
    db.close();
  });

  it('is idempotent — re-opening does not fail', () => {
    openDatabase(dbPath).close();
    const db2 = openDatabase(dbPath);
    expect(db2).toBeInstanceOf(DatabaseSync);
    db2.close();
  });
});

describe('insertExecution / listExecutions', () => {
  it('round-trips a full execution row', () => {
    const db = openDatabase(dbPath);
    const now = 1700000000000;
    insertExecution(db, {
      repo: 'myrepo',
      planFile: 'docs/plans/my-plan.md',
      planHash: 'abc123',
      attemptId: 'attempt-1',
      providerRequested: 'claude-code',
      providerUsed: 'claude-code',
      model: 'claude-opus-4',
      branch: 'feature/my-plan',
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

    const rows = listExecutions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe('myrepo');
    expect(rows[0].attemptId).toBe('attempt-1');
    expect(rows[0].providerRequested).toBe('claude-code');
    expect(rows[0].classification).toBe('healthy');
    db.close();
  });

  it('returns rows in descending created_at order', () => {
    const db = openDatabase(dbPath);
    const base = 1700000000000;
    for (let i = 0; i < 3; i++) {
      insertExecution(db, {
        repo: 'r', planFile: 'p.md', planHash: `h${i}`, attemptId: `a${i}`,
        providerRequested: 'claude-code', providerUsed: null, model: null,
        branch: null, worktree: null, status: 'running',
        latestProgressTs: null, latestTranscriptTs: null,
        rateLimitCooldownUntil: null, lastRecoveryAction: null, classification: null,
        createdAt: base + i, updatedAt: base + i,
      });
    }
    const rows = listExecutions(db);
    expect(rows[0].createdAt).toBeGreaterThan(rows[1].createdAt);
    db.close();
  });
});

describe('insertApprovalRequest / listApprovalRequests', () => {
  it('round-trips a pending approval request', () => {
    const db = openDatabase(dbPath);
    const now = 1700000000000;
    insertApprovalRequest(db, {
      id: 'req-1',
      repo: 'myrepo',
      plan: 'my-plan.md',
      action: 'force-push branch',
      context: 'branch diverged after squash',
      status: 'pending',
      channel: 'ui',
      decidedBy: null,
      createdAt: now,
      decidedAt: null,
    });

    const rows = listApprovalRequests(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('req-1');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].action).toBe('force-push branch');
    expect(rows[0].decidedBy).toBeNull();
    db.close();
  });

  it('returns rows in descending created_at order', () => {
    const db = openDatabase(dbPath);
    const base = 1700000000000;
    for (let i = 0; i < 2; i++) {
      insertApprovalRequest(db, {
        id: `req-${i}`, repo: 'r', plan: 'p.md',
        action: 'act', context: 'ctx', status: 'pending', channel: 'ui',
        decidedBy: null, createdAt: base + i, decidedAt: null,
      });
    }
    const rows = listApprovalRequests(db);
    expect(rows[0].createdAt).toBeGreaterThan(rows[1].createdAt);
    db.close();
  });
});
