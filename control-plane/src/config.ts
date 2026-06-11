export interface Config {
  workspaceRoot: string;
  orchestratorDbPath: string;
  claimsDir: string;
  password: string;
  sessionSecret: string;
  port: number;
  host: string;
  telegramBotToken: string;
  telegramAllowlist: number[];
  reposEnv?: string;
}

export function parseTelegramAllowlist(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(n => Number.isFinite(n) && n > 0);
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
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const telegramAllowlist = parseTelegramAllowlist(process.env.TELEGRAM_ALLOWLIST);
  const reposEnv = process.env.REPOS ?? '';

  return {
    workspaceRoot, orchestratorDbPath, claimsDir, password, sessionSecret,
    port, host, telegramBotToken, telegramAllowlist, reposEnv,
  };
}
