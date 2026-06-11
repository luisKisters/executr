import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import {
  parseTasksFromMarkdown,
  listRepos,
  listPlansForRepo,
  getPlanDetail,
  listNormalizedExecutions,
} from '../../src/discovery';
import { openDatabase, insertExecution } from '../../src/db';

// ── Fixture workspace ──────────────────────────────────────────────────

let workspaceRoot: string;
let repoPath: string;
let db: ReturnType<typeof openDatabase>;
let dbPath: string;

const PLAN_NORMAL = `# Plan: Normal Plan

## Validation Commands

\`\`\`
pnpm test
\`\`\`

### Task 1: First task
- [ ] Do thing A
- [x] Do thing B

### Task 2: Second task
- [ ] Do thing C
`;

const PLAN_TASK_ZERO = `# Plan: Bad numbering

## Validation Commands

\`\`\`
pnpm test
\`\`\`

### Task 0: Zero-indexed task
- [ ] Something
- [ ] Another thing

### Task 1: Next task
* [ ] Bullet with asterisk
`;

function gitInit(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
}

function gitCommit(dir: string, message: string): void {
  execSync('git add -A', { cwd: dir, stdio: 'ignore' });
  execSync(`git commit -m "${message}" --allow-empty`, { cwd: dir, stdio: 'ignore' });
}

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-discovery-test-'));
  repoPath = join(workspaceRoot, 'myrepo');

  // Set up fixture repo
  mkdirSync(join(repoPath, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(repoPath, '.ralphex', 'plan-state'), { recursive: true });
  mkdirSync(join(repoPath, '.ralphex', 'progress'), { recursive: true });

  writeFileSync(join(repoPath, 'docs', 'plans', 'normal-plan.md'), PLAN_NORMAL);
  writeFileSync(join(repoPath, 'docs', 'plans', 'task-zero-plan.md'), PLAN_TASK_ZERO);

  // normal-plan has completed status
  writeFileSync(join(repoPath, '.ralphex', 'plan-state', 'normal-plan_.sha256'), 'abc123');
  writeFileSync(join(repoPath, '.ralphex', 'plan-state', 'normal-plan_.status'), 'completed');

  // task-zero-plan has no status (none)
  writeFileSync(join(repoPath, '.ralphex', 'plan-state', 'task-zero-plan_.sha256'), 'def456');

  // progress log for normal-plan
  writeFileSync(
    join(repoPath, '.ralphex', 'progress', 'progress-normal-plan.txt'),
    'Starting execution\nvalidation: passed\nDone'
  );

  gitInit(repoPath);
  writeFileSync(join(repoPath, 'README.md'), 'hello');
  gitCommit(repoPath, 'initial commit');

  // A non-git dir that should be ignored
  mkdirSync(join(workspaceRoot, 'not-a-repo'), { recursive: true });

  // DB
  dbPath = join(workspaceRoot, '.executr', 'orchestrator.db');
  db = openDatabase(dbPath);

  insertExecution(db, {
    repo: 'myrepo',
    planFile: 'normal-plan.md',
    planHash: 'abc123',
    attemptId: 'attempt-1',
    providerRequested: 'claude-code',
    providerUsed: 'claude-code',
    model: 'claude-sonnet-4-6',
    branch: 'feat/normal-plan',
    worktree: null,
    status: 'running',
    latestProgressTs: null,
    latestTranscriptTs: null,
    rateLimitCooldownUntil: null,
    lastRecoveryAction: null,
    classification: null,
    createdAt: 1000,
    updatedAt: 1001,
  });
});

