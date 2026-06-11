import { readFileSync, readlinkSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { ClassificationSignal, ProviderName } from './contracts';
import type { OrchestratorDB, ExecutionRow } from './db';
import { getRunningExecutions, updateExecutionClassification } from './db';

// How long after execution start before we classify no-transcript as a startup stall.
const STARTUP_STALL_THRESHOLD_MS = 5 * 60 * 1000;

// Transcript or progress written within this window means the execution is active.
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

// Polling interval in milliseconds (between 30–60 s as specified).
export const POLL_INTERVAL_MS = 45_000;

// ── Process table ──────────────────────────────────────────────────────────

export interface ProcessEntry {
  pid: number;
  cmd: string;
  cwd: string | null;
}

/**
 * Read the running process table from /proc.
 * Gracefully degrades to an empty list if /proc is not available (non-Linux).
 */
export function readProcessTable(): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  try {
    const pids = readdirSync('/proc').filter(d => /^\d+$/.test(d));
    for (const pid of pids) {
      try {
        const cmdlineBuf = readFileSync(`/proc/${pid}/cmdline`);
        const cmd = cmdlineBuf.toString('utf8').replace(/\0/g, ' ').trim();
        if (!cmd) continue;

        let cwd: string | null = null;
        try {
          cwd = readlinkSync(`/proc/${pid}/cwd`) || null;
        } catch {
          // permission denied or PID vanished
        }

        entries.push({ pid: parseInt(pid, 10), cmd, cwd });
      } catch {
        // PID may have vanished; skip
      }
    }
  } catch {
    // /proc not available
  }
  return entries;
}

/**
 * Return the first process whose cwd is (or is under) repoPath and whose
 * command line includes one of the agent keywords.
 */
export function findRelatedProcess(
  processes: ProcessEntry[],
  repoPath: string,
  planSlug?: string
): ProcessEntry | null {
  const keywords = ['ralphex', 'fya', 'claude', 'codex'];
  for (const p of processes) {
    const cwdMatch = p.cwd !== null && (p.cwd === repoPath || p.cwd.startsWith(repoPath + '/'));
    const cmdMatch = keywords.some(k => p.cmd.includes(k));
    if (cwdMatch && cmdMatch) return p;
    // Also match by plan slug in the command line (e.g. fya pass planPath)
    if (planSlug && p.cmd.includes(planSlug) && cmdMatch) return p;
  }
  return null;
}

// ── Transcript discovery ───────────────────────────────────────────────────

/**
 * Convert a repo filesystem path to the Claude project slug.
 * e.g. /workspace/myrepo → -workspace-myrepo
 */
