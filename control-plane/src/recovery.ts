import { randomUUID } from 'node:crypto';
import { execSync, type ExecSyncOptions } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClassificationSignal } from './contracts';
import type { OrchestratorDB } from './db';
import {
  insertApprovalRequest,
  incrementRecoveryAttemptCount,
  setExecutionCooldown,
  setLastRecoveryAction,
  getRunningExecutions,
  getExecutionByAttemptId,
} from './db';

// ── Constants ──────────────────────────────────────────────────────────────

export const MAX_AUTO_RETRIES = 3;
export const PROVIDER_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
export const STARTUP_STALL_REPEAT_THRESHOLD = 2;
export const RECOVERY_POLL_INTERVAL_MS = 60_000; // 1 minute

// These classifications need recovery attempts; others are left alone.
const ACTIONABLE_CLASSIFICATIONS: Set<ClassificationSignal> = new Set([
  'failed_finalize',
  'dirty_tree_blocked',
  'rate_limited',
  'auth_missing',
  'known_startup_stall',
  'dead_loop',
  'tool_missing',
]);

// ── Types ──────────────────────────────────────────────────────────────────

export interface RecoveryContext {
  repo: string;
  planSlug: string;
  repoPath: string;
  attemptId: string;
  branch: string | null;
  classification: ClassificationSignal;
  hasDirtyTree: boolean;
  hasDirtySourceFiles: boolean;
  attemptCounts: Record<string, number>;
  cooldownUntil: number | null;
  nowMs: number;
}

export type RecoveryAction =
  | { type: 'noop'; reason: string }
  | { type: 'wait'; reason: string }
  | { type: 'push_branch'; branch: string }
  | { type: 'fix_excludes' }
  | { type: 'set_cooldown'; untilMs: number; switchProvider: boolean }
  | { type: 'switch_provider'; reason: string }
  | { type: 'request_approval'; action: string; context: string };

export interface RecoveryResult {
  action: RecoveryAction;
  success: boolean;
  message: string;
  approvalRequestId?: string;
}

// ── Pure decision function ─────────────────────────────────────────────────

/**
 * Decide what recovery action to take, if any, given the observed context.
 *
 * This is a pure function — no side effects. The RecoveryPoller calls it and
 * passes the result to executeRecovery.
 *
 * CRITICAL rules:
 * - known_startup_stall is self-healing; wait first, only switch provider after
 *   repeated stalls. NEVER recommend an external kill.
 * - Destructive actions (force-push, discard uncommitted work, branch deletion,
 *   scope-changing rewrites) are NEVER selected automatically — they produce a
 *   request_approval action and wait for a human decision.
 */
