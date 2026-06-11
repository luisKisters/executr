import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AttemptStatus, ClassificationSignal, ProviderName, ApprovalStatus } from './contracts';

export interface ExecutionRow {
  id: number;
  repo: string;
  planFile: string;
  planHash: string;
  attemptId: string;
  providerRequested: ProviderName;
  providerUsed: ProviderName | null;
  model: string | null;
  branch: string | null;
  worktree: string | null;
  status: AttemptStatus | 'running';
  latestProgressTs: number | null;
  latestTranscriptTs: number | null;
  rateLimitCooldownUntil: number | null;
  lastRecoveryAction: string | null;
  classification: ClassificationSignal | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApprovalRequestRow {
  id: string;
  repo: string;
  plan: string;
  action: string;
  context: string;
  status: ApprovalStatus;
  channel: string;
  decidedBy: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export type OrchestratorDB = DatabaseSync;

export function openDatabase(dbPath: string): OrchestratorDB {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  runMigrations(db);
  return db;
}

function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    )
  `);

  const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as
    | { version: number }
    | undefined;
  const currentVersion = row?.version ?? 0;

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        plan_file TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE,
        provider_requested TEXT NOT NULL,
        provider_used TEXT,
        model TEXT,
        branch TEXT,
        worktree TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        latest_progress_ts INTEGER,
        latest_transcript_ts INTEGER,
        rate_limit_cooldown_until INTEGER,
        last_recovery_action TEXT,
        classification TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        plan TEXT NOT NULL,
        action TEXT NOT NULL,
        context TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        channel TEXT NOT NULL,
        decided_by TEXT,
        created_at INTEGER NOT NULL,
        decided_at INTEGER
      );

      INSERT INTO schema_version (version) VALUES (1)
    `);
  }
}

export function insertExecution(
  db: OrchestratorDB,
  row: Omit<ExecutionRow, 'id'>
): void {
  db.prepare(`
    INSERT INTO executions (
      repo, plan_file, plan_hash, attempt_id,
      provider_requested, provider_used, model, branch, worktree,
      status, latest_progress_ts, latest_transcript_ts,
      rate_limit_cooldown_until, last_recovery_action, classification,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?
    )
  `).run(
    row.repo, row.planFile, row.planHash, row.attemptId,
    row.providerRequested, row.providerUsed ?? null, row.model ?? null,
    row.branch ?? null, row.worktree ?? null,
    row.status, row.latestProgressTs ?? null, row.latestTranscriptTs ?? null,
    row.rateLimitCooldownUntil ?? null, row.lastRecoveryAction ?? null,
    row.classification ?? null,
    row.createdAt, row.updatedAt
  );
}

export function insertApprovalRequest(
  db: OrchestratorDB,
  row: ApprovalRequestRow
): void {
  db.prepare(`
    INSERT INTO approval_requests (
      id, repo, plan, action, context, status, channel,
      decided_by, created_at, decided_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.repo, row.plan, row.action, row.context,
    row.status, row.channel,
    row.decidedBy ?? null, row.createdAt, row.decidedAt ?? null
  );
}

export function listExecutions(db: OrchestratorDB): ExecutionRow[] {
  const rows = db.prepare('SELECT * FROM executions ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(toExecutionRow);
}

export function getRunningExecutions(db: OrchestratorDB): ExecutionRow[] {
  const rows = db.prepare("SELECT * FROM executions WHERE status = 'running' ORDER BY created_at DESC").all() as Record<string, unknown>[];
  return rows.map(toExecutionRow);
}

export function updateExecutionClassification(
  db: OrchestratorDB,
  attemptId: string,
  classification: ClassificationSignal,
  latestProgressTs?: number,
  latestTranscriptTs?: number
): void {
  const now = Date.now();
  if (latestProgressTs !== undefined && latestTranscriptTs !== undefined) {
    db.prepare(`
      UPDATE executions
      SET classification = ?, latest_progress_ts = ?, latest_transcript_ts = ?, updated_at = ?
      WHERE attempt_id = ?
    `).run(classification, latestProgressTs, latestTranscriptTs, now, attemptId);
  } else if (latestProgressTs !== undefined) {
    db.prepare(`
      UPDATE executions
      SET classification = ?, latest_progress_ts = ?, updated_at = ?
      WHERE attempt_id = ?
    `).run(classification, latestProgressTs, now, attemptId);
  } else if (latestTranscriptTs !== undefined) {
    db.prepare(`
      UPDATE executions
      SET classification = ?, latest_transcript_ts = ?, updated_at = ?
      WHERE attempt_id = ?
    `).run(classification, latestTranscriptTs, now, attemptId);
  } else {
    db.prepare(`
      UPDATE executions
      SET classification = ?, updated_at = ?
      WHERE attempt_id = ?
    `).run(classification, now, attemptId);
  }
}

export function listApprovalRequests(db: OrchestratorDB): ApprovalRequestRow[] {
  const rows = db.prepare('SELECT * FROM approval_requests ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(toApprovalRequestRow);
}

function toExecutionRow(r: Record<string, unknown>): ExecutionRow {
  return {
    id: r['id'] as number,
    repo: r['repo'] as string,
    planFile: r['plan_file'] as string,
    planHash: r['plan_hash'] as string,
    attemptId: r['attempt_id'] as string,
    providerRequested: r['provider_requested'] as ProviderName,
    providerUsed: (r['provider_used'] as ProviderName | null) ?? null,
    model: (r['model'] as string | null) ?? null,
    branch: (r['branch'] as string | null) ?? null,
    worktree: (r['worktree'] as string | null) ?? null,
    status: r['status'] as AttemptStatus | 'running',
    latestProgressTs: (r['latest_progress_ts'] as number | null) ?? null,
    latestTranscriptTs: (r['latest_transcript_ts'] as number | null) ?? null,
    rateLimitCooldownUntil: (r['rate_limit_cooldown_until'] as number | null) ?? null,
    lastRecoveryAction: (r['last_recovery_action'] as string | null) ?? null,
    classification: (r['classification'] as ClassificationSignal | null) ?? null,
    createdAt: r['created_at'] as number,
    updatedAt: r['updated_at'] as number,
  };
}

function toApprovalRequestRow(r: Record<string, unknown>): ApprovalRequestRow {
  return {
    id: r['id'] as string,
    repo: r['repo'] as string,
    plan: r['plan'] as string,
    action: r['action'] as string,
    context: r['context'] as string,
    status: r['status'] as ApprovalStatus,
    channel: r['channel'] as string,
    decidedBy: (r['decided_by'] as string | null) ?? null,
    createdAt: r['created_at'] as number,
    decidedAt: (r['decided_at'] as number | null) ?? null,
  };
}