afterAll(() => {
  try { db.close(); } catch { /* ignore */ }
  try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── parseTasksFromMarkdown ─────────────────────────────────────────────

describe('parseTasksFromMarkdown', () => {
  it('parses normal plan with tasks starting from 1', () => {
    const { tasks, validationWarnings } = parseTasksFromMarkdown(PLAN_NORMAL);
    expect(validationWarnings).toHaveLength(0);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].rawTaskNumber).toBe(1);
    expect(tasks[0].normalizedDisplayNumber).toBe(1);
    expect(tasks[0].title).toBe('First task');
    expect(tasks[0].completedCount).toBe(1);
    expect(tasks[0].totalCount).toBe(2);
    expect(tasks[1].rawTaskNumber).toBe(2);
    expect(tasks[1].normalizedDisplayNumber).toBe(2);
  });

  it('normalizes Task 0 plans: rawTaskNumber=0, normalizedDisplayNumber=1', () => {
    const { tasks, validationWarnings } = parseTasksFromMarkdown(PLAN_TASK_ZERO);
    expect(tasks[0].rawTaskNumber).toBe(0);
    expect(tasks[0].normalizedDisplayNumber).toBe(1);
    expect(tasks[1].rawTaskNumber).toBe(1);
    expect(tasks[1].normalizedDisplayNumber).toBe(2);
    expect(validationWarnings.some(w => w.includes('numbered from 0'))).toBe(true);
  });

  it('warns about * [ ] bullets', () => {
    const { validationWarnings } = parseTasksFromMarkdown(PLAN_TASK_ZERO);
    expect(validationWarnings.some(w => w.includes('* [ ]'))).toBe(true);
  });

  it('no warning for clean - [ ] bullets', () => {
    const { validationWarnings } = parseTasksFromMarkdown(PLAN_NORMAL);
    expect(validationWarnings.filter(w => w.includes('bullet')).length).toBe(0);
  });

  it('returns empty tasks and no warnings for empty content', () => {
    const { tasks, validationWarnings } = parseTasksFromMarkdown('');
    expect(tasks).toHaveLength(0);
    expect(validationWarnings).toHaveLength(0);
  });

  it('handles mixed bullet styles', () => {
    const mixed = `### Task 1: Mixed\n- [ ] a\n* [ ] b\n`;
    const { validationWarnings } = parseTasksFromMarkdown(mixed);
    expect(validationWarnings.some(w => w.toLowerCase().includes('mixed'))).toBe(true);
  });

  it('counts completed checkboxes correctly', () => {
    const content = `### Task 1: Test\n- [x] done\n- [ ] not done\n- [X] also done\n`;
    const { tasks } = parseTasksFromMarkdown(content);
    expect(tasks[0].completedCount).toBe(2);
    expect(tasks[0].totalCount).toBe(3);
  });
});

// ── listRepos ──────────────────────────────────────────────────────────

describe('listRepos', () => {
  it('returns repos that have .git dirs', () => {
    const repos = listRepos(workspaceRoot);
    const names = repos.map(r => r.name);
    expect(names).toContain('myrepo');
    expect(names).not.toContain('not-a-repo');
  });

  it('includes current branch and latest commit', () => {
    const repos = listRepos(workspaceRoot);
    const myrepo = repos.find(r => r.name === 'myrepo');
    expect(myrepo).toBeDefined();
    expect(myrepo!.currentBranch).toBeTruthy();
    expect(myrepo!.latestCommit).toContain('initial commit');
  });

  it('reports planCount correctly', () => {
    const repos = listRepos(workspaceRoot);
    const myrepo = repos.find(r => r.name === 'myrepo');
    expect(myrepo!.planCount).toBe(2);
  });

  it('identifies activePlan as the plan with status=none', () => {
    const repos = listRepos(workspaceRoot);
    const myrepo = repos.find(r => r.name === 'myrepo');
    // task-zero-plan has no .status file → status=none → activePlan
    expect(myrepo!.activePlan).toBe('task-zero-plan');
  });

  it('returns empty array for non-existent workspaceRoot', () => {
    const repos = listRepos('/nonexistent/path/xyz');
    expect(repos).toEqual([]);
  });
});

// ── listPlansForRepo ───────────────────────────────────────────────────

