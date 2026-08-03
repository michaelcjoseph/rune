/**
 * Phase 1 — resource lease scheduler contract.
 *
 * The scheduler owns process-local resource contention.  These tests exercise
 * its public seam rather than the implementation: a caller identifies its run
 * and operation, waits through an AbortSignal/bounded timeout, and always
 * releases through an idempotent handle or `withLease`.
 *
 * `resource-lease.ts` is intentionally loaded dynamically until the coder
 * adds it.  A missing module becomes the clean missing-factory assertion below,
 * rather than a Vitest import-resolution failure.
 */

import { beforeAll, describe, expect, it } from 'vitest';

type LeaseType =
  | 'base-branch'
  | 'ios-simulator'
  | 'android-emulator'
  | 'port-range'
  | 'build-capacity'
  | 'cache-dir'
  | 'device';

type LeaseParty = { runId: string; operationId: string };

type LeaseRequest = {
  type: LeaseType;
  key: string;
  holder: LeaseParty;
  signal: AbortSignal;
  waitTimeoutMs?: number;
};

type LeaseHandle = { release: () => void | Promise<void> };

type LeaseSnapshot = {
  resource: { type: LeaseType; key: string; capacity: number };
  holders: LeaseParty[];
  waiters: Array<LeaseParty & { position: number; waitingSince: string }>;
};

type LeaseEvent = {
  kind: 'wait' | 'grant' | 'release';
  resource: { type: LeaseType; key: string };
  party: LeaseParty;
};

type ResourceLeaseScheduler = {
  acquire: (request: LeaseRequest) => Promise<LeaseHandle>;
  withLease: <T>(request: LeaseRequest, work: () => Promise<T> | T) => Promise<T>;
  snapshot: (type: LeaseType, key: string) => LeaseSnapshot | undefined;
};

type ResourceLeaseModule = {
  createResourceLeaseScheduler?: (options?: {
    resources?: Array<{ type: LeaseType; key: string; capacity: number }>;
    onEvent?: (event: LeaseEvent) => void;
  }) => ResourceLeaseScheduler;
};

let leaseModule: ResourceLeaseModule = {};

beforeAll(async () => {
  try {
    leaseModule = await import(new URL('./resource-lease.js', import.meta.url).href) as ResourceLeaseModule;
  } catch {
    leaseModule = {};
  }
});

function scheduler(options?: Parameters<NonNullable<ResourceLeaseModule['createResourceLeaseScheduler']>>[0]): ResourceLeaseScheduler {
  const factory = leaseModule.createResourceLeaseScheduler;
  expect(factory, 'expected resource-lease.ts to export createResourceLeaseScheduler').toBeTypeOf('function');
  if (!factory) throw new Error('unreachable after missing scheduler factory assertion');
  return factory(options);
}

function request(
  runId: string,
  operationId: string,
  overrides: Partial<Omit<LeaseRequest, 'holder' | 'signal'>> & { signal?: AbortSignal } = {},
): LeaseRequest {
  return {
    type: 'base-branch',
    key: 'repo-id:main',
    holder: { runId, operationId },
    signal: overrides.signal ?? new AbortController().signal,
    ...overrides,
  };
}

