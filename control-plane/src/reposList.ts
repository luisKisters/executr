import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OrchestratorDB } from './db';
import { listActiveRegistryRepos } from './db';

export function getReposListPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.executr', 'repos.list');
}

// Writes the active registry entries to the loop-readable repos.list file.
// Format: one "name=URL#branch" entry per line — the same format entrypoint.sh parses.
// Called on startup and after any registry mutation (add/archive) so the watch
// loop picks up changes within one POLL_SECONDS cycle without a restart.
export function writeReposListFile(db: OrchestratorDB, workspaceRoot: string): void {
  const repos = listActiveRegistryRepos(db);
  const listPath = getReposListPath(workspaceRoot);
  mkdirSync(dirname(listPath), { recursive: true });
  const lines = repos.map(r => `${r.name}=${r.gitUrl}#${r.branch}`);
  const content = lines.length > 0 ? lines.join('\n') + '\n' : '';
  writeFileSync(listPath, content, 'utf8');
}
