import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { join } from 'path';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const TEST_PORT = 19099;
const TEST_PASSWORD = 'e2e-test-password';
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: ChildProcess;
let screenshotDir: string;

async function waitForServer(maxMs = 15000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Server at ${BASE_URL} not ready after ${maxMs}ms`);
}

function ab(cmd: string): string {
  return execSync(`agent-browser ${cmd}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

beforeAll(async () => {
  screenshotDir = mkdtempSync(join(tmpdir(), 'cp-e2e-'));
  const tsxPath = join(__dirname, '../../node_modules/.bin/tsx');
  const srcIndex = join(__dirname, '../../src/index.ts');

  serverProcess = spawn(tsxPath, [srcIndex], {
    env: {
      ...process.env,
      CONTROL_PLANE_PORT: String(TEST_PORT),
      CONTROL_PLANE_PASSWORD: TEST_PASSWORD,
      SESSION_SECRET: 'e2e-session-secret-that-is-long-enough',
      WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'cp-ws-')),
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.error('[server]', msg);
  });

  await waitForServer();
});

afterAll(() => {
  try { ab('close'); } catch { /* ignore */ }
  serverProcess?.kill('SIGTERM');
});

describe('auth gate (agent-browser)', () => {
  it('unauthenticated / redirects to login page', () => {
    ab(`open "${BASE_URL}/"`);
    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('password');

    const screenshotPath = join(screenshotDir, '01-login.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });

  it('wrong password shows error', () => {
    ab(`open "${BASE_URL}/login"`);
    ab(`fill 'input[name="password"]' 'wrongpassword'`);
    ab(`click 'button[type="submit"]'`);
    ab('wait 1000');

    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('invalid');
  });

  it('correct password reaches overview page', () => {
    ab(`open "${BASE_URL}/login"`);
    ab(`fill 'input[name="password"]' '${TEST_PASSWORD}'`);
    ab(`click 'button[type="submit"]'`);
    ab('wait 1000');

    const snapshot = ab('snapshot');
    expect(snapshot.toLowerCase()).toContain('overview');
    expect(snapshot.toLowerCase()).not.toContain('sign in');

    const screenshotPath = join(screenshotDir, '02-overview.png');
    ab(`screenshot "${screenshotPath}"`);
    expect(existsSync(screenshotPath)).toBe(true);
  });
});
