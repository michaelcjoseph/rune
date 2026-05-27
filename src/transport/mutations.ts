import { randomUUID } from 'node:crypto';
import { appendMutationLine } from '../jobs/mutations-log.js';
import { upsertRun } from '../jobs/supervision-store.js';
import { type SupervisedRun } from '../intent/supervision.js';
import { createLogger } from '../utils/logger.js';
import config from '../config.js';
import { NotificationBus } from './notification-bus.js';

const log = createLogger('mutations');

/**
 * Build a SupervisedRun for a mutation descriptor. The supervision visibility
 * surface keys runs by id (using the mutation id keeps the two stores aligned).
 * `product` comes from the payload if present (gen-eval-loop-runner sets it
 * explicitly); otherwise defaults to 'jarvis' since today's only auto-approve
 * applier is the work-runner operating on the Jarvis repo itself. `project`
 * comes from `payload.projectSlug` / `payload.ref` / `target.ref` in order.
 *
 * `startedAt` is always `descriptor.createdAt` — the user's intent for the run
 * is created at createMutation time, and a delayed startApply (approval gate)
 * shouldn't move the "when did this start" timestamp the cockpit shows. The
 * caller passes a status because the same descriptor can be a `blocked-on-human`
 * seed (non-autoApprove pending approval) or a `running` flip (after approval).
 *
 * `lastChildAliveAt` is optional and threaded through verbatim — lifecycle
 * writes (seed/running/terminal) leave it undefined; keep-alive upserts set
 * it. This keeps the two signals (LLM output vs child-process liveness)
 * cleanly separated rather than synthesizing a fake liveness timestamp on
 * every lifecycle write.
 */
function buildSupervisedRun(
  d: MutationDescriptor,
  status: SupervisedRun['status'],
  nowIso: string,
  lastChildAliveAt?: string,
): SupervisedRun {
  const p = d.payload as Record<string, unknown>;
  const product = typeof p['product'] === 'string' ? p['product'] : 'jarvis';
  const project =
    typeof p['projectSlug'] === 'string' ? p['projectSlug']
    : typeof p['ref'] === 'string' ? p['ref']
    : d.target.ref || d.id;
  const run: SupervisedRun = {
    id: d.id,
    product,
    project,
    status,
    startedAt: d.createdAt,
    lastHeartbeatAt: nowIso,
  };
  if (lastChildAliveAt !== undefined) {
    run.lastChildAliveAt = lastChildAliveAt;
  }
  return run;
}

/** Best-effort wrapper around upsertRun — persistence failure logs but
 *  never crashes the mutation flow (the mutation log via appendMutationLine
 *  remains the source of truth for audit). */
function safeUpsertRun(run: SupervisedRun): void {
  try {
    upsertRun(run, config.SUPERVISED_RUNS_FILE);
  } catch (err) {
    log.warn('supervision-store upsertRun failed', {
      id: run.id,
      error: (err as Error).message,
    });
  }
}

