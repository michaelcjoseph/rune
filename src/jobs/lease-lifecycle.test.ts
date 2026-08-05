/**
 * Phase 1 — lease lifecycle and restart-recovery contract.
 *
 * The scheduler proves process-local FIFO in `resource-lease.test.ts`. These
 * tests pin the distinct lifecycle boundary: persisted `waitingOn` state is
 * diagnostic only, terminal/cancel cleanup removes it, and restart recovery
 * must acquire again through a fresh scheduler rather than trust the stale
 * record as ownership.
 *
 * The lifecycle module is loaded dynamically until the implementation exists,
 * so the red failure is an intentional missing-factory assertion instead of a
 * Vitest module-resolution error.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createResourceLeaseScheduler } from './resource-lease.js';

type LeaseType = 'base-branch';

type WaitingOn = {
  resource: { type: LeaseType; key: string };
  operationId: string;
  waitingSince: string;
};

type Run = {
  id: string;
  product: string;
  project: string;
  status: 'running' | 'failed';
  startedAt: string;
  lastHeartbeatAt: string;
  waitingOn?: WaitingOn;
};

type LeaseRequest = {
  type: LeaseType;
  key: string;
  operationId: string;
  signal: AbortSignal;
  waitTimeoutMs?: number;
};

type LeaseHandle = { release(): void | Promise<void> };

type Lifecycle = {
  acquire(run: Run, request: LeaseRequest): Promise<LeaseHandle>;
  withLease<T>(run: Run, request: LeaseRequest, work: () => Promise<T> | T): Promise<T>;
  /** Terminal cleanup must release an owned handle and remove durable wait state. */
  releaseRun(runId: string): void | Promise<void>;
  /**
   * Re-enter persisted waiters after a daemon restart. Implementations must
   * order the supplied records by their persisted waitingSince timestamps
   * before acquiring from the new scheduler.
   */
  recoverWaitingRuns(runs: readonly Run[], signalForRun?: (run: Run) => AbortSignal): Promise<{
    acquisitions: ReadonlyMap<string, Promise<LeaseHandle>>;
  }>;
};

type LifecycleModule = {
  createRunLeaseLifecycle?: (options: {
    scheduler: ReturnType<typeof createResourceLeaseScheduler>;
    writeRun: (run: Run) => void;
    resourceExists: (resource: WaitingOn['resource']) => boolean | Promise<boolean>;
    reportBlockedEnvironment: (blocked: {
      runId: string;
      kind: 'blocked-environment';
      resource: WaitingOn['resource'];
      remediation: string;
    }) => void;
    now: () => string;
  }) => Lifecycle;
};

let lifecycleModule: LifecycleModule = {};

beforeAll(async () => {
  try {
    lifecycleModule = await import(new URL('./lease-lifecycle.js', import.meta.url).href) as LifecycleModule;
  } catch {
    lifecycleModule = {};
  }
});

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function run(id: string, waitingOn?: WaitingOn): Run {
  return {
    id,
    product: 'aura',
    project: '24-execution-profiles',
    status: 'running',
    startedAt: '2026-08-05T12:00:00.000Z',
    lastHeartbeatAt: '2026-08-05T12:00:00.000Z',
    ...(waitingOn ? { waitingOn } : {}),
  };
}

function request(operationId: string, signal = new AbortController().signal): LeaseRequest {
  return {
    type: 'base-branch',
    key: 'repo-a:main',
    operationId,
    signal,
  };
}

function lifecycle(options: Partial<Parameters<NonNullable<LifecycleModule['createRunLeaseLifecycle']>>[0]> = {}) {
  const factory = lifecycleModule.createRunLeaseLifecycle;
  expect(factory, 'expected lease-lifecycle.ts to export createRunLeaseLifecycle').toBeTypeOf('function');
  if (!factory) throw new Error('unreachable after missing lifecycle factory assertion');

  const writes: Run[] = [];
  const blocked: Array<{
    runId: string;
    kind: 'blocked-environment';
    resource: WaitingOn['resource'];
    remediation: string;
  }> = [];
  const scheduler = options.scheduler ?? createResourceLeaseScheduler();
  return {
    lifecycle: factory({
      scheduler,
      writeRun: (entry) => writes.push(structuredClone(entry)),
      resourceExists: () => true,
      reportBlockedEnvironment: (entry) => blocked.push(entry),
      now: () => '2026-08-05T12:01:00.000Z',
      ...options,
    }),
    scheduler,
    writes,
    blocked,
  };
}

