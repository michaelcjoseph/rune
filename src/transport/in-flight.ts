import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import type { NotificationBus, BusOpEvent, OpKind } from './notification-bus.js';
import { formatOpLabel } from './op-labels.js';
import type { CancellationSource, OperationCancellation } from '../cancellation.js';

const log = createLogger('in-flight');

export interface InFlightOp {
  opId: string;
  kind: OpKind;
  label: string;
  agentName?: string;
  scope?: string;
  userId: number;
  startedAt: number;
  startedAtIso: string;
  child: ChildProcess;
  cancellation?: OperationCancellation;
  /** Latest one-line description of what the op is currently doing
   *  (e.g. "Read: knowledge/index.md"). Updated by setOpDetail() and emitted
   *  on every subsequent op-event publish. */
  detail?: string;
}

/** Public-shaped view (no `child`) for callers that want to surface ops without
 *  leaking the ChildProcess handle (HTTP responses, state-snapshot, etc.). */
export interface InFlightOpPublic {
  opId: string;
  kind: OpKind;
  label: string;
  agentName?: string;
  scope?: string;
  userId: number;
  startedAt: string;
  elapsedMs: number;
  detail?: string;
}

const ops = new Map<string, InFlightOp>();

let _bus: NotificationBus | null = null;
let _ticker: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_MS = 5_000;

export function setInFlightBus(bus: NotificationBus): void {
  _bus = bus;
}

function toPublic(op: InFlightOp): InFlightOpPublic {
  // Spread conditionally so `'agentName' in pub` is false when the op had no
  // agent (one-shot, chat, classifier). Tests rely on this absence semantic.
  // Use the friendly label so /cancel replies and state-snapshot consumers
  // see the same user-facing text as the bus events.
  return {
    opId: op.opId,
    kind: op.kind,
    label: formatOpLabel(op.kind, op.label, op.agentName),
    ...(op.agentName ? { agentName: op.agentName } : {}),
    ...(op.scope ? { scope: op.scope } : {}),
    userId: op.userId,
    startedAt: op.startedAtIso,
    elapsedMs: Date.now() - op.startedAt,
    ...(op.detail ? { detail: op.detail } : {}),
  };
}

function publishStart(op: InFlightOp): void {
  if (!_bus) return;
  const event: BusOpEvent = {
    kind: 'op-event',
    subKind: 'start',
    opId: op.opId,
    userId: op.userId,
    opKind: op.kind,
    label: formatOpLabel(op.kind, op.label, op.agentName),
    ...(op.agentName ? { agent: op.agentName } : {}),
    ...(op.scope ? { scope: op.scope } : {}),
    startedAt: op.startedAtIso,
    elapsedMs: 0,
    ...(op.detail ? { detail: op.detail } : {}),
  };
  _bus.publish(event);
}

function publishProgress(op: InFlightOp): void {
  if (!_bus) return;
  const event: BusOpEvent = {
    kind: 'op-event',
    subKind: 'progress',
    opId: op.opId,
    userId: op.userId,
    opKind: op.kind,
    label: formatOpLabel(op.kind, op.label, op.agentName),
    ...(op.agentName ? { agent: op.agentName } : {}),
    ...(op.scope ? { scope: op.scope } : {}),
    startedAt: op.startedAtIso,
    elapsedMs: Date.now() - op.startedAt,
    ...(op.detail ? { detail: op.detail } : {}),
  };
  _bus.publish(event);
}

function publishEnd(op: InFlightOp, status: 'success' | 'error' | 'cancelled', error?: string): void {
  if (!_bus) return;
  const event: BusOpEvent = {
    kind: 'op-event',
    subKind: 'end',
    opId: op.opId,
    userId: op.userId,
    opKind: op.kind,
    label: formatOpLabel(op.kind, op.label, op.agentName),
    ...(op.agentName ? { agent: op.agentName } : {}),
    ...(op.scope ? { scope: op.scope } : {}),
    startedAt: op.startedAtIso,
    elapsedMs: Date.now() - op.startedAt,
    status,
    ...(error ? { error } : {}),
    ...(op.detail ? { detail: op.detail } : {}),
  };
  _bus.publish(event);
}

/** Update the op's current activity description and immediately publish a
 *  progress event with the new detail — used by execClaude's stream-json
 *  parser as each tool_use arrives. No-op for unknown opIds. */
export function setOpDetail(opId: string, detail: string): void {
  const op = ops.get(opId);
  if (!op) return;
  op.detail = detail;
  publishProgress(op);
}

