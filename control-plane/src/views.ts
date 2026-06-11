import type { RepoInfo, PlanSummary } from './discovery';

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

export function renderOverviewPage(repos: RepoInfo[] = []): string {
  const reposHtml = repos.length === 0
    ? '<p class="empty">No repos found. Add repos to WORKSPACE_ROOT to see them here.</p>'
    : `<table class="repos-table">
        <thead>
          <tr>
            <th>Repo</th>
            <th>Branch</th>
            <th>Latest commit</th>
            <th>Plans</th>
            <th>Active plan</th>
          </tr>
        </thead>
        <tbody>
          ${repos.map(r => `
          <tr>
            <td><a href="/api/repos/${escapeHtml(r.name)}/plans">${escapeHtml(r.name)}</a></td>
            <td>${escapeHtml(r.currentBranch ?? '—')}</td>
            <td class="commit">${escapeHtml(r.latestCommit ?? '—')}</td>
            <td>${r.planCount}</td>
            <td>${r.activePlan ? escapeHtml(r.activePlan) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Control Plane — Overview</title>
  <style>${BASE_STYLES}
    .repos-table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
    .repos-table th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 2px solid #ddd; }
    .repos-table td { padding: 0.4rem 0.75rem; border-bottom: 1px solid #eee; vertical-align: top; }
    .repos-table a { color: #1a1a2e; }
    .commit { font-family: monospace; font-size: 0.85rem; max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  </style>
</head>
<body>
  ${NAV}
  <main>
    <h2>Overview</h2>
    ${reposHtml}
  </main>
</body>
</html>`;
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
    .success { color: #060; font-size: 0.9rem; padding: 0.5rem; background: #f0fff0; border: 1px solid #cfc; border-radius: 4px; margin-bottom: 1rem; }`;

export function renderPlansPage(
  repos: RepoInfo[],
  plans: Record<string, PlanSummary[]> = {},
  successMessage?: string
): string {
  const rows = repos.flatMap(r =>
    (plans[r.name] ?? []).map(p => `
      <tr>
        <td>${escapeHtml(r.name)}</td>
        <td><a href="/api/repos/${escapeHtml(r.name)}/plans/${escapeHtml(p.name)}">${escapeHtml(p.name)}</a></td>
        <td>${escapeHtml(p.status)}</td>
        <td class="hash">${p.contentHash ? escapeHtml(p.contentHash.slice(0, 8)) : '—'}</td>
        <td>${p.branch ? escapeHtml(p.branch) : '—'}</td>
      </tr>`)
  );

  const tableHtml = rows.length
    ? `<table class="data-table"><thead><tr><th>Repo</th><th>Plan</th><th>Status</th><th>Hash</th><th>Branch</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : '<p class="empty">No plans found.</p>';

  const successHtml = successMessage
    ? `<div class="success" role="status">${escapeHtml(successMessage)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Control Plane — Plans</title>
  <style>${BASE_STYLES}
    .data-table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
    .data-table th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 2px solid #ddd; }
    .data-table td { padding: 0.4rem 0.75rem; border-bottom: 1px solid #eee; vertical-align: top; }
    .data-table a { color: #1a1a2e; }
    .hash { font-family: monospace; font-size: 0.85rem; }
  </style>
</head>
<body>
  ${NAV}
  <main>
    <h2>Plans</h2>
    <p><a href="/plans/new">+ New Plan</a></p>
    ${successHtml}
    ${tableHtml}
  </main>
</body>
</html>`;
}

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
    form { max-width: 700px; display: flex; flex-direction: column; gap: 1rem; }
    label { font-size: 0.9rem; font-weight: 600; display: block; margin-bottom: 0.25rem; }
    input[type="text"], select, textarea { width: 100%; padding: 0.5rem 0.75rem; font-size: 0.9rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
    textarea { font-family: monospace; resize: vertical; }
    button[type="submit"] { align-self: flex-start; padding: 0.5rem 1.5rem; font-size: 0.95rem; background: #1a1a2e; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
    button[type="submit"]:hover { background: #16213e; }
  </style>
</head>
<body>
  ${NAV}
  <main>
    <h2>New Plan</h2>
    ${alertHtml}
    <form method="POST" action="/plans/new">
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
  </main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
