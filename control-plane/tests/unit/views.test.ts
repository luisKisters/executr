import { describe, it, expect } from 'vitest';
import {
  formatTimeSince,
  healthBadgeLabel,
  healthBadgeClass,
  renderOverviewPage,
  renderPlansPage,
  renderPlanDetailPage,
  renderActivityPage,
  renderSessionsPage,
  renderNewPlanPage,
  type SessionRow,
} from '../../src/views';
import type { RepoInfo, RegistryRepoInfo, NormalizedExecution, PlanDetail } from '../../src/discovery';
import type { ApprovalRequestRow } from '../../src/db';

// ── formatTimeSince ────────────────────────────────────────────────────

describe('formatTimeSince', () => {
  const NOW = 1_700_000_000_000;

  it('returns — for null', () => {
    expect(formatTimeSince(null, NOW)).toBe('—');
  });

  it('returns just now for future timestamps', () => {
    expect(formatTimeSince(NOW + 5000, NOW)).toBe('just now');
  });

  it('formats seconds ago', () => {
    expect(formatTimeSince(NOW - 45_000, NOW)).toBe('45s ago');
  });

  it('formats minutes ago', () => {
    expect(formatTimeSince(NOW - 5 * 60_000, NOW)).toBe('5m ago');
  });

  it('formats hours ago', () => {
    expect(formatTimeSince(NOW - 3 * 3600_000, NOW)).toBe('3h ago');
  });

  it('formats days ago', () => {
    expect(formatTimeSince(NOW - 2 * 86400_000, NOW)).toBe('2d ago');
  });

  it('formats 1 minute boundary', () => {
    expect(formatTimeSince(NOW - 60_000, NOW)).toBe('1m ago');
  });

  it('formats 1 hour boundary', () => {
    expect(formatTimeSince(NOW - 3600_000, NOW)).toBe('1h ago');
  });
});

// ── healthBadgeLabel / healthBadgeClass ────────────────────────────────

describe('healthBadgeLabel', () => {
  it('maps healthy', () => { expect(healthBadgeLabel('healthy')).toBe('Healthy'); });
  it('maps known_startup_stall', () => { expect(healthBadgeLabel('known_startup_stall')).toBe('Startup stall'); });
  it('maps failed_finalize', () => { expect(healthBadgeLabel('failed_finalize')).toBe('Finalize failed'); });
  it('maps dead_loop', () => { expect(healthBadgeLabel('dead_loop')).toBe('Dead loop'); });
  it('maps waiting_for_human', () => { expect(healthBadgeLabel('waiting_for_human')).toBe('Waiting'); });
  it('maps long_running_but_active', () => { expect(healthBadgeLabel('long_running_but_active')).toBe('Running'); });
  it('maps rate_limited', () => { expect(healthBadgeLabel('rate_limited')).toBe('Rate limited'); });
  it('maps dirty_tree_blocked', () => { expect(healthBadgeLabel('dirty_tree_blocked')).toBe('Dirty tree'); });
  it('maps auth_missing', () => { expect(healthBadgeLabel('auth_missing')).toBe('Auth missing'); });
  it('maps tool_missing', () => { expect(healthBadgeLabel('tool_missing')).toBe('Tool missing'); });
});

describe('healthBadgeClass', () => {
  it('healthy → badge-green', () => { expect(healthBadgeClass('healthy')).toBe('badge-green'); });
  it('long_running_but_active → badge-yellow', () => { expect(healthBadgeClass('long_running_but_active')).toBe('badge-yellow'); });
  it('known_startup_stall → badge-orange', () => { expect(healthBadgeClass('known_startup_stall')).toBe('badge-orange'); });
  it('rate_limited → badge-orange', () => { expect(healthBadgeClass('rate_limited')).toBe('badge-orange'); });
  it('waiting_for_human → badge-blue', () => { expect(healthBadgeClass('waiting_for_human')).toBe('badge-blue'); });
  it('failed_finalize → badge-red', () => { expect(healthBadgeClass('failed_finalize')).toBe('badge-red'); });
  it('dirty_tree_blocked → badge-red', () => { expect(healthBadgeClass('dirty_tree_blocked')).toBe('badge-red'); });
  it('auth_missing → badge-red', () => { expect(healthBadgeClass('auth_missing')).toBe('badge-red'); });
  it('tool_missing → badge-red', () => { expect(healthBadgeClass('tool_missing')).toBe('badge-red'); });
  it('dead_loop → badge-red', () => { expect(healthBadgeClass('dead_loop')).toBe('badge-red'); });
});

