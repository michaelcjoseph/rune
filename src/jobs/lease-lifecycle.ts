import { AsyncLocalStorage } from 'node:async_hooks';
import type { SupervisedRun } from '../intent/supervision.js';
import {
  LeaseAbortedError,
  type LeaseHandle,
  type LeaseType,
  type ResourceLeaseScheduler,
} from './resource-lease.js';

export interface RunLeaseWaitingMetadata {
  resource: { type: LeaseType; key: string };
  operationId: string;
  waitingSince: string;
}

export interface RunLeaseRecord {
  id: string;
  waitingOn?: RunLeaseWaitingMetadata;
}

export interface RunLeaseRequest {
  type: LeaseType;
  key: string;
  operationId: string;
  signal: AbortSignal;
  waitTimeoutMs?: number;
}

export interface BlockedLeaseResource {
  runId: string;
  kind: 'blocked-environment';
  resource: RunLeaseWaitingMetadata['resource'];
  remediation: string;
}

export interface RunLeaseLifecycle<R extends RunLeaseRecord> {
  acquire(run: R, request: RunLeaseRequest): Promise<LeaseHandle>;
  withLease<T>(run: R, request: RunLeaseRequest, work: () => Promise<T> | T): Promise<T>;
  releaseRun(runId: string): void;
  recoverWaitingRuns(
    runs: readonly R[],
    signalForRun?: (run: R) => AbortSignal,
  ): Promise<RecoveredRunLeases>;
}

/** Explicit ownership returned by restart replay; callers must bind or release each handle. */
export interface RecoveredRunLeases {
  acquisitions: ReadonlyMap<string, Promise<LeaseHandle>>;
}

export interface RunLeaseLifecycleOptions<R extends RunLeaseRecord> {
  scheduler: ResourceLeaseScheduler;
  /** Persist this exact run shape; absence of waitingOn means clear it. */
  writeRun: (run: R) => void;
  resourceExists: (
    resource: RunLeaseWaitingMetadata['resource'],
  ) => boolean | Promise<boolean>;
  reportBlockedEnvironment: (blocked: BlockedLeaseResource) => void;
  now?: () => string;
}

export interface RunLeaseExecutionContext {
  run: SupervisedRun;
  operationId: string;
  cancelled?: () => boolean;
  onCancel?: (listener: () => void) => (() => void) | undefined;
  /** Optional persistence seam for callers that own a different supervision store. */
  writeRun?: (run: SupervisedRun) => void;
}

const runLeaseContext = new AsyncLocalStorage<RunLeaseExecutionContext>();

/** Scope an existing lock call to one supervised run without changing its API. */
export function withRunLeaseContext<T>(context: RunLeaseExecutionContext, work: () => T): T {
  return runLeaseContext.run(context, work);
}

export function currentRunLeaseContext(): RunLeaseExecutionContext | undefined {
  return runLeaseContext.getStore();
}

function withoutWaiting<R extends RunLeaseRecord>(run: R): R {
  const next = { ...run };
  delete next.waitingOn;
  return next;
}

function recoveryOrder<R extends RunLeaseRecord>(a: R, b: R): number {
  const aTime = Date.parse(a.waitingOn?.waitingSince ?? '');
  const bTime = Date.parse(b.waitingOn?.waitingSince ?? '');
  const safeA = Number.isNaN(aTime) ? Number.POSITIVE_INFINITY : aTime;
  const safeB = Number.isNaN(bTime) ? Number.POSITIVE_INFINITY : bTime;
  return safeA - safeB;
}

/**
 * Bind process-local lease ownership to durable run diagnostics. The durable
 * `waitingOn` field is never treated as proof of ownership: recovery probes
 * the resource and submits a fresh scheduler acquisition in persisted FIFO
 * order.
 */