function ensureTicker(): void {
  if (_ticker) return;
  _ticker = setInterval(() => {
    if (ops.size === 0) {
      if (_ticker) { clearInterval(_ticker); _ticker = null; }
      return;
    }
    for (const op of ops.values()) {
      publishProgress(op);
    }
  }, HEARTBEAT_MS);
}

export function registerOp(input: {
  kind: OpKind;
  label: string;
  agentName?: string;
  scope?: string;
  userId: number;
  child: ChildProcess;
}): InFlightOp {
  const now = Date.now();
  const op: InFlightOp = {
    opId: randomUUID(),
    kind: input.kind,
    label: input.label,
    ...(input.agentName ? { agentName: input.agentName } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    userId: input.userId,
    startedAt: now,
    startedAtIso: new Date(now).toISOString(),
    child: input.child,
  };
  ops.set(op.opId, op);
  publishStart(op);
  ensureTicker();
  return op;
}

export function unregisterOp(opId: string, status: 'success' | 'error' | 'cancelled', error?: string): void {
  const op = ops.get(opId);
  if (!op) return;
  ops.delete(opId);
  // If the op was previously cancelled, force status to 'cancelled' regardless
  // of how the subprocess actually exited (SIGTERM may report as either timeout
  // or non-zero code; the structured record is the source of truth).
  const finalStatus = op.cancellation !== undefined ? 'cancelled' : status;
  publishEnd(op, finalStatus, error);
}

export function isCancelled(opId: string): boolean {
  return ops.get(opId)?.cancellation !== undefined;
}

/** Read the accepted cancellation request while the operation is still
 * registered. Callers must capture it before `unregisterOp()` removes the live
 * child record. */
export function getCancellation(opId: string): OperationCancellation | undefined {
  const cancellation = ops.get(opId)?.cancellation;
  return cancellation === undefined ? undefined : { ...cancellation };
}

/** Cancel a specific op by id. Returns true if the op was found and SIGTERM was sent.
 *
 *  Invariant: `op.cancellation` MUST be set synchronously before
 *  `child.kill('SIGTERM')` and this whole function MUST stay synchronous.
 *  Executors read `getCancellation(opId)` in their close handlers before
 *  unregistering. If an `await` were introduced between recording the request
 *  and the kill, a close event in that window could misreport the cancellation
 *  as a timeout. */
export function cancelOp(opId: string, source: CancellationSource): boolean {
  const op = ops.get(opId);
  if (!op) return false;
  if (op.cancellation !== undefined) return true;
  // Record synchronously before signalling. Repeated cancellation requests do
  // not overwrite the original source/timestamp, even if SIGTERM is slow.
  op.cancellation = {
    operationId: op.opId,
    source,
    requestedAt: new Date().toISOString(),
  };
  try {
    op.child.kill('SIGTERM');
  } catch (err) {
    log.warn('Failed to SIGTERM op child', { opId, error: (err as Error).message });
  }
  return true;
}

/** Cancel the most-recently-started op for a given userId. Returns the cancelled
 *  op (public-shaped) so callers can echo a confirmation, or null if none active. */
export function cancelMostRecentForUser(
  userId: number,
  source: CancellationSource,
): InFlightOpPublic | null {
  let latest: InFlightOp | null = null;
  for (const op of ops.values()) {
    if (op.userId !== userId) continue;
    if (op.cancellation !== undefined) continue;
    if (latest === null || op.startedAt > latest.startedAt) latest = op;
  }
  if (!latest) return null;
  cancelOp(latest.opId, source);
  return toPublic(latest);
}

/** Cancel an op by opId prefix (≥4 hex chars). Returns the matched public op or null.
 *  Minimum length is enforced here, but callers should validate user input
 *  upstream so users get a clearer error than a silent null. */
export const CANCEL_PREFIX_MIN_CHARS = 4;
export function cancelByPrefix(
  prefix: string,
  source: CancellationSource,
): InFlightOpPublic | null {
  if (prefix.length < CANCEL_PREFIX_MIN_CHARS) return null;
  for (const op of ops.values()) {
    if (op.opId.startsWith(prefix)) {
      cancelOp(op.opId, source);
      return toPublic(op);
    }
  }
  return null;
}

export function listOps(): InFlightOpPublic[] {
  return [...ops.values()].map(toPublic);
}

/** Stop the heartbeat ticker explicitly. Call from process shutdown so a
 *  delayed exit (e.g. waiting on the logger flush) doesn't leave the
 *  interval alive. Idempotent. */
export function stopInFlightTicker(): void {
  if (_ticker) {
    clearInterval(_ticker);
    _ticker = null;
  }
}