/** Drain queued Promise continuations before observing scheduler state. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ResourceLeaseScheduler', () => {
  it('exports the scheduler factory', () => {
    expect(leaseModule.createResourceLeaseScheduler).toBeTypeOf('function');
  });

  it('grants one resource in FIFO order and exposes the holder plus ordered waiters read-only', async () => {
    const leases = scheduler();
    const first = await leases.acquire(request('run-1', 'merge-1'));
    const second = leases.acquire(request('run-2', 'merge-2'));
    const third = leases.acquire(request('run-3', 'merge-3'));

    await flush();
    const queued = leases.snapshot('base-branch', 'repo-id:main');
    expect(queued).toEqual({
      resource: { type: 'base-branch', key: 'repo-id:main', capacity: 1 },
      holders: [{ runId: 'run-1', operationId: 'merge-1' }],
      waiters: [
        expect.objectContaining({ runId: 'run-2', operationId: 'merge-2', position: 1, waitingSince: expect.any(String) }),
        expect.objectContaining({ runId: 'run-3', operationId: 'merge-3', position: 2, waitingSince: expect.any(String) }),
      ],
    });

    await first.release();
    const secondHandle = await second;
    expect(leases.snapshot('base-branch', 'repo-id:main')?.holders).toEqual([
      { runId: 'run-2', operationId: 'merge-2' },
    ]);

    await secondHandle.release();
    const thirdHandle = await third;
    await thirdHandle.release();
    expect(leases.snapshot('base-branch', 'repo-id:main')).toBeUndefined();
  });

  it('removes an aborted waiter immediately without letting it leapfrog a later FIFO waiter', async () => {
    const leases = scheduler();
    const first = await leases.acquire(request('run-1', 'merge-1'));
    const cancelled = new AbortController();
    const abandoned = leases.acquire(request('run-2', 'merge-2', { signal: cancelled.signal }));
    const next = leases.acquire(request('run-3', 'merge-3'));

    await flush();
    cancelled.abort();
    await expect(abandoned).rejects.toThrow(/abort|cancel/i);
    expect(leases.snapshot('base-branch', 'repo-id:main')?.waiters).toEqual([
      expect.objectContaining({ runId: 'run-3', operationId: 'merge-3', position: 1 }),
    ]);

    await first.release();
    const nextHandle = await next;
    await nextHandle.release();
    expect(leases.snapshot('base-branch', 'repo-id:main')).toBeUndefined();
  });

  it('releases an acquired holder when its signal aborts and grants the next waiter', async () => {
    const leases = scheduler();
    const cancelled = new AbortController();
    const first = await leases.acquire(request('run-1', 'merge-1', {
      signal: cancelled.signal,
    }));
    const next = leases.acquire(request('run-2', 'merge-2'));

    await flush();
    cancelled.abort();
    const nextHandle = await next;

    expect(leases.snapshot('base-branch', 'repo-id:main')).toEqual({
      resource: { type: 'base-branch', key: 'repo-id:main', capacity: 1 },
      holders: [{ runId: 'run-2', operationId: 'merge-2' }],
      waiters: [],
    });

    await first.release();
    await nextHandle.release();
    expect(leases.snapshot('base-branch', 'repo-id:main')).toBeUndefined();
  });

  it('rejects acquisition when a grant subscriber synchronously aborts the holder', async () => {
    const cancelled = new AbortController();
    const leases = scheduler({
      onEvent: (event) => {
        if (event.kind === 'grant') cancelled.abort();
      },
    });

    await expect(leases.acquire(request('run-1', 'merge-1', {
      signal: cancelled.signal,
    }))).rejects.toThrow(/abort|cancel/i);
    expect(leases.snapshot('base-branch', 'repo-id:main')).toBeUndefined();
  });

  it('does not start withLease work when cancellation lands after grant resolution', async () => {
    const cancelled = new AbortController();
    let workStarted = false;
    const leases = scheduler({
      onEvent: (event) => {
        if (event.kind === 'grant') queueMicrotask(() => cancelled.abort());
      },
    });

    await expect(leases.withLease(request('run-1', 'merge-1', {
      signal: cancelled.signal,
    }), () => {
      workStarted = true;
    })).rejects.toThrow(/abort|cancel/i);
    expect(workStarted).toBe(false);
    expect(leases.snapshot('base-branch', 'repo-id:main')).toBeUndefined();
  });

  it('bounds a queued wait by timeout and leaves no stale waiter behind', async () => {
    const leases = scheduler();
    const holder = await leases.acquire(request('run-1', 'merge-1'));
    const timedOut = leases.acquire(request('run-2', 'merge-2', { waitTimeoutMs: 50 }));

    await expect(timedOut).rejects.toThrow(/timed out/i);
    expect(leases.snapshot('base-branch', 'repo-id:main')).toEqual({
      resource: { type: 'base-branch', key: 'repo-id:main', capacity: 1 },
      holders: [{ runId: 'run-1', operationId: 'merge-1' }],
      waiters: [],
    });

    await holder.release();
    expect(leases.snapshot('base-branch', 'repo-id:main')).toBeUndefined();
  });

  it('releases after work throws and leaves the resource usable by a later operation', async () => {
    const leases = scheduler();

    await expect(leases.withLease(request('run-1', 'merge-1'), async () => {
      throw new Error('merge failed');
    })).rejects.toThrow('merge failed');

    expect(leases.snapshot('base-branch', 'repo-id:main')).toBeUndefined();
    const later = await leases.acquire(request('run-2', 'merge-2'));
    await later.release();
    await later.release();
    expect(leases.snapshot('base-branch', 'repo-id:main')).toBeUndefined();
  });

  it('emits structured wait, grant, and release records with resource and party identity', async () => {
    const events: LeaseEvent[] = [];
    const leases = scheduler({ onEvent: (event) => events.push(event) });
    const first = await leases.acquire(request('run-1', 'merge-1'));
    const second = leases.acquire(request('run-2', 'merge-2'));

    await flush();
    await first.release();
    const secondHandle = await second;
    await secondHandle.release();

    expect(events).toEqual(expect.arrayContaining([
      { kind: 'wait', resource: { type: 'base-branch', key: 'repo-id:main' }, party: { runId: 'run-2', operationId: 'merge-2' } },
      { kind: 'grant', resource: { type: 'base-branch', key: 'repo-id:main' }, party: { runId: 'run-1', operationId: 'merge-1' } },
      { kind: 'release', resource: { type: 'base-branch', key: 'repo-id:main' }, party: { runId: 'run-1', operationId: 'merge-1' } },
      { kind: 'grant', resource: { type: 'base-branch', key: 'repo-id:main' }, party: { runId: 'run-2', operationId: 'merge-2' } },
      { kind: 'release', resource: { type: 'base-branch', key: 'repo-id:main' }, party: { runId: 'run-2', operationId: 'merge-2' } },
    ]));
  });

  it('allows configured build capacity to grant that many holders without imposing a global cap', async () => {
    const leases = scheduler({
      resources: [{ type: 'build-capacity', key: 'heavy-build', capacity: 2 }],
    });
    const first = await leases.acquire(request('run-1', 'build-1', { type: 'build-capacity', key: 'heavy-build' }));
    const second = await leases.acquire(request('run-2', 'build-2', { type: 'build-capacity', key: 'heavy-build' }));
    const third = leases.acquire(request('run-3', 'build-3', { type: 'build-capacity', key: 'heavy-build' }));

    await flush();
    expect(leases.snapshot('build-capacity', 'heavy-build')).toEqual({
      resource: { type: 'build-capacity', key: 'heavy-build', capacity: 2 },
      holders: [
        { runId: 'run-1', operationId: 'build-1' },
        { runId: 'run-2', operationId: 'build-2' },
      ],
      waiters: [expect.objectContaining({ runId: 'run-3', operationId: 'build-3', position: 1 })],
    });

    await first.release();
    const thirdHandle = await third;
    await Promise.all([second.release(), thirdHandle.release()]);
    expect(leases.snapshot('build-capacity', 'heavy-build')).toBeUndefined();
  });
});
