import { describe, it, expect, vi, type Mock } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SpawnSyncReturns } from 'child_process';
import {
  ClaudeCodeRunner,
  CodexRunner,
  ProviderRegistry,
  buildFyaArgv,
  buildCodexExecArgv,
  buildDraftPlanPrompt,
  parseDraftPlanOutput,
  DEFAULT_PROVIDER_POLICY,
  computePlanHash,
  appendProgressLog,
  buildCodexRunPlanPrompt,
  mapCodexExitToClassification,
  readAttemptResultFile,
  type SpawnFn,
  type ProviderPolicy,
  type PlanningSession,
} from '../../src/providers';
import { isLockHeld } from '../../src/claims';
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  type AttemptResult,
} from '../../src/contracts';

// ── Spawn mock helpers ──────────────────────────────────────────────────────

function makeSpawnResult(stdout = '', status = 0, hasError = false): SpawnSyncReturns<string> {
  return {
    stdout,
    stderr: '',
    status,
    error: hasError ? new Error('ENOENT') : undefined,
    pid: hasError ? -1 : 1,
    output: [],
    signal: null,
  } as unknown as SpawnSyncReturns<string>;
}

function makeSpawnOk(stdout = ''): SpawnFn {
  return vi.fn().mockReturnValue(makeSpawnResult(stdout, 0));
}

function makeSpawnFail(msg = 'error'): SpawnFn {
  return vi.fn().mockReturnValue({
    stdout: '',
    stderr: msg,
    status: 1,
    error: undefined,
    pid: 1,
    output: [],
    signal: null,
  } as SpawnSyncReturns<string>);
}

function makeSpawnError(): SpawnFn {
  return vi.fn().mockReturnValue(makeSpawnResult('', null as unknown as number, true));
}

function validAttemptResult(overrides: Partial<AttemptResult> = {}): AttemptResult {
  return {
    status: 'completed',
    provider: 'codex',
    model: 'gpt-5.5',
    branch: 'feature/test-plan',
    tasksCompleted: 2,
    commits: ['abc123', 'def456'],
    validation: { status: 'passed' },
    classification: 'healthy',
    summary: 'All tasks completed successfully',
    startedAt: '2024-01-01T00:00:00.000Z',
    endedAt: '2024-01-01T01:00:00.000Z',
    ...overrides,
  };
}

// ── buildFyaArgv ────────────────────────────────────────────────────────────

describe('buildFyaArgv', () => {
  it('includes --no-color, --claude-command, --external-review-tool, planRelPath', () => {
    const argv = buildFyaArgv({ planRelPath: 'docs/plans/my-plan.md' });
    expect(argv).toContain('--no-color');
    expect(argv.some(a => a.startsWith('--claude-command='))).toBe(true);
    expect(argv.some(a => a.startsWith('--external-review-tool='))).toBe(true);
    expect(argv[argv.length - 1]).toBe('docs/plans/my-plan.md');
  });

  it('uses custom fyaPath', () => {
    const argv = buildFyaArgv({ planRelPath: 'docs/plans/x.md', fyaPath: '/custom/fya' });
    expect(argv).toContain('--claude-command=/custom/fya');
  });

  it('uses custom externalReview', () => {
    const argv = buildFyaArgv({ planRelPath: 'docs/plans/x.md', externalReview: 'codex' });
    expect(argv).toContain('--external-review-tool=codex');
  });

  it('defaults externalReview to none', () => {
    const argv = buildFyaArgv({ planRelPath: 'x.md' });
    expect(argv).toContain('--external-review-tool=none');
  });
});

// ── buildCodexExecArgv ──────────────────────────────────────────────────────

describe('buildCodexExecArgv', () => {
  it('builds correct argv with exec subcommand', () => {
    const argv = buildCodexExecArgv({
      prompt: 'inspect the codebase',
      sandbox: 'read-only',
      model: 'gpt-5.5',
    });
    expect(argv[0]).toBe('exec');
    expect(argv).toContain('--sandbox');
    expect(argv).toContain('read-only');
    expect(argv).toContain('--ask-for-approval');
    expect(argv).toContain('never');
    expect(argv).toContain('--model');
    expect(argv).toContain(DEFAULT_CODEX_MODEL);
    expect(argv).toContain('-c');
    expect(argv).toContain(`model_reasoning_effort="${DEFAULT_CODEX_REASONING_EFFORT}"`);
    expect(argv[argv.length - 1]).toBe('inspect the codebase');
  });

  it('uses workspace-write sandbox', () => {
    const argv = buildCodexExecArgv({
      prompt: 'fix bug',
      sandbox: 'workspace-write',
      model: 'gpt-5.5',
    });
    expect(argv).toContain('workspace-write');
  });

  it('passes through custom approvalMode', () => {
    const argv = buildCodexExecArgv({
      prompt: 'q',
      sandbox: 'read-only',
      model: 'm',
      approvalMode: 'on-request',
    });
    expect(argv).toContain('on-request');
    expect(argv).not.toContain('never');
  });
});

// ── computePlanHash ─────────────────────────────────────────────────────────

describe('computePlanHash', () => {
  it('returns a 64-character hex string', () => {
    const hash = computePlanHash('# Plan: Test\n');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same content', () => {
    const content = '# Plan: Deterministic\n\n## Validation Commands\n\n```\npnpm test\n```\n';
    expect(computePlanHash(content)).toBe(computePlanHash(content));
  });

  it('produces different hashes for different content', () => {
    expect(computePlanHash('content A')).not.toBe(computePlanHash('content B'));
  });
});

