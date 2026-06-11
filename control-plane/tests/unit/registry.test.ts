import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  openDatabase,
  parseReposEnv,
  seedReposRegistry,
  listActiveRegistryRepos,
  listAllRegistryRepos,
} from '../../src/db';
import { listReposFromRegistry } from '../../src/discovery';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cp-registry-test-'));
  dbPath = join(tmpDir, '.executr', 'orchestrator.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Migration ──────────────────────────────────────────────────────────

describe('migration v4', () => {
  it('creates the repos table', () => {
    const db = openDatabase(dbPath);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='repos'").get();
    expect(row).toBeDefined();
    db.close();
  });

  it('records schema version 4', () => {
    const db = openDatabase(dbPath);
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(4);
    db.close();
  });

  it('is idempotent on re-open', () => {
    openDatabase(dbPath).close();
    const db2 = openDatabase(dbPath);
    expect(db2).toBeInstanceOf(DatabaseSync);
    db2.close();
  });
});

// ── parseReposEnv ─────────────────────────────────────────────────────

describe('parseReposEnv', () => {
  it('returns empty array for empty string', () => {
    expect(parseReposEnv('')).toEqual([]);
    expect(parseReposEnv('   ')).toEqual([]);
  });

  it('parses name=URL#branch format', () => {
    const entries = parseReposEnv('executr=https://github.com/x/executr.git#main');
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('executr');
    expect(entries[0].gitUrl).toBe('https://github.com/x/executr.git');
    expect(entries[0].branch).toBe('main');
  });

  it('parses URL#branch format (name derived from URL)', () => {
    const entries = parseReposEnv('https://github.com/x/my-repo.git#develop');
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('my-repo');
    expect(entries[0].gitUrl).toBe('https://github.com/x/my-repo.git');
    expect(entries[0].branch).toBe('develop');
  });

  it('parses name=URL without branch (defaults to main)', () => {
    const entries = parseReposEnv('myapp=https://github.com/x/myapp.git');
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('myapp');
    expect(entries[0].branch).toBe('main');
  });

  it('parses URL without branch or name (derives name, defaults branch)', () => {
    const entries = parseReposEnv('https://github.com/x/no-branch.git');
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('no-branch');
    expect(entries[0].branch).toBe('main');
  });

  it('parses multiple comma-separated entries', () => {
    const raw = 'a=https://github.com/x/a.git#main,b=https://github.com/x/b.git#dev';
    const entries = parseReposEnv(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('a');
    expect(entries[1].name).toBe('b');
    expect(entries[1].branch).toBe('dev');
  });

  it('strips whitespace around entries', () => {
    const entries = parseReposEnv(' a=https://github.com/x/a.git , b=https://github.com/x/b.git ');
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('a');
    expect(entries[1].name).toBe('b');
  });

  it('handles back-compat REPO_URL style (URL only)', () => {
    const entries = parseReposEnv('https://github.com/your-org/your-repo.git#main');
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('your-repo');
    expect(entries[0].branch).toBe('main');
  });
});

// ── seedReposRegistry + listActiveRegistryRepos ────────────────────────

describe('seedReposRegistry', () => {
  it('inserts entries from REPOS env', () => {
    const db = openDatabase(dbPath);
    seedReposRegistry(db, 'myapp=https://github.com/x/myapp.git#main');
    const repos = listActiveRegistryRepos(db);
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe('myapp');
    expect(repos[0].gitUrl).toBe('https://github.com/x/myapp.git');
    expect(repos[0].branch).toBe('main');
    expect(repos[0].source).toBe('seed');
    expect(repos[0].status).toBe('active');
    db.close();
  });

  it('is idempotent: re-seeding does not duplicate entries', () => {
    const db = openDatabase(dbPath);
    const raw = 'myapp=https://github.com/x/myapp.git#main';
    seedReposRegistry(db, raw);
    seedReposRegistry(db, raw);
    seedReposRegistry(db, raw);
    const repos = listActiveRegistryRepos(db);
    expect(repos).toHaveLength(1);
    db.close();
  });

  it('does not clobber an existing manually-added entry', () => {
    const db = openDatabase(dbPath);
    // Manually insert a repo first
    db.prepare(`
      INSERT INTO repos (name, git_url, branch, source, status, added_at)
      VALUES ('myapp', 'https://github.com/x/old.git', 'old-branch', 'manual', 'active', 1000)
    `).run();
    // Seed with a different URL
    seedReposRegistry(db, 'myapp=https://github.com/x/myapp.git#main');
    const repos = listAllRegistryRepos(db);
    expect(repos).toHaveLength(1);
    // INSERT OR IGNORE — original manual entry survives
    expect(repos[0].gitUrl).toBe('https://github.com/x/old.git');
    expect(repos[0].source).toBe('manual');
    db.close();
  });

  it('seeds multiple entries from comma-separated REPOS env', () => {
    const db = openDatabase(dbPath);
    seedReposRegistry(db, 'a=https://github.com/x/a.git#main,b=https://github.com/x/b.git#dev');
    const repos = listActiveRegistryRepos(db);
    expect(repos).toHaveLength(2);
    expect(repos.map(r => r.name)).toContain('a');
    expect(repos.map(r => r.name)).toContain('b');
    db.close();
  });

  it('does nothing for empty REPOS env', () => {
    const db = openDatabase(dbPath);
    seedReposRegistry(db, '');
    expect(listActiveRegistryRepos(db)).toHaveLength(0);
    db.close();
  });
});

// ── listActiveRegistryRepos excludes archived repos ──────────────────

describe('listActiveRegistryRepos', () => {
  it('excludes archived repos', () => {
    const db = openDatabase(dbPath);
    db.prepare(`
      INSERT INTO repos (name, git_url, branch, source, status, added_at)
      VALUES ('active-repo', 'https://github.com/x/active.git', 'main', 'seed', 'active', 1000)
    `).run();
    db.prepare(`
      INSERT INTO repos (name, git_url, branch, source, status, added_at)
      VALUES ('archived-repo', 'https://github.com/x/archived.git', 'main', 'seed', 'archived', 1001)
    `).run();
    const active = listActiveRegistryRepos(db);
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('active-repo');
    db.close();
  });

  it('listAllRegistryRepos includes archived repos', () => {
    const db = openDatabase(dbPath);
    db.prepare(`
      INSERT INTO repos (name, git_url, branch, source, status, added_at)
      VALUES ('active-repo', 'https://github.com/x/active.git', 'main', 'seed', 'active', 1000)
    `).run();
    db.prepare(`
      INSERT INTO repos (name, git_url, branch, source, status, added_at)
      VALUES ('archived-repo', 'https://github.com/x/archived.git', 'main', 'seed', 'archived', 1001)
    `).run();
    const all = listAllRegistryRepos(db);
    expect(all).toHaveLength(2);
    db.close();
  });
});

// ── listReposFromRegistry ─────────────────────────────────────────────

function gitInit(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  execSync('git add -A && git commit -m "init" --allow-empty', { cwd: dir, stdio: 'ignore' });
}

describe('listReposFromRegistry', () => {
  it('returns cloned=false for a registry entry with no clone on disk', () => {
    const db = openDatabase(dbPath);
    seedReposRegistry(db, 'ghost=https://github.com/x/ghost.git#main');
    const repos = listReposFromRegistry(db, tmpDir);
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe('ghost');
    expect(repos[0].cloned).toBe(false);
    expect(repos[0].currentBranch).toBeNull();
    expect(repos[0].planCount).toBe(0);
    db.close();
  });

  it('returns cloned=true and filesystem state for a cloned repo', () => {
    const db = openDatabase(dbPath);
    seedReposRegistry(db, 'myrepo=https://github.com/x/myrepo.git#main');

    const repoPath = join(tmpDir, 'myrepo');
    mkdirSync(join(repoPath, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(repoPath, 'README.md'), 'hello');
    gitInit(repoPath);

    const repos = listReposFromRegistry(db, tmpDir);
    expect(repos).toHaveLength(1);
    expect(repos[0].cloned).toBe(true);
    expect(repos[0].currentBranch).toBeTruthy();
    expect(repos[0].latestCommit).toBeTruthy();
    db.close();
  });

  it('includes gitUrl and source in the result', () => {
    const db = openDatabase(dbPath);
    seedReposRegistry(db, 'myrepo=https://github.com/x/myrepo.git#main');
    const repos = listReposFromRegistry(db, tmpDir);
    expect(repos[0].gitUrl).toBe('https://github.com/x/myrepo.git');
    expect(repos[0].source).toBe('seed');
    expect(repos[0].registryBranch).toBe('main');
    db.close();
  });

  it('excludes archived repos', () => {
    const db = openDatabase(dbPath);
    db.prepare(`
      INSERT INTO repos (name, git_url, branch, source, status, added_at)
      VALUES ('archived', 'https://github.com/x/archived.git', 'main', 'seed', 'archived', 1000)
    `).run();
    const repos = listReposFromRegistry(db, tmpDir);
    expect(repos).toHaveLength(0);
    db.close();
  });
});
