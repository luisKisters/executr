import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  claimPlan,
  renewClaim,
  releaseClaim,
  readClaim,
  isActiveClaim,
  acquireLock,
  isLockHeld,
  shouldSkipForClaim,
} from '../../src/claims';

let tmpDir: string;
let claimsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cp-claims-test-'));
  claimsDir = join(tmpDir, 'claims');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('claimPlan', () => {
  it('creates a claim file with correct fields', () => {
    const before = Date.now();
    const claim = claimPlan(claimsDir, 'myrepo', 'hash123', 'codex');
    const after = Date.now();
    expect(claim.repo).toBe('myrepo');
    expect(claim.planHash).toBe('hash123');
    expect(claim.provider).toBe('codex');
    expect(claim.leaseUntil).toBeGreaterThan(before);
    expect(claim.leaseUntil).toBeLessThanOrEqual(after + 5 * 60 * 1000);
    expect(claim.lockedAt).toBeGreaterThanOrEqual(before);
  });

  it('persists the claim to disk so it can be read back', () => {
    claimPlan(claimsDir, 'myrepo', 'hash123', 'codex');
    const read = readClaim(claimsDir, 'myrepo', 'hash123');
    expect(read).not.toBeNull();
    expect(read?.provider).toBe('codex');
  });

  it('accepts a custom lease duration', () => {
    const before = Date.now();
    const claim = claimPlan(claimsDir, 'r', 'h', 'claude-code', 60_000);
    expect(claim.leaseUntil).toBeGreaterThanOrEqual(before + 60_000 - 50);
    expect(claim.leaseUntil).toBeLessThanOrEqual(before + 60_000 + 200);
  });
});

describe('renewClaim', () => {
  it('extends the lease of an existing claim', () => {
    claimPlan(claimsDir, 'r', 'h', 'codex', 1_000);
    const ok = renewClaim(claimsDir, 'r', 'h', 5 * 60 * 1000);
    expect(ok).toBe(true);
    const refreshed = readClaim(claimsDir, 'r', 'h');
    expect(refreshed?.leaseUntil).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
  });

  it('returns false for a non-existent claim', () => {
    expect(renewClaim(claimsDir, 'r', 'noexist', 5000)).toBe(false);
  });
});

describe('releaseClaim', () => {
  it('removes the claim file', () => {
    claimPlan(claimsDir, 'r', 'h', 'codex');
    const ok = releaseClaim(claimsDir, 'r', 'h');
    expect(ok).toBe(true);
    expect(readClaim(claimsDir, 'r', 'h')).toBeNull();
  });

  it('returns false for a non-existent claim', () => {
    expect(releaseClaim(claimsDir, 'r', 'noexist')).toBe(false);
  });
});

describe('readClaim', () => {
  it('returns null when no claim file exists', () => {
    expect(readClaim(claimsDir, 'r', 'noexist')).toBeNull();
  });
});

describe('isActiveClaim', () => {
  it('returns false for null', () => {
    expect(isActiveClaim(null)).toBe(false);
  });

  it('returns true when leaseUntil is in the future', () => {
    const claim = claimPlan(claimsDir, 'r', 'h', 'codex', 60_000);
    expect(isActiveClaim(claim)).toBe(true);
  });

  it('returns false when lease has expired', () => {
    const expiredClaim = { repo: 'r', planHash: 'h', provider: 'codex' as const, leaseUntil: Date.now() - 1000, lockedAt: Date.now() - 2000 };
    expect(isActiveClaim(expiredClaim)).toBe(false);
  });
});

describe('shouldSkipForClaim (entrypoint-guard decision)', () => {
  it('returns run for null (unclaimed)', () => {
    expect(shouldSkipForClaim(null)).toBe('run');
  });

  it('returns run for an expired claim (any provider)', () => {
    const now = Date.now();
    const expired = { repo: 'r', planHash: 'h', provider: 'codex' as const, leaseUntil: now - 1, lockedAt: now - 2000 };
    expect(shouldSkipForClaim(expired, now)).toBe('run');
  });

  it('returns run for an active claude-code claim', () => {
    const now = Date.now();
    const claim = { repo: 'r', planHash: 'h', provider: 'claude-code' as const, leaseUntil: now + 60_000, lockedAt: now };
    expect(shouldSkipForClaim(claim, now)).toBe('run');
  });

  it('returns skip for an active codex claim', () => {
    const now = Date.now();
    const claim = { repo: 'r', planHash: 'h', provider: 'codex' as const, leaseUntil: now + 60_000, lockedAt: now };
    expect(shouldSkipForClaim(claim, now)).toBe('skip');
  });

  it('returns run when claim expires at exactly now', () => {
    const now = Date.now();
    const claim = { repo: 'r', planHash: 'h', provider: 'codex' as const, leaseUntil: now, lockedAt: now };
    expect(shouldSkipForClaim(claim, now)).toBe('run');
  });
});

describe('acquireLock / isLockHeld', () => {
  it('lock is held after acquire, released after calling release()', async () => {
    const release = await acquireLock('repo', 'hash');
    expect(isLockHeld('repo', 'hash')).toBe(true);
    release();
    expect(isLockHeld('repo', 'hash')).toBe(false);
  });

  it('second acquireLock waits until first is released', async () => {
    const release1 = await acquireLock('repo', 'planA');
    let secondLockAcquired = false;

    const lock2Promise = acquireLock('repo', 'planA').then((release2) => {
      secondLockAcquired = true;
      release2();
    });

    // Before release1, second lock should not be acquired yet
    await new Promise(r => setTimeout(r, 10));
    expect(secondLockAcquired).toBe(false);

    release1();
    await lock2Promise;
    expect(secondLockAcquired).toBe(true);
  });

  it('queues more than one waiter for the same lock', async () => {
    const release1 = await acquireLock('repo', 'planA');
    const order: string[] = [];

    const lock2Promise = acquireLock('repo', 'planA').then((release2) => {
      order.push('second');
      return release2;
    });
    const lock3Promise = acquireLock('repo', 'planA').then((release3) => {
      order.push('third');
      return release3;
    });

    await new Promise(r => setTimeout(r, 10));
    expect(order).toEqual([]);

    release1();
    const release2 = await lock2Promise;
    await new Promise(r => setTimeout(r, 10));
    expect(order).toEqual(['second']);

    release2();
    const release3 = await lock3Promise;
    expect(order).toEqual(['second', 'third']);
    release3();
    expect(isLockHeld('repo', 'planA')).toBe(false);
  });

  it('locks for different (repo, planHash) pairs are independent', async () => {
    const releaseA = await acquireLock('repo', 'planA');
    const releaseB = await acquireLock('repo', 'planB');
    expect(isLockHeld('repo', 'planA')).toBe(true);
    expect(isLockHeld('repo', 'planB')).toBe(true);
    releaseA();
    releaseB();
  });
});