// ── appendProgressLog ───────────────────────────────────────────────────────

describe('appendProgressLog', () => {
  it('appends an ISO-prefixed line to the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-progress-'));
    const filePath = join(dir, 'progress.txt');
    appendProgressLog(filePath, 'test message');
    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('test message');
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
  });

  it('appends multiple lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-progress-multi-'));
    const filePath = join(dir, 'progress.txt');
    appendProgressLog(filePath, 'first');
    appendProgressLog(filePath, 'second');
    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('first');
    expect(content).toContain('second');
  });

  it('does not throw if directory does not exist', () => {
    expect(() => {
      appendProgressLog('/nonexistent/path/progress.txt', 'msg');
    }).not.toThrow();
  });
});

// ── buildCodexRunPlanPrompt ─────────────────────────────────────────────────

describe('buildCodexRunPlanPrompt', () => {
  const opts = {
    planPath: 'docs/plans/my-plan.md',
    planContent: '# Plan: My Plan\n\n### Task 1: Do it\n\n- [ ] Step one\n',
    planSlug: 'my-plan',
    planHash: 'abc123hash',
    attemptResultPath: '.ralphex/attempt-my-plan.json',
    progressPath: '.ralphex/progress/progress-my-plan.txt',
    planStatePath: '.ralphex/plan-state/my-plan_',
  };

  it('includes the plan content', () => {
    const prompt = buildCodexRunPlanPrompt(opts);
    expect(prompt).toContain('# Plan: My Plan');
    expect(prompt).toContain('Step one');
  });

  it('includes the feature branch name', () => {
    const prompt = buildCodexRunPlanPrompt(opts);
    expect(prompt).toContain('feature/my-plan');
  });

  it('includes the plan hash for plan-state', () => {
    const prompt = buildCodexRunPlanPrompt(opts);
    expect(prompt).toContain('abc123hash');
  });

  it('includes the attempt result path', () => {
    const prompt = buildCodexRunPlanPrompt(opts);
    expect(prompt).toContain('.ralphex/attempt-my-plan.json');
  });

  it('includes the plan state path', () => {
    const prompt = buildCodexRunPlanPrompt(opts);
    expect(prompt).toContain('.ralphex/plan-state/my-plan_');
  });

  it('instructs to use --sandbox workspace-write semantics (commit-per-task)', () => {
    const prompt = buildCodexRunPlanPrompt(opts);
    expect(prompt).toContain('Task N');
    expect(prompt).toContain('git commit');
  });

  it('lists all valid classification values', () => {
    const prompt = buildCodexRunPlanPrompt(opts);
    expect(prompt).toContain('healthy');
    expect(prompt).toContain('rate_limited');
    expect(prompt).toContain('auth_missing');
    expect(prompt).toContain('failed_finalize');
    expect(prompt).toContain('dead_loop');
  });
});

// ── mapCodexExitToClassification ────────────────────────────────────────────

describe('mapCodexExitToClassification', () => {
  it('returns healthy for exit code 0', () => {
    expect(mapCodexExitToClassification('success', '', 0)).toBe('healthy');
  });

  it('returns rate_limited for "rate limit" in output', () => {
    expect(mapCodexExitToClassification('rate limit exceeded', '', 1)).toBe('rate_limited');
  });

  it('returns rate_limited for 429 in output', () => {
    expect(mapCodexExitToClassification('', 'HTTP 429 error', 1)).toBe('rate_limited');
  });

  it('returns rate_limited for quota exceeded', () => {
    expect(mapCodexExitToClassification('quota exceeded', '', 1)).toBe('rate_limited');
  });

  it('returns auth_missing for 401 in output', () => {
    expect(mapCodexExitToClassification('', 'HTTP 401 unauthorized', 1)).toBe('auth_missing');
  });

  it('returns auth_missing for 403 in output', () => {
    expect(mapCodexExitToClassification('', '403 forbidden', 1)).toBe('auth_missing');
  });

  it('returns auth_missing for api key error', () => {
    expect(mapCodexExitToClassification('invalid api key', '', 1)).toBe('auth_missing');
  });

  it('returns auth_missing for OPENAI_API_KEY reference', () => {
    expect(mapCodexExitToClassification('', 'OPENAI_API_KEY not set', 1)).toBe('auth_missing');
  });

  it('returns failed_finalize for push rejected', () => {
    expect(mapCodexExitToClassification('', 'push rejected by remote', 1)).toBe('failed_finalize');
  });

  it('returns failed_finalize for push failed', () => {
    expect(mapCodexExitToClassification('push failed', '', 1)).toBe('failed_finalize');
  });

  it('returns tool_missing for ENOENT', () => {
    expect(mapCodexExitToClassification('', 'ENOENT', 1)).toBe('tool_missing');
  });

  it('returns tool_missing for command not found', () => {
    expect(mapCodexExitToClassification('command not found', '', 1)).toBe('tool_missing');
  });

  it('returns dead_loop for unknown non-zero exit', () => {
    expect(mapCodexExitToClassification('some random error', 'stderr output', 1)).toBe('dead_loop');
  });

  it('returns dead_loop for null exit code', () => {
    expect(mapCodexExitToClassification('', '', null)).toBe('dead_loop');
  });
});

// ── readAttemptResultFile ───────────────────────────────────────────────────

