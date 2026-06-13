import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import type { OrchestratorDB, ExecutionRow } from './db';
import { getRepoFromRegistry, insertExecution, updateExecutionFromAttemptResult } from './db';
import { claimPlan, releaseClaim, renewClaim } from './claims';
import {
  DEFAULT_PROVIDER_POLICY,
  type AgentRunner,
  type ProviderPolicy,
  type ProviderRegistry,
  type ProviderSwitchTrigger,
} from './providers';
import type { AttemptResult, ProviderName } from './contracts';
import type { PlanProvider } from './planCreation';

export interface CreatedPlanExecution {
  repo: string;
  fileName: string;
  planHash: string;
  requestedProvider: PlanProvider;
}

export interface ExecutionSchedulerOptions {
  db: OrchestratorDB;
  workspaceRoot: string;
  claimsDir: string;
  registry: ProviderRegistry;
  providerPolicy?: () => ProviderPolicy;
  leaseDurationMs?: number;
  leaseRenewMs?: number;
}

export type ScheduleResult = 'started' | 'delegated_to_legacy' | 'no_provider';

export class ExecutionScheduler {
  private readonly db: OrchestratorDB;
  private readonly workspaceRoot: string;
  private readonly claimsDir: string;
  private readonly registry: ProviderRegistry;
  private readonly providerPolicy: () => ProviderPolicy;
  private readonly leaseDurationMs: number;
  private readonly leaseRenewMs: number;

  constructor(opts: ExecutionSchedulerOptions) {
    this.db = opts.db;
    this.workspaceRoot = opts.workspaceRoot;
    this.claimsDir = opts.claimsDir;
    this.registry = opts.registry;
    this.providerPolicy = opts.providerPolicy ?? (() => DEFAULT_PROVIDER_POLICY);
    this.leaseDurationMs = opts.leaseDurationMs ?? 5 * 60 * 1000;
    this.leaseRenewMs = opts.leaseRenewMs ?? 60 * 1000;
  }

  scheduleCreatedPlan(plan: CreatedPlanExecution): void {
    setTimeout(() => {
      void this.runCreatedPlan(plan);
    }, 0);
  }

  scheduleProviderSwitchRetry(execution: ExecutionRow, trigger: ProviderSwitchTrigger): void {
    setTimeout(() => {
      void this.runProviderSwitchRetry(execution, trigger);
    }, 0);
  }

  async runProviderSwitchRetry(
    execution: ExecutionRow,
    trigger: ProviderSwitchTrigger
  ): Promise<ScheduleResult> {
    const runner = await this.registry.selectProvider(this.providerPolicy(), trigger);
    if (!runner) return 'no_provider';

    const currentProvider = execution.providerUsed ?? execution.providerRequested;
    if (runner.providerName === currentProvider) return 'no_provider';

    if (runner.providerName === 'claude-code') {
      releaseClaim(this.claimsDir, execution.repo, execution.planHash);
      return 'delegated_to_legacy';
    }

    this.scheduleCreatedPlan({
      repo: execution.repo,
      fileName: execution.planFile,
      planHash: execution.planHash,
      requestedProvider: runner.providerName,
    });
    return 'started';
  }

  async runCreatedPlan(plan: CreatedPlanExecution): Promise<ScheduleResult> {
    const runner = await this.selectRunner(plan.requestedProvider);
    if (!runner) return 'no_provider';
    if (runner.providerName === 'claude-code') return 'delegated_to_legacy';

    const provider = runner.providerName;
    claimPlan(this.claimsDir, plan.repo, plan.planHash, provider, this.leaseDurationMs);
    const renewTimer = setInterval(() => {
      renewClaim(this.claimsDir, plan.repo, plan.planHash, this.leaseDurationMs);
    }, this.leaseRenewMs);

    const attemptId = randomUUID();
    const now = Date.now();
    const planSlug = basename(plan.fileName, '.md');
    const repoPath = join(this.workspaceRoot, plan.repo);
    const planRelPath = join('docs', 'plans', plan.fileName);
    const worktreePath = this.worktreePath(plan.repo, planSlug, attemptId);

    insertExecution(this.db, {
      repo: plan.repo,
      planFile: plan.fileName,
      planHash: plan.planHash,
      attemptId,
      providerRequested: this.requestedProviderName(plan.requestedProvider),
      providerUsed: provider,
      model: null,
      branch: `feature/${planSlug}`,
      worktree: worktreePath,
      status: 'running',
      latestProgressTs: null,
      latestTranscriptTs: null,
      rateLimitCooldownUntil: null,
      lastRecoveryAction: null,
      classification: null,
      recoveryAttemptCounts: {},
      createdAt: now,
      updatedAt: now,
    });

    try {
      this.prepareWorktree(repoPath, worktreePath, plan.repo, planRelPath);
      const result = await runner.runPlan(worktreePath, planRelPath, {
        provider,
        attemptId,
      });
      updateExecutionFromAttemptResult(this.db, attemptId, result);
    } catch (err) {
      updateExecutionFromAttemptResult(this.db, attemptId, this.failedResult(provider, String(err)));
    } finally {
      clearInterval(renewTimer);
      releaseClaim(this.claimsDir, plan.repo, plan.planHash);
      this.cleanupWorktree(repoPath, worktreePath);
    }

    return 'started';
  }