export function decideRecovery(ctx: RecoveryContext): RecoveryAction {
  const { classification, attemptCounts, cooldownUntil, nowMs } = ctx;

  // If we're still within a cooldown window, wait
  if (cooldownUntil !== null && nowMs < cooldownUntil) {
    return { type: 'wait', reason: `In cooldown until ${new Date(cooldownUntil).toISOString()}` };
  }

  switch (classification) {
    case 'failed_finalize': {
      if (!ctx.branch) {
        return { type: 'noop', reason: 'No branch known; cannot push' };
      }
      const attempts = attemptCounts['push_branch'] ?? 0;
      if (attempts >= MAX_AUTO_RETRIES) {
        return {
          type: 'request_approval',
          action: 'manual_finalize',
          context: `Auto-push of branch "${ctx.branch}" failed after ${MAX_AUTO_RETRIES} attempts. Manual push or force-push may be required.`,
        };
      }
      return { type: 'push_branch', branch: ctx.branch };
    }

    case 'dirty_tree_blocked': {
      if (ctx.hasDirtySourceFiles) {
        // Source/user files are dirty — never discard automatically
        return {
          type: 'request_approval',
          action: 'discard_source_changes',
          context: `Source files are dirty in repo "${ctx.repo}" (plan: ${ctx.planSlug}). Cannot auto-clean user/source files — manual review required before execution can continue.`,
        };
      }
      // Only runtime files dirty — fix gitignore excludes automatically
      const attempts = attemptCounts['fix_excludes'] ?? 0;
      if (attempts >= MAX_AUTO_RETRIES) {
        return {
          type: 'request_approval',
          action: 'manual_clean_runtime',
          context: `Runtime-file gitignore fix failed after ${MAX_AUTO_RETRIES} attempts in "${ctx.repo}" (plan: ${ctx.planSlug}). Manual cleanup required.`,
        };
      }
      return { type: 'fix_excludes' };
    }

    case 'rate_limited': {
      const attempts = attemptCounts['set_cooldown'] ?? 0;
      if (attempts >= MAX_AUTO_RETRIES) {
        return { type: 'noop', reason: `Rate-limit cooldown already applied ${MAX_AUTO_RETRIES} times; waiting for system-level resolution` };
      }
      return { type: 'set_cooldown', untilMs: nowMs + PROVIDER_COOLDOWN_MS, switchProvider: true };
    }

    case 'auth_missing': {
      return { type: 'switch_provider', reason: `Provider auth missing for "${ctx.planSlug}"; switching to next available provider` };
    }

    case 'known_startup_stall': {
      const stalls = attemptCounts['startup_stall'] ?? 0;
      if (stalls < STARTUP_STALL_REPEAT_THRESHOLD) {
        // Per CLAUDE.md: self-heals after 30 m via FYA_TRANSIENT_TIMEOUT — just wait
        return { type: 'wait', reason: 'known_startup_stall — waiting for 30-minute self-heal (do not kill externally)' };
      }
      // After repeated stalls consider a provider switch (still not a kill)
      return { type: 'switch_provider', reason: `Repeated startup stalls (${stalls}) for "${ctx.planSlug}"; switching provider` };
    }

    case 'dead_loop': {
      return {
        type: 'request_approval',
        action: 'restart_or_reset',
        context: `Execution for "${ctx.repo}" / "${ctx.planSlug}" is in a dead loop state. Manual restart or plan-state reset required.`,
      };
    }

    case 'tool_missing': {
      return {
        type: 'request_approval',
        action: 'install_tool',
        context: `A required tool is missing for "${ctx.repo}" / "${ctx.planSlug}". Administrator intervention required to install the tool.`,
      };
    }

    case 'waiting_for_human':
      return { type: 'wait', reason: 'Execution is waiting for human input' };

    default:
      return { type: 'noop', reason: `No recovery defined for classification: ${classification}` };
  }
}

// ── Git / shell exec abstraction (injectable for testing) ──────────────────

export type ExecFn = (cmd: string, opts?: ExecSyncOptions) => string;

function defaultExecFn(cmd: string, opts?: ExecSyncOptions): string {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) as string;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(e.stderr ?? e.message ?? String(err));
  }
}

// Runtime-only paths that are safe to gitignore automatically
const RUNTIME_GITIGNORE_ENTRIES = [
  '.ralphex/',
  '.build/',
  '.swiftpm/',
  'dist/',
  'node_modules/',
];

export function fixGitExcludes(repoPath: string): void {
  const gitignorePath = join(repoPath, '.gitignore');
  let existing = '';
  if (existsSync(gitignorePath)) {
    existing = readFileSync(gitignorePath, 'utf8');
  }

  const missing = RUNTIME_GITIGNORE_ENTRIES.filter(entry => {
    const bare = entry.replace(/\/$/, '');
    return !existing.includes(entry) && !existing.includes(bare + '\n') && !existing.includes(bare + '\r');
  });

  if (missing.length > 0) {
    const toAppend = (existing.endsWith('\n') || existing === '' ? '' : '\n') + missing.join('\n') + '\n';
    appendFileSync(gitignorePath, toAppend, 'utf8');
  }
}

// ── Impure execution function ──────────────────────────────────────────────

