import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, seedReposRegistry } from '../../src/db';
import { getReposListPath, writeReposListFile } from '../../src/reposList';

let tmpDir: string;
let workspaceRoot: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cp-reposlist-test-'));
  workspaceRoot = join(tmpDir, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  dbPath = join(tmpDir, '.executr', 'orchestrator.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('getReposListPath', () => {
  it('returns the correct path under .executr', () => {
    const path = getReposListPath('/workspace');
    expect(path).toBe('/workspace/.executr/repos.list');
  });

  it('uses the provided workspaceRoot', () => {
    const path = getReposListPath('/custom/root');
    expect(path).toBe('/custom/root/.executr/repos.list');
  });
});

describe('writeReposListFile', () => {
  it('creates the .executr directory and repos.list file', () => {
    const db = openDatabase(dbPath);
    seedReposRegistry(db, 'myapp=https://github.com/x/myapp.git#main');
    writeReposListFile(db, workspaceRoot);
    const listPath = getReposListPath(workspaceRoot);
    expect(existsSync(listPath)).toBe(true);
    db.close();
  });

  it('writes one "name=URL#branch" line per active repo', () => {
    const db = openDatabase(dbPath);
    seedReposRegistry(db, 'app=https://github.com/x/app.git#main,api=https://github.com/x/api.git#develop');
    writeReposListFile(db, workspaceRoot);
    const listPath = getReposListPath(workspaceRoot);
    const content = readFileSync(listPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toContain('app=https://github.com/x/app.git#main');
    expect(lines).toContain('api=https://github.com/x/api.git#develop');
    expect(lines).toHaveLength(2);
    db.close();
  });

  it('produces an empty file when the registry is empty', () => {
    const db = openDatabase(dbPath);
    writeReposListFile(db, workspaceRoot);
    const listPath = getReposListPath(workspaceRoot);
    expect(existsSync(listPath)).toBe(true);
    const content = readFileSync(listPath, 'utf8');
    expect(content.trim()).toBe('');
    db.close();
  });

  it('excludes archived repos', () => {
    const db = openDatabase(dbPath);
    seedReposRegistry(db, 'active=https://github.com/x/active.git#main,gone=https://github.com/x/gone.git#main');
    // Archive 'gone'
    db.prepare("UPDATE repos SET status = 'archived' WHERE name = 'gone'").run();
    writeReposListFile(db, workspaceRoot);
    const content = readFileSync(getReposListPath(workspaceRoot), 'utf8');
    expect(content).toContain('active=');
    expect(content).not.toContain('gone=');
    db.close();
  });

  it('is idempotent: calling multiple times produces the same result', () => {
    const db = openDatabase(dbPath);
    seedReposRegistry(db, 'myapp=https://github.com/x/myapp.git#main');
    writeReposListFile(db, workspaceRoot);
    writeReposListFile(db, workspaceRoot);
    const content = readFileSync(getReposListPath(workspaceRoot), 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    db.close();
  });

  it('reflects a newly-added repo after writing', () => {
    const db = openDatabase(dbPath);
    seedReposRegistry(db, 'first=https://github.com/x/first.git#main');
    writeReposListFile(db, workspaceRoot);

    // Simulate adding a second repo via the API
    const now = Date.now();
    db.prepare(`
      INSERT INTO repos (name, git_url, branch, source, status, added_at)
      VALUES ('second', 'https://github.com/x/second.git', 'main', 'manual', 'active', ?)
    `).run(now);
    writeReposListFile(db, workspaceRoot);

    const content = readFileSync(getReposListPath(workspaceRoot), 'utf8');
    expect(content).toContain('first=');
    expect(content).toContain('second=');
    db.close();
  });

  it('removes an archived repo on next write', () => {
    const db = openDatabase(dbPath);
    seedReposRegistry(db, 'repoA=https://github.com/x/a.git#main,repoB=https://github.com/x/b.git#main');
    writeReposListFile(db, workspaceRoot);

    // Archive repoB and rewrite
    db.prepare("UPDATE repos SET status = 'archived' WHERE name = 'repoB'").run();
    writeReposListFile(db, workspaceRoot);

    const content = readFileSync(getReposListPath(workspaceRoot), 'utf8');
    expect(content).toContain('repoA=');
    expect(content).not.toContain('repoB=');
    db.close();
  });

  it('loop reads repos.list and ignores empty REPOS env', () => {
    // This test verifies the contract the shell entrypoint depends on:
    // if repos.list exists and has content, the loop should use it even if REPOS is empty.
    const db = openDatabase(dbPath);
    // Empty REPOS env — but two repos in the registry (e.g. manually added from prev run)
    db.prepare(`
      INSERT INTO repos (name, git_url, branch, source, status, added_at)
      VALUES ('manual-a', 'https://github.com/x/manual-a.git', 'main', 'manual', 'active', 1000),
             ('manual-b', 'https://github.com/x/manual-b.git', 'develop', 'manual', 'active', 1001)
    `).run();
    writeReposListFile(db, workspaceRoot);
    const content = readFileSync(getReposListPath(workspaceRoot), 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines).toContain('manual-a=https://github.com/x/manual-a.git#main');
    expect(lines).toContain('manual-b=https://github.com/x/manual-b.git#develop');
    db.close();
  });
});
