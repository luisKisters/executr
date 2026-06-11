import { describe, it, expect, vi, type Mock } from 'vitest';
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
  type SpawnFn,
  type ProviderPolicy,
  type PlanningSession,
} from '../../src/providers';

// ── Spawn mock helpers ──────────────────────────────────────────────────────

function makeSpawnOk(stdout = ''): SpawnFn {
  return vi.fn().mockReturnValue({
    stdout,
    stderr: '',
    status: 0,
    error: undefined,
    pid: 1,
    output: [],
    signal: null,
  } as SpawnSyncReturns<string>);
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
  return vi.fn().mockReturnValue({
    stdout: '',
    stderr: '',
    status: null,
    error: new Error('ENOENT'),
    pid: -1,
    output: [],
    signal: null,
  } as unknown as SpawnSyncReturns<string>);
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
      model: 'gpt-5.1-codex',
    });
    expect(argv[0]).toBe('exec');
    expect(argv).toContain('--sandbox');
    expect(argv).toContain('read-only');
    expect(argv).toContain('--approval');
    expect(argv).toContain('never');
    expect(argv).toContain('--model');
    expect(argv).toContain('gpt-5.1-codex');
    expect(argv[argv.length - 1]).toBe('inspect the codebase');
  });

  it('uses workspace-write sandbox', () => {
    const argv = buildCodexExecArgv({
      prompt: 'fix bug',
      sandbox: 'workspace-write',
      model: 'gpt-5.1-codex',
    });
    expect(argv).toContain('workspace-write');
  });

  it('passes through custom approvalMode', () => {
    const argv = buildCodexExecArgv({
      prompt: 'q',
      sandbox: 'read-only',
      model: 'm',
      approvalMode: 'auto',
    });
    expect(argv).toContain('auto');
    expect(argv).not.toContain('never');
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

  it('returns unavailable when OPENAI_API_KEY missing', async () => {
    const original = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    try {
      const runner = new CodexRunner({ spawnFn: makeSpawnOk('codex 1.0') });
      const status = await runner.availability();
      expect(status.available).toBe(false);
      expect(status.reason).toBe('auth_missing');
    } finally {
      if (original !== undefined) process.env['OPENAI_API_KEY'] = original;
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
});

describe('CodexRunner.inspect', () => {
  it('builds correct argv with exec subcommand', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    const spawnFn = makeSpawnOk('inspection result') as Mock;
    const runner = new CodexRunner({ spawnFn, codexPath: 'codex', model: 'gpt-5.1-codex' });
    const result = await runner.inspect('/repo', 'check for bugs', 'readonly');

    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe('codex');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.1-codex');
    expect(args[args.length - 1]).toBe('check for bugs');
    expect(opts.cwd).toBe('/repo');
    expect(result.answer).toBe('inspection result');
    expect(result.provider).toBe('codex');
    delete process.env['OPENAI_API_KEY'];
  });

  it('uses workspace-write sandbox for workspace-write mode', async () => {
    const spawnFn = makeSpawnOk() as Mock;
    const runner = new CodexRunner({ spawnFn, model: 'gpt-5.1-codex' });
    await runner.inspect('/repo', 'fix it', 'workspace-write');
    const [, args] = spawnFn.mock.calls[0];
    expect(args).toContain('workspace-write');
    expect(args).not.toContain('read-only');
  });
});

describe('CodexRunner.runPlan', () => {
  it('returns stub failed result (Task 7 not yet implemented)', async () => {
    const runner = new CodexRunner({ spawnFn: makeSpawnOk() });
    const result = await runner.runPlan('/repo', 'plan.md', {
      provider: 'codex',
      attemptId: 'a1',
    });
    expect(result.status).toBe('failed');
    expect(result.provider).toBe('codex');
    expect(result.summary).toContain('Task 7');
  });
});

describe('CodexRunner.draftPlan', () => {
  it('returns valid draft for well-formed output', async () => {
    const validPlan = `# Plan: Codex Plan\n\n## Validation Commands\n\n\`\`\`\npnpm test\n\`\`\`\n\n### Task 1: Implement it\n\n- [ ] Do the thing\n`;
    const runner = new CodexRunner({ spawnFn: makeSpawnOk(validPlan), model: 'gpt-5.1-codex' });
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

// ── Provider policy API ─────────────────────────────────────────────────────

describe('provider policy via server', () => {
  it('GET /api/provider-policy returns default policy shape', async () => {
    const { createServer } = await import('../../src/server');
    const { openDatabase } = await import('../../src/db');
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');

    const tmp = mkdtempSync(join(tmpdir(), 'cp-providers-test-'));
    const db = openDatabase(join(tmp, 'test.db'));
    const app = await createServer({
      workspaceRoot: tmp,
      orchestratorDbPath: join(tmp, 'test.db'),
      claimsDir: join(tmp, 'claims'),
      password: 'pw',
      sessionSecret: 'secret-secret-32-chars-padding!!',
      port: 0,
      host: '127.0.0.1',
    }, db);

    // Login
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
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');

    const tmp = mkdtempSync(join(tmpdir(), 'cp-providers-put-'));
    const db = openDatabase(join(tmp, 'test.db'));
    const app = await createServer({
      workspaceRoot: tmp,
      orchestratorDbPath: join(tmp, 'test.db'),
      claimsDir: join(tmp, 'claims'),
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
