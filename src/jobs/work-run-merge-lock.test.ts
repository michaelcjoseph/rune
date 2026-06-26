/**
 * Project 15 P1.5 — per-product / per-base-branch merge-lock suite
 * (`work-run-merge-lock.ts`). test-plan.md §6 "Concurrency + durability":
 * "Two projects sharing one product `main` serialize through the per-product /
 * per-base-branch lock; neither corrupts the other's merge."
 *
 * Written TEST-FIRST: both `baseBranchLockKey` and `withBaseBranchLock` are
 * `notImplemented` scaffolds, so every test here is RED until the P1.5 impl
 * lands. Expected failure: the `notImplemented` throw / rejection — never a
 * module-resolution or syntax error. The serialization tests set up an ordering
 * probe whose assertions only run once the mutex exists; until then the call
 * throws and the test is red for the right reason.
 *
 * Headline contract: the lock keys on (product, baseBranch), NOT on the project
 * slug — two projects of the same product landing on the same `main` must
 * serialize, because they share one base branch and the supervision store
 * assumes a single writer.
 */

import { describe, it, expect } from 'vitest';
import { baseBranchLockKey, withBaseBranchLock } from './work-run-merge-lock.js';

/** A deferred so a test can hold the lock open until it chooses to release. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Yield a full macrotask so EVERY pending microtask drains, regardless of how
 * many `.then()` hops the mutex impl puts before invoking `fn`. (A single
 * `await Promise.resolve()` only drains one tick and would false-fail a correct
 * impl whose dispatch is a hop deeper.) The held-open deferred — not this flush
 * — is what proves a waiter can't proceed: the lock holder parks on an
 * unresolved promise, so a serialized waiter stays blocked across the flush.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('baseBranchLockKey — per-product / per-base-branch (P1.5)', () => {
  it('is the `<product>:<baseBranch>` composite (delimiter guards against collision-prone formats)', () => {
    // Pin the concrete shape: a delimiter-less `product+baseBranch` would let
    // ("jar","vis/main") collide with ("rune","/main"). The gate runtime keys
    // its concurrent-run check on this exact string.
    expect(baseBranchLockKey('rune', 'main')).toBe('rune:main');
  });

  it('is identical for the same product + base branch (so they serialize)', () => {
    expect(baseBranchLockKey('rune', 'main')).toBe(baseBranchLockKey('rune', 'main'));
  });

  it('differs by base branch within one product', () => {
    expect(baseBranchLockKey('rune', 'main')).not.toBe(baseBranchLockKey('rune', 'release'));
  });

  it('differs by product for the same base branch name', () => {
    expect(baseBranchLockKey('rune', 'main')).not.toBe(baseBranchLockKey('aura', 'main'));
  });

  it('does NOT depend on the project slug — two projects of one product collide on one key', () => {
    // The headline reason the lock is per-product/per-base and not per-project:
    // the key takes no project argument, so passing different project slugs (via
    // an extra arg the signature ignores) yields the SAME key — the two projects
    // necessarily serialize on it.
    const keyA = (baseBranchLockKey as (p: string, b: string, project?: string) => string)(
      'rune', 'main', 'project-A',
    );
    const keyB = (baseBranchLockKey as (p: string, b: string, project?: string) => string)(
      'rune', 'main', 'project-B',
    );
    expect(keyA).toBe(keyB);
  });
});

describe('withBaseBranchLock — serialization (P1.5)', () => {
  it('serializes two finalizers for two projects of the SAME product/base branch', async () => {
    // Two DIFFERENT projects, ONE product + base branch → one shared lock key.
    // The second must not start its critical section until the first releases.
    const order: string[] = [];
    const firstHolds = deferred();

    const p1 = withBaseBranchLock('rune', 'main', async () => {
      order.push('p1:start'); // project A
      await firstHolds.promise; // hold the lock open
      order.push('p1:end');
    });
    const p2 = withBaseBranchLock('rune', 'main', async () => {
      order.push('p2:start'); // project B — must wait for A to finish
    });

    // Let everything settle: p2 must NOT have started while p1 holds the lock
    // (p1 is parked on the unresolved deferred, so a serialized p2 stays blocked
    // across a full macrotask flush regardless of the mutex's dispatch depth).
    await flush();
    expect(order).toEqual(['p1:start']);

    firstHolds.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['p1:start', 'p1:end', 'p2:start']);
  });

  it('does NOT block different base branches (concurrent on distinct keys)', async () => {
    const order: string[] = [];
    const aHolds = deferred();

    const a = withBaseBranchLock('rune', 'main', async () => {
      order.push('main:start');
      await aHolds.promise;
      order.push('main:end');
    });
    const b = withBaseBranchLock('rune', 'release', async () => {
      order.push('release:start'); // distinct key — runs immediately
    });

    await flush();
    // The release-branch finalize starts without waiting on the main-branch one.
    expect(order).toContain('release:start');

    aHolds.resolve();
    await Promise.all([a, b]);
  });

  it('releases the lock even when fn throws — one failed finalize never deadlocks the next', async () => {
    await expect(
      withBaseBranchLock('rune', 'main', async () => {
        throw new Error('merge blew up');
      }),
    ).rejects.toThrow('merge blew up');

    // A subsequent acquisition of the same key still proceeds.
    const ran = await withBaseBranchLock('rune', 'main', async () => 'ok');
    expect(ran).toBe('ok');
  });

  it('returns fn\'s resolved value to the caller', async () => {
    const value = await withBaseBranchLock('rune', 'main', async () => 42);
    expect(value).toBe(42);
  });
});
