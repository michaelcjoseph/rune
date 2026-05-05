import { randomUUID } from 'node:crypto';
import { appendMutationLine } from '../jobs/mutations-log.js';
import { createLogger } from '../utils/logger.js';
import config from '../config.js';
import { NotificationBus } from './notification-bus.js';

const log = createLogger('mutations');

export type MutationKind = 'work-run' | 'project-edit' | 'proposal-action' | 'agent-edit' | 'cron-toggle';
export type MutationStatus = 'pending' | 'approved' | 'running' | 'completed' | 'failed' | 'rejected';

export interface MutationDescriptor<P = Record<string, unknown>> {
  id: string;
  kind: MutationKind;
  source: 'webview' | 'review' | 'cron' | 'cli';
  target: { type: string; ref: string };
  preview: { summary: string; details?: string };
  payload: P;
  createdAt: string;
  status: MutationStatus;
  error?: string;
}

export interface MutationEvent {
  mutationId: string;
  ts: string;
  kind: 'log' | 'progress' | 'output' | 'completed' | 'failed';
  data?: unknown;
}

export interface ApplyContext {
  bus: NotificationBus;
  cancel: () => boolean;
}

export interface RunHandle {
  descriptor: MutationDescriptor;
  cancel: () => void;
}

export interface MutationApplier<P = Record<string, unknown>> {
  kind: MutationKind;
  autoApprove: boolean;
  validate(payload: P): { ok: true } | { ok: false; reason: string };
  apply(descriptor: MutationDescriptor<P>, ctx: ApplyContext): AsyncIterable<MutationEvent>;
}

// Registry of appliers by kind
const applierRegistry = new Map<MutationKind, MutationApplier<Record<string, unknown>>>();

// Active mutations in flight
export const activeRuns = new Map<string, RunHandle>();

// Injected bus — set from index.ts at startup
let _bus: NotificationBus | null = null;

// No-op bus used when real bus isn't available yet (pre-startup calls)
const noopBus = new NotificationBus();

export function setMutationBus(bus: NotificationBus): void {
  _bus = bus;
}

export function registerApplier<P>(applier: MutationApplier<P>): void {
  applierRegistry.set(applier.kind, applier as MutationApplier<Record<string, unknown>>);
}

export function getApplier(kind: MutationKind): MutationApplier<Record<string, unknown>> | undefined {
  return applierRegistry.get(kind);
}

/** Create, validate, persist, and (if autoApprove) start a mutation. */
export async function createMutation(
  kind: MutationKind,
  payload: Record<string, unknown>,
  source: MutationDescriptor['source'],
): Promise<{ ok: true; descriptor: MutationDescriptor } | { ok: false; reason: string }> {
  const applier = applierRegistry.get(kind);
  if (!applier) {
    return { ok: false, reason: `unknown mutation kind: ${kind}` };
  }

  const validResult = applier.validate(payload);
  if (!validResult.ok) {
    return { ok: false, reason: validResult.reason };
  }

  const descriptor: MutationDescriptor = {
    id: randomUUID(),
    kind,
    source,
    target: { type: kind, ref: String(payload['projectSlug'] ?? payload['ref'] ?? '') },
    preview: { summary: `${kind} on ${String(payload['projectSlug'] ?? payload['ref'] ?? '')}` },
    payload,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };

  appendMutationLine(descriptor);

  if (applier.autoApprove) {
    void startApply(applier, descriptor);
  }

  return { ok: true, descriptor };
}

/** Cancel a running mutation by calling its cancel hook. */
export function cancelMutation(id: string): { ok: true } | { ok: false; reason: string } {
  const handle = activeRuns.get(id);
  if (!handle) {
    return { ok: false, reason: 'not found or already terminal' };
  }
  handle.cancel();
  return { ok: true };
}

async function startApply(
  applier: MutationApplier<Record<string, unknown>>,
  descriptor: MutationDescriptor,
): Promise<void> {
  let cancelled = false;

  const handle: RunHandle = {
    descriptor,
    cancel: () => { cancelled = true; },
  };
  activeRuns.set(descriptor.id, handle);

  descriptor.status = 'running';
  appendMutationLine(descriptor);

  // Use the real bus if available, else a no-op so appliers always receive a valid object
  const ctx: ApplyContext = {
    bus: _bus ?? noopBus,
    cancel: () => cancelled,
  };

  try {
    for await (const event of applier.apply(descriptor, ctx)) {
      (_bus ?? noopBus).publish({
        kind: 'mutation-event',
        mutationId: event.mutationId,
        subKind: event.kind,
        ts: event.ts,
        data: event.data,
        userId: config.TELEGRAM_USER_ID,
      });

      if (event.kind === 'completed' || event.kind === 'failed') {
        descriptor.status = event.kind === 'completed' ? 'completed' : 'failed';
        if (event.kind === 'failed' && event.data) {
          descriptor.error = String((event.data as Record<string, unknown>)['reason'] ?? '');
        }
        appendMutationLine(descriptor);
        return;
      }
    }
    // Applier exhausted without terminal event — treat as completed
    descriptor.status = 'completed';
    appendMutationLine(descriptor);
  } catch (err) {
    log.error('Mutation applier threw', { id: descriptor.id, error: (err as Error).message });
    descriptor.status = 'failed';
    descriptor.error = (err as Error).message;
    appendMutationLine(descriptor);
  } finally {
    activeRuns.delete(descriptor.id);
  }
}