export type MutationKind =
  | 'work-run'
  | 'gen-eval-loop'
  | 'project-edit'
  | 'proposal-action'
  | 'agent-edit'
  | 'cron-toggle';
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
  /**
   * `keep-alive` is a process-liveness signal emitted by the applier on a
   * periodic ticker while the child is alive — distinct from `output`
   * (which reflects LLM activity). The two signals back two SupervisedRun
   * timestamps: `output` → `lastHeartbeatAt`, `keep-alive` →
   * `lastChildAliveAt`. Stall-check prefers `lastChildAliveAt` so a long
   * quiet LLM call no longer trips a false stall nudge.
   */
  kind: 'log' | 'progress' | 'output' | 'keep-alive' | 'completed' | 'failed';
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

  // Seed the supervision visibility surface with the new run. An autoApprove
  // mutation starts running immediately, so seed as 'running'; a non-
  // autoApprove mutation is awaiting human approval, so seed as
  // 'blocked-on-human' — the accurate state, distinguishable on the cockpit
  // via getVisibility's `blocked` bucket. (Validation-rejected mutations
  // never reach this line, so no stray supervision entries get written.)
  const seedStatus: SupervisedRun['status'] = applier.autoApprove ? 'running' : 'blocked-on-human';
  safeUpsertRun(buildSupervisedRun(descriptor, seedStatus, descriptor.createdAt));

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
  // Flip supervision to 'running' — for an autoApprove mutation this confirms
  // the seed; for a manual-approval mutation it transitions out of the
  // 'blocked-on-human' seed once the human approved and dispatch started.
  safeUpsertRun(buildSupervisedRun(descriptor, 'running', new Date().toISOString()));

  // Heartbeat upserts are throttled — a busy run that streams thousands of
  // output lines must not block the event loop with a read-modify-write per
  // line. The supervision stale threshold is in minutes; a 30s minimum gap
  // between persisted heartbeats is well under that. Terminal and crash
  // writes are NOT throttled — those are one-shot.
  //
  // `output` and `keep-alive` events are throttled INDEPENDENTLY because
  // they signal different things — LLM activity vs child-process liveness.
  // Sharing one throttle would let a chatty output stream block the
  // keep-alive ticker (or vice versa) from updating its distinct field.
  let lastHeartbeatUpsertAt = Date.now();
  let lastKeepAliveUpsertAt = Date.now();
  /** Latest child-liveness timestamp persisted to disk, so subsequent
   *  lifecycle writes (terminal, post-keep-alive completed) preserve it
   *  instead of overwriting it with `undefined`. */
  let currentChildAliveAt: string | undefined;
  const HEARTBEAT_THROTTLE_MS = 30_000;

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
        // Phase 6 C5: surface the descriptor kind on every event so
        // subscribers (TelegramSender) can specialize rendering per
        // mutation kind without a registry round-trip.
        mutationKind: descriptor.kind,
        subKind: event.kind,
        ts: event.ts,
        data: event.data,
        userId: config.TELEGRAM_USER_ID,
      });

      // Heartbeat: each output line refreshes lastHeartbeatAt so a long-quiet
      // run gets flagged stalled while a chatty run does not. Throttled —
      // per HEARTBEAT_THROTTLE_MS above — so a per-line stdout stream
      // doesn't blow up the event loop with per-line read-modify-write.
      if (event.kind === 'output') {
        const now = Date.now();
        if (now - lastHeartbeatUpsertAt >= HEARTBEAT_THROTTLE_MS) {
          safeUpsertRun(
            buildSupervisedRun(descriptor, 'running', new Date(now).toISOString(), currentChildAliveAt),
          );
          lastHeartbeatUpsertAt = now;
        }
      }

      // Keep-alive: the applier's process-liveness ticker. Advances
      // lastChildAliveAt without bumping lastHeartbeatAt — the two signals
      // mean different things. Throttled on its own counter so it isn't
      // gated by a chatty output stream (and vice versa). The upsert
      // preserves the prior lastHeartbeatAt by passing it back through
      // buildSupervisedRun.
      if (event.kind === 'keep-alive') {
        const now = Date.now();
        if (now - lastKeepAliveUpsertAt >= HEARTBEAT_THROTTLE_MS) {
          const nowIso = new Date(now).toISOString();
          currentChildAliveAt = nowIso;
          safeUpsertRun(
            buildSupervisedRun(
              descriptor,
              'running',
              new Date(lastHeartbeatUpsertAt).toISOString(),
              nowIso,
            ),
          );
          lastKeepAliveUpsertAt = now;
        }
      }

      if (event.kind === 'completed' || event.kind === 'failed') {
        descriptor.status = event.kind === 'completed' ? 'completed' : 'failed';
        if (event.kind === 'failed' && event.data) {
          descriptor.error = String((event.data as Record<string, unknown>)['reason'] ?? '');
        }
        appendMutationLine(descriptor);
        safeUpsertRun(
          buildSupervisedRun(
            descriptor,
            descriptor.status,
            new Date().toISOString(),
            currentChildAliveAt,
          ),
        );
        return;
      }
    }
    // Applier exhausted without terminal event — treat as completed
    descriptor.status = 'completed';
    appendMutationLine(descriptor);
    safeUpsertRun(
      buildSupervisedRun(descriptor, 'completed', new Date().toISOString(), currentChildAliveAt),
    );
  } catch (err) {
    log.error('Mutation applier threw', { id: descriptor.id, error: (err as Error).message });
    descriptor.status = 'failed';
    descriptor.error = (err as Error).message;
    appendMutationLine(descriptor);
    // Persist directly as 'failed' — the terminal-event branch above exits
    // via `return`, so this catch is only reachable when the run is still
    // 'running' and a markCrashed() wrap would be a no-op composition.
    safeUpsertRun(
      buildSupervisedRun(descriptor, 'failed', new Date().toISOString(), currentChildAliveAt),
    );
  } finally {
    activeRuns.delete(descriptor.id);
  }
}
