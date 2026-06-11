import type { RepoInfo } from './discovery';

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
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 0; }
    nav { background: #1a1a2e; color: #fff; padding: 0.75rem 1.5rem; display: flex; align-items: center; gap: 1.5rem; }
    nav a { color: #ccc; text-decoration: none; font-size: 0.9rem; }
    nav a:hover { color: #fff; }
    nav .title { font-weight: 700; font-size: 1rem; color: #fff; margin-right: auto; }
    main { padding: 2rem 1.5rem; }
    h2 { font-size: 1.2rem; }
    .empty { color: #888; font-size: 0.95rem; }
    .repos-table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
    .repos-table th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 2px solid #ddd; }
    .repos-table td { padding: 0.4rem 0.75rem; border-bottom: 1px solid #eee; vertical-align: top; }
    .repos-table a { color: #1a1a2e; }
    .commit { font-family: monospace; font-size: 0.85rem; max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  </style>
</head>
<body>
  <nav>
    <span class="title">Control Plane</span>
    <a href="/">Overview</a>
    <a href="/plans">Plans</a>
    <a href="/plans/new">New Plan</a>
    <a href="/activity">Activity</a>
    <a href="/sessions">Sessions</a>
    <a href="/logout">Sign out</a>
  </nav>
  <main>
    <h2>Overview</h2>
    ${reposHtml}
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