  private async selectRunner(requestedProvider: PlanProvider): Promise<AgentRunner | null> {
    if (requestedProvider === 'auto') {
      return this.registry.selectProvider(this.providerPolicy());
    }
    return this.registry.get(requestedProvider);
  }

  private requestedProviderName(requestedProvider: PlanProvider): ProviderName {
    return requestedProvider === 'auto' ? this.providerPolicy().prefer : requestedProvider;
  }

  private failedResult(provider: ProviderName, summary: string): AttemptResult {
    const now = new Date().toISOString();
    return {
      status: 'failed',
      provider,
      model: '',
      branch: '',
      tasksCompleted: 0,
      commits: [],
      validation: { status: 'skipped' },
      classification: 'dead_loop',
      summary,
      startedAt: now,
      endedAt: now,
    };
  }

  private worktreePath(repo: string, planSlug: string, attemptId: string): string {
    const safeRepo = repo.replace(/[^A-Za-z0-9._-]/g, '_');
    const safeSlug = planSlug.replace(/[^A-Za-z0-9._-]/g, '-');
    return join(this.workspaceRoot, '.executr', 'worktrees', safeRepo, `${safeSlug}-${attemptId.slice(0, 8)}`);
  }

  private prepareWorktree(repoPath: string, worktreePath: string, repoName: string, planRelPath: string): void {
    const registryRepo = getRepoFromRegistry(this.db, repoName);
    const baseBranch = registryRepo?.branch ?? this.currentBranch(repoPath) ?? 'HEAD';
    const baseRefs = baseBranch === 'HEAD'
      ? ['HEAD']
      : [`origin/${baseBranch}`, baseBranch, 'HEAD'];

    this.cleanupWorktree(repoPath, worktreePath);
    mkdirSync(dirname(worktreePath), { recursive: true });

    let added = false;
    let lastError = '';
    for (const ref of baseRefs) {
      const result = spawnSync('git', ['-C', repoPath, 'worktree', 'add', '--detach', worktreePath, ref], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.status === 0 && !result.error) {
        added = true;
        break;
      }
      lastError = (result.stderr ?? result.stdout ?? result.error?.message ?? '').trim();
      rmSync(worktreePath, { recursive: true, force: true });
    }

    if (!added) {
      throw new Error(`Failed to create worktree for ${repoName}: ${lastError}`);
    }

    const sourcePlan = join(repoPath, planRelPath);
    const targetPlan = join(worktreePath, planRelPath);
    mkdirSync(dirname(targetPlan), { recursive: true });
    copyFileSync(sourcePlan, targetPlan);
    this.linkRalphexRuntime(repoPath, worktreePath);
  }

  private linkRalphexRuntime(repoPath: string, worktreePath: string): void {
    const mainRalphexDir = join(repoPath, '.ralphex');
    const worktreeRalphexDir = join(worktreePath, '.ralphex');
    mkdirSync(join(mainRalphexDir, 'progress'), { recursive: true });
    mkdirSync(join(mainRalphexDir, 'plan-state'), { recursive: true });
    mkdirSync(worktreeRalphexDir, { recursive: true });

    for (const name of ['progress', 'plan-state']) {
      const linkPath = join(worktreeRalphexDir, name);
      if (!existsSync(linkPath)) {
        symlinkSync(join(mainRalphexDir, name), linkPath, 'dir');
      }
    }
  }

  private currentBranch(repoPath: string): string | null {
    const result = spawnSync('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0 || result.error) return null;
    const branch = (result.stdout ?? '').trim();
    return branch || null;
  }

  private cleanupWorktree(repoPath: string, worktreePath: string): void {
    spawnSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    rmSync(worktreePath, { recursive: true, force: true });
  }
}
