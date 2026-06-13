import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CONTROL_PLANE_PROVIDER,
  type AttemptResult,
  type ProviderName,
  type ProviderStatus,
  type ClassificationSignal,
} from './contracts';
import { acquireLock } from './claims';

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
  reasoningEffort?: string;
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
  prefer: DEFAULT_CONTROL_PLANE_PROVIDER,
  fallback_order: ['codex', 'claude-code'],
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
  reasoningEffort?: string;
  approvalMode?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
}): string[] {
  return [
    'exec',
    '--sandbox', opts.sandbox,
    '--ask-for-approval', opts.approvalMode ?? 'never',
    '--model', opts.model,
    '-c', `model_reasoning_effort="${opts.reasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT}"`,
    opts.prompt,
  ];
}

// ── Codex runPlan helpers (pure, testable) ─────────────────────────────────

export function computePlanHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function appendProgressLog(filePath: string, msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(filePath, line, 'utf8');
  } catch {
    // best-effort; directory may not exist yet
  }
}

export function buildCodexRunPlanPrompt(opts: {
  planPath: string;
  planContent: string;
  planSlug: string;
  planHash: string;
  attemptResultPath: string;
  progressPath: string;
  planStatePath: string;
}): string {
  return `You are implementing the following software plan. Execute all tasks completely.

PLAN FILE PATH: ${opts.planPath}

PLAN CONTENT:
${opts.planContent}

EXECUTION INSTRUCTIONS:
1. Create a feature branch:
   git checkout -b feature/${opts.planSlug} 2>/dev/null || git switch feature/${opts.planSlug}

2. For each "### Task N:" section in the plan, in order:
   a. Implement ALL "- [ ]" checkboxes in that task section
   b. Stage and commit: git add -A && git commit -m "feat: implement Task N"
   c. Append to progress: printf '[%s] Task N completed\\n' "$(date -Iseconds)" >> ${opts.progressPath}

3. Run any validation commands from the "## Validation Commands" section.

4. Push the branch: git push -u origin feature/${opts.planSlug} --force-with-lease

5. Open a PR if none exists:
   gh pr create --title "Plan: ${opts.planSlug}" --body "Automated execution by CodexRunner" || true

6. Write plan-state files:
   printf '%s' "${opts.planHash}" > ${opts.planStatePath}.sha256
   printf 'completed' > ${opts.planStatePath}.status

7. REQUIRED — write the result JSON to ${opts.attemptResultPath}:
{
  "status": "<completed|failed|needs_review>",
  "provider": "codex",
  "model": "<actual-model-name>",
  "branch": "feature/${opts.planSlug}",
  "tasksCompleted": <number-of-tasks-completed>,
  "commits": [<list-of-commit-shas>],
  "validation": { "status": "<passed|failed|skipped>" },
  "classification": "<see-below>",
  "summary": "<brief-summary>",
  "startedAt": "<ISO-8601-timestamp>",
  "endedAt": "<ISO-8601-timestamp>"
}

Valid classification values: healthy, long_running_but_active, known_startup_stall, rate_limited,
waiting_for_human, failed_finalize, dirty_tree_blocked, auth_missing, tool_missing, dead_loop.
Use "healthy" for successful completion. Use "failed_finalize" if push/PR failed.
Use "rate_limited" for quota errors. Use "auth_missing" for API key errors.
Use "dead_loop" for other failures.

IMPORTANT RULES:
- Commit messages MUST include "Task N" (e.g. "feat: implement database schema Task 1")
- ALWAYS write ${opts.attemptResultPath} even if tasks fail
- Mark plan-state as "failed" if any tasks could not be completed
- Do NOT mark tasks as done without implementing them`;
}

export function mapCodexExitToClassification(
  stdout: string,
  stderr: string,
  exitCode: number | null
): ClassificationSignal {
  if (exitCode === 0) return 'healthy';
  const combined = (stdout + stderr).toLowerCase();
  if (combined.includes('rate limit') || combined.includes('429') || combined.includes('quota exceeded')) {
    return 'rate_limited';
  }
  if (
    combined.includes('auth') ||
    combined.includes('401') ||
    combined.includes('403') ||
    combined.includes('api key') ||
    combined.includes('openai_api_key') ||
    combined.includes('invalid_api_key')
  ) {
    return 'auth_missing';
  }
  if (
    (combined.includes('push') && (combined.includes('rejected') || combined.includes('failed'))) ||
    combined.includes('failed_finalize')
  ) {
    return 'failed_finalize';
  }
  if (
    combined.includes('enoent') ||
    combined.includes('command not found') ||
    combined.includes('no such file')
  ) {
    return 'tool_missing';
  }
  return 'dead_loop';
}

