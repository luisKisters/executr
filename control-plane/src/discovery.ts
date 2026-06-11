import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import type { ClassificationSignal, ProviderName, AttemptStatus } from './contracts';
import type { OrchestratorDB } from './db';
import { listExecutions as dbListExecutions } from './db';

// ── Types ──────────────────────────────────────────────────────────────

export interface TaskInfo {
  rawTaskNumber: number;
  normalizedDisplayNumber: number;
  title: string;
  completedCount: number;
  totalCount: number;
}

export interface PlanSummary {
  name: string;
  file: string;
  status: 'completed' | 'failed' | 'invalid' | 'none';
  contentHash: string | null;
  createdTime: number | null;
  lastRunTime: number | null;
  branch: string | null;
  tasks: TaskInfo[];
  validationWarnings: string[];
}

export interface RepoInfo {
  name: string;
  currentBranch: string | null;
  latestCommit: string | null;
  activePlan: string | null;
  planCount: number;
}

export interface PlanDetail extends PlanSummary {
  rawMarkdown: string;
  progressLogTail: string;
  recentCommits: string[];
  validationState: 'passed' | 'failed' | 'skipped' | 'unknown';
}

export interface NormalizedExecution {
  id: number;
  repo: string;
  planFile: string;
  planHash: string;
  attemptId: string;
  providerRequested: ProviderName;
  providerUsed: ProviderName | null;
  model: string | null;
  branch: string | null;
  status: AttemptStatus | 'running';
  // NOTE: placeholder ('healthy') until Task 8 implements the live classifier
  classification: ClassificationSignal;
  latestProgressTs: number | null;
  latestTranscriptTs: number | null;
  lastRecoveryAction: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── Git helpers ────────────────────────────────────────────────────────

function gitExec(args: string, repoPath: string): string | null {
  try {
    return execSync(`git -C "${repoPath}" ${args}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

export function getGitBranch(repoPath: string): string | null {
  const out = gitExec('rev-parse --abbrev-ref HEAD', repoPath);
  return out || null;
}

export function getGitLatestCommit(repoPath: string): string | null {
  const out = gitExec('log --oneline -1', repoPath);
  return out || null;
}

export function getGitRecentCommits(repoPath: string, n = 5): string[] {
  const out = gitExec(`log --oneline -${n}`, repoPath);
  if (!out) return [];
  return out.split('\n').filter(Boolean);
}

// ── Plan-state helpers ─────────────────────────────────────────────────

type PlanStateStatus = 'completed' | 'failed' | 'invalid' | 'none';

interface PlanState {
  status: PlanStateStatus;
  hash: string | null;
  mtime: number | null;
}

function getPlanState(repoPath: string, planName: string): PlanState {
  const stateDir = join(repoPath, '.ralphex', 'plan-state');
  const sha256File = join(stateDir, `${planName}_.sha256`);
  const statusFile = join(stateDir, `${planName}_.status`);

  let hash: string | null = null;
  let mtime: number | null = null;
  let status: PlanStateStatus = 'none';

  if (existsSync(sha256File)) {
    try {
      hash = readFileSync(sha256File, 'utf8').trim();
      mtime = statSync(sha256File).mtimeMs;
    } catch { /* ignore */ }
  }

  if (existsSync(statusFile)) {
    try {
      const s = readFileSync(statusFile, 'utf8').trim();
      if (s === 'completed' || s === 'failed' || s === 'invalid') {
        status = s;
      }
    } catch { /* ignore */ }
  }

  return { status, hash, mtime };
}

// ── Markdown / plan parsing ────────────────────────────────────────────

export interface ParseResult {
  tasks: TaskInfo[];
  validationWarnings: string[];
}

export function parseTasksFromMarkdown(content: string): ParseResult {
  const warnings: string[] = [];
  const rawTasks: Array<{ rawTaskNumber: number; title: string; completedCount: number; totalCount: number; startIdx: number }> = [];

  const hasBulletStar = /^\s*\* \[[ x]\]/m.test(content);
  const hasBulletDash = /^\s*- \[[ x]\]/m.test(content);

  if (hasBulletStar && !hasBulletDash) {
    warnings.push('Uses `* [ ]` bullets instead of `- [ ]`; tasks may not render correctly in the dashboard');
  } else if (hasBulletStar && hasBulletDash) {
    warnings.push('Mixed `* [ ]` and `- [ ]` bullets found');
  }

  const taskHeadingRe = /^###\s+(?:Task|Iteration)\s+(\d+)\s*:(.*)/gm;
  let match: RegExpExecArray | null;

  while ((match = taskHeadingRe.exec(content)) !== null) {
    const rawNum = parseInt(match[1], 10);
    const title = match[2].trim();
    rawTasks.push({ rawTaskNumber: rawNum, title, completedCount: 0, totalCount: 0, startIdx: match.index + match[0].length });
  }

  // Count checkboxes per task section
  for (let i = 0; i < rawTasks.length; i++) {
    const start = rawTasks[i].startIdx;
    const end = i + 1 < rawTasks.length ? rawTasks[i + 1].startIdx : content.length;
    const section = content.slice(start, end);

    const totalOpen = (section.match(/^\s*[-*] \[ \]/gm) ?? []).length;
    const totalClosed = (section.match(/^\s*[-*] \[x\]/gim) ?? []).length;
    rawTasks[i].totalCount = totalOpen + totalClosed;
    rawTasks[i].completedCount = totalClosed;
  }

  // Normalize display numbers: if tasks start from 0, add 1 to all
  const startsFromZero = rawTasks.length > 0 && rawTasks[0].rawTaskNumber === 0;
  if (startsFromZero) {
    warnings.push('Tasks numbered from 0 (recommended: start from 1)');
  }

  const tasks: TaskInfo[] = rawTasks.map(t => ({
    rawTaskNumber: t.rawTaskNumber,
    normalizedDisplayNumber: startsFromZero ? t.rawTaskNumber + 1 : t.rawTaskNumber,
    title: t.title,
    completedCount: t.completedCount,
    totalCount: t.totalCount,
  }));

  return { tasks, validationWarnings: warnings };
}

// ── Path safety ────────────────────────────────────────────────────────

function isSafeSegment(segment: string): boolean {
  return !/[/\\]/.test(segment) && segment !== '..' && segment !== '.';
}

// ── Discovery functions ────────────────────────────────────────────────

function buildPlanSummary(workspaceRoot: string, repoName: string, file: string): PlanSummary {
  const repoPath = join(workspaceRoot, repoName);
  const planName = file.replace(/\.md$/, '');
  const filePath = join(repoPath, 'docs', 'plans', file);

  let rawMarkdown = '';
  let createdTime: number | null = null;
  try {
    const st = statSync(filePath);
    rawMarkdown = readFileSync(filePath, 'utf8');
    createdTime = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
  } catch { /* ignore */ }

  const { status, hash, mtime } = getPlanState(repoPath, planName);
  const { tasks, validationWarnings } = parseTasksFromMarkdown(rawMarkdown);

  const currentBranch = getGitBranch(repoPath);
  const branch =
    currentBranch && currentBranch !== 'main' && currentBranch !== 'master'
      ? currentBranch
      : null;

  return { name: planName, file, status, contentHash: hash, createdTime, lastRunTime: mtime, branch, tasks, validationWarnings };
}

export function listRepos(workspaceRoot: string): RepoInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(workspaceRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }

  return entries
    .filter(name => existsSync(join(workspaceRoot, name, '.git')))
    .map(name => {
      const repoPath = join(workspaceRoot, name);
      const plansDir = join(repoPath, 'docs', 'plans');
      let planCount = 0;
      let activePlan: string | null = null;

      try {
        const planFiles = readdirSync(plansDir).filter(f => f.endsWith('.md'));
        planCount = planFiles.length;
        for (const file of planFiles) {
          const planName = file.replace(/\.md$/, '');
          const { status } = getPlanState(repoPath, planName);
          if (status === 'none') {
            activePlan = planName;
            break;
          }
        }
      } catch { /* no plans dir */ }

      return {
        name,
        currentBranch: getGitBranch(repoPath),
        latestCommit: getGitLatestCommit(repoPath),
        activePlan,
        planCount,
      };
    });
}

export function listPlansForRepo(workspaceRoot: string, repoName: string): PlanSummary[] {
  if (!isSafeSegment(repoName)) return [];

  const repoPath = resolve(join(workspaceRoot, repoName));
  if (!repoPath.startsWith(resolve(workspaceRoot) + '/') && repoPath !== resolve(workspaceRoot)) {
    return [];
  }

  const plansDir = join(repoPath, 'docs', 'plans');
  let planFiles: string[];
  try {
    planFiles = readdirSync(plansDir).filter(f => f.endsWith('.md')).sort();
  } catch {
    return [];
  }

  return planFiles.map(file => buildPlanSummary(workspaceRoot, repoName, file));
}

export function getPlanDetail(
  workspaceRoot: string,
  repoName: string,
  planName: string
): PlanDetail | null {
  if (!isSafeSegment(repoName) || !isSafeSegment(planName)) return null;

  const repoPath = resolve(join(workspaceRoot, repoName));
  if (!repoPath.startsWith(resolve(workspaceRoot) + '/') && repoPath !== resolve(workspaceRoot)) {
    return null;
  }

  const planFile = `${planName}.md`;
  const planFilePath = join(repoPath, 'docs', 'plans', planFile);
  if (!existsSync(planFilePath)) return null;

  let rawMarkdown = '';
  let createdTime: number | null = null;
  try {
    const st = statSync(planFilePath);
    rawMarkdown = readFileSync(planFilePath, 'utf8');
    createdTime = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
  } catch {
    return null;
  }

  const { status, hash, mtime } = getPlanState(repoPath, planName);
  const { tasks, validationWarnings } = parseTasksFromMarkdown(rawMarkdown);

  const progressFile = join(repoPath, '.ralphex', 'progress', `progress-${planName}.txt`);
  let progressLogTail = '';
  if (existsSync(progressFile)) {
    try {
      const lines = readFileSync(progressFile, 'utf8').split('\n');
      progressLogTail = lines.slice(-50).join('\n');
    } catch { /* ignore */ }
  }

  const recentCommits = getGitRecentCommits(repoPath);
  const currentBranch = getGitBranch(repoPath);
  const branch =
    currentBranch && currentBranch !== 'main' && currentBranch !== 'master'
      ? currentBranch
      : null;

  let validationState: 'passed' | 'failed' | 'skipped' | 'unknown' = 'unknown';
  if (progressLogTail.includes('validation: passed')) validationState = 'passed';
  else if (progressLogTail.includes('validation: failed')) validationState = 'failed';
  else if (progressLogTail.includes('validation: skipped')) validationState = 'skipped';

  return {
    name: planName,
    file: planFile,
    status,
    contentHash: hash,
    createdTime,
    lastRunTime: mtime,
    branch,
    tasks,
    validationWarnings,
    rawMarkdown,
    progressLogTail,
    recentCommits,
    validationState,
  };
}

export function listNormalizedExecutions(db: OrchestratorDB): NormalizedExecution[] {
  const rows = dbListExecutions(db);
  return rows.map(row => ({
    id: row.id,
    repo: row.repo,
    planFile: row.planFile,
    planHash: row.planHash,
    attemptId: row.attemptId,
    providerRequested: row.providerRequested,
    providerUsed: row.providerUsed,
    model: row.model,
    branch: row.branch,
    status: row.status,
    classification: (row.classification ?? 'healthy') as ClassificationSignal,
    latestProgressTs: row.latestProgressTs,
    latestTranscriptTs: row.latestTranscriptTs,
    lastRecoveryAction: row.lastRecoveryAction,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}
