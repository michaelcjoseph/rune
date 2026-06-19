import { randomUUID } from 'node:crypto';
import { appendMutationLine } from '../jobs/mutations-log.js';
import { upsertRun } from '../jobs/supervision-store.js';
import { applyOutcomeToDescriptor, type WorkOutcome, type WorkProductFacts } from '../jobs/work-run-classify.js';
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
  lastOutputAt?: string,
  operatorWorktreePath?: string,
): SupervisedRun {
  const p = d.payload as Record<string, unknown>;
  const product = typeof p['product'] === 'string' ? p['product'] : 'jarvis';
  const project =
    typeof p['projectSlug'] === 'string' ? p['projectSlug']
    : typeof p['ref'] === 'string' ? p['ref']
    : d.target.ref || d.id;
  const run: SupervisedRun = {
    id: d.id,
    kind: d.kind,
    product,
    project,
    status,
    startedAt: d.createdAt,
    lastHeartbeatAt: nowIso,
  };
  if (lastChildAliveAt !== undefined) {
    run.lastChildAliveAt = lastChildAliveAt;
  }
  // `lastOutputAt` is the LLM-output signal the quiet-run nudge keys on —
  // distinct from `lastChildAliveAt` (child liveness). Only output events
  // advance it; lifecycle/keep-alive writes thread the prior value back through
  // so they don't reset it to undefined.
  if (lastOutputAt !== undefined) {
    run.lastOutputAt = lastOutputAt;
  }
  if (operatorWorktreePath !== undefined) {
    run.operatorWorktreePath = operatorWorktreePath;
  }
  return run;
}

function parkedOperatorWorktreePath(event: MutationEvent): string | undefined {
  const data = event.data as Record<string, unknown> | undefined;
  if (data?.['parked'] !== true) return undefined;
  const value = data['operatorWorktreePath'];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
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

function isTerminalMutationStatus(status: MutationStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'rejected';
}

export type MutationKind =
  | 'work-run'
  // Project 14 Phase 5: the Jarvis-owned multi-task orchestration loop. The
  // cockpit Start action dispatches this kind when the orchestrated-work toggle
  // selects orchestrated mode (see src/jobs/work-dispatch.ts); otherwise it
  // dispatches the legacy `work-run` applier as the recorded fallback.
  | 'orchestrated-work'
  // Project 13 Phase 1c: release a PARKED (`blocked-on-human`) work-run — the
  // applier cold-finalizes a clean parked worktree through the Project 15
  // finalizer (gated-merge), or discards a confirmed-dirty one. Auto-approved
  // (the human already decided to release via the preflight). Payload:
  // `{ runId, confirmDirty }` (see src/jobs/work-run-release.ts).
  | 'work-run-release'
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
  /**
   * Work-run terminal verdict (project 11), distinct from `status` (which stays
   * within its fixed enum). Copied off the terminal MutationEvent by
   * `applyOutcomeToDescriptor` in `startApply` before `appendMutationLine`, so
   * the classification reaches mutations.jsonl / the cockpit / the index.
   * Only work-run terminals populate these; other kinds leave them undefined.
   */
  outcome?: WorkOutcome;
  workProduct?: WorkProductFacts;
}

export interface MutationEvent {
  mutationId: string;
  ts: string;
  /**
   * `start` is a one-shot run-start notification emitted by the work-run
   * applier once its worktree exists (project 13). It carries the local-operator
   * `operatorWorktreePath` so Michael can reach a live run in one step; the
   * mutations pipeline only publishes it to the bus (no supervision side effect)
   * and never copies its data onto the descriptor — the un-scrubbed path must
   * not reach mutations.jsonl. `keep-alive` is a process-liveness signal emitted
   * by the applier on a periodic ticker while the child is alive — distinct from
   * `output` (which reflects LLM activity). The two signals back two
   * SupervisedRun timestamps: `output` → `lastHeartbeatAt`, `keep-alive` →
   * `lastChildAliveAt`. Stall-check prefers `lastChildAliveAt` so a long
   * quiet LLM call no longer trips a false stall nudge.
   *
   * `activity` is a non-rendered work-liveness signal: a parsed stream-json
   * envelope that renders nothing in the drawer (a `system` task_progress /
   * task_started / thinking frame, or a successful tool_result) is still
   * evidence the run is actively working. It advances the SAME timestamps as
   * `output` (`lastHeartbeatAt` + `lastOutputAt`) so a run busy in a long tool
   * call or subagent isn't mistaken for quiet — subagent/Task lifecycle frames
   * are all type:'system', which never render. It is NOT forwarded to the bus
   * (never reaches Telegram/the drawer); it exists only to keep supervision's
   * activity heartbeat fresh.
   */
  kind: 'start' | 'log' | 'progress' | 'output' | 'keep-alive' | 'activity' | 'completed' | 'failed';
  data?: unknown;
}