// ── renderOverviewPage ─────────────────────────────────────────────────

function makeRegistryRepo(overrides: Partial<RegistryRepoInfo> & Pick<RegistryRepoInfo, 'name'>): RegistryRepoInfo {
  return {
    currentBranch: null, latestCommit: null, activePlan: null, planCount: 0,
    gitUrl: 'https://github.com/example/repo.git', registryBranch: 'main',
    source: 'seed', registryStatus: 'active', cloned: true,
    ...overrides,
  };
}

describe('renderOverviewPage', () => {
  it('renders empty state with no repos', () => {
    const html = renderOverviewPage([], []);
    expect(html).toContain('No repos found');
    expect(html).toContain('Overview');
  });

  it('renders add-repo form', () => {
    const html = renderOverviewPage([], []);
    expect(html).toContain('Add repo');
    expect(html).toContain('action="/repos"');
    expect(html).toContain('name="gitUrl"');
  });

  it('renders repo names', () => {
    const repos: RegistryRepoInfo[] = [
      makeRegistryRepo({ name: 'myrepo', currentBranch: 'main', latestCommit: 'abc123 fix bug' }),
    ];
    const html = renderOverviewPage(repos, []);
    expect(html).toContain('myrepo');
    expect(html).toContain('main');
  });

  it('renders cloned/not-cloned badge', () => {
    const repos: RegistryRepoInfo[] = [
      makeRegistryRepo({ name: 'cloned-repo', cloned: true }),
      makeRegistryRepo({ name: 'ghost-repo', cloned: false }),
    ];
    const html = renderOverviewPage(repos, []);
    expect(html).toContain('Cloned');
    expect(html).toContain('Not cloned');
  });

  it('renders archive button per repo', () => {
    const repos: RegistryRepoInfo[] = [
      makeRegistryRepo({ name: 'testrepo' }),
    ];
    const html = renderOverviewPage(repos, []);
    expect(html).toContain('action="/repos/testrepo/archive"');
    expect(html).toContain('Archive');
  });

  it('renders success message', () => {
    const html = renderOverviewPage([], [], { type: 'success', text: 'Repo added.' });
    expect(html).toContain('Repo added.');
  });

  it('renders error message', () => {
    const html = renderOverviewPage([], [], { type: 'error', text: 'Something went wrong.' });
    expect(html).toContain('Something went wrong.');
  });

  it('renders health badge from executions', () => {
    const repos: RegistryRepoInfo[] = [
      makeRegistryRepo({ name: 'myrepo', currentBranch: 'main' }),
    ];
    const executions: NormalizedExecution[] = [{
      id: 1, repo: 'myrepo', planFile: 'plan.md', planHash: 'abc',
      attemptId: 'att1', providerRequested: 'claude-code', providerUsed: 'claude-code',
      model: null, branch: null, status: 'running', classification: 'rate_limited',
      latestProgressTs: null, latestTranscriptTs: null, lastRecoveryAction: null, createdAt: 0, updatedAt: 0,
    }];
    const html = renderOverviewPage(repos, executions);
    expect(html).toContain('Rate limited');
    expect(html).toContain('badge-orange');
  });

  it('shows time-since columns in header', () => {
    const repos: RegistryRepoInfo[] = [makeRegistryRepo({ name: 'r' })];
    const html = renderOverviewPage(repos, []);
    expect(html).toContain('Last progress');
    expect(html).toContain('Last transcript');
  });

  it('shows health classification column in header', () => {
    const repos: RegistryRepoInfo[] = [makeRegistryRepo({ name: 'r' })];
    const html = renderOverviewPage(repos, []);
    expect(html).toContain('Health');
  });

  it('links active plan to plan detail page', () => {
    const repos: RegistryRepoInfo[] = [
      makeRegistryRepo({ name: 'testrepo', activePlan: 'my-plan', planCount: 1 }),
    ];
    const html = renderOverviewPage(repos, []);
    expect(html).toContain('/repos/testrepo/plans/my-plan');
  });
});

