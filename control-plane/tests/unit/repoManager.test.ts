import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { openDatabase } from '../../src/db';
import {
  isValidRepoName,
  isValidGitUrl,
  validateAddRepoInput,
  buildGitCloneArgs,
  buildGitFetchArgs,
  addRepo,
  archiveRepo,
  hasUncommittedWork,
  type GitExecFn,
} from '../../src/repoManager';

let tmpDir: string;
let workspaceRoot: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cp-repomgr-test-'));
  workspaceRoot = join(tmpDir, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  dbPath = join(tmpDir, '.executr', 'orchestrator.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── isValidRepoName ────────────────────────────────────────────────────

describe('isValidRepoName', () => {
  it('accepts simple alphanumeric names', () => {
    expect(isValidRepoName('myrepo')).toBe(true);
    expect(isValidRepoName('my-repo')).toBe(true);
    expect(isValidRepoName('my_repo')).toBe(true);
    expect(isValidRepoName('MyRepo123')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidRepoName('')).toBe(false);
  });

  it('rejects path traversal with ..',() => {
    expect(isValidRepoName('..')).toBe(false);
    expect(isValidRepoName('.')).toBe(false);
  });

  it('rejects names with forward slash', () => {
    expect(isValidRepoName('org/repo')).toBe(false);
  });

  it('rejects names with backslash', () => {
    expect(isValidRepoName('org\\repo')).toBe(false);
  });

  it('rejects names starting with non-alphanumeric', () => {
    expect(isValidRepoName('-repo')).toBe(false);
    expect(isValidRepoName('.repo')).toBe(false);
  });
});

// ── isValidGitUrl ──────────────────────────────────────────────────────

describe('isValidGitUrl', () => {
  it('accepts https URLs', () => {
    expect(isValidGitUrl('https://github.com/org/repo.git')).toBe(true);
  });

  it('accepts http URLs', () => {
    expect(isValidGitUrl('http://example.com/repo.git')).toBe(true);
  });

  it('accepts file:// URLs', () => {
    expect(isValidGitUrl('file:///tmp/my-repo')).toBe(true);
  });

  it('accepts SSH-style git@ URLs', () => {
    expect(isValidGitUrl('git@github.com:org/repo.git')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidGitUrl('')).toBe(false);
  });

  it('rejects random non-URL strings', () => {
    expect(isValidGitUrl('not a url at all')).toBe(false);
    expect(isValidGitUrl('../something')).toBe(false);
  });
});

// ── validateAddRepoInput ───────────────────────────────────────────────

describe('validateAddRepoInput', () => {
  it('returns null for valid input', () => {
    expect(validateAddRepoInput({ name: 'myrepo', gitUrl: 'https://github.com/x/repo.git' })).toBeNull();
  });

  it('rejects empty name', () => {
    expect(validateAddRepoInput({ name: '', gitUrl: 'https://github.com/x/repo.git' })).toMatch(/name/);
  });

  it('rejects path-traversal name', () => {
    expect(validateAddRepoInput({ name: '../escape', gitUrl: 'https://github.com/x/repo.git' })).toMatch(/invalid|traversal/i);
  });

  it('rejects empty gitUrl', () => {
    expect(validateAddRepoInput({ name: 'myrepo', gitUrl: '' })).toMatch(/gitUrl/);
  });

  it('rejects invalid gitUrl', () => {
    expect(validateAddRepoInput({ name: 'myrepo', gitUrl: 'not-a-url' })).toMatch(/not a valid/i);
  });
});

// ── buildGitCloneArgs ──────────────────────────────────────────────────

describe('buildGitCloneArgs', () => {
  it('includes clone, branch, depth, and target path', () => {
    const args = buildGitCloneArgs('https://github.com/x/repo.git', '/workspace/repo', 'main');
    expect(args[0]).toBe('clone');
    expect(args).toContain('--branch');
    expect(args).toContain('main');
    expect(args).toContain('/workspace/repo');
    expect(args).toContain('https://github.com/x/repo.git');
    expect(args).toContain('--single-branch');
    expect(args).toContain('--depth');
  });

  it('uses the provided branch', () => {
    const args = buildGitCloneArgs('https://github.com/x/repo.git', '/workspace/repo', 'develop');
    const branchIdx = args.indexOf('--branch');
    expect(args[branchIdx + 1]).toBe('develop');
  });
});

// ── buildGitFetchArgs ──────────────────────────────────────────────────

describe('buildGitFetchArgs', () => {
  it('returns fetch --all', () => {
    const args = buildGitFetchArgs();
    expect(args[0]).toBe('fetch');
    expect(args).toContain('--all');
  });
});

// ── addRepo ────────────────────────────────────────────────────────────

function makeFailGitExec(msg: string): GitExecFn {
  return (_args, _cwd) => ({ ok: false, output: msg });
}

describe('addRepo', () => {
  it('returns error for invalid name', () => {
    const db = openDatabase(dbPath);
    const result = addRepo(workspaceRoot, db, { name: '../escape', gitUrl: 'https://github.com/x/repo.git' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(400);
    db.close();
  });

  it('returns error for bad URL', () => {
    const db = openDatabase(dbPath);
    const result = addRepo(workspaceRoot, db, { name: 'myrepo', gitUrl: 'not-a-url' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(400);
    db.close();
  });

  it('returns error on clone failure', () => {
    const db = openDatabase(dbPath);
    const result = addRepo(
      workspaceRoot, db,
      { name: 'newrepo', gitUrl: 'https://github.com/x/repo.git' },
      makeFailGitExec('authentication failed')
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Clone failed');
      expect(result.statusCode).toBe(500);
    }
    db.close();
  });

  it('clones a new repo and registers it in the DB', () => {
    const db = openDatabase(dbPath);
    let capturedArgs: string[] = [];
    const mockGit: GitExecFn = (args, _cwd) => {
      capturedArgs = args;
      // Simulate the clone by creating the .git directory
      const targetPath = args[args.length - 1];
      mkdirSync(join(targetPath, '.git'), { recursive: true });
      return { ok: true, output: '' };
    };
    const result = addRepo(
      workspaceRoot, db,
      { name: 'newrepo', gitUrl: 'https://github.com/x/newrepo.git', branch: 'main' },
      mockGit
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.alreadyExisted).toBe(false);
    expect(capturedArgs[0]).toBe('clone');
    expect(capturedArgs).toContain('main');

    // Verify registered in DB
    const row = db.prepare('SELECT * FROM repos WHERE name = ?').get('newrepo') as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.['source']).toBe('manual');
    expect(row?.['status']).toBe('active');
    expect(row?.['last_cloned_at']).toBeTruthy();
    db.close();
  });

  it('re-fetches when repo already exists on disk', () => {
    const db = openDatabase(dbPath);
    // Create a fake cloned repo
    const repoPath = join(workspaceRoot, 'existingrepo');
    mkdirSync(join(repoPath, '.git'), { recursive: true });

    let capturedArgs: string[] = [];
    const mockGit: GitExecFn = (args, _cwd) => {
      if (args[0] === 'remote') return { ok: true, output: 'https://github.com/x/existingrepo.git' };
      if (args[0] === 'rev-parse') return { ok: true, output: 'main' };
      capturedArgs = args;
      return { ok: true, output: '' };
    };
    const result = addRepo(
      workspaceRoot, db,
      { name: 'existingrepo', gitUrl: 'https://github.com/x/existingrepo.git' },
      mockGit
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.alreadyExisted).toBe(true);
    expect(capturedArgs[0]).toBe('fetch');
    db.close();
  });

  it('rejects re-add when existing clone origin differs', () => {
    const db = openDatabase(dbPath);
    const repoPath = join(workspaceRoot, 'existingrepo');
    mkdirSync(join(repoPath, '.git'), { recursive: true });

    const mockGit: GitExecFn = (args, _cwd) => {
      if (args[0] === 'remote') return { ok: true, output: 'https://github.com/other/repo.git' };
      return { ok: true, output: '' };
    };

    const result = addRepo(
      workspaceRoot, db,
      { name: 'existingrepo', gitUrl: 'https://github.com/x/existingrepo.git' },
      mockGit
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('origin mismatch');
      expect(result.statusCode).toBe(409);
    }
    db.close();
  });

  it('rejects re-add when existing clone branch differs', () => {
    const db = openDatabase(dbPath);
    const repoPath = join(workspaceRoot, 'existingrepo');
    mkdirSync(join(repoPath, '.git'), { recursive: true });

    const mockGit: GitExecFn = (args, _cwd) => {
      if (args[0] === 'remote') return { ok: true, output: 'https://github.com/x/existingrepo.git' };
      if (args[0] === 'rev-parse') return { ok: true, output: 'develop' };
      return { ok: true, output: '' };
    };

    const result = addRepo(
      workspaceRoot, db,
      { name: 'existingrepo', gitUrl: 'https://github.com/x/existingrepo.git', branch: 'main' },
      mockGit
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('branch mismatch');
      expect(result.statusCode).toBe(409);
    }
    db.close();
  });

  it('returns error on re-fetch failure', () => {
    const db = openDatabase(dbPath);
    const repoPath = join(workspaceRoot, 'fetchfail');
    mkdirSync(join(repoPath, '.git'), { recursive: true });
    const mockGit: GitExecFn = (args, _cwd) => {
      if (args[0] === 'remote') return { ok: true, output: 'https://github.com/x/fetchfail.git' };
      if (args[0] === 'rev-parse') return { ok: true, output: 'main' };
      return { ok: false, output: 'network error' };
    };
    const result = addRepo(
      workspaceRoot, db,
      { name: 'fetchfail', gitUrl: 'https://github.com/x/fetchfail.git' },
      mockGit
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Re-fetch failed');
      expect(result.statusCode).toBe(500);
    }
    db.close();
  });

  it('rejects path-traversal in name even if validation passes the base check', () => {
    const db = openDatabase(dbPath);
    // "." and ".." should have been caught already, but let's verify the path resolution guard
    const result = addRepo(workspaceRoot, db, { name: '..', gitUrl: 'https://github.com/x/repo.git' });
    expect(result.ok).toBe(false);
    db.close();
  });

  it('uses main as default branch when not specified', () => {
    const db = openDatabase(dbPath);
    let capturedArgs: string[] = [];
    const mockGit: GitExecFn = (args, _cwd) => {
      capturedArgs = args;
      const targetPath = args[args.length - 1];
      mkdirSync(join(targetPath, '.git'), { recursive: true });
      return { ok: true, output: '' };
    };
    addRepo(workspaceRoot, db, { name: 'branchtest', gitUrl: 'https://github.com/x/branchtest.git' }, mockGit);
    const branchIdx = capturedArgs.indexOf('--branch');
    expect(capturedArgs[branchIdx + 1]).toBe('main');
    db.close();
  });
});

// ── hasUncommittedWork ─────────────────────────────────────────────────

describe('hasUncommittedWork', () => {
  function gitInit(dir: string): void {
    execSync('git init', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
    execSync('git add -A && git commit -m "init" --allow-empty', { cwd: dir, stdio: 'ignore' });
  }

  it('returns false for a clean repo', () => {
    const repoPath = join(workspaceRoot, 'cleanrepo');
    mkdirSync(repoPath);
    gitInit(repoPath);
    expect(hasUncommittedWork(repoPath)).toBe(false);
  });

  it('returns true when there are uncommitted changes', () => {
    const repoPath = join(workspaceRoot, 'dirtyrepo');
    mkdirSync(repoPath);
    gitInit(repoPath);
    writeFileSync(join(repoPath, 'dirty.txt'), 'uncommitted');
    expect(hasUncommittedWork(repoPath)).toBe(true);
  });

  it('returns false for a non-git directory', () => {
    const nonGitDir = join(workspaceRoot, 'nongit');
    mkdirSync(nonGitDir);
    expect(hasUncommittedWork(nonGitDir)).toBe(false);
  });
});

// ── archiveRepo ────────────────────────────────────────────────────────

describe('archiveRepo', () => {
  function gitInit(dir: string): void {
    execSync('git init', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
    execSync('git add -A && git commit -m "init" --allow-empty', { cwd: dir, stdio: 'ignore' });
  }

  it('returns 404 for a repo not in the registry', () => {
    const db = openDatabase(dbPath);
    const result = archiveRepo(workspaceRoot, db, 'ghost');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(404);
    db.close();
  });

  it('returns 400 for invalid repo name', () => {
    const db = openDatabase(dbPath);
    const result = archiveRepo(workspaceRoot, db, '../escape');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.statusCode).toBe(400);
    db.close();
  });

  it('archives a repo with no uncommitted work', () => {
    const db = openDatabase(dbPath);
    db.prepare(`INSERT INTO repos (name, git_url, branch, source, status, added_at) VALUES ('cleanrepo', 'https://x.com/r.git', 'main', 'seed', 'active', 1000)`).run();

    const repoPath = join(workspaceRoot, 'cleanrepo');
    mkdirSync(repoPath);
    gitInit(repoPath);

    const result = archiveRepo(workspaceRoot, db, 'cleanrepo');
    expect(result.ok).toBe(true);

    const row = db.prepare("SELECT status FROM repos WHERE name = 'cleanrepo'").get() as { status: string };
    expect(row.status).toBe('archived');
    db.close();
  });

  it('returns 409 with hasUncommittedWork when repo has dirty changes', () => {
    const db = openDatabase(dbPath);
    db.prepare(`INSERT INTO repos (name, git_url, branch, source, status, added_at) VALUES ('dirtyrepo', 'https://x.com/r.git', 'main', 'seed', 'active', 1000)`).run();

    const repoPath = join(workspaceRoot, 'dirtyrepo');
    mkdirSync(repoPath);
    gitInit(repoPath);
    writeFileSync(join(repoPath, 'dirty.txt'), 'uncommitted');

    const result = archiveRepo(workspaceRoot, db, 'dirtyrepo');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(409);
      expect(result.hasUncommittedWork).toBe(true);
    }

    // Status must not be changed
    const row = db.prepare("SELECT status FROM repos WHERE name = 'dirtyrepo'").get() as { status: string };
    expect(row.status).toBe('active');
    db.close();
  });

  it('is idempotent: archiving an already-archived repo returns ok', () => {
    const db = openDatabase(dbPath);
    db.prepare(`INSERT INTO repos (name, git_url, branch, source, status, added_at) VALUES ('archived', 'https://x.com/r.git', 'main', 'seed', 'archived', 1000)`).run();
    const result = archiveRepo(workspaceRoot, db, 'archived');
    expect(result.ok).toBe(true);
    db.close();
  });

  it('archives a repo that is in the registry but not cloned on disk', () => {
    const db = openDatabase(dbPath);
    db.prepare(`INSERT INTO repos (name, git_url, branch, source, status, added_at) VALUES ('notcloned', 'https://x.com/r.git', 'main', 'seed', 'active', 1000)`).run();
    // No .git directory on disk

    const result = archiveRepo(workspaceRoot, db, 'notcloned');
    expect(result.ok).toBe(true);

    const row = db.prepare("SELECT status FROM repos WHERE name = 'notcloned'").get() as { status: string };
    expect(row.status).toBe('archived');
    db.close();
  });
});