describe('readAttemptResultFile', () => {
  it('returns null for a missing file', () => {
    expect(readAttemptResultFile('/nonexistent/path/attempt.json')).toBeNull();
  });

  it('returns null for an empty file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-attempt-'));
    const filePath = join(dir, 'attempt.json');
    writeFileSync(filePath, '', 'utf8');
    expect(readAttemptResultFile(filePath)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-attempt-'));
    const filePath = join(dir, 'attempt.json');
    writeFileSync(filePath, 'not json {{{', 'utf8');
    expect(readAttemptResultFile(filePath)).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-attempt-'));
    const filePath = join(dir, 'attempt.json');
    writeFileSync(filePath, JSON.stringify({ status: 'completed' }), 'utf8');
    expect(readAttemptResultFile(filePath)).toBeNull();
  });

  it('returns parsed result for a valid AttemptResult JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-attempt-'));
    const filePath = join(dir, 'attempt.json');
    const result = validAttemptResult();
    writeFileSync(filePath, JSON.stringify(result), 'utf8');
    const parsed = readAttemptResultFile(filePath);
    expect(parsed).not.toBeNull();
    expect(parsed?.status).toBe('completed');
    expect(parsed?.provider).toBe('codex');
    expect(parsed?.model).toBe('gpt-5.5');
    expect(parsed?.summary).toContain('All tasks');
  });
});

// ── ClaudeCodeRunner ────────────────────────────────────────────────────────

describe('ClaudeCodeRunner.availability', () => {
  it('returns available when claude --version succeeds', async () => {
    const runner = new ClaudeCodeRunner({ spawnFn: makeSpawnOk('claude 2.0') });
    const status = await runner.availability();
    expect(status.available).toBe(true);
  });

  it('returns unavailable when claude --version fails', async () => {
    const runner = new ClaudeCodeRunner({ spawnFn: makeSpawnFail() });
    const status = await runner.availability();
    expect(status.available).toBe(false);
    expect(status.reason).toBe('auth_missing');
  });

  it('returns unavailable when spawn errors (ENOENT)', async () => {
    const runner = new ClaudeCodeRunner({ spawnFn: makeSpawnError() });
    const status = await runner.availability();
    expect(status.available).toBe(false);
  });
});

describe('ClaudeCodeRunner.runPlan', () => {
  it('returns completed when ralphex exits 0', async () => {
    const spawnFn = makeSpawnOk('done');
    const runner = new ClaudeCodeRunner({ spawnFn });
    const result = await runner.runPlan('/repo', 'docs/plans/my.md', {
      provider: 'claude-code',
      attemptId: 'a1',
    });
    expect(result.status).toBe('completed');
    expect(result.provider).toBe('claude-code');
  });

  it('returns failed when ralphex exits non-zero', async () => {
    const runner = new ClaudeCodeRunner({ spawnFn: makeSpawnFail('failure') });
    const result = await runner.runPlan('/repo', 'docs/plans/my.md', {
      provider: 'claude-code',
      attemptId: 'a2',
    });
    expect(result.status).toBe('failed');
  });

  it('passes correct argv to ralphex (spy)', async () => {
    const spawnFn = makeSpawnOk() as Mock;
    const runner = new ClaudeCodeRunner({
      spawnFn,
      ralphexPath: 'ralphex',
      fyaPath: '/usr/local/bin/fya-wrapper.sh',
    });
    await runner.runPlan('/workspace/myrepo', 'docs/plans/plan.md', {
      provider: 'claude-code',
      attemptId: 'a3',
    });
    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe('ralphex');
    expect(args).toContain('--no-color');
    expect(args).toContain('--claude-command=/usr/local/bin/fya-wrapper.sh');
    expect(args[args.length - 1]).toBe('docs/plans/plan.md');
    expect(opts.cwd).toBe('/workspace/myrepo');
  });
});

describe('ClaudeCodeRunner.inspect', () => {
  it('calls claude -p with the question', async () => {
    const spawnFn = makeSpawnOk('answer text') as Mock;
    const runner = new ClaudeCodeRunner({ spawnFn, claudePath: 'claude' });
    const result = await runner.inspect('/repo', 'What does this do?', 'readonly');
    const [cmd, args] = spawnFn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toContain('-p');
    expect(args).toContain('What does this do?');
    expect(result.answer).toBe('answer text');
    expect(result.provider).toBe('claude-code');
  });
});

