import type { RepoInfo, PlanSummary, PlanDetail, NormalizedExecution } from './discovery';
import type { ClassificationSignal } from './contracts';
import type { ApprovalRequestRow } from './db';

// ── Time formatting ────────────────────────────────────────────────────

export function formatTimeSince(ts: number | null, now = Date.now()): string {
  if (ts === null) return '—';
  const diffMs = now - ts;
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

// ── Health badge ────────────────────────────────────────────────────────

const HEALTH_LABELS: Record<ClassificationSignal, string> = {
  healthy: 'Healthy',
  long_running_but_active: 'Running',
  known_startup_stall: 'Startup stall',
  rate_limited: 'Rate limited',
  waiting_for_human: 'Waiting',
  failed_finalize: 'Finalize failed',
  dirty_tree_blocked: 'Dirty tree',
  auth_missing: 'Auth missing',
  tool_missing: 'Tool missing',
  dead_loop: 'Dead loop',
};

const HEALTH_CLASSES: Record<ClassificationSignal, string> = {
  healthy: 'badge-green',
  long_running_but_active: 'badge-yellow',
  known_startup_stall: 'badge-orange',
  rate_limited: 'badge-orange',
  waiting_for_human: 'badge-blue',
  failed_finalize: 'badge-red',
  dirty_tree_blocked: 'badge-red',
  auth_missing: 'badge-red',
  tool_missing: 'badge-red',
  dead_loop: 'badge-red',
};

export function healthBadgeLabel(signal: ClassificationSignal): string {
  return HEALTH_LABELS[signal] ?? signal;
}

export function healthBadgeClass(signal: ClassificationSignal): string {
  return HEALTH_CLASSES[signal] ?? 'badge-grey';
}

// ── Shared HTML primitives ─────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const NAV = `
  <nav>
    <span class="title">Control Plane</span>
    <a href="/">Overview</a>
    <a href="/plans">Plans</a>
    <a href="/plans/new">New Plan</a>
    <a href="/activity">Activity</a>
    <a href="/sessions">Sessions</a>
    <a href="/logout">Sign out</a>
  </nav>`;

const BASE_STYLES = `
    body { font-family: system-ui, sans-serif; margin: 0; padding: 0; }
    nav { background: #1a1a2e; color: #fff; padding: 0.75rem 1.5rem; display: flex; align-items: center; gap: 1.5rem; }
    nav a { color: #ccc; text-decoration: none; font-size: 0.9rem; }
    nav a:hover { color: #fff; }
    nav .title { font-weight: 700; font-size: 1rem; color: #fff; margin-right: auto; }
    main { padding: 2rem 1.5rem; }
    h2 { font-size: 1.2rem; }
    .empty { color: #888; font-size: 0.95rem; }
    .error { color: #c00; font-size: 0.9rem; padding: 0.5rem; background: #fff0f0; border: 1px solid #fcc; border-radius: 4px; margin-bottom: 1rem; }
    .success { color: #060; font-size: 0.9rem; padding: 0.5rem; background: #f0fff0; border: 1px solid #cfc; border-radius: 4px; margin-bottom: 1rem; }
    .data-table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
    .data-table th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 2px solid #ddd; }
    .data-table td { padding: 0.4rem 0.75rem; border-bottom: 1px solid #eee; vertical-align: top; }
    .data-table a { color: #1a1a2e; }
    .hash { font-family: monospace; font-size: 0.85rem; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
    .badge-green { background: #d1fae5; color: #065f46; }
    .badge-yellow { background: #fef3c7; color: #92400e; }
    .badge-orange { background: #ffedd5; color: #9a3412; }
    .badge-blue { background: #dbeafe; color: #1e40af; }
    .badge-red { background: #fee2e2; color: #991b1b; }
    .badge-grey { background: #f3f4f6; color: #374151; }`;

function page(title: string, extraStyles: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Control Plane — ${escapeHtml(title)}</title>
  <style>${BASE_STYLES}${extraStyles}</style>
</head>
<body>
  ${NAV}
  <main>
    ${body}
  </main>
</body>
</html>`;
}

// ── Login ──────────────────────────────────────────────────────────────

export function renderLoginPage(error?: string): string {
  const errorHtml = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Control Plane — Login</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 360px; margin: 10vh auto; padding: 0 1rem; }
    h1 { font-size: 1.4rem; margin-bottom: 1.5rem; }
    form { display: flex; flex-direction: column; gap: 0.75rem; }
    label { font-size: 0.9rem; font-weight: 600; }
    input { padding: 0.5rem 0.75rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; }
    button { padding: 0.6rem; font-size: 1rem; background: #1a1a2e; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
    button:hover { background: #16213e; }
    .error { color: #c00; font-size: 0.9rem; margin: 0; }
  </style>
</head>
<body>
  <h1>Control Plane</h1>
  ${errorHtml}
  <form method="POST" action="/login">
    <label for="password">Password</label>
    <input type="password" id="password" name="password" autofocus required autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

// ── Overview ───────────────────────────────────────────────────────────

export function renderOverviewPage(repos: RepoInfo[] = [], executions: NormalizedExecution[] = []): string {
  const execByRepo = new Map<string, NormalizedExecution[]>();
  for (const ex of executions) {
    const list = execByRepo.get(ex.repo) ?? [];
    list.push(ex);
    execByRepo.set(ex.repo, list);
  }

  const reposHtml = repos.length === 0
    ? '<p class="empty">No repos found. Add repos to WORKSPACE_ROOT to see them here.</p>'
    : `<table class="data-table">
        <thead>
          <tr>
            <th>Repo</th>
            <th>Branch</th>
            <th>Latest commit</th>
            <th>Plans</th>
            <th>Active plan</th>
            <th>Health</th>
            <th>Last progress</th>
            <th>Last transcript</th>
          </tr>
        </thead>
        <tbody>
          ${repos.map(r => {
            const repoExecs = execByRepo.get(r.name) ?? [];
            const latest = repoExecs[0] ?? null;
            const classification = latest?.classification ?? null;
            const badgeHtml = classification
              ? `<span class="badge ${healthBadgeClass(classification)}">${escapeHtml(healthBadgeLabel(classification))}</span>`
              : '<span class="badge badge-grey">—</span>';
            const lastProgress = formatTimeSince(latest?.latestProgressTs ?? null);
            const lastTranscript = formatTimeSince(latest?.latestTranscriptTs ?? null);
            return `
          <tr>
            <td><a href="/repos/${escapeHtml(r.name)}/plans">${escapeHtml(r.name)}</a></td>
            <td>${escapeHtml(r.currentBranch ?? '—')}</td>
            <td class="hash">${escapeHtml(r.latestCommit ?? '—')}</td>
            <td>${r.planCount}</td>
            <td>${r.activePlan ? `<a href="/repos/${escapeHtml(r.name)}/plans/${escapeHtml(r.activePlan)}">${escapeHtml(r.activePlan)}</a>` : '—'}</td>
            <td>${badgeHtml}</td>
            <td>${escapeHtml(lastProgress)}</td>
            <td>${escapeHtml(lastTranscript)}</td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>`;

  return page('Overview', `
    .hash { font-family: monospace; font-size: 0.85rem; max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`,
    `<h2>Overview</h2>${reposHtml}`);
}

// ── Plans list ─────────────────────────────────────────────────────────

export function renderPlansPage(
  repos: RepoInfo[],
  plans: Record<string, PlanSummary[]> = {},
  successMessage?: string
): string {
  const rows = repos.flatMap(r =>
    (plans[r.name] ?? []).map(p => {
      const tasksDone = p.tasks.reduce((s, t) => s + t.completedCount, 0);
      const tasksTotal = p.tasks.reduce((s, t) => s + t.totalCount, 0);
      const progress = tasksTotal > 0 ? `${tasksDone}/${tasksTotal}` : '—';
      return `
      <tr>
        <td>${escapeHtml(r.name)}</td>
        <td><a href="/repos/${escapeHtml(r.name)}/plans/${escapeHtml(p.name)}">${escapeHtml(p.name)}</a></td>
        <td><span class="badge ${statusBadgeClass(p.status)}">${escapeHtml(p.status)}</span></td>
        <td class="hash">${p.contentHash ? escapeHtml(p.contentHash.slice(0, 8)) : '—'}</td>
        <td>${p.createdTime ? escapeHtml(new Date(p.createdTime).toLocaleDateString()) : '—'}</td>
        <td>${p.lastRunTime ? escapeHtml(formatTimeSince(p.lastRunTime)) : '—'}</td>
        <td>${p.branch ? escapeHtml(p.branch) : '—'}</td>
        <td>${escapeHtml(progress)}</td>
      </tr>`;
    })
  );

  const tableHtml = rows.length
    ? `<table class="data-table"><thead><tr><th>Repo</th><th>Plan</th><th>Status</th><th>Hash</th><th>Created</th><th>Last run</th><th>Branch</th><th>Tasks</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : '<p class="empty">No plans found.</p>';

  const successHtml = successMessage
    ? `<div class="success" role="status">${escapeHtml(successMessage)}</div>`
    : '';

  return page('Plans', '', `<h2>Plans</h2><p><a href="/plans/new">+ New Plan</a></p>${successHtml}${tableHtml}`);
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'completed': return 'badge-green';
    case 'failed': return 'badge-red';
    case 'invalid': return 'badge-orange';
    default: return 'badge-grey';
  }
}

// ── Plan detail ────────────────────────────────────────────────────────

export function renderPlanDetailPage(detail: PlanDetail, repoName: string): string {
  const taskRows = detail.tasks.map(t => {
    const pct = t.totalCount > 0 ? Math.round((t.completedCount / t.totalCount) * 100) : 0;
    const done = t.completedCount === t.totalCount && t.totalCount > 0;
    return `<tr>
      <td>Task ${t.normalizedDisplayNumber}</td>
      <td>${escapeHtml(t.title)}</td>
      <td>${t.completedCount}/${t.totalCount}</td>
      <td><div class="prog-bar"><div class="prog-fill${done ? ' done' : ''}" style="width:${pct}%"></div></div></td>
    </tr>`;
  }).join('');

  const tasksHtml = detail.tasks.length
    ? `<table class="data-table"><thead><tr><th>#</th><th>Title</th><th>Done</th><th>Progress</th></tr></thead><tbody>${taskRows}</tbody></table>`
    : '<p class="empty">No tasks found.</p>';

  const commitsHtml = detail.recentCommits.length
    ? `<ul class="commit-list">${detail.recentCommits.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`
    : '<p class="empty">No recent commits.</p>';

  const progressHtml = detail.progressLogTail
    ? `<pre class="log-box">${escapeHtml(detail.progressLogTail)}</pre>`
    : '<p class="empty">No progress log.</p>';

  const warningsHtml = detail.validationWarnings.length
    ? `<div class="warn-box">${detail.validationWarnings.map(w => `<p>${escapeHtml(w)}</p>`).join('')}</div>`
    : '';

  return page(`Plan: ${detail.name}`, `
    .prog-bar { background: #e5e7eb; border-radius: 4px; height: 8px; width: 120px; overflow: hidden; }
    .prog-fill { background: #6b7280; height: 100%; border-radius: 4px; }
    .prog-fill.done { background: #059669; }
    .log-box { background: #f8f8f8; border: 1px solid #e0e0e0; padding: 1rem; border-radius: 4px; overflow-x: auto; font-size: 0.82rem; max-height: 300px; overflow-y: auto; white-space: pre-wrap; }
    .commit-list { font-family: monospace; font-size: 0.85rem; padding-left: 1.2rem; margin: 0; }
    .commit-list li { margin-bottom: 0.2rem; }
    .warn-box { background: #fffbeb; border: 1px solid #fcd34d; padding: 0.75rem 1rem; border-radius: 4px; color: #92400e; font-size: 0.9rem; margin-bottom: 1rem; }
    .warn-box p { margin: 0.2rem 0; }
    .meta-grid { display: grid; grid-template-columns: max-content 1fr; gap: 0.3rem 1rem; font-size: 0.9rem; margin-bottom: 1.5rem; }
    .meta-grid dt { font-weight: 600; color: #555; }
    .raw-md { background: #f8f8f8; border: 1px solid #e0e0e0; padding: 1rem; border-radius: 4px; overflow-x: auto; font-size: 0.82rem; max-height: 400px; overflow-y: auto; white-space: pre-wrap; }`,
    `<p><a href="/repos/${escapeHtml(repoName)}/plans">&larr; Back to plans</a></p>
    <h2>${escapeHtml(detail.name)}</h2>
    ${warningsHtml}
    <dl class="meta-grid">
      <dt>Status</dt><dd><span class="badge ${statusBadgeClass(detail.status)}">${escapeHtml(detail.status)}</span></dd>
      <dt>Branch</dt><dd>${detail.branch ? escapeHtml(detail.branch) : '—'}</dd>
      <dt>Hash</dt><dd class="hash">${detail.contentHash ? escapeHtml(detail.contentHash.slice(0, 12)) : '—'}</dd>
      <dt>Validation</dt><dd><span class="badge ${validationBadgeClass(detail.validationState)}">${escapeHtml(detail.validationState)}</span></dd>
    </dl>
    <h3>Tasks</h3>
    ${tasksHtml}
    <h3>Recent commits</h3>
    ${commitsHtml}
    <h3>Progress log</h3>
    ${progressHtml}
    <h3>Plan source</h3>
    <pre class="raw-md">${escapeHtml(detail.rawMarkdown)}</pre>`);
}

function validationBadgeClass(state: string): string {
  switch (state) {
    case 'passed': return 'badge-green';
    case 'failed': return 'badge-red';
    case 'skipped': return 'badge-yellow';
    default: return 'badge-grey';
  }
}

// ── Repo's plans list ──────────────────────────────────────────────────

export function renderRepoPlansPage(repoName: string, plans: PlanSummary[]): string {
  const rows = plans.map(p => {
    const tasksDone = p.tasks.reduce((s, t) => s + t.completedCount, 0);
    const tasksTotal = p.tasks.reduce((s, t) => s + t.totalCount, 0);
    return `<tr>
      <td><a href="/repos/${escapeHtml(repoName)}/plans/${escapeHtml(p.name)}">${escapeHtml(p.name)}</a></td>
      <td><span class="badge ${statusBadgeClass(p.status)}">${escapeHtml(p.status)}</span></td>
      <td class="hash">${p.contentHash ? escapeHtml(p.contentHash.slice(0, 8)) : '—'}</td>
      <td>${p.createdTime ? escapeHtml(new Date(p.createdTime).toLocaleDateString()) : '—'}</td>
      <td>${p.lastRunTime ? escapeHtml(formatTimeSince(p.lastRunTime)) : '—'}</td>
      <td>${p.branch ? escapeHtml(p.branch) : '—'}</td>
      <td>${tasksDone}/${tasksTotal}</td>
    </tr>`;
  }).join('');

  const tableHtml = rows.length
    ? `<table class="data-table"><thead><tr><th>Plan</th><th>Status</th><th>Hash</th><th>Created</th><th>Last run</th><th>Branch</th><th>Tasks</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="empty">No plans found.</p>';

  return page(`Plans — ${repoName}`, '', `
    <p><a href="/">&larr; Overview</a></p>
    <h2>${escapeHtml(repoName)} — Plans</h2>
    <p><a href="/plans/new">+ New Plan</a></p>
    ${tableHtml}`);
}

// ── New plan form ──────────────────────────────────────────────────────

export interface NewPlanFormValues {
  repo?: string;
  title?: string;
  body?: string;
  validationCommands?: string;
  provider?: string;
}

export function renderNewPlanPage(
  repos: RepoInfo[],
  opts: { error?: string; success?: string; values?: NewPlanFormValues } = {}
): string {
  const { error, success, values = {} } = opts;
  const alertHtml = error
    ? `<div class="error" role="alert">${escapeHtml(error)}</div>`
    : success
    ? `<div class="success" role="status">${escapeHtml(success)}</div>`
    : '';

  const repoOptions = repos.map(r =>
    `<option value="${escapeHtml(r.name)}"${values.repo === r.name ? ' selected' : ''}>${escapeHtml(r.name)}</option>`
  ).join('');

  const providers = ['claude-code', 'codex', 'auto'];
  const providerOptions = providers.map(p =>
    `<option value="${p}"${(values.provider ?? 'claude-code') === p ? ' selected' : ''}>${p}</option>`
  ).join('');

  const defaultBody = values.body ?? `### Task 1: My first task\n- [ ] Do something\n`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Control Plane — New Plan</title>
  <style>${BASE_STYLES}
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; align-items: start; }
    form { display: flex; flex-direction: column; gap: 1rem; }
    label { font-size: 0.9rem; font-weight: 600; display: block; margin-bottom: 0.25rem; }
    input[type="text"], select, textarea { width: 100%; padding: 0.5rem 0.75rem; font-size: 0.9rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
    textarea { font-family: monospace; resize: vertical; }
    button[type="submit"] { align-self: flex-start; padding: 0.5rem 1.5rem; font-size: 0.95rem; background: #1a1a2e; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
    button[type="submit"]:hover { background: #16213e; }
    .preview-box { position: sticky; top: 1rem; }
    .preview-box h3 { font-size: 0.9rem; font-weight: 600; margin-bottom: 0.5rem; color: #555; }
    #preview { background: #f8f8f8; border: 1px solid #e0e0e0; border-radius: 4px; padding: 1rem; font-family: monospace; font-size: 0.82rem; white-space: pre-wrap; min-height: 300px; overflow-y: auto; max-height: 80vh; }
  </style>
</head>
<body>
  ${NAV}
  <main>
    <h2>New Plan</h2>
    ${alertHtml}
    <div class="form-row">
      <form method="POST" action="/plans/new" id="new-plan-form">
        <div>
          <label for="repo">Repository</label>
          <select id="repo" name="repo" required>${repoOptions || '<option value="">— no repos found —</option>'}</select>
        </div>
        <div>
          <label for="title">Plan title</label>
          <input type="text" id="title" name="title" value="${escapeHtml(values.title ?? '')}" required placeholder="e.g. Add user authentication">
        </div>
        <div>
          <label for="validationCommands">Validation commands</label>
          <textarea id="validationCommands" name="validationCommands" rows="4" required placeholder="pnpm test&#10;pnpm run typecheck">${escapeHtml(values.validationCommands ?? '')}</textarea>
        </div>
        <div>
          <label for="body">Tasks (ralphex format: ### Task 1: … with - [ ] checkboxes)</label>
          <textarea id="body" name="body" rows="12" required>${escapeHtml(values.body ?? defaultBody)}</textarea>
        </div>
        <div>
          <label for="provider">Provider</label>
          <select id="provider" name="provider">${providerOptions}</select>
        </div>
        <button type="submit">Create plan</button>
      </form>
      <div class="preview-box">
        <h3>Live preview</h3>
        <pre id="preview"></pre>
      </div>
    </div>
  </main>
  <script>
    function generatePreview() {
      var title = document.getElementById('title').value;
      var cmds = document.getElementById('validationCommands').value;
      var body = document.getElementById('body').value;
      var preview = '# Plan: ' + (title || '(title)') + '\\n\\n## Validation Commands\\n\\n\`\`\`\\n' + (cmds || '(validation commands)') + '\\n\`\`\`\\n\\n' + (body || '(tasks)');
      document.getElementById('preview').textContent = preview;
    }
    document.getElementById('title').addEventListener('input', generatePreview);
    document.getElementById('validationCommands').addEventListener('input', generatePreview);
    document.getElementById('body').addEventListener('input', generatePreview);
    generatePreview();
  </script>
</body>
</html>`;
}

// ── Activity / Timeline ────────────────────────────────────────────────

interface ActivityEvent {
  ts: number;
  type: 'execution' | 'approval';
  label: string;
  detail: string;
  badgeClass: string;
}

export function renderActivityPage(
  executions: NormalizedExecution[] = [],
  approvalRequests: ApprovalRequestRow[] = []
): string {
  const events: ActivityEvent[] = [];

  for (const ex of executions) {
    const signal = ex.classification;
    events.push({
      ts: ex.updatedAt,
      type: 'execution',
      label: `${ex.repo} / ${ex.planFile}`,
      detail: `${ex.status} · ${ex.providerUsed ?? ex.providerRequested} · ${healthBadgeLabel(signal)}`,
      badgeClass: healthBadgeClass(signal),
    });
  }

  for (const ar of approvalRequests) {
    const badgeClass = ar.status === 'approved' ? 'badge-green' : ar.status === 'denied' ? 'badge-red' : 'badge-blue';
    events.push({
      ts: ar.createdAt,
      type: 'approval',
      label: `Approval: ${ar.repo} / ${ar.plan}`,
      detail: `${ar.action} · ${ar.status}${ar.decidedBy ? ' by ' + ar.decidedBy : ''}`,
      badgeClass,
    });
  }

  events.sort((a, b) => b.ts - a.ts);

  const itemsHtml = events.length === 0
    ? '<p class="empty">No activity yet.</p>'
    : `<ul class="timeline">${events.map(ev => `
      <li class="tl-item">
        <span class="tl-time">${escapeHtml(formatTimeSince(ev.ts))}</span>
        <span class="badge ${escapeHtml(ev.badgeClass)}">${escapeHtml(ev.type)}</span>
        <span class="tl-label">${escapeHtml(ev.label)}</span>
        <span class="tl-detail">${escapeHtml(ev.detail)}</span>
      </li>`).join('')}
    </ul>`;

  return page('Activity', `
    .timeline { list-style: none; padding: 0; margin: 0; }
    .tl-item { display: grid; grid-template-columns: 6rem 5rem 1fr 1fr; gap: 0.5rem; align-items: center; padding: 0.5rem 0; border-bottom: 1px solid #eee; font-size: 0.88rem; }
    .tl-time { color: #888; font-size: 0.82rem; }
    .tl-label { font-weight: 600; }
    .tl-detail { color: #555; }`,
    `<h2>Activity / Timeline</h2>${itemsHtml}`);
}

// ── Sessions ───────────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  name: string;
  targetRepo: string | null;
  status: 'active' | 'submitted' | 'abandoned';
  createdAt: number;
  updatedAt: number;
}

export function renderSessionsPage(sessions: SessionRow[] = []): string {
  const tableHtml = sessions.length === 0
    ? '<p class="empty">No Telegram planning sessions yet. Sessions are created via the Telegram bot (/session new).</p>'
    : `<table class="data-table">
        <thead><tr><th>Name</th><th>Repo</th><th>Status</th><th>Created</th><th>Updated</th></tr></thead>
        <tbody>${sessions.map(s => `
          <tr>
            <td>${escapeHtml(s.name)}</td>
            <td>${s.targetRepo ? escapeHtml(s.targetRepo) : '—'}</td>
            <td><span class="badge ${sessionBadgeClass(s.status)}">${escapeHtml(s.status)}</span></td>
            <td>${escapeHtml(formatTimeSince(s.createdAt))}</td>
            <td>${escapeHtml(formatTimeSince(s.updatedAt))}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;

  return page('Sessions', '', `<h2>Telegram Planning Sessions</h2>${tableHtml}`);
}

function sessionBadgeClass(status: string): string {
  switch (status) {
    case 'submitted': return 'badge-green';
    case 'abandoned': return 'badge-grey';
    default: return 'badge-blue';
  }
}