// ── renderPlansPage ────────────────────────────────────────────────────

describe('renderPlansPage', () => {
  it('renders empty state', () => {
    const html = renderPlansPage([], {});
    expect(html).toContain('No plans found');
  });

  it('renders plan names with status badges', () => {
    const repos: RepoInfo[] = [
      { name: 'repo1', currentBranch: 'main', latestCommit: null, activePlan: null, planCount: 1 },
    ];
    const plans = {
      repo1: [{
        name: 'my-plan', file: 'my-plan.md', status: 'completed' as const,
        contentHash: 'deadbeef', createdTime: null, lastRunTime: null,
        branch: null, tasks: [], validationWarnings: [],
      }],
    };
    const html = renderPlansPage(repos, plans);
    expect(html).toContain('my-plan');
    expect(html).toContain('badge-green');
    expect(html).toContain('completed');
  });

  it('renders success message when provided', () => {
    const html = renderPlansPage([], {}, 'Plan "foo" created successfully.');
    expect(html).toContain('Plan &quot;foo&quot; created successfully.');
  });
});

// ── renderPlanDetailPage ───────────────────────────────────────────────

describe('renderPlanDetailPage', () => {
  const baseDetail: PlanDetail = {
    name: 'my-plan',
    file: 'my-plan.md',
    status: 'none',
    contentHash: 'abc123abc123',
    createdTime: null,
    lastRunTime: null,
    branch: 'feature/my-plan',
    tasks: [
      { rawTaskNumber: 1, normalizedDisplayNumber: 1, title: 'Do the thing', completedCount: 1, totalCount: 2 },
    ],
    validationWarnings: [],
    rawMarkdown: '# Plan: my-plan\n\n### Task 1: Do the thing\n- [x] Step one\n- [ ] Step two\n',
    progressLogTail: 'step 1 done\nvalidation: passed',
    recentCommits: ['abc1234 feat: task 1'],
    validationState: 'passed',
  };

  it('renders plan name', () => {
    const html = renderPlanDetailPage(baseDetail, 'myrepo');
    expect(html).toContain('my-plan');
  });

  it('renders task progress', () => {
    const html = renderPlanDetailPage(baseDetail, 'myrepo');
    expect(html).toContain('1/2');
    expect(html).toContain('Do the thing');
  });

  it('renders recent commits', () => {
    const html = renderPlanDetailPage(baseDetail, 'myrepo');
    expect(html).toContain('feat: task 1');
  });

  it('renders validation state badge', () => {
    const html = renderPlanDetailPage(baseDetail, 'myrepo');
    expect(html).toContain('passed');
    expect(html).toContain('badge-green');
  });

  it('renders progress log tail', () => {
    const html = renderPlanDetailPage(baseDetail, 'myrepo');
    expect(html).toContain('step 1 done');
  });

  it('renders branch info', () => {
    const html = renderPlanDetailPage(baseDetail, 'myrepo');
    expect(html).toContain('feature/my-plan');
  });

  it('renders back link to repo plans', () => {
    const html = renderPlanDetailPage(baseDetail, 'myrepo');
    expect(html).toContain('/repos/myrepo/plans');
  });

  it('renders validation warnings', () => {
    const detailWithWarnings = { ...baseDetail, validationWarnings: ['Uses `* [ ]` bullets'] };
    const html = renderPlanDetailPage(detailWithWarnings, 'myrepo');
    expect(html).toContain('Uses');
    expect(html).toContain('warn-box');
  });
});

// ── renderActivityPage ─────────────────────────────────────────────────