export function claudeProjectSlug(repoPath: string): string {
  return repoPath.replace(/\//g, '-');
}

/**
 * Find the mtime of the most-recently-modified .jsonl transcript for a repo.
 * Returns null if no transcripts exist.
 *
 * @param homeDir  The home directory where ~/.claude lives (e.g. /home/node)
 */
export function findLatestTranscriptMtime(homeDir: string, repoPath: string): number | null {
  const slug = claudeProjectSlug(repoPath);
  const projectDir = join(homeDir, '.claude', 'projects', slug);
  try {
    const files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    if (!files.length) return null;
    let latest = 0;
    for (const f of files) {
      try {
        const ms = statSync(join(projectDir, f)).mtimeMs;
        if (ms > latest) latest = ms;
      } catch { /* file gone */ }
    }
    return latest > 0 ? latest : null;
  } catch {
    return null;
  }
}

// ── Progress file helpers ──────────────────────────────────────────────────

export function getProgressFileMtime(repoPath: string, planSlug: string): number | null {
  const p = join(repoPath, '.ralphex', 'progress', `progress-${planSlug}.txt`);
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

export function readProgressLogTail(repoPath: string, planSlug: string, lines = 200): string {
  const p = join(repoPath, '.ralphex', 'progress', `progress-${planSlug}.txt`);
  try {
    const content = readFileSync(p, 'utf8');
    const all = content.split('\n');
    return all.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

// ── Plan-state reader ──────────────────────────────────────────────────────

export function readPlanStatus(repoPath: string, planSlug: string): 'completed' | 'failed' | 'invalid' | 'none' {
  const statusFile = join(repoPath, '.ralphex', 'plan-state', `${planSlug}_.status`);
  try {
    const s = readFileSync(statusFile, 'utf8').trim();
    if (s === 'completed' || s === 'failed' || s === 'invalid') return s;
  } catch { /* ignore */ }
  return 'none';
}

// ── Codex attempt result ───────────────────────────────────────────────────

export function readCodexAttemptClassification(repoPath: string, planSlug: string): ClassificationSignal | null {
  const p = join(repoPath, '.ralphex', `attempt-${planSlug}.json`);
  try {
    const raw = readFileSync(p, 'utf8').trim();
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const c = obj['classification'];
    if (typeof c === 'string') return c as ClassificationSignal;
  } catch { /* ignore */ }
  return null;
}

// ── Git dirty-tree check ───────────────────────────────────────────────────

const RUNTIME_PREFIXES = ['.ralphex/', '.build/', '.swiftpm/', 'dist/', 'node_modules/'];

function isRuntimePath(filePath: string): boolean {
  return RUNTIME_PREFIXES.some(prefix => filePath.startsWith(prefix));
}

export interface DirtyTreeResult {
  hasDirtyTree: boolean;
  hasDirtySourceFiles: boolean;
}

export function checkGitDirtyTree(repoPath: string): DirtyTreeResult {
  try {
    const out = execSync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!out.trim()) return { hasDirtyTree: false, hasDirtySourceFiles: false };

    const lines = out.split('\n').filter(Boolean);
    const hasDirtyTree = lines.length > 0;
    // Each line is like "?? path/to/file" or " M path/to/file"
    const hasDirtySourceFiles = lines.some(line => {
      const path = line.slice(3).trim();
      return !isRuntimePath(path);
    });
    return { hasDirtyTree, hasDirtySourceFiles };
  } catch {
    return { hasDirtyTree: false, hasDirtySourceFiles: false };
  }
}

// ── Observation context ────────────────────────────────────────────────────

export interface ObservationContext {
  repo: string;
  planSlug: string;
  provider: ProviderName;
  createdAtMs: number;
  nowMs: number;

  hasActiveProcess: boolean;

  // null = no transcripts have ever been written for this repo
  latestTranscriptMtimeMs: number | null;

  latestProgressMtimeMs: number | null;
  progressLogTail: string;

  planStatus: 'completed' | 'failed' | 'invalid' | 'none';
  codexAttemptClassification: ClassificationSignal | null;

  hasDirtyTree: boolean;
  hasDirtySourceFiles: boolean;
}

export interface CollectOptions {
  workspaceRoot: string;
  homeDir?: string;
  processes?: ProcessEntry[];
  nowMs?: number;
}

export function collectObservationContext(
  execution: ExecutionRow,
  opts: CollectOptions
): ObservationContext {
  const homeDir = opts.homeDir ?? '/home/node';
  const repoPath = join(opts.workspaceRoot, execution.repo);
  const planSlug = execution.planFile.replace(/\.md$/, '');

  const effectiveProvider = execution.providerUsed ?? execution.providerRequested;
  const processes = opts.processes ?? readProcessTable();
  const activeProcess = findRelatedProcess(processes, repoPath, planSlug);

  const latestTranscriptMtimeMs = effectiveProvider === 'claude-code'
    ? findLatestTranscriptMtime(homeDir, repoPath)
    : null;

  const latestProgressMtimeMs = getProgressFileMtime(repoPath, planSlug);
  const progressLogTail = readProgressLogTail(repoPath, planSlug);
  const planStatus = readPlanStatus(repoPath, planSlug);
  const codexAttemptClassification = effectiveProvider === 'codex'
    ? readCodexAttemptClassification(repoPath, planSlug)
    : null;

  const dirty = existsSync(repoPath) ? checkGitDirtyTree(repoPath) : { hasDirtyTree: false, hasDirtySourceFiles: false };

  return {
    repo: execution.repo,
    planSlug,
    provider: effectiveProvider,
    createdAtMs: execution.createdAt,
    nowMs: opts.nowMs ?? Date.now(),
    hasActiveProcess: activeProcess !== null,
    latestTranscriptMtimeMs,
    latestProgressMtimeMs,
    progressLogTail,
    planStatus,
    codexAttemptClassification,
    hasDirtyTree: dirty.hasDirtyTree,
    hasDirtySourceFiles: dirty.hasDirtySourceFiles,
  };
}

// ── Pure classifier ────────────────────────────────────────────────────────

/**
 * Classify an execution's current state from observed inputs.
 *
 * This is a pure function — all inputs are in `ctx`. The observer collects
 * these inputs and updates the DB; it never takes destructive actions.
 *
 * CRITICAL: known_startup_stall is self-healing (fya self-retries after 30 m).
 * This classifier must NEVER recommend an external kill for that signal.
 */
export function classifyExecution(ctx: ObservationContext): ClassificationSignal {
  const ageMs = ctx.nowMs - ctx.createdAtMs;

  // Plan-state tells us the ground truth for terminal states
  if (ctx.planStatus === 'completed') return 'healthy';

  // Check explicit signals in the progress log first — they're the most precise
  const log = ctx.progressLogTail.toLowerCase();

  if (log.includes('rate limit') || log.includes('429') || log.includes('quota exceeded')) {
    return 'rate_limited';
  }
  if (
    (log.includes('auth') && (log.includes('missing') || log.includes('failed') || log.includes('invalid'))) ||
    log.includes('api key') ||
    log.includes('openai_api_key')
  ) {
    return 'auth_missing';
  }
  if (
    (log.includes('push') && (log.includes('failed') || log.includes('rejected'))) ||
    log.includes('failed_finalize')
  ) {
    return 'failed_finalize';
  }
  if (log.includes('command not found') || (log.includes('enoent') && !log.includes('progress'))) {
    return 'tool_missing';
  }

  // Codex: use the stored attempt classification when available
  if (ctx.provider === 'codex' && ctx.codexAttemptClassification) {
    return ctx.codexAttemptClassification;
  }

  // No active process
  if (!ctx.hasActiveProcess) {
    if (ctx.planStatus === 'failed') return 'dead_loop';
    // Execution row exists but nothing is running and plan-state is unknown:
    // if enough time has passed, treat as dead
    if (ctx.planStatus === 'none' && ageMs > 2 * 60 * 1000) return 'dead_loop';
    return 'healthy';
  }

  // Active process is running below ───────────────────────────────────────

  // Dirty source tree: report but don't act (Task 9 handles actions)
  if (ctx.hasDirtySourceFiles) {
    return 'dirty_tree_blocked';
  }

  // Progress file updated recently → actively working (takes precedence over stall detection)
  if (
    ctx.latestProgressMtimeMs !== null &&
    ctx.nowMs - ctx.latestProgressMtimeMs < ACTIVE_WINDOW_MS
  ) {
    return 'long_running_but_active';
  }

  if (ctx.provider === 'claude-code') {
    // No transcript has ever been written after the warmup period = startup stall.
    // Per CLAUDE.md this is self-healing at 30 m via FYA_TRANSIENT_TIMEOUT.
    // NEVER flag for kill — just observe and report.
    if (ctx.latestTranscriptMtimeMs === null && ageMs > STARTUP_STALL_THRESHOLD_MS) {
      return 'known_startup_stall';
    }

    // Transcript is being updated recently → actively working
    if (
      ctx.latestTranscriptMtimeMs !== null &&
      ctx.nowMs - ctx.latestTranscriptMtimeMs < ACTIVE_WINDOW_MS
    ) {
      return 'long_running_but_active';
    }
  }

  // Active process exists but signals are quiet — conservatively treat as running
  return 'long_running_but_active';
}

// ── Observer poller ────────────────────────────────────────────────────────

export interface ObserverPollOptions {
  workspaceRoot: string;
  homeDir?: string;
  intervalMs?: number;
}

export class ObserverPoller {
  private readonly db: OrchestratorDB;
  private readonly opts: Required<ObserverPollOptions>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(db: OrchestratorDB, opts: ObserverPollOptions) {
    this.db = db;
    this.opts = {
      workspaceRoot: opts.workspaceRoot,
      homeDir: opts.homeDir ?? '/home/node',
      intervalMs: opts.intervalMs ?? POLL_INTERVAL_MS,
    };
  }

  start(): void {
    if (this.timer) return;
    // Run once immediately, then on interval
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
      const processes = readProcessTable();
      const now = Date.now();

      for (const execution of running) {
        try {
          const ctx = collectObservationContext(execution, {
            workspaceRoot: this.opts.workspaceRoot,
            homeDir: this.opts.homeDir,
            processes,
            nowMs: now,
          });
          const classification = classifyExecution(ctx);

          const progressTs = ctx.latestProgressMtimeMs ?? undefined;
          const transcriptTs = ctx.latestTranscriptMtimeMs ?? undefined;
          updateExecutionClassification(this.db, execution.attemptId, classification, progressTs, transcriptTs);
        } catch {
          // Don't let one bad execution break the whole poll cycle
        }
      }
    } catch {
      // Polling must never throw
    }
  }
}