export function executeRecovery(
  decision: RecoveryAction,
  ctx: RecoveryContext,
  db: OrchestratorDB,
  execFn: ExecFn = defaultExecFn
): RecoveryResult {
  switch (decision.type) {
    case 'push_branch': {
      const { branch } = decision;
      let success = true;
      let message = '';
      try {
        execFn(`git push -u origin "${branch}" --force-with-lease`, { cwd: ctx.repoPath });
        message = `Pushed branch ${branch} after failed finalize`;
        // Best-effort PR open — failure here doesn't fail the recovery
        try {
          execFn(`gh pr create --title "Plan: ${ctx.planSlug}" --body "Auto-pushed after failed finalize" --head "${branch}"`, { cwd: ctx.repoPath });
          message += ' + opened PR';
        } catch {
          message += ' (PR already exists or could not be created)';
        }
      } catch (err) {
        success = false;
        message = `Push failed: ${String(err).slice(0, 200)}`;
      }
      incrementRecoveryAttemptCount(db, ctx.attemptId, 'push_branch');
      setLastRecoveryAction(db, ctx.attemptId, `push_branch: ${success ? 'ok' : 'failed'} — ${message}`);
      return { action: decision, success, message };
    }

    case 'fix_excludes': {
      let success = true;
      let message = '';
      try {
        fixGitExcludes(ctx.repoPath);
        // Stage the .gitignore change and commit if needed
        try {
          execFn('git add .gitignore', { cwd: ctx.repoPath });
          const status = execFn('git status --porcelain', { cwd: ctx.repoPath });
          if (status.trim()) {
            execFn('git commit -m "chore: add runtime paths to .gitignore (auto-recovery)"', { cwd: ctx.repoPath });
          }
        } catch { /* ignore if nothing to commit */ }
        message = 'Added runtime paths to .gitignore';
      } catch (err) {
        success = false;
        message = `fix_excludes failed: ${String(err).slice(0, 200)}`;
      }
      incrementRecoveryAttemptCount(db, ctx.attemptId, 'fix_excludes');
      setLastRecoveryAction(db, ctx.attemptId, `fix_excludes: ${success ? 'ok' : 'failed'} — ${message}`);
      return { action: decision, success, message };
    }

    case 'set_cooldown': {
      setExecutionCooldown(db, ctx.attemptId, decision.untilMs);
      incrementRecoveryAttemptCount(db, ctx.attemptId, 'set_cooldown');
      const msg = `Provider cooldown set until ${new Date(decision.untilMs).toISOString()}${decision.switchProvider ? '; provider switch requested' : ''}`;
      setLastRecoveryAction(db, ctx.attemptId, `set_cooldown: ${msg}`);
      return { action: decision, success: true, message: msg };
    }

    case 'switch_provider': {
      const msg = `Provider switch requested: ${decision.reason}`;
      setLastRecoveryAction(db, ctx.attemptId, `switch_provider: ${msg}`);
      return { action: decision, success: true, message: msg };
    }

    case 'request_approval': {
      const id = randomUUID();
      const now = ctx.nowMs;
      insertApprovalRequest(db, {
        id,
        repo: ctx.repo,
        plan: ctx.planSlug,
        action: decision.action,
        context: decision.context,
        status: 'pending',
        channel: 'ui',
        decidedBy: null,
        createdAt: now,
        decidedAt: null,
      });
      setLastRecoveryAction(db, ctx.attemptId, `requested_approval: ${decision.action}`);
      return { action: decision, success: true, message: `Approval request created: ${decision.action}`, approvalRequestId: id };
    }

    case 'wait':
      return { action: decision, success: true, message: decision.reason };

    case 'noop':
    default:
      return { action: decision, success: true, message: (decision as { reason?: string }).reason ?? 'noop' };
  }
}

// ── RecoveryPoller ─────────────────────────────────────────────────────────

export interface RecoveryPollOptions {
  workspaceRoot: string;
  intervalMs?: number;
}

