import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { ExecutionScheduler } from '../../src/executor';
import { openDatabase, listExecutions, type OrchestratorDB } from '../../src/db';
import { readClaim } from '../../src/claims';
import { ProviderRegistry, type AgentRunner, type AttemptConfig, type InspectionMode, type PlanningSession } from '../../src/providers';
import type { AttemptResult, ProviderStatus } from '../../src/contracts';

function gitInit(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
}

class FakeCodexRunner implements AgentRunner {
  readonly providerName = 'codex' as const;
  calls: Array<{ repo: string; planPath: string; config: AttemptConfig }> = [];
  planExistedAtRun: boolean[] = [];

  async runPlan(repo: string, planPath: string, config: AttemptConfig): Promise<AttemptResult> {
    this.calls.push({ repo, planPath, config });
    this.planExistedAtRun.push(existsSync(join(repo, planPath)));
    const now = new Date().toISOString();
    return {
      status: 'completed',
      provider: 'codex',
      model: 'fake-model',
      branch: 'feature/test-plan',
      tasksCompleted: 1,
      commits: ['abc123'],
      validation: { status: 'passed' },
      classification: 'healthy',
      summary: 'done',
      startedAt: now,
      endedAt: now,
    };
  }

  async inspect(): Promise<{ question: string; answer: string; mode: InspectionMode; provider: 'codex' }> {
    return { question: '', answer: '', mode: 'readonly', provider: 'codex' };
  }

  async draftPlan(_session: PlanningSession): Promise<{ markdown: string; valid: boolean; warnings: string[] }> {
    return { markdown: '', valid: false, warnings: [] };
  }

  async availability(): Promise<ProviderStatus> {
    return { available: true };
  }
}

function setup(): { root: string; db: OrchestratorDB; claimsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'executor-test-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'plans', 'test-plan.md'), '# Plan: Test\n\n## Validation Commands\n\n```\npnpm test\n```\n\n### Task 1: Do\n\n- [ ] It\n');
  gitInit(repo);
  execSync('git add docs/plans/test-plan.md && git commit -m "add test plan"', { cwd: repo, stdio: 'ignore' });
  const db = openDatabase(join(root, '.executr', 'orchestrator.db'));
  return { root, db, claimsDir: join(root, '.executr', 'claims') };
}

describe('ExecutionScheduler', () => {
  it('runs codex plans, records execution result, and releases the claim', async () => {
    const { root, db, claimsDir } = setup();
    try {
      const runner = new FakeCodexRunner();
      const registry = new ProviderRegistry();
      registry.register(runner);
      const scheduler = new ExecutionScheduler({
        db,
        workspaceRoot: root,
        claimsDir,
        registry,
        providerPolicy: () => ({
          prefer: 'codex',
          fallback_order: ['codex'],
          switch_on: {},
        }),
        leaseRenewMs: 10,
      });

      const result = await scheduler.runCreatedPlan({
        repo: 'repo',
        fileName: 'test-plan.md',
        planHash: 'hash123',
        requestedProvider: 'codex',
      });

      expect(result).toBe('started');
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0].repo).toMatch(new RegExp(`${join(root, '.executr', 'worktrees', 'repo', 'test-plan-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-f0-9-]+`));
      expect(runner.calls[0].planPath).toBe(join('docs', 'plans', 'test-plan.md'));
      expect(runner.planExistedAtRun[0]).toBe(true);
      expect(existsSync(runner.calls[0].repo)).toBe(false);
      expect(readClaim(claimsDir, 'repo', 'hash123')).toBeNull();

      const [execution] = listExecutions(db);
      expect(execution.status).toBe('completed');
      expect(execution.providerRequested).toBe('codex');
      expect(execution.providerUsed).toBe('codex');
      expect(execution.model).toBe('fake-model');
      expect(execution.classification).toBe('healthy');
      expect(execution.worktree).toBe(runner.calls[0].repo);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('delegates claude-code plans to the legacy loop', async () => {
    const { root, db, claimsDir } = setup();
    try {
      const registry = new ProviderRegistry();
      const scheduler = new ExecutionScheduler({ db, workspaceRoot: root, claimsDir, registry });

      const result = await scheduler.runCreatedPlan({
        repo: 'repo',
        fileName: 'test-plan.md',
        planHash: 'hash123',
        requestedProvider: 'claude-code',
      });

      expect(result).toBe('no_provider');
      expect(listExecutions(db)).toHaveLength(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