describe('ClaudeCodeRunner.draftPlan', () => {
  const validPlanMarkdown = `# Plan: Test Plan

## Validation Commands

\`\`\`
pnpm test
\`\`\`

### Task 1: Do something

- [ ] Step one
`;

  it('returns valid draft when provider returns well-formed plan', async () => {
    const runner = new ClaudeCodeRunner({ spawnFn: makeSpawnOk(validPlanMarkdown) });
    const session: PlanningSession = {
      transcript: ['User: build a feature', 'Assistant: sure'],
      targetRepo: 'myrepo',
      sessionName: 'my-session',
    };
    const result = await runner.draftPlan(session, '/workspace/myrepo');
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.markdown).toContain('# Plan:');
  });

  it('returns invalid draft with warnings when output is malformed', async () => {
    const runner = new ClaudeCodeRunner({ spawnFn: makeSpawnOk('just some random text') });
    const session: PlanningSession = {
      transcript: [],
      targetRepo: 'repo',
      sessionName: 'sess',
    };
    const result = await runner.draftPlan(session, '/workspace/repo');
    expect(result.valid).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('returns fallback plan when provider output is empty', async () => {
    const runner = new ClaudeCodeRunner({ spawnFn: makeSpawnOk('') });
    const session: PlanningSession = {
      transcript: [],
      targetRepo: 'repo',
      sessionName: 'fallback-sess',
    };
    const result = await runner.draftPlan(session, '/workspace/repo');
    expect(result.valid).toBe(false);
    expect(result.warnings).toContain('Empty output from provider');
    expect(result.markdown).toContain('# Plan:');
  });
});

// ── CodexRunner ─────────────────────────────────────────────────────────────

describe('CodexRunner.availability', () => {
  it('returns unavailable when codex binary missing', async () => {
    const runner = new CodexRunner({ spawnFn: makeSpawnError() });
    const status = await runner.availability();
    expect(status.available).toBe(false);
    expect(status.reason).toBe('tool_missing');
  });

  it('returns unavailable when OPENAI_API_KEY and Codex auth file are missing', async () => {
    const originalKey = process.env['OPENAI_API_KEY'];
    const originalHome = process.env['CODEX_HOME'];
    delete process.env['OPENAI_API_KEY'];
    process.env['CODEX_HOME'] = mkdtempSync(join(tmpdir(), 'cp-codex-home-empty-'));
    try {
      const runner = new CodexRunner({ spawnFn: makeSpawnOk('codex 1.0') });
      const status = await runner.availability();
      expect(status.available).toBe(false);
      expect(status.reason).toBe('auth_missing');
    } finally {
      if (originalKey !== undefined) process.env['OPENAI_API_KEY'] = originalKey;
      if (originalHome !== undefined) process.env['CODEX_HOME'] = originalHome;
      else delete process.env['CODEX_HOME'];
    }
  });

  it('returns available when codex present and key set', async () => {
    const original = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'test-key';
    try {
      const runner = new CodexRunner({ spawnFn: makeSpawnOk('codex 1.0') });
      const status = await runner.availability();
      expect(status.available).toBe(true);
    } finally {
      if (original !== undefined) process.env['OPENAI_API_KEY'] = original;
      else delete process.env['OPENAI_API_KEY'];
    }
  });

  it('returns available when codex auth file is mounted', async () => {
    const originalKey = process.env['OPENAI_API_KEY'];
    const originalHome = process.env['CODEX_HOME'];
    delete process.env['OPENAI_API_KEY'];
    const codexHome = mkdtempSync(join(tmpdir(), 'cp-codex-home-auth-'));
    writeFileSync(join(codexHome, 'auth.json'), '{}', 'utf8');
    process.env['CODEX_HOME'] = codexHome;
    try {
      const runner = new CodexRunner({ spawnFn: makeSpawnOk('codex 1.0') });
      const status = await runner.availability();
      expect(status.available).toBe(true);
    } finally {
      if (originalKey !== undefined) process.env['OPENAI_API_KEY'] = originalKey;
      if (originalHome !== undefined) process.env['CODEX_HOME'] = originalHome;
      else delete process.env['CODEX_HOME'];
    }
  });
});

describe('CodexRunner.inspect', () => {
  it('builds correct argv with exec subcommand', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    const spawnFn = makeSpawnOk('inspection result') as Mock;
    const runner = new CodexRunner({ spawnFn, codexPath: 'codex', model: 'gpt-5.5' });
    const result = await runner.inspect('/repo', 'check for bugs', 'readonly');

    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe('codex');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.5');
    expect(args[args.length - 1]).toBe('check for bugs');
    expect(opts.cwd).toBe('/repo');
    expect(result.answer).toBe('inspection result');
    expect(result.provider).toBe('codex');
    delete process.env['OPENAI_API_KEY'];
  });

  it('uses workspace-write sandbox for workspace-write mode', async () => {
    const spawnFn = makeSpawnOk() as Mock;
    const runner = new CodexRunner({ spawnFn, model: 'gpt-5.5' });
    await runner.inspect('/repo', 'fix it', 'workspace-write');
    const [, args] = spawnFn.mock.calls[0];
    expect(args).toContain('workspace-write');
    expect(args).not.toContain('read-only');
  });
});

// ── CodexRunner.runPlan — full implementation ──────────────────────────────

function setupCodexFixture(planContent = '# Plan: Test\n\n## Validation Commands\n\n```\npnpm test\n```\n\n### Task 1: Step\n\n- [ ] Do it\n') {
  const repo = mkdtempSync(join(tmpdir(), 'cp-codex-run-'));
  const planDir = join(repo, 'docs', 'plans');
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, 'test-plan.md'), planContent, 'utf8');
  return { repo, planPath: 'docs/plans/test-plan.md', planSlug: 'test-plan', planContent };
}