export function createRunLeaseLifecycle<R extends RunLeaseRecord>(
  options: RunLeaseLifecycleOptions<R>,
): RunLeaseLifecycle<R> {
  const now = options.now ?? (() => new Date().toISOString());
  const latestRuns = new Map<string, R>();
  const handles = new Map<string, Set<LeaseHandle>>();
  const pending = new Map<string, Set<AbortController>>();

  const forgetIfIdle = (runId: string): void => {
    if (!handles.has(runId) && !pending.has(runId)) latestRuns.delete(runId);
  };

  const remember = (run: R): void => {
    latestRuns.set(run.id, run);
  };

  const persistWaiting = (run: R, waitingOn?: RunLeaseWaitingMetadata): R => {
    const current = latestRuns.get(run.id) ?? run;
    const next = waitingOn
      ? { ...current, waitingOn } as R
      : withoutWaiting(current);
    options.writeRun(next);
    remember(next);
    return next;
  };

  const clearWaitingIfPersisted = (run: R): void => {
    const current = latestRuns.get(run.id) ?? run;
    if (current.waitingOn === undefined) return;
    persistWaiting(current);
  };

  const trackPending = (runId: string, controller: AbortController): void => {
    const values = pending.get(runId) ?? new Set<AbortController>();
    values.add(controller);
    pending.set(runId, values);
  };

  const untrackPending = (runId: string, controller: AbortController): void => {
    const values = pending.get(runId);
    if (!values) return;
    values.delete(controller);
    if (values.size === 0) pending.delete(runId);
  };

  const preGrantSignal = (
    requestSignal: AbortSignal,
    lifecycleSignal: AbortSignal,
  ): { signal: AbortSignal; detach: () => void } => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    requestSignal.addEventListener('abort', abort, { once: true });
    lifecycleSignal.addEventListener('abort', abort, { once: true });
    if (requestSignal.aborted || lifecycleSignal.aborted) controller.abort();
    return {
      signal: controller.signal,
      detach: () => {
        requestSignal.removeEventListener('abort', abort);
        lifecycleSignal.removeEventListener('abort', abort);
      },
    };
  };

  const acquire = async (run: R, request: RunLeaseRequest): Promise<LeaseHandle> => {
    remember(run);
    const lifecycleAbort = new AbortController();
    trackPending(run.id, lifecycleAbort);
    const wait = preGrantSignal(request.signal, lifecycleAbort.signal);
    const schedulerRequest = {
      type: request.type,
      key: request.key,
      holder: { runId: run.id, operationId: request.operationId },
      signal: wait.signal,
      ...(request.waitTimeoutMs !== undefined
        ? { waitTimeoutMs: request.waitTimeoutMs }
        : {}),
    };
    const acquisition = options.scheduler.acquire(schedulerRequest);
    const queued = options.scheduler.snapshot(request.type, request.key)?.waiters.some(
      waiter => waiter.runId === run.id && waiter.operationId === request.operationId,
    ) ?? false;

    if (queued) {
      try {
        persistWaiting(run, {
          resource: { type: request.type, key: request.key },
          operationId: request.operationId,
          waitingSince: now(),
        });
      } catch (err) {
        lifecycleAbort.abort();
        void acquisition.catch(() => {});
        untrackPending(run.id, lifecycleAbort);
        throw err;
      }
    }

    try {
      const rawHandle = await acquisition;
      wait.detach();
      untrackPending(run.id, lifecycleAbort);
      if (wait.signal.aborted) {
        rawHandle.release();
        throw new LeaseAbortedError(request.type, request.key);
      }
      try {
        clearWaitingIfPersisted(run);
      } catch (err) {
        rawHandle.release();
        throw err;
      }

      let released = false;
      const managed: LeaseHandle = {
        release(): void {
          if (released) return;
          released = true;
          rawHandle.release();
          const runHandles = handles.get(run.id);
          runHandles?.delete(managed);
          if (runHandles?.size === 0) handles.delete(run.id);
          forgetIfIdle(run.id);
        },
      };
      const runHandles = handles.get(run.id) ?? new Set<LeaseHandle>();
      runHandles.add(managed);
      handles.set(run.id, runHandles);
      return managed;
    } catch (err) {
      wait.detach();
      untrackPending(run.id, lifecycleAbort);
      try {
        clearWaitingIfPersisted(run);
      } finally {
        forgetIfIdle(run.id);
      }
      throw err;
    }
  };

  const releaseRun = (runId: string): void => {
    const run = latestRuns.get(runId);
    for (const controller of pending.get(runId) ?? []) controller.abort();
    pending.delete(runId);
    for (const handle of handles.get(runId) ?? []) handle.release();
    handles.delete(runId);
    if (run?.waitingOn !== undefined) persistWaiting(run);
    latestRuns.delete(runId);
  };

  return {
    acquire,
    async withLease<T>(run: R, request: RunLeaseRequest, work: () => Promise<T> | T): Promise<T> {
      remember(run);
      const lifecycleAbort = new AbortController();
      trackPending(run.id, lifecycleAbort);
      const signal = AbortSignal.any([request.signal, lifecycleAbort.signal]);
      const schedulerRequest = {
        type: request.type,
        key: request.key,
        holder: { runId: run.id, operationId: request.operationId },
        signal,
        ...(request.waitTimeoutMs !== undefined
          ? { waitTimeoutMs: request.waitTimeoutMs }
          : {}),
      };
      const operation = options.scheduler.withLease(schedulerRequest, async () => {
        clearWaitingIfPersisted(run);
        return await work();
      });
      const queued = options.scheduler.snapshot(request.type, request.key)?.waiters.some(
        waiter => waiter.runId === run.id && waiter.operationId === request.operationId,
      ) ?? false;

      if (queued) {
        try {
          persistWaiting(run, {
            resource: { type: request.type, key: request.key },
            operationId: request.operationId,
            waitingSince: now(),
          });
        } catch (err) {
          lifecycleAbort.abort();
          void operation.catch(() => {});
          untrackPending(run.id, lifecycleAbort);
          throw err;
        }
      }

      try {
        return await operation;
      } finally {
        untrackPending(run.id, lifecycleAbort);
        try {
          clearWaitingIfPersisted(run);
        } finally {
          forgetIfIdle(run.id);
        }
      }
    },
    releaseRun,
    async recoverWaitingRuns(
      runs: readonly R[],
      signalForRun = () => new AbortController().signal,
    ): Promise<RecoveredRunLeases> {
      const acquisitions = new Map<string, Promise<LeaseHandle>>();
      const ordered = runs
        .filter((run): run is R & { waitingOn: RunLeaseWaitingMetadata } => run.waitingOn !== undefined)
        .slice()
        .sort(recoveryOrder);
      for (const run of ordered) {
        const waiting = run.waitingOn;
        if (!await options.resourceExists(waiting.resource)) {
          try {
            persistWaiting(run);
          } finally {
            forgetIfIdle(run.id);
          }
          options.reportBlockedEnvironment({
            runId: run.id,
            kind: 'blocked-environment',
            resource: { ...waiting.resource },
            remediation: `Restore the ${waiting.resource.type.replaceAll('-', ' ')} resource and retry the run.`,
          });
          continue;
        }
        const acquisition = acquire(run, {
          type: waiting.resource.type,
          key: waiting.resource.key,
          operationId: waiting.operationId,
          signal: signalForRun(run),
        });
        acquisitions.set(run.id, acquisition);
        // The returned batch owns these promises. Attach a rejection observer
        // so a caller can release/cancel the batch without an unhandled rejection.
        void acquisition.catch(() => {});
      }
      return { acquisitions };
    },
  };
}
