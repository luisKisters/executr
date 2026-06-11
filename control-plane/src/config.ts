export interface Config {
  workspaceRoot: string;
  orchestratorDbPath: string;
  claimsDir: string;
  password: string;
  sessionSecret: string;
  port: number;
  host: string;
}

export function loadConfig(): Config {
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? '/workspace';
  const orchestratorDbPath =
    process.env.ORCHESTRATOR_DB_PATH ?? `${workspaceRoot}/.executr/orchestrator.db`;
  const claimsDir = process.env.CLAIMS_DIR ?? `${workspaceRoot}/.executr/claims`;
  const password = process.env.CONTROL_PLANE_PASSWORD ?? '';
  const sessionSecret = process.env.SESSION_SECRET ?? password;
  const port = parseInt(process.env.CONTROL_PLANE_PORT ?? '8090', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  return { workspaceRoot, orchestratorDbPath, claimsDir, password, sessionSecret, port, host };
}