describe('listPlansForRepo', () => {
  it('returns both plans in sorted order', () => {
    const plans = listPlansForRepo(workspaceRoot, 'myrepo');
    expect(plans.map(p => p.name)).toEqual(['normal-plan', 'task-zero-plan']);
  });

  it('normal-plan has status=completed', () => {
    const plans = listPlansForRepo(workspaceRoot, 'myrepo');
    const p = plans.find(pl => pl.name === 'normal-plan')!;
    expect(p.status).toBe('completed');
    expect(p.contentHash).toBe('abc123');
  });

  it('task-zero-plan has status=none (no .status file)', () => {
    const plans = listPlansForRepo(workspaceRoot, 'myrepo');
    const p = plans.find(pl => pl.name === 'task-zero-plan')!;
    expect(p.status).toBe('none');
  });

  it('includes task-level info including rawTaskNumber + normalizedDisplayNumber', () => {
    const plans = listPlansForRepo(workspaceRoot, 'myrepo');
    const p = plans.find(pl => pl.name === 'task-zero-plan')!;
    expect(p.tasks[0].rawTaskNumber).toBe(0);
    expect(p.tasks[0].normalizedDisplayNumber).toBe(1);
    expect(p.validationWarnings.some(w => w.includes('numbered from 0'))).toBe(true);
  });

  it('returns empty array for unknown repo', () => {
    const plans = listPlansForRepo(workspaceRoot, 'does-not-exist');
    expect(plans).toEqual([]);
  });

  it('rejects path traversal in repo name', () => {
    const plans = listPlansForRepo(workspaceRoot, '../other');
    expect(plans).toEqual([]);
  });
});

// ── getPlanDetail ──────────────────────────────────────────────────────

describe('getPlanDetail', () => {
  it('returns detail for existing plan', () => {
    const detail = getPlanDetail(workspaceRoot, 'myrepo', 'normal-plan');
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe('normal-plan');
    expect(detail!.rawMarkdown).toContain('Task 1');
    expect(detail!.tasks).toHaveLength(2);
  });

  it('includes progress log tail', () => {
    const detail = getPlanDetail(workspaceRoot, 'myrepo', 'normal-plan');
    expect(detail!.progressLogTail).toContain('validation: passed');
  });

  it('extracts validationState from progress log', () => {
    const detail = getPlanDetail(workspaceRoot, 'myrepo', 'normal-plan');
    expect(detail!.validationState).toBe('passed');
  });

  it('includes recent git commits', () => {
    const detail = getPlanDetail(workspaceRoot, 'myrepo', 'normal-plan');
    expect(detail!.recentCommits.length).toBeGreaterThan(0);
    expect(detail!.recentCommits[0]).toContain('initial commit');
  });

  it('returns null for unknown plan', () => {
    const detail = getPlanDetail(workspaceRoot, 'myrepo', 'ghost-plan');
    expect(detail).toBeNull();
  });

  it('returns null for unknown repo', () => {
    const detail = getPlanDetail(workspaceRoot, 'ghost-repo', 'normal-plan');
    expect(detail).toBeNull();
  });

  it('returns null for path traversal in plan name', () => {
    const detail = getPlanDetail(workspaceRoot, 'myrepo', '../etc/passwd');
    expect(detail).toBeNull();
  });
});

// ── listNormalizedExecutions ───────────────────────────────────────────

describe('listNormalizedExecutions', () => {
  it('returns seeded execution with placeholder classification', () => {
    const execs = listNormalizedExecutions(db);
    expect(execs.length).toBeGreaterThan(0);
    const ex = execs.find(e => e.attemptId === 'attempt-1');
    expect(ex).toBeDefined();
    expect(ex!.repo).toBe('myrepo');
    expect(ex!.planFile).toBe('normal-plan.md');
    expect(ex!.status).toBe('running');
    // classification is placeholder until Task 8
    expect(ex!.classification).toBe('healthy');
    expect(ex!.providerRequested).toBe('claude-code');
  });

  it('returns empty array when DB has no executions', () => {
    const emptyDb = openDatabase(join(workspaceRoot, '.executr', 'empty.db'));
    const execs = listNormalizedExecutions(emptyDb);
    expect(execs).toEqual([]);
    emptyDb.close();
  });
});

