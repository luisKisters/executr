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
  recoveryAttemptCounts: Record<string, number>;
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

  if (currentVersion < 2) {
    db.exec(`
      ALTER TABLE executions ADD COLUMN recovery_attempt_counts TEXT;
      INSERT INTO schema_version (version) VALUES (2)
    `);
  }

  if (currentVersion < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_sessions (
        id TEXT PRIMARY KEY,
        telegram_user_id INTEGER NOT NULL,
        telegram_chat_id INTEGER NOT NULL,
        session_name TEXT NOT NULL,
        target_repo TEXT,
        transcript TEXT NOT NULL DEFAULT '[]',
        draft_plan TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        is_current INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telegram_known_users (
        user_id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        first_seen_at INTEGER NOT NULL
      );

      INSERT INTO schema_version (version) VALUES (3)
    `);
  }

  if (currentVersion < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        name TEXT PRIMARY KEY,
        git_url TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT 'main',
        source TEXT NOT NULL DEFAULT 'seed',
        status TEXT NOT NULL DEFAULT 'active',
        added_at INTEGER NOT NULL,
        last_cloned_at INTEGER
      );

      INSERT INTO schema_version (version) VALUES (4)
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

export function getExecutionByAttemptId(db: OrchestratorDB, attemptId: string): ExecutionRow | null {
  const row = db.prepare('SELECT * FROM executions WHERE attempt_id = ?').get(attemptId) as Record<string, unknown> | undefined;
  return row ? toExecutionRow(row) : null;
}

export function incrementRecoveryAttemptCount(
  db: OrchestratorDB,
  attemptId: string,
  actionType: string
): void {
  const existing = getExecutionByAttemptId(db, attemptId);
  if (!existing) return;
  const counts = { ...existing.recoveryAttemptCounts };
  counts[actionType] = (counts[actionType] ?? 0) + 1;
  const now = Date.now();
  db.prepare('UPDATE executions SET recovery_attempt_counts = ?, updated_at = ? WHERE attempt_id = ?')
    .run(JSON.stringify(counts), now, attemptId);
}

export function setExecutionCooldown(
  db: OrchestratorDB,
  attemptId: string,
  cooldownUntilMs: number
): void {
  const now = Date.now();
  db.prepare('UPDATE executions SET rate_limit_cooldown_until = ?, updated_at = ? WHERE attempt_id = ?')
    .run(cooldownUntilMs, now, attemptId);
}

export function setLastRecoveryAction(
  db: OrchestratorDB,
  attemptId: string,
  action: string
): void {
  const now = Date.now();
  db.prepare('UPDATE executions SET last_recovery_action = ?, updated_at = ? WHERE attempt_id = ?')
    .run(action, now, attemptId);
}

export function updateApprovalRequestStatus(
  db: OrchestratorDB,
  id: string,
  status: ApprovalStatus,
  decidedBy?: string
): void {
  const now = Date.now();
  db.prepare('UPDATE approval_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
    .run(status, decidedBy ?? null, now, id);
}

function parseRecoveryAttemptCounts(raw: unknown): Record<string, number> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const result: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number') result[k] = v;
      }
      return result;
    }
  } catch { /* ignore */ }
  return {};
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
    recoveryAttemptCounts: parseRecoveryAttemptCounts(r['recovery_attempt_counts']),
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

// ── Telegram session types + CRUD ────────────────────────────────────────

export interface TelegramSessionRow {
  id: string;
  telegramUserId: number;
  telegramChatId: number;
  sessionName: string;
  targetRepo: string | null;
  transcript: string[];
  draftPlan: string | null;
  status: 'active' | 'submitted' | 'abandoned';
  isCurrent: boolean;
  createdAt: number;
  updatedAt: number;
}

function toTelegramSessionRow(r: Record<string, unknown>): TelegramSessionRow {
  let transcript: string[] = [];
  try {
    const parsed = JSON.parse(r['transcript'] as string) as unknown;
    if (Array.isArray(parsed)) transcript = parsed as string[];
  } catch { /* ignore */ }
  return {
    id: r['id'] as string,
    telegramUserId: r['telegram_user_id'] as number,
    telegramChatId: r['telegram_chat_id'] as number,
    sessionName: r['session_name'] as string,
    targetRepo: (r['target_repo'] as string | null) ?? null,
    transcript,
    draftPlan: (r['draft_plan'] as string | null) ?? null,
    status: r['status'] as 'active' | 'submitted' | 'abandoned',
    isCurrent: (r['is_current'] as number) === 1,
    createdAt: r['created_at'] as number,
    updatedAt: r['updated_at'] as number,
  };
}

export function insertTelegramSession(db: OrchestratorDB, row: TelegramSessionRow): void {
  db.prepare(`
    INSERT INTO telegram_sessions (
      id, telegram_user_id, telegram_chat_id, session_name,
      target_repo, transcript, draft_plan, status, is_current,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.telegramUserId, row.telegramChatId, row.sessionName,
    row.targetRepo ?? null, JSON.stringify(row.transcript),
    row.draftPlan ?? null, row.status, row.isCurrent ? 1 : 0,
    row.createdAt, row.updatedAt
  );
}

export function getTelegramSessionById(db: OrchestratorDB, id: string): TelegramSessionRow | null {
  const r = db.prepare('SELECT * FROM telegram_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toTelegramSessionRow(r) : null;
}

export function getTelegramSessionsForUser(db: OrchestratorDB, userId: number): TelegramSessionRow[] {
  const rows = db.prepare('SELECT * FROM telegram_sessions WHERE telegram_user_id = ? ORDER BY created_at DESC').all(userId) as Record<string, unknown>[];
  return rows.map(toTelegramSessionRow);
}

export function getCurrentSessionForUser(db: OrchestratorDB, userId: number): TelegramSessionRow | null {
  const r = db.prepare('SELECT * FROM telegram_sessions WHERE telegram_user_id = ? AND is_current = 1 LIMIT 1').get(userId) as Record<string, unknown> | undefined;
  return r ? toTelegramSessionRow(r) : null;
}

export function updateTelegramSession(
  db: OrchestratorDB,
  id: string,
  updates: {
    targetRepo?: string | null;
    transcript?: string[];
    draftPlan?: string | null;
    status?: 'active' | 'submitted' | 'abandoned';
    isCurrent?: boolean;
  }
): void {
  const now = Date.now();
  const sets: string[] = ['updated_at = ?'];
  const vals: unknown[] = [now];

  if ('targetRepo' in updates) { sets.push('target_repo = ?'); vals.push(updates.targetRepo ?? null); }
  if (updates.transcript !== undefined) { sets.push('transcript = ?'); vals.push(JSON.stringify(updates.transcript)); }
  if ('draftPlan' in updates) { sets.push('draft_plan = ?'); vals.push(updates.draftPlan ?? null); }
  if (updates.status !== undefined) { sets.push('status = ?'); vals.push(updates.status); }
  if (updates.isCurrent !== undefined) { sets.push('is_current = ?'); vals.push(updates.isCurrent ? 1 : 0); }

  vals.push(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.prepare(`UPDATE telegram_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as any[]));
}

export function setCurrentSession(db: OrchestratorDB, userId: number, newSessionId: string): void {
  db.prepare('UPDATE telegram_sessions SET is_current = 0 WHERE telegram_user_id = ?').run(userId);
  db.prepare('UPDATE telegram_sessions SET is_current = 1 WHERE id = ?').run(newSessionId);
}

export function listTelegramSessions(db: OrchestratorDB): TelegramSessionRow[] {
  const rows = db.prepare('SELECT * FROM telegram_sessions ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(toTelegramSessionRow);
}

export function upsertKnownUser(db: OrchestratorDB, userId: number, chatId: number): void {
  db.prepare(`
    INSERT INTO telegram_known_users (user_id, chat_id, first_seen_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id
  `).run(userId, chatId, Date.now());
}

export function getKnownUserChatIds(db: OrchestratorDB): number[] {
  const rows = db.prepare('SELECT chat_id FROM telegram_known_users').all() as { chat_id: number }[];
  return rows.map(r => r.chat_id);
}

// ── Repo registry ────────────────────────────────────────────────────────

export interface RepoRegistryRow {
  name: string;
  gitUrl: string;
  branch: string;
  source: 'seed' | 'manual';
  status: 'active' | 'archived';
  addedAt: number;
  lastClonedAt: number | null;
}

export interface ReposEnvEntry {
  name: string;
  gitUrl: string;
  branch: string;
}

export function parseReposEnv(raw: string | undefined | null): ReposEnvEntry[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map(e => e.trim())
    .filter(Boolean)
    .map(e => {
      let name = '';
      let rest = e;
      if (e.includes('=')) {
        const idx = e.indexOf('=');
        name = e.slice(0, idx).trim();
        rest = e.slice(idx + 1).trim();
      }
      let gitUrl = rest;
      let branch = 'main';
      const hashIdx = rest.lastIndexOf('#');
      if (hashIdx > 0) {
        gitUrl = rest.slice(0, hashIdx);
        branch = rest.slice(hashIdx + 1);
      }
      if (!name) {
        const base = gitUrl.split('/').pop() ?? gitUrl;
        name = base.replace(/\.git$/, '');
      }
      return { name, gitUrl, branch };
    })
    .filter(e => e.name && e.gitUrl);
}

export function seedReposRegistry(db: OrchestratorDB, reposEnv: string | undefined | null): void {
  const entries = parseReposEnv(reposEnv);
  const now = Date.now();
  for (const entry of entries) {
    db.prepare(`
      INSERT OR IGNORE INTO repos (name, git_url, branch, source, status, added_at)
      VALUES (?, ?, ?, 'seed', 'active', ?)
    `).run(entry.name, entry.gitUrl, entry.branch, now);
  }
}

export function listActiveRegistryRepos(db: OrchestratorDB): RepoRegistryRow[] {
  const rows = db.prepare("SELECT * FROM repos WHERE status = 'active' ORDER BY added_at ASC").all() as Record<string, unknown>[];
  return rows.map(toRepoRegistryRow);
}

export function listAllRegistryRepos(db: OrchestratorDB): RepoRegistryRow[] {
  const rows = db.prepare('SELECT * FROM repos ORDER BY added_at ASC').all() as Record<string, unknown>[];
  return rows.map(toRepoRegistryRow);
}

export function getRepoFromRegistry(db: OrchestratorDB, name: string): RepoRegistryRow | null {
  const r = db.prepare('SELECT * FROM repos WHERE name = ?').get(name) as Record<string, unknown> | undefined;
  return r ? toRepoRegistryRow(r) : null;
}

export function archiveRepoInRegistry(db: OrchestratorDB, name: string): void {
  db.prepare("UPDATE repos SET status = 'archived' WHERE name = ?").run(name);
}

export function updateRepoLastCloned(db: OrchestratorDB, name: string, timestamp: number): void {
  db.prepare('UPDATE repos SET last_cloned_at = ? WHERE name = ?').run(timestamp, name);
}

export function upsertRepoInRegistry(db: OrchestratorDB, entry: RepoRegistryRow): void {
  db.prepare(`
    INSERT INTO repos (name, git_url, branch, source, status, added_at, last_cloned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      git_url = excluded.git_url,
      branch = excluded.branch,
      source = excluded.source,
      status = excluded.status,
      last_cloned_at = excluded.last_cloned_at
  `).run(
    entry.name, entry.gitUrl, entry.branch, entry.source, entry.status,
    entry.addedAt, entry.lastClonedAt ?? null
  );
}

function toRepoRegistryRow(r: Record<string, unknown>): RepoRegistryRow {
  return {
    name: r['name'] as string,
    gitUrl: r['git_url'] as string,
    branch: r['branch'] as string,
    source: r['source'] as 'seed' | 'manual',
    status: r['status'] as 'active' | 'archived',
    addedAt: r['added_at'] as number,
    lastClonedAt: (r['last_cloned_at'] as number | null) ?? null,
  };
}
