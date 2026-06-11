import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import {
  titleToFilename,
  validatePlanInput,
  generatePlanMarkdown,
  createPlan,
  hashContent,
  type PlanInput,
} from '../../src/planCreation';
import { readClaim } from '../../src/claims';

let workspaceRoot: string;
let claimsDir: string;
let repoPath: string;

function gitInit(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
}

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cp-plan-creation-test-'));
  claimsDir = join(workspaceRoot, '.executr', 'claims');
  repoPath = join(workspaceRoot, 'testrepo');
  mkdirSync(join(repoPath, 'docs', 'plans'), { recursive: true });
  gitInit(repoPath);
});

afterAll(() => {
  try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── titleToFilename ────────────────────────────────────────────────────

describe('titleToFilename', () => {
  it('converts spaces to hyphens and lowercases', () => {
    expect(titleToFilename('My Great Plan')).toBe('my-great-plan');
  });

  it('collapses multiple non-alphanumeric chars to one hyphen', () => {
    expect(titleToFilename('Add --- OAuth2 / PKCE')).toBe('add-oauth2-pkce');
  });

  it('strips leading and trailing hyphens', () => {
    expect(titleToFilename('  --test--  ')).toBe('test');
  });

  it('returns empty string for all-special title', () => {
    expect(titleToFilename('---!!!')).toBe('');
  });

  it('truncates to 100 chars', () => {
    const long = 'a'.repeat(200);
    expect(titleToFilename(long)).toHaveLength(100);
  });
});

// ── validatePlanInput ──────────────────────────────────────────────────

const validInput: PlanInput = {
  title: 'My Feature Plan',
  body: '### Task 1: Do something\n- [ ] Step A\n- [ ] Step B\n',
  validationCommands: 'pnpm test',
  provider: 'claude-code',
};

describe('validatePlanInput', () => {
  it('accepts valid input', () => {
    expect(validatePlanInput(validInput)).toBeNull();
  });

  it('rejects empty title', () => {
    const err = validatePlanInput({ ...validInput, title: '' });
    expect(err).toContain('Title');
  });

  it('rejects title that slugifies to empty', () => {
    const err = validatePlanInput({ ...validInput, title: '---' });
    expect(err).not.toBeNull();
  });

  it('rejects empty validationCommands', () => {
    const err = validatePlanInput({ ...validInput, validationCommands: '' });
    expect(err).toContain('Validation');
  });

  it('rejects empty body', () => {
    const err = validatePlanInput({ ...validInput, body: '' });
    expect(err).toContain('Body');
  });

  it('rejects * [ ] bullets', () => {
    const err = validatePlanInput({ ...validInput, body: '### Task 1: foo\n* [ ] thing\n' });
    expect(err).toContain('* [ ]');
  });

  it('rejects body with no ### Task heading', () => {
    const err = validatePlanInput({ ...validInput, body: '- [ ] orphan checkbox\n' });
    expect(err).toContain('task section');
  });

  it('rejects Task 0 numbering', () => {
    const err = validatePlanInput({
      ...validInput,
      body: '### Task 0: Zero task\n- [ ] thing\n',
    });
    expect(err).toContain('numbered from 1');
  });

  it('accepts body with Iteration 1 heading', () => {
    const input = { ...validInput, body: '### Iteration 1: Setup\n- [ ] do it\n' };
    expect(validatePlanInput(input)).toBeNull();
  });
});

// ── generatePlanMarkdown ───────────────────────────────────────────────

describe('generatePlanMarkdown', () => {
  it('includes # Plan: title header', () => {
    const md = generatePlanMarkdown(validInput);
    expect(md).toContain('# Plan: My Feature Plan');
  });

  it('includes ## Validation Commands section', () => {
    const md = generatePlanMarkdown(validInput);
    expect(md).toContain('## Validation Commands');
    expect(md).toContain('pnpm test');
  });

  it('includes the body tasks', () => {
    const md = generatePlanMarkdown(validInput);
    expect(md).toContain('### Task 1: Do something');
    expect(md).toContain('- [ ] Step A');
  });
});

// ── createPlan ─────────────────────────────────────────────────────────

describe('createPlan — valid input writes file atomically', () => {
  it('creates the plan file with correct content', () => {
    const outcome = createPlan({
      workspaceRoot,
      claimsDir,
      repo: 'testrepo',
      input: validInput,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const planPath = join(repoPath, 'docs', 'plans', outcome.fileName);
    expect(existsSync(planPath)).toBe(true);

    const content = readFileSync(planPath, 'utf8');
    expect(content).toContain('# Plan: My Feature Plan');
    expect(content).toContain('## Validation Commands');
    expect(content).toContain('### Task 1: Do something');
  });

  it('returns correct planName, fileName, planHash', () => {
    const outcome = createPlan({
      workspaceRoot,
      claimsDir,
      repo: 'testrepo',
      input: { ...validInput, title: 'Hash Test Plan' },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.planName).toBe('hash-test-plan');
    expect(outcome.fileName).toBe('hash-test-plan.md');

    const content = readFileSync(join(repoPath, 'docs', 'plans', outcome.fileName), 'utf8');
    expect(outcome.planHash).toBe(hashContent(content));
  });
});

describe('createPlan — malformed cases are rejected', () => {
  it('rejects Task 0', () => {
    const outcome = createPlan({
      workspaceRoot,
      claimsDir,
      repo: 'testrepo',
      input: { ...validInput, body: '### Task 0: Bad\n- [ ] x\n' },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.statusCode).toBe(400);
    expect(outcome.error).toContain('numbered from 1');
  });

  it('rejects * [ ] bullets', () => {
    const outcome = createPlan({
      workspaceRoot,
      claimsDir,
      repo: 'testrepo',
      input: { ...validInput, body: '### Task 1: Bad\n* [ ] thing\n' },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.statusCode).toBe(400);
  });

  it('rejects missing Validation Commands (empty string)', () => {
    const outcome = createPlan({
      workspaceRoot,
      claimsDir,
      repo: 'testrepo',
      input: { ...validInput, validationCommands: '' },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.statusCode).toBe(400);
  });

  it('rejects path traversal in repo name', () => {
    const outcome = createPlan({
      workspaceRoot,
      claimsDir,
      repo: '../other',
      input: validInput,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.statusCode).toBe(400);
  });

  it('rejects .. in repo name', () => {
    const outcome = createPlan({
      workspaceRoot,
      claimsDir,
      repo: '..',
      input: validInput,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.statusCode).toBe(400);
  });
});

describe('createPlan — provider and claims', () => {
  it('does NOT write a claim for claude-code provider', () => {
    const input: PlanInput = {
      ...validInput,
      title: 'Claude Code Plan',
      provider: 'claude-code',
    };
    const outcome = createPlan({ workspaceRoot, claimsDir, repo: 'testrepo', input });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const claim = readClaim(claimsDir, 'testrepo', outcome.planHash);
    expect(claim).toBeNull();
  });

  it('does NOT write a claim for auto provider', () => {
    const input: PlanInput = {
      ...validInput,
      title: 'Auto Provider Plan',
      provider: 'auto',
    };
    const outcome = createPlan({ workspaceRoot, claimsDir, repo: 'testrepo', input });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const claim = readClaim(claimsDir, 'testrepo', outcome.planHash);
    expect(claim).toBeNull();
  });

  it('writes a claim for codex provider', () => {
    const input: PlanInput = {
      ...validInput,
      title: 'Codex Provider Plan',
      provider: 'codex',
    };
    const outcome = createPlan({ workspaceRoot, claimsDir, repo: 'testrepo', input });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const claim = readClaim(claimsDir, 'testrepo', outcome.planHash);
    expect(claim).not.toBeNull();
    expect(claim!.provider).toBe('codex');
    expect(claim!.repo).toBe('testrepo');
    expect(claim!.planHash).toBe(outcome.planHash);
  });
});

describe('createPlan — concurrent writes do not corrupt', () => {
  it('two concurrent writes with different titles both produce valid files', async () => {
    const make = (suffix: string) =>
      createPlan({
        workspaceRoot,
        claimsDir,
        repo: 'testrepo',
        input: { ...validInput, title: `Concurrent Plan ${suffix}` },
      });

    const [r1, r2] = await Promise.all([make('Alpha'), make('Beta')]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    const c1 = readFileSync(join(repoPath, 'docs', 'plans', r1.fileName), 'utf8');
    const c2 = readFileSync(join(repoPath, 'docs', 'plans', r2.fileName), 'utf8');

    expect(c1).toContain('# Plan: Concurrent Plan Alpha');
    expect(c2).toContain('# Plan: Concurrent Plan Beta');
  });
});

// ── POST /api/repos/:repo/plans ────────────────────────────────────────

describe('POST /api/repos/:repo/plans (server endpoint)', () => {
  it('creates a plan and returns 201', async () => {
    const { createServer } = await import('../../src/server');
    const config = {
      workspaceRoot,
      orchestratorDbPath: join(workspaceRoot, '.executr', 'api-test.db'),
      claimsDir,
      password: 'test',
      sessionSecret: 'test-session-secret-32chars-padded!',
      port: 0,
      host: '127.0.0.1',
    };
    const app = await createServer(config);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'password=test',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cookieStr = (loginRes.headers['set-cookie'] as string).split(';')[0];

    const res = await app.inject({
      method: 'POST',
      url: '/api/repos/testrepo/plans',
      payload: JSON.stringify({
        title: 'API Created Plan',
        body: '### Task 1: API task\n- [ ] Do something\n',
        validationCommands: 'pnpm test',
        provider: 'claude-code',
      }),
      headers: {
        cookie: cookieStr,
        'content-type': 'application/json',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.planName).toBe('api-created-plan');
    expect(body.fileName).toBe('api-created-plan.md');
    expect(body.planHash).toBeTruthy();

    const planPath = join(repoPath, 'docs', 'plans', 'api-created-plan.md');
    expect(existsSync(planPath)).toBe(true);
  });

  it('returns 400 for Task 0 body', async () => {
    const { createServer } = await import('../../src/server');
    const config = {
      workspaceRoot,
      orchestratorDbPath: join(workspaceRoot, '.executr', 'api-test2.db'),
      claimsDir,
      password: 'test',
      sessionSecret: 'test-session-secret-32chars-padded!',
      port: 0,
      host: '127.0.0.1',
    };
    const app = await createServer(config);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'password=test',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cookieStr = (loginRes.headers['set-cookie'] as string).split(';')[0];

    const res = await app.inject({
      method: 'POST',
      url: '/api/repos/testrepo/plans',
      payload: JSON.stringify({
        title: 'Bad Plan',
        body: '### Task 0: Should fail\n- [ ] thing\n',
        validationCommands: 'pnpm test',
        provider: 'claude-code',
      }),
      headers: {
        cookie: cookieStr,
        'content-type': 'application/json',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBeTruthy();
  });

  it('returns 401 without auth cookie', async () => {
    const { createServer } = await import('../../src/server');
    const config = {
      workspaceRoot,
      orchestratorDbPath: join(workspaceRoot, '.executr', 'api-test3.db'),
      claimsDir,
      password: 'test',
      sessionSecret: 'test-session-secret-32chars-padded!',
      port: 0,
      host: '127.0.0.1',
    };
    const app = await createServer(config);

    const res = await app.inject({
      method: 'POST',
      url: '/api/repos/testrepo/plans',
      payload: JSON.stringify({ title: 'x', body: '### Task 1: x\n- [ ] y\n', validationCommands: 'x' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });
});