/**
 * Who initiated a cancel. `user` is an explicit human action (the /cancel
 * surface, the cockpit Cancel button). `system` is a Jarvis backstop reaping a
 * run on its own (the P2.7 quiet→cancel escalation, the max-runtime ceiling).
 * The two share the cancel mechanics (SIGTERM the tree) but MUST classify
 * differently: a user cancel is terminal-fail regardless of work product, while
 * a system reap classifies on the work product (a backstop kill of a complete
 * branch must read branch-complete, never as a cancel the user never made).
 */
export type CancelReason = 'user' | 'system';

export interface ApplyContext {
  bus: NotificationBus;
  cancel: () => boolean;
  /** Why the run was cancelled, once it has been. `null` until a cancel fires.
   *  Optional for back-compat with appliers/tests that don't consult it. */
  cancelReason?: () => CancelReason | null;
}

export interface RunHandle {
  descriptor: MutationDescriptor;
  cancel: (reason?: CancelReason) => void;
}

export interface MutationApplier<P = Record<string, unknown>> {
  kind: MutationKind;
  autoApprove: boolean;
  /**
   * Whether this applier's runs are tracked in the supervision visibility
   * surface (`supervised-runs.json`). Defaults to `true`. A short-lived CONTROL
   * mutation that acts ON another run — e.g. `work-run-release`, whose subject
   * (the parked run) already has its own supervised record it transitions —
   * sets this `false` so the pipeline does NOT seed a redundant record keyed by
   * the control mutation's own UUID (which would otherwise show as a bare-UUID
   * `running` entry, trip the 5-min stall nudge on a slow finalize, and produce
   * a spurious crash-recovery warning).
   */
  supervised?: boolean;
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

/** Re-dispatch a descriptor recovered from mutations.jsonl without creating a
 *  new mutation id. Startup recovery uses this for still-running resumable
 *  orchestrated-work runs after reconstructing their durable cursor. */
export function redispatchMutation(
  descriptor: MutationDescriptor,
): { ok: true } | { ok: false; reason: string } {
  const applier = applierRegistry.get(descriptor.kind);
  if (!applier) {
    return { ok: false, reason: `unknown mutation kind: ${descriptor.kind}` };
  }
  if (activeRuns.has(descriptor.id)) {
    return { ok: false, reason: `mutation already running: ${descriptor.id}` };
  }

  const validResult = applier.validate(descriptor.payload as Record<string, unknown>);
  if (!validResult.ok) {
    return { ok: false, reason: validResult.reason };
  }

  void startApply(applier, descriptor);
  return { ok: true };
}

/** Persist a terminal event for a recovered descriptor that cannot be
 *  re-dispatched. Mirrors the terminal branch in startApply closely enough for
 *  startup recovery paths that do not enter the async applier loop. */
export function writeRecoveredTerminalMutation(
  descriptor: MutationDescriptor,
  event: MutationEvent,
): void {
  if (event.kind !== 'completed' && event.kind !== 'failed') {
    throw new Error(`writeRecoveredTerminalMutation requires a terminal event, got ${event.kind}`);
  }

  descriptor.status = event.kind === 'completed' ? 'completed' : 'failed';
  if (event.kind === 'failed' && event.data) {
    descriptor.error = String((event.data as Record<string, unknown>)['reason'] ?? '');
  }
  if (descriptor.kind === 'work-run' || descriptor.kind === 'orchestrated-work') {
    applyOutcomeToDescriptor(descriptor, event);
  }
  appendMutationLine(descriptor);

  const parked =
    (descriptor.kind === 'work-run' || descriptor.kind === 'orchestrated-work') &&
    (event.data as Record<string, unknown> | undefined)?.['parked'] === true;
  const supervisionStatus: SupervisedRun['status'] = parked
    ? 'blocked-on-human'
    : descriptor.status;
  safeUpsertRun(
    buildSupervisedRun(
      descriptor,
      supervisionStatus,
      new Date().toISOString(),
      undefined,
      undefined,
      parkedOperatorWorktreePath(event),
    ),
  );

  (_bus ?? noopBus).publish({
    kind: 'mutation-event',
    mutationId: event.mutationId,
    mutationKind: descriptor.kind,
    subKind: event.kind,
    ts: event.ts,
    data: event.data,
    userId: config.TELEGRAM_USER_ID,
  });
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
  // Opt-out for control mutations (e.g. work-run-release) that don't represent a
  // long-running supervised run of their own.
  if (applier.supervised !== false) {
    safeUpsertRun(buildSupervisedRun(descriptor, seedStatus, descriptor.createdAt));
  }

  if (applier.autoApprove) {
    void startApply(applier, descriptor);
  }

  return { ok: true, descriptor };
}

/** Cancel a running mutation by calling its cancel hook. `reason` records
 *  WHO initiated it (default `user`) so the classifier can tell an explicit
 *  human cancel from a Jarvis backstop reap — see {@link CancelReason}. */
export function cancelMutation(
  id: string,
  reason: CancelReason = 'user',
): { ok: true } | { ok: false; reason: string } {
  const handle = activeRuns.get(id);
  if (!handle) {
    return { ok: false, reason: 'not found or already terminal' };
  }
  handle.cancel(reason);
  return { ok: true };
}

async function startApply(
  applier: MutationApplier<Record<string, unknown>>,
  descriptor: MutationDescriptor,
): Promise<void> {
  let cancelled = false;
  let cancelReason: CancelReason | null = null;

  const handle: RunHandle = {
    descriptor,
    cancel: (reason: CancelReason = 'user') => { cancelled = true; cancelReason = reason; },
  };
  activeRuns.set(descriptor.id, handle);

  // Control mutations (e.g. work-run-release) opt out of supervision tracking —
  // they act ON a run that already has its own supervised record. `supervise`
  // gates every supervision write below; the mutation log (appendMutationLine)
  // is unconditional so audit is never skipped.
  const supervise = applier.supervised !== false;

  descriptor.status = 'running';
  appendMutationLine(descriptor);
  // Flip supervision to 'running' — for an autoApprove mutation this confirms
  // the seed; for a manual-approval mutation it transitions out of the
  // 'blocked-on-human' seed once the human approved and dispatch started.
  if (supervise) safeUpsertRun(buildSupervisedRun(descriptor, 'running', new Date().toISOString()));

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
  /** Latest LLM-output timestamp persisted, so non-output writes (keep-alive,
   *  terminal) preserve it for the quiet-run predicate instead of resetting it. */
  let currentOutputAt: string | undefined;
  const HEARTBEAT_THROTTLE_MS = 30_000;

  // Use the real bus if available, else a no-op so appliers always receive a valid object
  const ctx: ApplyContext = {
    bus: _bus ?? noopBus,
    cancel: () => cancelled,
    cancelReason: () => cancelReason,
  };

  try {
    for await (const event of applier.apply(descriptor, ctx)) {
      const isTerminalEvent = event.kind === 'completed' || event.kind === 'failed';

      // `activity` is an internal work-liveness signal only — it advances the
      // supervision heartbeat below but is never forwarded to the bus, so a
      // run can emit one per stdout envelope without spamming Telegram/the
      // drawer with thousands of empty frames.
      if (event.kind !== 'activity') (_bus ?? noopBus).publish({
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

      if (isTerminalEvent && isTerminalMutationStatus(descriptor.status)) {
        return;
      }

      // Heartbeat: each output line refreshes lastHeartbeatAt so a long-quiet
      // run gets flagged stalled while a chatty run does not. Throttled —
      // per HEARTBEAT_THROTTLE_MS above — so a per-line stdout stream
      // doesn't blow up the event loop with per-line read-modify-write.
      //
      // `activity` rides the SAME advance: a non-rendering envelope (subagent/
      // Task lifecycle `system` frame, successful tool_result) is real work, so
      // it must keep `lastOutputAt` fresh too — otherwise a run busy in a long
      // tool call or subagent reads as quiet and the P2.7 quiet→cancel backstop
      // can reap a healthy run (docs/projects/bugs.md).
      if (supervise && (event.kind === 'output' || event.kind === 'activity')) {
        const now = Date.now();
        if (now - lastHeartbeatUpsertAt >= HEARTBEAT_THROTTLE_MS) {
          const nowIso = new Date(now).toISOString();
          // An output/activity event is a work signal — advance lastOutputAt too.
          currentOutputAt = nowIso;
          safeUpsertRun(
            buildSupervisedRun(descriptor, 'running', nowIso, currentChildAliveAt, currentOutputAt),
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
      if (supervise && event.kind === 'keep-alive') {
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
              currentOutputAt,
            ),
          );
          lastKeepAliveUpsertAt = now;
        }
      }

      if (isTerminalEvent) {
        descriptor.status = event.kind === 'completed' ? 'completed' : 'failed';
        if (event.kind === 'failed' && event.data) {
          descriptor.error = String((event.data as Record<string, unknown>)['reason'] ?? '');
        }
        // Copy the work-applier verdict (outcome + workProduct) off the terminal
        // event onto the descriptor BEFORE persisting — otherwise the
        // classification is dropped here and never reaches mutations.jsonl, the
        // cockpit, Telegram, the index, or GC. Gated on `kind` so the
        // work-specific stamping is explicit at the call site (the helper is
        // also a guarded no-op for terminals that carry no outcome).
        if (descriptor.kind === 'work-run' || descriptor.kind === 'orchestrated-work') {
          applyOutcomeToDescriptor(descriptor, event);
        }
        appendMutationLine(descriptor);
        // Project 13 (Background §7): a PARKED work-run terminates the MUTATION
        // normally (the child exited to report a human-block), but the SUPERVISED
        // run must stay `blocked-on-human` until a human releases it. The parked
        // terminal event carries explicit `parked: true`; treat it as a
        // supervision OVERRIDE — persist the descriptor as terminal (above), but
        // reassert supervision as `blocked-on-human` rather than the terminal
        // status. This is the second of the two terminal supervision writers
        // (the applier wrote the parked record first); without the override this
        // writer would clobber it back to completed/failed. Gated on
        // work appliers that can preserve a run worktree, so the stringly-typed
        // `parked` flag can only divert supervision for appliers that actually
        // emit it.
        const parked =
          (descriptor.kind === 'work-run' || descriptor.kind === 'orchestrated-work') &&
          (event.data as Record<string, unknown> | undefined)?.['parked'] === true;
        const supervisionStatus: SupervisedRun['status'] = parked
          ? 'blocked-on-human'
          : descriptor.status;
        if (supervise) {
          safeUpsertRun(
            buildSupervisedRun(
              descriptor,
              supervisionStatus,
              new Date().toISOString(),
              currentChildAliveAt,
              currentOutputAt,
              parkedOperatorWorktreePath(event),
            ),
          );
        }
        return;
      }
    }
    // Applier exhausted without terminal event — treat as completed
    descriptor.status = 'completed';
    appendMutationLine(descriptor);
    if (supervise) {
      safeUpsertRun(
        buildSupervisedRun(descriptor, 'completed', new Date().toISOString(), currentChildAliveAt, currentOutputAt),
      );
    }
  } catch (err) {
    log.error('Mutation applier threw', { id: descriptor.id, error: (err as Error).message });
    descriptor.status = 'failed';
    descriptor.error = (err as Error).message;
    appendMutationLine(descriptor);
    // Persist directly as 'failed' — the terminal-event branch above exits
    // via `return`, so this catch is only reachable when the run is still
    // 'running' and a markCrashed() wrap would be a no-op composition.
    if (supervise) {
      safeUpsertRun(
        buildSupervisedRun(descriptor, 'failed', new Date().toISOString(), currentChildAliveAt, currentOutputAt),
      );
    }
  } finally {
    activeRuns.delete(descriptor.id);
  }
}