// ── /api/repos endpoint ────────────────────────────────────────────────

describe('GET /api/repos', () => {
  it('returns repos list via server', async () => {
    const { createServer } = await import('../../src/server');
    const config = {
      workspaceRoot,
      orchestratorDbPath: dbPath,
      claimsDir: join(workspaceRoot, '.executr', 'claims'),
      password: 'test',
      sessionSecret: 'test-session-secret-32chars-padded!',
      port: 0,
      host: '127.0.0.1',
    };
    const app = await createServer(config, db);

    // Login first
    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'password=test',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cookieStr = (loginRes.headers['set-cookie'] as string).split(';')[0];

    const res = await app.inject({
      method: 'GET',
      url: '/api/repos',
      headers: { cookie: cookieStr },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    const names = body.map((r: { name: string }) => r.name);
    expect(names).toContain('myrepo');
    expect(names).not.toContain('not-a-repo');
  });
});

describe('GET /api/repos/:repo/plans', () => {
  it('returns plans for existing repo', async () => {
    const { createServer } = await import('../../src/server');
    const config = {
      workspaceRoot,
      orchestratorDbPath: dbPath,
      claimsDir: join(workspaceRoot, '.executr', 'claims'),
      password: 'test',
      sessionSecret: 'test-session-secret-32chars-padded!',
      port: 0,
      host: '127.0.0.1',
    };
    const app = await createServer(config, db);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'password=test',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cookieStr = (loginRes.headers['set-cookie'] as string).split(';')[0];

    const res = await app.inject({
      method: 'GET',
      url: '/api/repos/myrepo/plans',
      headers: { cookie: cookieStr },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((p: { name: string }) => p.name)).toContain('normal-plan');
  });
});

describe('GET /api/repos/:repo/plans/:plan', () => {
  it('returns plan detail for existing plan', async () => {
    const { createServer } = await import('../../src/server');
    const config = {
      workspaceRoot,
      orchestratorDbPath: dbPath,
      claimsDir: join(workspaceRoot, '.executr', 'claims'),
      password: 'test',
      sessionSecret: 'test-session-secret-32chars-padded!',
      port: 0,
      host: '127.0.0.1',
    };
    const app = await createServer(config, db);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'password=test',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cookieStr = (loginRes.headers['set-cookie'] as string).split(';')[0];

    const res = await app.inject({
      method: 'GET',
      url: '/api/repos/myrepo/plans/normal-plan',
      headers: { cookie: cookieStr },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('normal-plan');
    expect(body.rawMarkdown).toBeTruthy();
    expect(body.validationState).toBe('passed');
  });

  it('returns 404 for unknown plan', async () => {
    const { createServer } = await import('../../src/server');
    const config = {
      workspaceRoot,
      orchestratorDbPath: dbPath,
      claimsDir: join(workspaceRoot, '.executr', 'claims'),
      password: 'test',
      sessionSecret: 'test-session-secret-32chars-padded!',
      port: 0,
      host: '127.0.0.1',
    };
    const app = await createServer(config, db);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'password=test',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cookieStr = (loginRes.headers['set-cookie'] as string).split(';')[0];

    const res = await app.inject({
      method: 'GET',
      url: '/api/repos/myrepo/plans/ghost-plan',
      headers: { cookie: cookieStr },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/executions', () => {
  it('returns normalized executions with placeholder classification', async () => {
    const { createServer } = await import('../../src/server');
    const config = {
      workspaceRoot,
      orchestratorDbPath: dbPath,
      claimsDir: join(workspaceRoot, '.executr', 'claims'),
      password: 'test',
      sessionSecret: 'test-session-secret-32chars-padded!',
      port: 0,
      host: '127.0.0.1',
    };
    const app = await createServer(config, db);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'password=test',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cookieStr = (loginRes.headers['set-cookie'] as string).split(';')[0];

    const res = await app.inject({
      method: 'GET',
      url: '/api/executions',
      headers: { cookie: cookieStr },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].classification).toBe('healthy');
  });
});
