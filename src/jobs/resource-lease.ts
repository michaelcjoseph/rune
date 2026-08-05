import { createHash } from 'node:crypto';
import { createLogger } from '../utils/logger.js';

export type LeaseType =
  | 'base-branch'
  | 'ios-simulator'
  | 'android-emulator'
  | 'port-range'
  | 'build-capacity'
  | 'cache-dir'
  | 'device';

export interface LeaseParty {
  runId: string;
  operationId: string;
}

export interface LeaseRequest {
  type: LeaseType;
  key: string;
  holder: LeaseParty;
  signal: AbortSignal;
  waitTimeoutMs?: number;
}

export interface LeaseHandle {
  /**
   * Relinquish a directly acquired lease. If that acquisition's signal aborts,
   * the scheduler calls this automatically; the caller must stop touching the
   * resource as soon as it observes the abort.
   */
  release(): void;
}

export interface LeaseSnapshot {
  resource: { type: LeaseType; key: string; capacity: number };
  holders: LeaseParty[];
  waiters: Array<LeaseParty & { position: number; waitingSince: string }>;
}

export interface LeaseEvent {
  kind: 'wait' | 'grant' | 'release';
  resource: { type: LeaseType; key: string };
  party: LeaseParty;
}

export interface ResourceLeaseScheduler {
  /**
   * Acquire a manually managed lease. An abort after grant relinquishes the
   * lease immediately, so callers must not continue using the resource after
   * their signal aborts. Use `withLease` when work must settle before release.
   */
  acquire(request: LeaseRequest): Promise<LeaseHandle>;
  withLease<T>(request: LeaseRequest, work: () => Promise<T> | T): Promise<T>;
  snapshot(type: LeaseType, key: string): LeaseSnapshot | undefined;
}

export interface ResourceLeaseSchedulerOptions {
  resources?: Array<{ type: LeaseType; key: string; capacity: number }>;
  onEvent?: (event: LeaseEvent) => void;
}

interface HolderRecord {
  token: symbol;
  party: LeaseParty;
  signal: AbortSignal;
  onAbort?: () => void;
}

interface WaiterRecord {
  party: LeaseParty;
  signal: AbortSignal;
  waitingSince: string;
  resolve: (handle: LeaseHandle) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
  onAbort: () => void;
  releaseOnHolderAbort: boolean;
}

interface ResourceState {
  resource: { type: LeaseType; key: string; capacity: number };
  holders: HolderRecord[];
  waiters: WaiterRecord[];
}

const log = createLogger('resource-lease');

export class LeaseAbortedError extends Error {
  constructor(type: LeaseType, key: string) {
    super(`lease acquisition aborted for ${type}:${safeResourceKey(key)}`);
    this.name = 'LeaseAbortedError';
  }
}

export class LeaseWaitTimeoutError extends Error {
  constructor(type: LeaseType, key: string, waitTimeoutMs: number) {
    super(`lease wait timed out after ${waitTimeoutMs}ms for ${type}:${safeResourceKey(key)}`);
    this.name = 'LeaseWaitTimeoutError';
  }
}

function resourceId(type: LeaseType, key: string): string {
  return JSON.stringify([type, key]);
}

/** Opaque presentation/storage identity for resource keys that contain host paths. */
export function safeResourceKey(key: string): string {
  if (!key.startsWith('/')) return key;
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 12);
  return `<path:${digest}>`;
}

function copyParty(party: LeaseParty): LeaseParty {
  return { runId: party.runId, operationId: party.operationId };
}

/**
 * Create one process-local FIFO lease scheduler. Resource definitions set
 * capacities; unconfigured resources are exclusive by default.
 */