describe('CodexRunner.runPlan', () => {
  it('returns failed with tool_missing when plan file cannot be read', async () => {
    const runner = new CodexRunner({ spawnFn: makeSpawnOk() });
    const result = await runner.runPlan('/nonexistent/repo', 'docs/plans/missing.md', {
      provider: 'codex',
      attemptId: 'a1',
    });
    expect(result.status).toBe('failed');
    expect(result.provider).toBe('codex');
    expect(result.classification).toBe('tool_missing');
    expect(result.summary).toContain('Could not read plan file');
  });

  it('happy path: codex exits 0 and writes valid AttemptResult JSON', async () => {
    const { repo, planPath } = setupCodexFixture();
    const expectedResult = validAttemptResult();

    const spawnFn = vi.fn().mockImplementation((_cmd: string, _args: string[], opts: { cwd: string }) => {
      // Simulate codex writing the AttemptResult file
      const attemptFile = join(opts.cwd, '.ralphex', 'attempt-test-plan.json');
      mkdirSync(join(opts.cwd, '.ralphex'), { recursive: true });
      writeFileSync(attemptFile, JSON.stringify(expectedResult), 'utf8');
      return makeSpawnResult('done', 0);
    }) as SpawnFn;

    const runner = new CodexRunner({ spawnFn, model: 'gpt-5.5' });
    const result = await runner.runPlan(repo, planPath, { provider: 'codex', attemptId: 'a-happy' });

    expect(result.status).toBe('completed');
    expect(result.provider).toBe('codex');
    expect(result.tasksCompleted).toBe(2);
    expect(result.commits).toEqual(['abc123', 'def456']);
    expect(result.classification).toBe('healthy');
  });

  it('writes plan-state files after successful run', async () => {
    const { repo, planPath, planContent } = setupCodexFixture();
    const expectedHash = computePlanHash(planContent);

    const spawnFn = vi.fn().mockImplementation((_cmd: string, _args: string[], opts: { cwd: string }) => {
      const attemptFile = join(opts.cwd, '.ralphex', 'attempt-test-plan.json');
      mkdirSync(join(opts.cwd, '.ralphex'), { recursive: true });
      writeFileSync(attemptFile, JSON.stringify(validAttemptResult()), 'utf8');
      return makeSpawnResult('done', 0);
    }) as SpawnFn;

    const runner = new CodexRunner({ spawnFn });
    await runner.runPlan(repo, planPath, { provider: 'codex', attemptId: 'a-state' });

    const sha256File = join(repo, '.ralphex', 'plan-state', 'test-plan_.sha256');
    const statusFile = join(repo, '.ralphex', 'plan-state', 'test-plan_.status');
    expect(existsSync(sha256File)).toBe(true);
    expect(existsSync(statusFile)).toBe(true);
    expect(readFileSync(sha256File, 'utf8')).toBe(expectedHash);
    expect(readFileSync(statusFile, 'utf8')).toBe('completed');
  });

  it('writes progress log during execution', async () => {
    const { repo, planPath } = setupCodexFixture();

    const spawnFn = vi.fn().mockImplementation((_cmd: string, _args: string[], opts: { cwd: string }) => {
      const attemptFile = join(opts.cwd, '.ralphex', 'attempt-test-plan.json');
      mkdirSync(join(opts.cwd, '.ralphex'), { recursive: true });
      writeFileSync(attemptFile, JSON.stringify(validAttemptResult()), 'utf8');
      return makeSpawnResult('done', 0);
    }) as SpawnFn;

    const runner = new CodexRunner({ spawnFn });
    await runner.runPlan(repo, planPath, { provider: 'codex', attemptId: 'a-progress' });

    const progressFile = join(repo, '.ralphex', 'progress', 'progress-test-plan.txt');
    expect(existsSync(progressFile)).toBe(true);
    const content = readFileSync(progressFile, 'utf8');
    expect(content).toContain('CodexRunner:');
    expect(content).toContain('test-plan');
  });

  it('exit-code-wins: non-zero exit overrides status to failed', async () => {
    const { repo, planPath } = setupCodexFixture();

    // Codex writes a JSON claiming success but exits non-zero
    const spawnFn = vi.fn().mockImplementation((_cmd: string, _args: string[], opts: { cwd: string }) => {
      const attemptFile = join(opts.cwd, '.ralphex', 'attempt-test-plan.json');
      mkdirSync(join(opts.cwd, '.ralphex'), { recursive: true });
      writeFileSync(attemptFile, JSON.stringify(validAttemptResult({ status: 'completed' })), 'utf8');
      return makeSpawnResult('', 1);
    }) as SpawnFn;

    const runner = new CodexRunner({ spawnFn });
    const result = await runner.runPlan(repo, planPath, { provider: 'codex', attemptId: 'a-exit' });

    expect(result.status).toBe('failed');
    expect(result.provider).toBe('codex');
  });

  it('exit-code-wins: classifies rate_limited from stderr when exit non-zero', async () => {
    const { repo, planPath } = setupCodexFixture();

    const spawnFn = vi.fn().mockReturnValue({
      stdout: '',
      stderr: 'HTTP 429 rate limit exceeded',
      status: 1,
      error: undefined,
      pid: 1,
      output: [],
      signal: null,
    } as SpawnSyncReturns<string>);

    const runner = new CodexRunner({ spawnFn });
    const result = await runner.runPlan(repo, planPath, { provider: 'codex', attemptId: 'a-rate' });

    expect(result.status).toBe('failed');
    expect(result.classification).toBe('rate_limited');
  });

  it('exit-code-wins: classifies auth_missing from "401" in output', async () => {
    const { repo, planPath } = setupCodexFixture();

    const spawnFn = vi.fn().mockReturnValue({
      stdout: '401 unauthorized',
      stderr: '',
      status: 1,
      error: undefined,
      pid: 1,
      output: [],
      signal: null,
    } as SpawnSyncReturns<string>);

    const runner = new CodexRunner({ spawnFn });
    const result = await runner.runPlan(repo, planPath, { provider: 'codex', attemptId: 'a-auth' });

    expect(result.classification).toBe('auth_missing');
  });

  it('retry: retries once when exit 0 but AttemptResult JSON is missing', async () => {
    const { repo, planPath } = setupCodexFixture();
    let callCount = 0;

    const spawnFn = vi.fn().mockImplementation((_cmd: string, _args: string[], opts: { cwd: string }) => {
      callCount++;
      if (callCount === 2) {
        // Second call writes the file
        const attemptFile = join(opts.cwd, '.ralphex', 'attempt-test-plan.json');
        mkdirSync(join(opts.cwd, '.ralphex'), { recursive: true });
        writeFileSync(attemptFile, JSON.stringify(validAttemptResult({ tasksCompleted: 3 })), 'utf8');
      }
      return makeSpawnResult('done', 0);
    }) as SpawnFn;

    const runner = new CodexRunner({ spawnFn });
    const result = await runner.runPlan(repo, planPath, { provider: 'codex', attemptId: 'a-retry' });

    expect(callCount).toBe(2);
    expect(result.status).toBe('completed');
    expect(result.tasksCompleted).toBe(3);
  });

  it('synthesizes result from exit code when JSON still missing after retry', async () => {
    const { repo, planPath } = setupCodexFixture();

    // Both calls exit 0 but never write the JSON
    const spawnFn = makeSpawnOk('codex output') as Mock;

    const runner = new CodexRunner({ spawnFn, model: 'gpt-5.5' });
    const result = await runner.runPlan(repo, planPath, { provider: 'codex', attemptId: 'a-synth' });

    expect(spawnFn.mock.calls.length).toBe(2);
    expect(result.status).toBe('completed');
    expect(result.provider).toBe('codex');
    expect(result.classification).toBe('healthy');
    expect(result.branch).toContain('test-plan');
  });

  it('lock is held during codex exec', async () => {
    const { repo, planPath, planContent } = setupCodexFixture();
    const planHash = computePlanHash(planContent);
    let lockHeldDuringExec = false;

    const spawnFn = vi.fn().mockImplementation((_cmd: string, _args: string[], opts: { cwd: string }) => {
      lockHeldDuringExec = isLockHeld(opts.cwd, planHash);
      const attemptFile = join(opts.cwd, '.ralphex', 'attempt-test-plan.json');
      mkdirSync(join(opts.cwd, '.ralphex'), { recursive: true });
      writeFileSync(attemptFile, JSON.stringify(validAttemptResult()), 'utf8');
      return makeSpawnResult('done', 0);
    }) as SpawnFn;

    const runner = new CodexRunner({ spawnFn });
    await runner.runPlan(repo, planPath, { provider: 'codex', attemptId: 'a-lock' });

    expect(lockHeldDuringExec).toBe(true);
    expect(isLockHeld(repo, planHash)).toBe(false); // released after run
  });

  it('codex exec argv: uses workspace-write sandbox, approval never, correct model and cwd', async () => {
    const { repo, planPath } = setupCodexFixture();
    const spawnFn = vi.fn().mockImplementation((_cmd: string, _args: string[], opts: { cwd: string }) => {
      const attemptFile = join(opts.cwd, '.ralphex', 'attempt-test-plan.json');
      mkdirSync(join(opts.cwd, '.ralphex'), { recursive: true });
      writeFileSync(attemptFile, JSON.stringify(validAttemptResult()), 'utf8');
      return makeSpawnResult('done', 0);
    }) as Mock;

    const runner = new CodexRunner({ spawnFn, codexPath: 'codex', model: 'gpt-5.5' });
    await runner.runPlan(repo, planPath, { provider: 'codex', model: 'custom-model', attemptId: 'a-argv' });

    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe('codex');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
    expect(args).toContain('--ask-for-approval');
    expect(args).toContain('never');
    expect(args).toContain('--model');
    expect(args).toContain('custom-model');
    expect(args).toContain(`model_reasoning_effort="${DEFAULT_CODEX_REASONING_EFFORT}"`);
    expect(opts.cwd).toBe(repo);
  });

  it('adapter prompt includes plan file content', async () => {
    const { repo, planPath } = setupCodexFixture('# Plan: My Custom Plan\n\n## Validation Commands\n\n```\npnpm test\n```\n\n### Task 1: Custom task\n\n- [ ] Custom step\n');
    const spawnFn = vi.fn().mockImplementation((_cmd: string, _args: string[], opts: { cwd: string }) => {
      const attemptFile = join(opts.cwd, '.ralphex', 'attempt-test-plan.json');
      mkdirSync(join(opts.cwd, '.ralphex'), { recursive: true });
      writeFileSync(attemptFile, JSON.stringify(validAttemptResult()), 'utf8');
      return makeSpawnResult('done', 0);
    }) as Mock;

    const runner = new CodexRunner({ spawnFn });
    await runner.runPlan(repo, planPath, { provider: 'codex', attemptId: 'a-prompt' });

    const [, args] = spawnFn.mock.calls[0];
    const prompt = args[args.length - 1] as string;
    expect(prompt).toContain('# Plan: My Custom Plan');
    expect(prompt).toContain('Custom task');
    expect(prompt).toContain('Custom step');
    expect(prompt).toContain('feature/test-plan');
  });

  it('writes plan-state as failed when exit code is non-zero', async () => {
    const { repo, planPath } = setupCodexFixture();

    const spawnFn = vi.fn().mockReturnValue(makeSpawnResult('', 1)) as SpawnFn;

    const runner = new CodexRunner({ spawnFn });
    await runner.runPlan(repo, planPath, { provider: 'codex', attemptId: 'a-fail-state' });

    const statusFile = join(repo, '.ralphex', 'plan-state', 'test-plan_.status');
    expect(existsSync(statusFile)).toBe(true);
    expect(readFileSync(statusFile, 'utf8')).toBe('failed');
  });
});

