import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { AttemptResult, ProviderName, ProviderStatus } from './contracts';

// ── Types ──────────────────────────────────────────────────────────────────

export type InspectionMode = 'readonly' | 'workspace-write';

export interface InspectionResult {
  question: string;
  answer: string;
  mode: InspectionMode;
  provider: ProviderName;
}

export interface PlanningSession {
  transcript: string[];
  targetRepo: string;
  sessionName: string;
}

export interface DraftPlanResult {
  markdown: string;
  valid: boolean;
  warnings: string[];
}

export interface AttemptConfig {
  provider: ProviderName;
  model?: string;
  attemptId: string;
}

export interface AgentRunner {
  readonly providerName: ProviderName;
  runPlan(repo: string, planPath: string, config: AttemptConfig): Promise<AttemptResult>;
  inspect(repo: string, question: string, mode: InspectionMode): Promise<InspectionResult>;
  draftPlan(session: PlanningSession, repo: string): Promise<DraftPlanResult>;
  availability(): Promise<ProviderStatus>;
}

export type ProviderSwitchTrigger =
  | 'provider_rate_limited'
  | 'provider_auth_unavailable'
  | 'startup_stall_repeated'
  | 'transient_timeout_repeated';

export interface ProviderPolicy {
  prefer: ProviderName;
  fallback_order: ProviderName[];
  switch_on: Partial<Record<ProviderSwitchTrigger, boolean>>;
}

export const DEFAULT_PROVIDER_POLICY: ProviderPolicy = {
  prefer: 'claude-code',
  fallback_order: ['claude-code', 'codex'],
  switch_on: {
    provider_rate_limited: true,
    provider_auth_unavailable: true,
    startup_stall_repeated: false,
    transient_timeout_repeated: false,
  },
};

// Spawn abstraction — injectable for testing.
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; encoding: 'utf8' }
) => SpawnSyncReturns<string>;

// ── argv builders (pure, no side-effects, directly testable) ───────────────

export function buildFyaArgv(opts: {
  planRelPath: string;
  fyaPath?: string;
  externalReview?: string;
}): string[] {
  return [
    '--no-color',
    `--claude-command=${opts.fyaPath ?? '/usr/local/bin/fya-wrapper.sh'}`,
    `--external-review-tool=${opts.externalReview ?? 'none'}`,
    opts.planRelPath,
  ];
}

export function buildCodexExecArgv(opts: {
  prompt: string;
  sandbox: 'read-only' | 'workspace-write';
  model: string;
  approvalMode?: 'never' | 'auto';
}): string[] {
  return [
    'exec',
    '--sandbox', opts.sandbox,
    '--approval', opts.approvalMode ?? 'never',
    '--model', opts.model,
    opts.prompt,
  ];
}

// ── Draft plan helpers ─────────────────────────────────────────────────────

export function buildDraftPlanPrompt(session: PlanningSession): string {
  const transcript = session.transcript.join('\n');
  return `You are a software planning assistant. Based on the following planning session, generate a ralphex-format markdown plan.

REQUIRED FORMAT:
- First line: # Plan: <title>
- Include: ## Validation Commands section with a fenced code block
- Task sections numbered from 1: ### Task 1: <title>
- Use - [ ] checkboxes (NOT * [ ])
- Do NOT use Task 0

Planning session (${session.sessionName}):
${transcript}

Target repository: ${session.targetRepo}

Output ONLY the markdown plan, nothing else.`;
}