export function createResourceLeaseScheduler(
  options: ResourceLeaseSchedulerOptions = {},
): ResourceLeaseScheduler {
  const capacities = new Map<string, number>();
  for (const resource of options.resources ?? []) {
    if (!Number.isSafeInteger(resource.capacity) || resource.capacity < 1) {
      throw new RangeError(`lease capacity must be a positive integer for ${resource.type}`);
    }
    capacities.set(resourceId(resource.type, resource.key), resource.capacity);
  }

  const states = new Map<string, ResourceState>();

  const emit = (event: LeaseEvent): void => {
    log.info(`resource lease ${event.kind}`, {
      resourceType: event.resource.type,
      resourceKey: safeResourceKey(event.resource.key),
      runId: event.party.runId,
      operationId: event.party.operationId,
    });
    if (options.onEvent) {
      try {
        options.onEvent(event);
      } catch (err) {
        log.warn('lease event listener failed', { error: (err as Error).message });
      }
    }
  };

  const getOrCreateState = (type: LeaseType, key: string): ResourceState => {
    const id = resourceId(type, key);
    let state = states.get(id);
    if (!state) {
      state = {
        resource: { type, key, capacity: capacities.get(id) ?? 1 },
        holders: [],
        waiters: [],
      };
      states.set(id, state);
    }
    return state;
  };

  const prune = (state: ResourceState): void => {
    if (state.holders.length === 0 && state.waiters.length === 0) {
      states.delete(resourceId(state.resource.type, state.resource.key));
    }
  };

  const cleanupWaiter = (waiter: WaiterRecord): void => {
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
  };

  const removeWaiter = (state: ResourceState, waiter: WaiterRecord, error: Error): void => {
    const index = state.waiters.indexOf(waiter);
    if (index === -1) return;
    state.waiters.splice(index, 1);
    cleanupWaiter(waiter);
    waiter.reject(error);
    prune(state);
  };

  const grant = (
    state: ResourceState,
    party: LeaseParty,
    signal: AbortSignal,
    releaseOnHolderAbort: boolean,
  ): LeaseHandle => {
    let released = false;
    const record: HolderRecord = {
      token: Symbol('lease-holder'),
      party: copyParty(party),
      signal,
    };
    const release = (): void => {
      if (released) return;
      released = true;
      if (record.onAbort) {
        record.signal.removeEventListener('abort', record.onAbort);
      }
      const index = state.holders.findIndex((holder) => holder.token === record.token);
      if (index === -1) return;
      state.holders.splice(index, 1);
      emit({
        kind: 'release',
        resource: { type: state.resource.type, key: state.resource.key },
        party: copyParty(record.party),
      });
      promote(state);
      prune(state);
    };

    state.holders.push(record);
    emit({
      kind: 'grant',
      resource: { type: state.resource.type, key: state.resource.key },
      party: copyParty(record.party),
    });
    if (releaseOnHolderAbort) {
      record.onAbort = () => release();
      signal.addEventListener('abort', record.onAbort, { once: true });
      if (signal.aborted) release();
    }

    return { release };
  };

  const promote = (state: ResourceState): void => {
    while (state.holders.length < state.resource.capacity && state.waiters.length > 0) {
      const waiter = state.waiters.shift();
      if (!waiter) break;
      cleanupWaiter(waiter);
      if (waiter.signal.aborted) {
        waiter.reject(new LeaseAbortedError(state.resource.type, state.resource.key));
        continue;
      }
      const handle = grant(
        state,
        waiter.party,
        waiter.signal,
        waiter.releaseOnHolderAbort,
      );
      if (waiter.signal.aborted) {
        handle.release();
        waiter.reject(new LeaseAbortedError(state.resource.type, state.resource.key));
        continue;
      }
      waiter.resolve(handle);
    }
  };

  const acquireWithPolicy = async (
    request: LeaseRequest,
    releaseOnHolderAbort: boolean,
  ): Promise<LeaseHandle> => {
    if (request.signal.aborted) {
      throw new LeaseAbortedError(request.type, request.key);
    }
    if (
      request.waitTimeoutMs !== undefined &&
      (!Number.isFinite(request.waitTimeoutMs) || request.waitTimeoutMs < 0)
    ) {
      throw new RangeError('lease waitTimeoutMs must be a finite non-negative number');
    }

    const state = getOrCreateState(request.type, request.key);
    if (state.holders.length < state.resource.capacity && state.waiters.length === 0) {
      const handle = grant(
        state,
        request.holder,
        request.signal,
        releaseOnHolderAbort,
      );
      if (request.signal.aborted) {
        handle.release();
        throw new LeaseAbortedError(request.type, request.key);
      }
      return handle;
    }

    return new Promise<LeaseHandle>((resolve, reject) => {
      const waiter: WaiterRecord = {
        party: copyParty(request.holder),
        signal: request.signal,
        waitingSince: new Date().toISOString(),
        resolve,
        reject,
        onAbort: () => {
          removeWaiter(
            state,
            waiter,
            new LeaseAbortedError(state.resource.type, state.resource.key),
          );
        },
        releaseOnHolderAbort,
      };
      state.waiters.push(waiter);
      request.signal.addEventListener('abort', waiter.onAbort, { once: true });
      if (request.waitTimeoutMs !== undefined) {
        waiter.timeout = setTimeout(() => {
          removeWaiter(
            state,
            waiter,
            new LeaseWaitTimeoutError(
              state.resource.type,
              state.resource.key,
              request.waitTimeoutMs!,
            ),
          );
        }, request.waitTimeoutMs);
      }
      emit({
        kind: 'wait',
        resource: { type: state.resource.type, key: state.resource.key },
        party: copyParty(waiter.party),
      });
    });
  };

  const acquire = (request: LeaseRequest): Promise<LeaseHandle> =>
    acquireWithPolicy(request, true);

  return {
    acquire,
    async withLease<T>(request: LeaseRequest, work: () => Promise<T> | T): Promise<T> {
      const handle = await acquireWithPolicy(request, false);
      if (request.signal.aborted) {
        handle.release();
        throw new LeaseAbortedError(request.type, request.key);
      }
      try {
        return await work();
      } finally {
        handle.release();
      }
    },
    snapshot(type: LeaseType, key: string): LeaseSnapshot | undefined {
      const state = states.get(resourceId(type, key));
      if (!state) return undefined;
      return {
        resource: { ...state.resource },
        holders: state.holders.map((holder) => copyParty(holder.party)),
        waiters: state.waiters.map((waiter, index) => ({
          ...copyParty(waiter.party),
          position: index + 1,
          waitingSince: waiter.waitingSince,
        })),
      };
    },
  };
}