describe('CodexRunner.draftPlan', () => {
  it('returns valid draft for well-formed output', async () => {
    const validPlan = `# Plan: Codex Plan\n\n## Validation Commands\n\n\`\`\`\npnpm test\n\`\`\`\n\n### Task 1: Implement it\n\n- [ ] Do the thing\n`;
    const runner = new CodexRunner({ spawnFn: makeSpawnOk(validPlan), model: 'gpt-5.5' });
    const session: PlanningSession = {
      transcript: ['User: make a plan'],
      targetRepo: 'repo',
      sessionName: 'codex-session',
    };
    const result = await runner.draftPlan(session, '/workspace/repo');
    expect(result.valid).toBe(true);
    expect(result.markdown).toContain('# Plan: Codex Plan');
  });
});

// ── parseDraftPlanOutput ────────────────────────────────────────────────────

describe('parseDraftPlanOutput', () => {
  it('returns valid for well-formed plan', () => {
    const md = `# Plan: My Plan\n\n## Validation Commands\n\n\`\`\`\npnpm test\n\`\`\`\n\n### Task 1: Do it\n\n- [ ] step\n`;
    const result = parseDraftPlanOutput(md, 'test');
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('warns about missing # Plan: header', () => {
    const md = `## Validation Commands\n\`\`\`\npnpm test\n\`\`\`\n### Task 1: x\n- [ ] y\n`;
    const result = parseDraftPlanOutput(md, 'test');
    expect(result.warnings.some(w => w.includes('# Plan:'))).toBe(true);
    expect(result.valid).toBe(false);
  });

  it('warns about * [ ] bullets', () => {
    const md = `# Plan: X\n## Validation Commands\n\`\`\`\npnpm test\n\`\`\`\n### Task 1: x\n* [ ] bad bullet\n`;
    const result = parseDraftPlanOutput(md, 'test');
    expect(result.warnings.some(w => w.includes('* [ ]'))).toBe(true);
  });

  it('returns fallback plan for empty output', () => {
    const result = parseDraftPlanOutput('', 'my-session');
    expect(result.valid).toBe(false);
    expect(result.warnings).toContain('Empty output from provider');
    expect(result.markdown).toContain('# Plan:');
  });
});

// ── buildDraftPlanPrompt ────────────────────────────────────────────────────

describe('buildDraftPlanPrompt', () => {
  it('includes session transcript and target repo', () => {
    const session: PlanningSession = {
      transcript: ['User: I need X', 'Bot: ok'],
      targetRepo: 'myrepo',
      sessionName: 'sess-1',
    };
    const prompt = buildDraftPlanPrompt(session);
    expect(prompt).toContain('User: I need X');
    expect(prompt).toContain('Bot: ok');
    expect(prompt).toContain('myrepo');
    expect(prompt).toContain('sess-1');
  });

  it('instructs to use - [ ] not * [ ]', () => {
    const session: PlanningSession = {
      transcript: [],
      targetRepo: 'r',
      sessionName: 's',
    };
    const prompt = buildDraftPlanPrompt(session);
    expect(prompt).toContain('- [ ]');
    expect(prompt).toContain('NOT * [ ]');
  });
});

// ── ProviderRegistry ────────────────────────────────────────────────────────

describe('ProviderRegistry', () => {
  it('defaults to codex with claude-code fallback', () => {
    expect(DEFAULT_PROVIDER_POLICY.prefer).toBe('codex');
    expect(DEFAULT_PROVIDER_POLICY.fallback_order).toEqual(['codex', 'claude-code']);
  });

  it('returns null for unregistered provider', () => {
    const registry = new ProviderRegistry();
    expect(registry.get('claude-code')).toBeNull();
  });

  it('returns registered runner', () => {
    const registry = new ProviderRegistry();
    const runner = new ClaudeCodeRunner({ spawnFn: makeSpawnOk() });
    registry.register(runner);
    expect(registry.get('claude-code')).toBe(runner);
  });

  describe('selectProvider', () => {
    it('returns preferred provider when available', async () => {
      const registry = new ProviderRegistry();
      const ccRunner = new ClaudeCodeRunner({ spawnFn: makeSpawnOk('claude 2.0') });
      const codexRunner = new CodexRunner({ spawnFn: makeSpawnOk('codex 1.0') });
      process.env['OPENAI_API_KEY'] = 'test-key';
      registry.register(ccRunner);
      registry.register(codexRunner);

      const policy: ProviderPolicy = {
        prefer: 'claude-code',
        fallback_order: ['claude-code', 'codex'],
        switch_on: {},
      };
      const result = await registry.selectProvider(policy);
      expect(result?.providerName).toBe('claude-code');
      delete process.env['OPENAI_API_KEY'];
    });

    it('falls back when preferred provider is unavailable', async () => {
      const registry = new ProviderRegistry();
      const ccRunner = new ClaudeCodeRunner({ spawnFn: makeSpawnFail() });
      process.env['OPENAI_API_KEY'] = 'test-key';
      const codexRunner = new CodexRunner({ spawnFn: makeSpawnOk('codex 1.0') });
      registry.register(ccRunner);
      registry.register(codexRunner);

      const policy: ProviderPolicy = {
        prefer: 'claude-code',
        fallback_order: ['claude-code', 'codex'],
        switch_on: {},
      };
      const result = await registry.selectProvider(policy);
      expect(result?.providerName).toBe('codex');
      delete process.env['OPENAI_API_KEY'];
    });

    it('skips preferred on provider_rate_limited trigger when switch_on enabled', async () => {
      const registry = new ProviderRegistry();
      const ccRunner = new ClaudeCodeRunner({ spawnFn: makeSpawnOk('claude 2.0') });
      process.env['OPENAI_API_KEY'] = 'test-key';
      const codexRunner = new CodexRunner({ spawnFn: makeSpawnOk('codex 1.0') });
      registry.register(ccRunner);
      registry.register(codexRunner);

      const policy: ProviderPolicy = {
        prefer: 'claude-code',
        fallback_order: ['claude-code', 'codex'],
        switch_on: { provider_rate_limited: true },
      };
      const result = await registry.selectProvider(policy, 'provider_rate_limited');
      expect(result?.providerName).toBe('codex');
      delete process.env['OPENAI_API_KEY'];
    });

    it('does NOT skip preferred for startup_stall_repeated when switch_on=false', async () => {
      const registry = new ProviderRegistry();
      const ccRunner = new ClaudeCodeRunner({ spawnFn: makeSpawnOk('claude 2.0') });
      const codexRunner = new CodexRunner({ spawnFn: makeSpawnOk('codex 1.0') });
      process.env['OPENAI_API_KEY'] = 'test-key';
      registry.register(ccRunner);
      registry.register(codexRunner);

      const policy: ProviderPolicy = {
        prefer: 'claude-code',
        fallback_order: ['claude-code', 'codex'],
        switch_on: { startup_stall_repeated: false },
      };
      const result = await registry.selectProvider(policy, 'startup_stall_repeated');
      expect(result?.providerName).toBe('claude-code');
      delete process.env['OPENAI_API_KEY'];
    });

    it('returns null when no providers available', async () => {
      const registry = new ProviderRegistry();
      const ccRunner = new ClaudeCodeRunner({ spawnFn: makeSpawnFail() });
      const codexRunner = new CodexRunner({ spawnFn: makeSpawnError() });
      registry.register(ccRunner);
      registry.register(codexRunner);

      const result = await registry.selectProvider(DEFAULT_PROVIDER_POLICY);
      expect(result).toBeNull();
    });

    it('skips preferred on provider_auth_unavailable when switch_on enabled', async () => {
      const registry = new ProviderRegistry();
      const ccRunner = new ClaudeCodeRunner({ spawnFn: makeSpawnOk('claude') });
      process.env['OPENAI_API_KEY'] = 'key';
      const codexRunner = new CodexRunner({ spawnFn: makeSpawnOk('codex') });
      registry.register(ccRunner);
      registry.register(codexRunner);

      const policy: ProviderPolicy = {
        prefer: 'claude-code',
        fallback_order: ['claude-code', 'codex'],
        switch_on: { provider_auth_unavailable: true },
      };
      const result = await registry.selectProvider(policy, 'provider_auth_unavailable');
      expect(result?.providerName).toBe('codex');
      delete process.env['OPENAI_API_KEY'];
    });
  });
});

// ── Provider policy via server ──────────────────────────────────────────────

describe('provider policy via server', () => {
  it('GET /api/provider-policy returns default policy shape', async () => {
    const { createServer } = await import('../../src/server');
    const { openDatabase } = await import('../../src/db');
    const { mkdtempSync: mkd } = await import('fs');
    const { tmpdir: td } = await import('os');
    const { join: j } = await import('path');

    const tmp = mkd(j(td(), 'cp-providers-test-'));
    const db = openDatabase(j(tmp, 'test.db'));
    const app = await createServer({
      workspaceRoot: tmp,
      orchestratorDbPath: j(tmp, 'test.db'),
      claimsDir: j(tmp, 'claims'),
      password: 'pw',
      sessionSecret: 'secret-secret-32-chars-padding!!',
      port: 0,
      host: '127.0.0.1',
    }, db);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'password=pw',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cookieStr = (loginRes.headers['set-cookie'] as string).split(';')[0];

    const res = await app.inject({
      method: 'GET',
      url: '/api/provider-policy',
      headers: { cookie: cookieStr },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ProviderPolicy;
    expect(body.prefer).toBeDefined();
    expect(Array.isArray(body.fallback_order)).toBe(true);
    expect(typeof body.switch_on).toBe('object');
  });

  it('PUT /api/provider-policy updates prefer field', async () => {
    const { createServer } = await import('../../src/server');
    const { openDatabase } = await import('../../src/db');
    const { mkdtempSync: mkd } = await import('fs');
    const { tmpdir: td } = await import('os');
    const { join: j } = await import('path');

    const tmp = mkd(j(td(), 'cp-providers-put-'));
    const db = openDatabase(j(tmp, 'test.db'));
    const app = await createServer({
      workspaceRoot: tmp,
      orchestratorDbPath: j(tmp, 'test.db'),
      claimsDir: j(tmp, 'claims'),
      password: 'pw',
      sessionSecret: 'secret-secret-32-chars-padding!!',
      port: 0,
      host: '127.0.0.1',
    }, db);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'password=pw',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cookieStr = (loginRes.headers['set-cookie'] as string).split(';')[0];

    const res = await app.inject({
      method: 'PUT',
      url: '/api/provider-policy',
      headers: { cookie: cookieStr, 'content-type': 'application/json' },
      payload: JSON.stringify({ prefer: 'codex' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ProviderPolicy;
    expect(body.prefer).toBe('codex');
  });
});