describe('run lease lifecycle', () => {
  it('does not persist clears for an uncontended lease that never queued', async () => {
    const { lifecycle: leases, writes } = lifecycle();

    await leases.withLease(run('run-uncontended'), request('uncontended'), () => 'done');

    expect(writes).toEqual([]);
  });

  it('persists waiting metadata while queued, then clears it on grant and terminal release', async () => {
    const { lifecycle: leases, scheduler, writes } = lifecycle();
    const first = run('run-holder');
    const waiter = run('run-waiter');
    const firstHandle = await leases.acquire(first, request('finalize-holder'));
    const queued = leases.acquire(waiter, request('finalize-waiter'));

    await flush();
    expect(writes.at(-1)).toMatchObject({
      id: 'run-waiter',
      waitingOn: {
        resource: { type: 'base-branch', key: 'repo-a:main' },
        operationId: 'finalize-waiter',
        waitingSince: '2026-08-05T12:01:00.000Z',
      },
    });

    await firstHandle.release();
    await queued;
    expect(writes.at(-1)).toMatchObject({ id: 'run-waiter' });
    expect(writes.at(-1)).not.toHaveProperty('waitingOn');

    await leases.releaseRun('run-waiter');
    expect(scheduler.snapshot('base-branch', 'repo-a:main')).toBeUndefined();
  });

  it('cancellation and a crashing operation leave neither a holder nor stale waiting metadata', async () => {
    const { lifecycle: leases, scheduler, writes } = lifecycle();
    const holder = await leases.acquire(run('run-holder'), request('holder'));
    const cancelled = new AbortController();
    const queuedRun = run('run-cancelled');
    const queued = leases.acquire(queuedRun, request('cancelled', cancelled.signal));

    await flush();
    expect(writes.at(-1)).toHaveProperty('waitingOn');
    cancelled.abort();
    await expect(queued).rejects.toThrow(/abort|cancel/i);
    expect(writes.at(-1)).toMatchObject({ id: 'run-cancelled' });
    expect(writes.at(-1)).not.toHaveProperty('waitingOn');

    const crashedRun = run('run-crashed');
    const crashed = leases.withLease(crashedRun, request('crashed'), () => {
      throw new Error('child crashed');
    });
    await flush();
    expect(writes.at(-1)).toMatchObject({ id: 'run-crashed', waitingOn: expect.any(Object) });
    await holder.release();
    await expect(crashed).rejects.toThrow('child crashed');
    expect(scheduler.snapshot('base-branch', 'repo-a:main')).toBeUndefined();
    expect(writes.at(-1)).toMatchObject({ id: 'run-crashed' });
    expect(writes.at(-1)).not.toHaveProperty('waitingOn');
  });

  it('does not start lifecycle work when cancellation lands after grant resolution', async () => {
    const cancelled = new AbortController();
    let workStarted = false;
    const scheduler = createResourceLeaseScheduler({
      onEvent: (event) => {
        if (event.kind === 'grant') queueMicrotask(() => cancelled.abort());
      },
    });
    const { lifecycle: leases, writes } = lifecycle({ scheduler });

    await expect(leases.withLease(
      run('run-cancelled-after-grant'),
      request('cancelled-after-grant', cancelled.signal),
      () => {
        workStarted = true;
      },
    )).rejects.toThrow(/abort|cancel/i);

    expect(workStarted).toBe(false);
    expect(scheduler.snapshot('base-branch', 'repo-a:main')).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it('keeps an active operation leased until its work settles after cancellation', async () => {
    const cancelled = new AbortController();
    let settleWork!: () => void;
    const workSettled = new Promise<void>(resolve => { settleWork = resolve; });
    const { lifecycle: leases, scheduler } = lifecycle();

    const active = leases.withLease(
      run('run-active'),
      request('active-operation', cancelled.signal),
      () => workSettled,
    );
    await flush();
    const queued = leases.acquire(run('run-next'), request('next-operation'));
    await flush();

    cancelled.abort();
    await flush();
    expect(scheduler.snapshot('base-branch', 'repo-a:main')).toMatchObject({
      holders: [{ runId: 'run-active', operationId: 'active-operation' }],
      waiters: [expect.objectContaining({ runId: 'run-next', operationId: 'next-operation' })],
    });

    settleWork();
    await active;
    const nextHandle = await queued;
    await nextHandle.release();
    expect(scheduler.snapshot('base-branch', 'repo-a:main')).toBeUndefined();
  });

  it('keeps a directly acquired grant until its owner releases it after cancellation', async () => {
    const cancelled = new AbortController();
    const { lifecycle: leases, scheduler } = lifecycle();
    const handle = await leases.acquire(
      run('run-direct-active'),
      request('direct-operation', cancelled.signal),
    );

    cancelled.abort();
    await flush();
    expect(scheduler.snapshot('base-branch', 'repo-a:main')?.holders).toEqual([
      { runId: 'run-direct-active', operationId: 'direct-operation' },
    ]);

    await handle.release();
    expect(scheduler.snapshot('base-branch', 'repo-a:main')).toBeUndefined();
  });

  it('replays persisted waiters through FIFO after restart instead of treating a pre-restart record as a held lease', async () => {
    const older: WaitingOn = {
      resource: { type: 'base-branch', key: 'repo-a:main' },
      operationId: 'older-operation',
      waitingSince: '2026-08-05T12:01:00.000Z',
    };
    const newer: WaitingOn = {
      resource: { type: 'base-branch', key: 'repo-a:main' },
      operationId: 'newer-operation',
      waitingSince: '2026-08-05T12:02:00.000Z',
    };
    const { lifecycle: leases, scheduler } = lifecycle();

    // Supply reverse disk order: recovery must use persisted queue age, not
    // incidental JSON order or a stale holder claim.
    const recovery = await leases.recoverWaitingRuns([
      run('newer-run', newer),
      run('older-run', older),
    ]);
    await flush();

    expect([...recovery.acquisitions.keys()]).toEqual(['older-run', 'newer-run']);

    expect(scheduler.snapshot('base-branch', 'repo-a:main')).toMatchObject({
      holders: [{ runId: 'older-run', operationId: 'older-operation' }],
      waiters: [expect.objectContaining({ runId: 'newer-run', operationId: 'newer-operation', position: 1 })],
    });

    const olderHandle = await recovery.acquisitions.get('older-run');
    await olderHandle?.release();
    expect(scheduler.snapshot('base-branch', 'repo-a:main')?.holders).toEqual([
      { runId: 'newer-run', operationId: 'newer-operation' },
    ]);
    const newerHandle = await recovery.acquisitions.get('newer-run');
    await newerHandle?.release();
    expect(scheduler.snapshot('base-branch', 'repo-a:main')).toBeUndefined();
  });

  it('clears a stale waiter and emits an actionable blocked-environment fact when restart probing finds no resource', async () => {
    const missing: WaitingOn = {
      resource: { type: 'base-branch', key: 'missing-repo:main' },
      operationId: 'recover-missing',
      waitingSince: '2026-08-05T12:01:00.000Z',
    };
    const { lifecycle: leases, scheduler, writes, blocked } = lifecycle({
      resourceExists: () => false,
    });

    await leases.recoverWaitingRuns([run('missing-run', missing)]);

    expect(scheduler.snapshot('base-branch', 'missing-repo:main')).toBeUndefined();
    expect(writes.at(-1)).toMatchObject({ id: 'missing-run' });
    expect(writes.at(-1)).not.toHaveProperty('waitingOn');
    expect(blocked).toEqual([
      expect.objectContaining({
        runId: 'missing-run',
        kind: 'blocked-environment',
        resource: { type: 'base-branch', key: 'missing-repo:main' },
        remediation: expect.any(String),
      }),
    ]);
  });
});