export class RecoveryPoller {
  private readonly db: OrchestratorDB;
  private readonly opts: Required<RecoveryPollOptions>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly execFn: ExecFn;

  constructor(db: OrchestratorDB, opts: RecoveryPollOptions, execFn?: ExecFn) {
    this.db = db;
    this.opts = {
      workspaceRoot: opts.workspaceRoot,
      intervalMs: opts.intervalMs ?? RECOVERY_POLL_INTERVAL_MS,
    };
    this.execFn = execFn ?? defaultExecFn;
  }

  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  poll(): void {
    try {
      const running = getRunningExecutions(this.db);
      const now = Date.now();

      for (const execution of running) {
        try {
          const { classification } = execution;
          if (!classification || !ACTIONABLE_CLASSIFICATIONS.has(classification)) continue;

          // Re-fetch to get latest recovery_attempt_counts (may have been updated this poll)
          const fresh = getExecutionByAttemptId(this.db, execution.attemptId) ?? execution;

          const ctx: RecoveryContext = {
            repo: fresh.repo,
            planSlug: fresh.planFile.replace(/\.md$/, ''),
            repoPath: join(this.opts.workspaceRoot, fresh.repo),
            attemptId: fresh.attemptId,
            branch: fresh.branch,
            classification,
            hasDirtyTree: false, // observer already classified dirty_tree_blocked
            hasDirtySourceFiles: false,
            attemptCounts: fresh.recoveryAttemptCounts,
            cooldownUntil: fresh.rateLimitCooldownUntil,
            nowMs: now,
          };

          // For dirty_tree_blocked, we need to know if source files are actually dirty
          // We can read this from the classification in context of the DB record.
          // The observer sets dirty_tree_blocked only when hasDirtyTree is true; for the
          // approval-gate decision we need hasDirtySourceFiles. Check git status live.
          if (classification === 'dirty_tree_blocked') {
            const dirtyInfo = getDirtyTreeInfo(ctx.repoPath);
            ctx.hasDirtyTree = dirtyInfo.hasDirtyTree;
            ctx.hasDirtySourceFiles = dirtyInfo.hasDirtySourceFiles;
          }
          // For known_startup_stall, track stall count separately
          if (classification === 'known_startup_stall') {
            ctx.attemptCounts = {
              ...ctx.attemptCounts,
              startup_stall: ctx.attemptCounts['startup_stall'] ?? 0,
            };
            // Increment stall count so repeated stalls are tracked
            incrementRecoveryAttemptCount(this.db, fresh.attemptId, 'startup_stall');
            ctx.attemptCounts['startup_stall'] = (ctx.attemptCounts['startup_stall'] ?? 0) + 1;
          }

          const decision = decideRecovery(ctx);
          executeRecovery(decision, ctx, this.db, this.execFn);
        } catch {
          // Don't let one bad execution break the whole poll cycle
        }
      }
    } catch {
      // Polling must never throw
    }
  }
}

// ── Dirty tree check (inline for recovery context) ─────────────────────────

const RUNTIME_PREFIXES = ['.ralphex/', '.build/', '.swiftpm/', 'dist/', 'node_modules/'];

function isRuntimePath(filePath: string): boolean {
  return RUNTIME_PREFIXES.some(prefix => filePath.startsWith(prefix));
}

function getDirtyTreeInfo(repoPath: string): { hasDirtyTree: boolean; hasDirtySourceFiles: boolean } {
  try {
    const out = execSync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as string;
    if (!out.trim()) return { hasDirtyTree: false, hasDirtySourceFiles: false };
    const lines = out.split('\n').filter(Boolean);
    const hasDirtySourceFiles = lines.some(line => {
      const path = line.slice(3).trim();
      return !isRuntimePath(path);
    });
    return { hasDirtyTree: lines.length > 0, hasDirtySourceFiles };
  } catch {
    return { hasDirtyTree: false, hasDirtySourceFiles: false };
  }
}