export function readAttemptResultFile(filePath: string): AttemptResult | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed['status'] !== 'string' ||
      typeof parsed['provider'] !== 'string' ||
      typeof parsed['model'] !== 'string' ||
      typeof parsed['summary'] !== 'string'
    ) {
      return null;
    }
    return parsed as unknown as AttemptResult;
  } catch {
    return null;
  }
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
  readonly reasoningEffort: string;

  constructor(opts: {
    spawnFn?: SpawnFn;
    codexPath?: string;
    model?: string;
    reasoningEffort?: string;
  } = {}) {
    this.spawnFn = opts.spawnFn ?? (spawnSync as SpawnFn);
    this.codexPath = opts.codexPath ?? 'codex';
    this.model = opts.model ?? DEFAULT_CODEX_MODEL;
    this.reasoningEffort = opts.reasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT;
  }

  async availability(): Promise<ProviderStatus> {
    const result = this.spawnFn(this.codexPath, ['--version'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      return { available: false, reason: 'tool_missing' };
    }
    const codexHome = process.env['CODEX_HOME'] ?? join(process.env['HOME'] ?? '', '.codex');
    const hasAuthFile = codexHome ? existsSync(join(codexHome, 'auth.json')) : false;
    if (!process.env['OPENAI_API_KEY'] && !hasAuthFile) {
      return { available: false, reason: 'auth_missing' };
    }
    return { available: true };
  }

  async runPlan(repo: string, planPath: string, config: AttemptConfig): Promise<AttemptResult> {
    const startedAt = new Date().toISOString();

    // Read plan file to build prompt and compute hash
    let planContent: string;
    try {
      planContent = readFileSync(join(repo, planPath), 'utf8');
    } catch {
      return {
        status: 'failed',
        provider: 'codex',
        model: config.model ?? this.model,
        branch: '',
        tasksCompleted: 0,
        commits: [],
        validation: { status: 'skipped' },
        classification: 'tool_missing',
        summary: `Could not read plan file: ${planPath}`,
        startedAt,
        endedAt: new Date().toISOString(),
      };
    }

    const planSlug = basename(planPath, '.md');
    const planHash = computePlanHash(planContent);

    // Acquire per-(repo, planHash) in-process lock for the whole run
    const releaseLock = await acquireLock(repo, planHash);

    try {
      const ralphexDir = join(repo, '.ralphex');
      const progressDir = join(ralphexDir, 'progress');
      const planStateDir = join(ralphexDir, 'plan-state');
      const attemptFile = join(ralphexDir, `attempt-${planSlug}.json`);
      const progressFile = join(progressDir, `progress-${planSlug}.txt`);

      mkdirSync(progressDir, { recursive: true });
      mkdirSync(planStateDir, { recursive: true });

      appendProgressLog(progressFile, `CodexRunner: starting execution of ${planSlug}`);

      const prompt = buildCodexRunPlanPrompt({
        planPath,
        planContent,
        planSlug,
        planHash,
        attemptResultPath: `.ralphex/attempt-${planSlug}.json`,
        progressPath: `.ralphex/progress/progress-${planSlug}.txt`,
        planStatePath: `.ralphex/plan-state/${planSlug}_`,
      });

      const argv = buildCodexExecArgv({
        prompt,
        sandbox: 'workspace-write',
        model: config.model ?? this.model,
        reasoningEffort: config.reasoningEffort ?? this.reasoningEffort,
      });

      // First run
      const result1 = this.spawnFn(this.codexPath, argv, { cwd: repo, encoding: 'utf8' });
      const exitCode1 = result1.status;
      const stdout1 = result1.stdout ?? '';
      const stderr1 = result1.stderr ?? '';

      // exit-code-wins: non-zero exit → failure regardless of JSON content
      if (exitCode1 !== 0 || result1.error) {
        const classification = mapCodexExitToClassification(stdout1, stderr1, exitCode1);
        const endedAt = new Date().toISOString();

        let parsed = readAttemptResultFile(attemptFile);
        if (parsed) {
          // Honour Codex-written JSON but override status/classification with exit code verdict
          parsed = { ...parsed, status: 'failed', classification, endedAt, provider: 'codex' };
        }

        const finalResult: AttemptResult = parsed ?? {
          status: 'failed',
          provider: 'codex',
          model: config.model ?? this.model,
          branch: '',
          tasksCompleted: 0,
          commits: [],
          validation: { status: 'skipped' },
          classification,
          summary: stdout1 + (stderr1 ? '\n' + stderr1 : ''),
          startedAt,
          endedAt,
        };

        writeFileSync(join(planStateDir, `${planSlug}_.sha256`), planHash, 'utf8');
        writeFileSync(join(planStateDir, `${planSlug}_.status`), 'failed', 'utf8');
        writeFileSync(attemptFile, JSON.stringify(finalResult), 'utf8');
        appendProgressLog(progressFile, `CodexRunner: failed (exit ${String(exitCode1)})`);

        return finalResult;
      }

      // Exit 0 — try to read AttemptResult JSON that Codex should have written
      let parsed = readAttemptResultFile(attemptFile);

      // Retry once if missing or malformed
      if (!parsed) {
        appendProgressLog(progressFile, 'CodexRunner: attempt-result missing/malformed, retrying');

        const result2 = this.spawnFn(this.codexPath, argv, { cwd: repo, encoding: 'utf8' });
        const exitCode2 = result2.status;
        const stdout2 = result2.stdout ?? '';
        const stderr2 = result2.stderr ?? '';

        if (exitCode2 !== 0 || result2.error) {
          const classification = mapCodexExitToClassification(stdout2, stderr2, exitCode2);
          const endedAt = new Date().toISOString();
          const finalResult: AttemptResult = {
            status: 'failed',
            provider: 'codex',
            model: config.model ?? this.model,
            branch: '',
            tasksCompleted: 0,
            commits: [],
            validation: { status: 'skipped' },
            classification,
            summary: stdout2 + (stderr2 ? '\n' + stderr2 : ''),
            startedAt,
            endedAt,
          };
          writeFileSync(join(planStateDir, `${planSlug}_.sha256`), planHash, 'utf8');
          writeFileSync(join(planStateDir, `${planSlug}_.status`), 'failed', 'utf8');
          writeFileSync(attemptFile, JSON.stringify(finalResult), 'utf8');
          appendProgressLog(progressFile, `CodexRunner: retry failed (exit ${String(exitCode2)})`);
          return finalResult;
        }

        parsed = readAttemptResultFile(attemptFile);
      }

      // Synthesize if still missing after retry (Codex forgot to write it)
      const endedAt = new Date().toISOString();
      const finalResult: AttemptResult = parsed
        ? { ...parsed, provider: 'codex', endedAt }
        : {
            status: 'completed',
            provider: 'codex',
            model: config.model ?? this.model,
            branch: `feature/${planSlug}`,
            tasksCompleted: 0,
            commits: [],
            validation: { status: 'skipped' },
            classification: 'healthy',
            summary: stdout1,
            startedAt,
            endedAt,
          };

      const planStatus = finalResult.status === 'completed' ? 'completed' : 'failed';
      writeFileSync(join(planStateDir, `${planSlug}_.sha256`), planHash, 'utf8');
      writeFileSync(join(planStateDir, `${planSlug}_.status`), planStatus, 'utf8');
      writeFileSync(attemptFile, JSON.stringify(finalResult), 'utf8');
      appendProgressLog(progressFile, `CodexRunner: completed with status=${finalResult.status}`);

      return finalResult;
    } finally {
      releaseLock();
    }
  }

  async inspect(repo: string, question: string, mode: InspectionMode): Promise<InspectionResult> {
    const sandbox: 'read-only' | 'workspace-write' =
      mode === 'readonly' ? 'read-only' : 'workspace-write';
    const args = buildCodexExecArgv({
      prompt: question,
      sandbox,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
    });
    const result = this.spawnFn(this.codexPath, args, { cwd: repo, encoding: 'utf8' });
    return { question, answer: result.stdout ?? '', mode, provider: 'codex' };
  }

  async draftPlan(session: PlanningSession, repo: string): Promise<DraftPlanResult> {
    const prompt = buildDraftPlanPrompt(session);
    const args = buildCodexExecArgv({
      prompt,
      sandbox: 'read-only',
      model: this.model,
      reasoningEffort: this.reasoningEffort,
    });
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
