import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../../src/config';

const ENV_KEYS = [
  'WORKSPACE_ROOT',
  'ORCHESTRATOR_DB_PATH',
  'CLAIMS_DIR',
  'CONTROL_PLANE_PASSWORD',
  'SESSION_SECRET',
  'CONTROL_PLANE_PORT',
  'HOST',
];

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe('loadConfig defaults', () => {
  it('uses /workspace as default WORKSPACE_ROOT', () => {
    const config = loadConfig();
    expect(config.workspaceRoot).toBe('/workspace');
  });

  it('derives orchestratorDbPath from WORKSPACE_ROOT default', () => {
    const config = loadConfig();
    expect(config.orchestratorDbPath).toBe('/workspace/.executr/orchestrator.db');
  });

  it('derives claimsDir from WORKSPACE_ROOT default', () => {
    const config = loadConfig();
    expect(config.claimsDir).toBe('/workspace/.executr/claims');
  });

  it('defaults port to 8090', () => {
    const config = loadConfig();
    expect(config.port).toBe(8090);
  });

  it('defaults host to 0.0.0.0', () => {
    const config = loadConfig();
    expect(config.host).toBe('0.0.0.0');
  });
});

describe('loadConfig env overrides', () => {
  it('respects WORKSPACE_ROOT override', () => {
    process.env.WORKSPACE_ROOT = '/custom/workspace';
    const config = loadConfig();
    expect(config.workspaceRoot).toBe('/custom/workspace');
  });

  it('respects ORCHESTRATOR_DB_PATH override', () => {
    process.env.ORCHESTRATOR_DB_PATH = '/custom/db.sqlite';
    const config = loadConfig();
    expect(config.orchestratorDbPath).toBe('/custom/db.sqlite');
  });

  it('respects CLAIMS_DIR override', () => {
    process.env.CLAIMS_DIR = '/custom/claims';
    const config = loadConfig();
    expect(config.claimsDir).toBe('/custom/claims');
  });

  it('derives orchestratorDbPath from custom WORKSPACE_ROOT when not overridden', () => {
    process.env.WORKSPACE_ROOT = '/custom/workspace';
    const config = loadConfig();
    expect(config.orchestratorDbPath).toBe('/custom/workspace/.executr/orchestrator.db');
  });

  it('reads CONTROL_PLANE_PASSWORD', () => {
    process.env.CONTROL_PLANE_PASSWORD = 'mysecret';
    const config = loadConfig();
    expect(config.password).toBe('mysecret');
  });

  it('uses password as sessionSecret when SESSION_SECRET not set', () => {
    process.env.CONTROL_PLANE_PASSWORD = 'mysecret';
    const config = loadConfig();
    expect(config.sessionSecret).toBe('mysecret');
  });

  it('uses SESSION_SECRET when set', () => {
    process.env.CONTROL_PLANE_PASSWORD = 'pass';
    process.env.SESSION_SECRET = 'separate-secret';
    const config = loadConfig();
    expect(config.sessionSecret).toBe('separate-secret');
  });

  it('parses CONTROL_PLANE_PORT as integer', () => {
    process.env.CONTROL_PLANE_PORT = '9090';
    const config = loadConfig();
    expect(config.port).toBe(9090);
  });
});