export function parseDraftPlanOutput(output: string, fallbackName: string): DraftPlanResult {
  const markdown = output.trim();
  const warnings: string[] = [];

  if (!markdown) {
    return {
      markdown: generateFallbackPlan(fallbackName),
      valid: false,
      warnings: ['Empty output from provider'],
    };
  }

  if (!/^#\s+Plan:/m.test(markdown)) warnings.push('Missing # Plan: header');
  if (!/^##\s+Validation Commands/m.test(markdown)) warnings.push('Missing ## Validation Commands section');
  if (!/^###\s+(?:Task|Iteration)\s+[1-9]/m.test(markdown)) warnings.push('Missing ### Task N: sections (must start from 1)');
  if (/^\s*\* \[[ x]\]/m.test(markdown)) warnings.push('Uses * [ ] bullets instead of - [ ]');

  return { markdown, valid: warnings.length === 0, warnings };
}

function generateFallbackPlan(name: string): string {
  const title = name || 'New Plan';
  return `# Plan: ${title}\n\n## Validation Commands\n\n\`\`\`\npnpm test\n\`\`\`\n\n### Task 1: Implement ${title}\n\n- [ ] Implement the feature\n`;
}

// ── ClaudeCodeRunner ───────────────────────────────────────────────────────

export class ClaudeCodeRunner implements AgentRunner {
  readonly providerName: ProviderName = 'claude-code';
  private readonly spawnFn: SpawnFn;
  private readonly ralphexPath: string;
  private readonly fyaPath: string;
  private readonly claudePath: string;

  constructor(opts: {
    spawnFn?: SpawnFn;
    ralphexPath?: string;
    fyaPath?: string;
    claudePath?: string;
  } = {}) {
    this.spawnFn = opts.spawnFn ?? (spawnSync as SpawnFn);
    this.ralphexPath = opts.ralphexPath ?? 'ralphex';
    this.fyaPath = opts.fyaPath ?? '/usr/local/bin/fya-wrapper.sh';
    this.claudePath = opts.claudePath ?? 'claude';
  }

  async availability(): Promise<ProviderStatus> {
    const result = this.spawnFn(this.claudePath, ['--version'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      return { available: false, reason: 'auth_missing' };
    }
    return { available: true };
  }

  async runPlan(repo: string, planPath: string, config: AttemptConfig): Promise<AttemptResult> {
    const now = new Date().toISOString();
    const argv = buildFyaArgv({ planRelPath: planPath, fyaPath: this.fyaPath });
    const result = this.spawnFn(this.ralphexPath, argv, { cwd: repo, encoding: 'utf8' });
    const status = result.error || result.status !== 0 ? 'failed' : 'completed';
    return {
      status,
      provider: 'claude-code',
      model: config.model ?? 'claude-code-default',
      branch: '',
      tasksCompleted: 0,
      commits: [],
      validation: { status: 'skipped' },
      classification: status === 'failed' ? 'dead_loop' : 'healthy',
      summary: (result.stdout ?? '') + (result.stderr ?? ''),
      startedAt: now,
      endedAt: new Date().toISOString(),
    };
  }

  async inspect(repo: string, question: string, mode: InspectionMode): Promise<InspectionResult> {
    const args = ['-p', question, '--dangerously-skip-permissions'];
    if (mode === 'readonly') args.push('--no-file-access');
    const result = this.spawnFn(this.claudePath, args, { cwd: repo, encoding: 'utf8' });
    return { question, answer: result.stdout ?? '', mode, provider: 'claude-code' };
  }

  async draftPlan(session: PlanningSession, repo: string): Promise<DraftPlanResult> {
    const prompt = buildDraftPlanPrompt(session);
    const result = this.spawnFn(
      this.claudePath,
      ['-p', prompt, '--dangerously-skip-permissions'],
      { cwd: repo, encoding: 'utf8' }
    );
    return parseDraftPlanOutput(result.stdout ?? '', session.sessionName);
  }
}

// ── CodexRunner ────────────────────────────────────────────────────────────

export class CodexRunner implements AgentRunner {
  readonly providerName: ProviderName = 'codex';
  private readonly spawnFn: SpawnFn;
  private readonly codexPath: string;
  readonly model: string;

  constructor(opts: {
    spawnFn?: SpawnFn;
    codexPath?: string;
    model?: string;
  } = {}) {
    this.spawnFn = opts.spawnFn ?? (spawnSync as SpawnFn);
    this.codexPath = opts.codexPath ?? 'codex';
    this.model = opts.model ?? 'gpt-5.1-codex';
  }

  async availability(): Promise<ProviderStatus> {
    const result = this.spawnFn(this.codexPath, ['--version'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      return { available: false, reason: 'tool_missing' };
    }
    if (!process.env['OPENAI_API_KEY']) {
      return { available: false, reason: 'auth_missing' };
    }
    return { available: true };
  }

  async runPlan(_repo: string, _planPath: string, config: AttemptConfig): Promise<AttemptResult> {
    // Full implementation is Task 7; returning a clear stub result.
    const now = new Date().toISOString();
    return {
      status: 'failed',
      provider: 'codex',
      model: config.model ?? this.model,
      branch: '',
      tasksCompleted: 0,
      commits: [],
      validation: { status: 'skipped' },
      classification: 'tool_missing',
      summary: 'CodexRunner.runPlan not yet implemented (see Task 7)',
      startedAt: now,
      endedAt: new Date().toISOString(),
    };
  }

  async inspect(repo: string, question: string, mode: InspectionMode): Promise<InspectionResult> {
    const sandbox: 'read-only' | 'workspace-write' =
      mode === 'readonly' ? 'read-only' : 'workspace-write';
    const args = buildCodexExecArgv({ prompt: question, sandbox, model: this.model });
    const result = this.spawnFn(this.codexPath, args, { cwd: repo, encoding: 'utf8' });
    return { question, answer: result.stdout ?? '', mode, provider: 'codex' };
  }

  async draftPlan(session: PlanningSession, repo: string): Promise<DraftPlanResult> {
    const prompt = buildDraftPlanPrompt(session);
    const args = buildCodexExecArgv({ prompt, sandbox: 'read-only', model: this.model });
    const result = this.spawnFn(this.codexPath, args, { cwd: repo, encoding: 'utf8' });
    return parseDraftPlanOutput(result.stdout ?? '', session.sessionName);
  }
}

// ── ProviderRegistry ───────────────────────────────────────────────────────

export class ProviderRegistry {
  private runners = new Map<ProviderName, AgentRunner>();

  register(runner: AgentRunner): void {
    this.runners.set(runner.providerName, runner);
  }

  get(name: ProviderName): AgentRunner | null {
    return this.runners.get(name) ?? null;
  }

  /**
   * Pick the best available runner given the policy and an optional trigger.
   *
   * If a trigger is active and the policy has switch_on[trigger]=true, the
   * preferred provider is skipped and the first available fallback is returned.
   * Without a trigger, the preferred provider is tried first, then fallbacks.
   */
  async selectProvider(
    policy: ProviderPolicy,
    trigger?: ProviderSwitchTrigger
  ): Promise<AgentRunner | null> {
    const shouldSwitch =
      trigger !== undefined &&
      (policy.switch_on[trigger] ?? false) &&
      (trigger === 'provider_rate_limited' || trigger === 'provider_auth_unavailable');

    const order = shouldSwitch
      ? policy.fallback_order.filter(p => p !== policy.prefer)
      : [policy.prefer, ...policy.fallback_order.filter(p => p !== policy.prefer)];

    for (const name of order) {
      const runner = this.runners.get(name);
      if (!runner) continue;
      const status = await runner.availability();
      if (status.available) return runner;
    }
    return null;
  }
}
