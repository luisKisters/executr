import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OrchestratorDB } from './db';
import {
  getRepoFromRegistry,
  archiveRepoInRegistry,
  updateRepoLastCloned,
  upsertRepoInRegistry,
} from './db';

export interface AddRepoInput {
  name: string;
  gitUrl: string;
  branch?: string;
}

export type AddRepoResult =
  | { ok: true; alreadyExisted: boolean }
  | { ok: false; error: string; statusCode: number };

export type ArchiveRepoResult =
  | { ok: true }
  | { ok: false; error: string; statusCode: number; hasUncommittedWork?: boolean };

export type GitExecFn = (args: string[], cwd?: string) => { ok: boolean; output: string };

export function isValidRepoName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  // No path separators, not . or .., must start with alphanumeric
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
}

export function isValidGitUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return ['https:', 'http:', 'git:', 'ssh:', 'file:'].includes(u.protocol);
  } catch {
    // SSH-style: git@github.com:org/repo.git
    return /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9/._-]+$/.test(url);
  }
}

export function validateAddRepoInput(input: AddRepoInput): string | null {
  const name = (input.name ?? '').trim();
  const gitUrl = (input.gitUrl ?? '').trim();
  if (!name) return 'name is required';
  if (!isValidRepoName(name)) return 'name contains invalid characters or is a path-traversal attempt';
  if (!gitUrl) return 'gitUrl is required';
  if (!isValidGitUrl(gitUrl)) return 'gitUrl is not a valid git URL';
  return null;
}

export function buildGitCloneArgs(gitUrl: string, targetPath: string, branch: string): string[] {
  return ['clone', '--branch', branch, '--single-branch', '--depth', '1', gitUrl, targetPath];
}

export function buildGitFetchArgs(): string[] {
  return ['fetch', '--all'];
}

function defaultGitExec(args: string[], cwd?: string): { ok: boolean; output: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  const ok = result.status === 0 && !result.error;
  const output = [(result.stderr ?? ''), (result.stdout ?? '')].filter(Boolean).join('\n');
  return { ok, output };
}

export function addRepo(
  workspaceRoot: string,
  db: OrchestratorDB,
  input: AddRepoInput,
  gitExec: GitExecFn = defaultGitExec
): AddRepoResult {
  const name = (input.name ?? '').trim();
  const gitUrl = (input.gitUrl ?? '').trim();
  const branch = ((input.branch ?? '').trim()) || 'main';

  const validationError = validateAddRepoInput({ name, gitUrl, branch });
  if (validationError) return { ok: false, error: validationError, statusCode: 400 };

  // Prevent path traversal in the resolved target path
  const targetPath = resolve(join(workspaceRoot, name));
  const resolvedRoot = resolve(workspaceRoot);
  if (targetPath !== resolvedRoot && !targetPath.startsWith(resolvedRoot + '/')) {
    return { ok: false, error: 'Path traversal detected in repo name', statusCode: 400 };
  }

  const existing = getRepoFromRegistry(db, name);
  const isCloned = existsSync(join(targetPath, '.git'));

  if (isCloned) {
    // Repo already cloned on disk: re-fetch regardless of registry state
    const result = gitExec(buildGitFetchArgs(), targetPath);
    if (!result.ok) {
      return { ok: false, error: `Re-fetch failed: ${result.output}`, statusCode: 500 };
    }
    const now = Date.now();
    upsertRepoInRegistry(db, {
      name,
      gitUrl,
      branch,
      source: existing?.source === 'seed' ? 'seed' : 'manual',
      status: 'active',
      addedAt: existing?.addedAt ?? now,
      lastClonedAt: now,
    });
    updateRepoLastCloned(db, name, now);
    return { ok: true, alreadyExisted: true };
  }

  // Clone the repo
  const cloneResult = gitExec(buildGitCloneArgs(gitUrl, targetPath, branch));
  if (!cloneResult.ok) {
    return { ok: false, error: `Clone failed: ${cloneResult.output}`, statusCode: 500 };
  }

  const now = Date.now();
  upsertRepoInRegistry(db, {
    name,
    gitUrl,
    branch,
    source: 'manual',
    status: 'active',
    addedAt: existing?.addedAt ?? now,
    lastClonedAt: now,
  });

  return { ok: true, alreadyExisted: false };
}

export function hasUncommittedWork(repoPath: string): boolean {
  const result = spawnSync('git', ['-C', repoPath, 'status', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  if (result.status !== 0 || result.error) return false;
  return ((result.stdout ?? '').trim()).length > 0;
}

export function archiveRepo(
  workspaceRoot: string,
  db: OrchestratorDB,
  name: string
): ArchiveRepoResult {
  if (!isValidRepoName(name)) {
    return { ok: false, error: 'Invalid repo name', statusCode: 400 };
  }

  const existing = getRepoFromRegistry(db, name);
  if (!existing) {
    return { ok: false, error: 'Repo not found in registry', statusCode: 404 };
  }

  if (existing.status === 'archived') {
    return { ok: true }; // already archived, idempotent
  }

  const repoPath = join(workspaceRoot, name);
  if (existsSync(join(repoPath, '.git')) && hasUncommittedWork(repoPath)) {
    return {
      ok: false,
      error: 'Repo has uncommitted work. Commit or stash changes before archiving.',
      statusCode: 409,
      hasUncommittedWork: true,
    };
  }

  archiveRepoInRegistry(db, name);
  return { ok: true };
}
