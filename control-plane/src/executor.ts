import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import type { OrchestratorDB } from './db';
import { insertExecution, updateExecutionFromAttemptResult } from './db';
import { claimPlan, releaseClaim, renewClaim } from './claims';
import {
  DEFAULT_PROVIDER_POLICY,
  type AgentRunner,
  type ProviderPolicy,
  type ProviderRegistry,
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

    insertExecution(this.db, {
      repo: plan.repo,
      planFile: plan.fileName,
      planHash: plan.planHash,
      attemptId,
      providerRequested: this.requestedProviderName(plan.requestedProvider),
      providerUsed: provider,
      model: null,
      branch: `feature/${planSlug}`,
      worktree: null,
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
      const result = await runner.runPlan(repoPath, planRelPath, {
        provider,
        attemptId,
      });
      updateExecutionFromAttemptResult(this.db, attemptId, result);
    } catch (err) {
      updateExecutionFromAttemptResult(this.db, attemptId, this.failedResult(provider, String(err)));
    } finally {
      clearInterval(renewTimer);
      releaseClaim(this.claimsDir, plan.repo, plan.planHash);
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
}

