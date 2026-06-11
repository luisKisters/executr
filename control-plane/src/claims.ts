import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderName } from './contracts';

export interface Claim {
  repo: string;
  planHash: string;
  provider: ProviderName;
  leaseUntil: number;
  lockedAt: number;
}

// Per-(repo, planHash) in-process mutex.
// Cross-process guard uses the claim file directly (entrypoint reads it).
const activeLocks = new Map<string, Promise<void>>();

function claimFilePath(claimsDir: string, repo: string, planHash: string): string {
  // sanitize repo name to avoid directory traversal
  const safeRepo = repo.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(claimsDir, `${safeRepo}__${planHash}.json`);
}

function lockKey(repo: string, planHash: string): string {
  return `${repo}::${planHash}`;
}

export function claimPlan(
  claimsDir: string,
  repo: string,
  planHash: string,
  provider: ProviderName,
  leaseDurationMs = 5 * 60 * 1000
): Claim {
  mkdirSync(claimsDir, { recursive: true });
  const claim: Claim = {
    repo,
    planHash,
    provider,
    leaseUntil: Date.now() + leaseDurationMs,
    lockedAt: Date.now(),
  };
  writeFileSync(claimFilePath(claimsDir, repo, planHash), JSON.stringify(claim), 'utf8');
  return claim;
}

export function renewClaim(
  claimsDir: string,
  repo: string,
  planHash: string,
  leaseDurationMs = 5 * 60 * 1000
): boolean {
  const fp = claimFilePath(claimsDir, repo, planHash);
  if (!existsSync(fp)) return false;
  try {
    const claim: Claim = JSON.parse(readFileSync(fp, 'utf8'));
    claim.leaseUntil = Date.now() + leaseDurationMs;
    writeFileSync(fp, JSON.stringify(claim), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function releaseClaim(claimsDir: string, repo: string, planHash: string): boolean {
  const fp = claimFilePath(claimsDir, repo, planHash);
  if (!existsSync(fp)) return false;
  try {
    unlinkSync(fp);
    return true;
  } catch {
    return false;
  }
}

export function readClaim(claimsDir: string, repo: string, planHash: string): Claim | null {
  const fp = claimFilePath(claimsDir, repo, planHash);
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, 'utf8')) as Claim;
  } catch {
    return null;
  }
}

export function isActiveClaim(claim: Claim | null, now = Date.now()): boolean {
  if (!claim) return false;
  return claim.leaseUntil > now;
}

export async function acquireLock(repo: string, planHash: string): Promise<() => void> {
  const key = lockKey(repo, planHash);
  const existing = activeLocks.get(key);
  if (existing) {
    await existing;
  }

  let release!: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  activeLocks.set(key, lockPromise);

  return () => {
    activeLocks.delete(key);
    release();
  };
}

export function isLockHeld(repo: string, planHash: string): boolean {
  return activeLocks.has(lockKey(repo, planHash));
}

/**
 * Pure decision function consumed by the entrypoint guard logic and unit tests.
 * Returns 'skip' only when there is an active claim for a non-claude-code provider.
 * Returns 'run' for: unclaimed, expired claim, or claude-code claim.
 */
export function shouldSkipForClaim(
  claim: Claim | null,
  now = Date.now()
): 'skip' | 'run' {
  if (!claim) return 'run';
  if (claim.leaseUntil <= now) return 'run';
  if (claim.provider === 'claude-code') return 'run';
  return 'skip';
}