describe('renderActivityPage', () => {
  it('renders empty state', () => {
    const html = renderActivityPage([], []);
    expect(html).toContain('No activity yet');
    expect(html).toContain('Activity');
  });

  it('renders executions in the timeline', () => {
    const executions: NormalizedExecution[] = [{
      id: 1, repo: 'repo1', planFile: 'plan.md', planHash: 'abc',
      attemptId: 'att1', providerRequested: 'claude-code', providerUsed: 'claude-code',
      model: null, branch: null, status: 'running', classification: 'healthy',
      latestProgressTs: null, latestTranscriptTs: null, createdAt: 1000, updatedAt: 2000,
    }];
    const html = renderActivityPage(executions, []);
    expect(html).toContain('repo1');
    expect(html).toContain('plan.md');
    expect(html).toContain('execution');
  });

  it('renders approval requests', () => {
    const approvals: ApprovalRequestRow[] = [{
      id: 'ar1', repo: 'repo2', plan: 'my-plan', action: 'force-push',
      context: 'branch diverged', status: 'pending', channel: 'telegram',
      decidedBy: null, createdAt: 3000, decidedAt: null,
    }];
    const html = renderActivityPage([], approvals);
    expect(html).toContain('repo2');
    expect(html).toContain('force-push');
    expect(html).toContain('approval');
  });

  it('shows approved status badge-green for approved requests', () => {
    const approvals: ApprovalRequestRow[] = [{
      id: 'ar2', repo: 'r', plan: 'p', action: 'push',
      context: 'c', status: 'approved', channel: 'telegram',
      decidedBy: 'user1', createdAt: 1000, decidedAt: 2000,
    }];
    const html = renderActivityPage([], approvals);
    expect(html).toContain('badge-green');
  });
});

// ── renderSessionsPage ─────────────────────────────────────────────────

describe('renderSessionsPage', () => {
  it('renders empty state with Telegram bot hint', () => {
    const html = renderSessionsPage([]);
    expect(html).toContain('Telegram');
    expect(html).toContain('/session new');
  });

  it('renders sessions when provided', () => {
    const sessions: SessionRow[] = [{
      id: 'sess1',
      name: 'Add feature X',
      targetRepo: 'myrepo',
      status: 'active',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 30_000,
    }];
    const html = renderSessionsPage(sessions);
    expect(html).toContain('Add feature X');
    expect(html).toContain('myrepo');
    expect(html).toContain('active');
  });

  it('renders submitted status as badge-green', () => {
    const sessions: SessionRow[] = [{
      id: 'sess2',
      name: 'Done session',
      targetRepo: null,
      status: 'submitted',
      createdAt: Date.now() - 3600_000,
      updatedAt: Date.now() - 3600_000,
    }];
    const html = renderSessionsPage(sessions);
    expect(html).toContain('badge-green');
    expect(html).toContain('submitted');
  });
});

// ── renderNewPlanPage ──────────────────────────────────────────────────

describe('renderNewPlanPage', () => {
  const repos: RepoInfo[] = [
    { name: 'repo-a', currentBranch: 'main', latestCommit: null, activePlan: null, planCount: 0 },
    { name: 'repo-b', currentBranch: 'main', latestCommit: null, activePlan: null, planCount: 0 },
  ];

  it('renders repo picker with all repos', () => {
    const html = renderNewPlanPage(repos);
    expect(html).toContain('repo-a');
    expect(html).toContain('repo-b');
  });

  it('renders provider selector with claude-code, codex, auto options', () => {
    const html = renderNewPlanPage(repos);
    expect(html).toContain('claude-code');
    expect(html).toContain('codex');
    expect(html).toContain('auto');
  });

  it('renders the live preview element', () => {
    const html = renderNewPlanPage(repos);
    expect(html).toContain('id="preview"');
    expect(html).toContain('generatePreview');
  });

  it('renders live preview JS that generates ralphex markdown', () => {
    const html = renderNewPlanPage(repos);
    expect(html).toContain('# Plan:');
    expect(html).toContain('## Validation Commands');
  });

  it('renders error message', () => {
    const html = renderNewPlanPage(repos, { error: 'Title is required' });
    expect(html).toContain('Title is required');
  });

  it('pre-fills values when provided', () => {
    const html = renderNewPlanPage(repos, { values: { title: 'My plan', provider: 'codex' } });
    expect(html).toContain('My plan');
    expect(html).toContain('value="codex"');
  });
});
