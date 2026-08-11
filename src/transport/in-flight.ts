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
  /** Internal-only correlation for bounded sibling operations. Never copied
   * into `InFlightOpPublic` or bus payloads. */
  batchId?: string;
  /** True only when the child was spawned as its own process-group leader. */
  processGroup?: boolean;
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
export interface CorrelatedOpOwner {
  userId: number;
  scope?: string;
}

interface CorrelatedCancellation {
  owner: CorrelatedOpOwner;
  cancellation: OperationCancellation;
}

const correlatedCancellations = new Map<string, CorrelatedCancellation>();
const correlatedAgentCancellations = new Map<string, CorrelatedCancellation>();

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
  batchId?: string;
  processGroup?: boolean;
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
    ...(input.batchId ? { batchId: input.batchId } : {}),
    ...(input.processGroup ? { processGroup: true } : {}),
  };
  ops.set(op.opId, op);
  publishStart(op);
  ensureTicker();
  const correlatedCancellation = op.batchId === undefined
    ? undefined
    : correlatedCancellations.get(correlationKey(op.batchId, ownerOf(op)))?.cancellation ??
      (op.agentName === undefined
        ? undefined
        : correlatedAgentCancellations.get(
            agentCorrelationKey(op.batchId, ownerOf(op), op.agentName),
          )?.cancellation);
  if (correlatedCancellation !== undefined) {
    cancelWithRecord(op, inducedCancellationFor(op, correlatedCancellation));
  }
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
  const cancellation: OperationCancellation = {
    operationId: op.opId,
    source,
    requestedAt: new Date().toISOString(),
  };
  if (op.batchId !== undefined) {
    cancelCorrelatedOps(op.batchId, cancellation, ownerOf(op));
    return true;
  }
  cancelWithRecord(op, cancellation);
  return true;
}

/** Cancel every live operation in one internal batch with one shared record.
 * The caller may supply either a source (for internal cleanup) or an existing
 * record (when a user cancelled one member). External user cancellation is
 * allowed to replace an earlier internally-induced sibling record. */
export function cancelCorrelatedOps(
  batchId: string,
  sourceOrRecord: CancellationSource | OperationCancellation = 'internal',
  requestedOwner?: CorrelatedOpOwner,
): number {
  const owner = resolveCorrelationOwner(batchId, sourceOrRecord, requestedOwner);
  if (owner === undefined) return 0;
  const siblings = [...ops.values()].filter(
    (op) => op.batchId === batchId && sameOwner(ownerOf(op), owner),
  );
  const requestedCancellation = typeof sourceOrRecord === 'string'
    ? {
        operationId: siblings[0]?.opId ?? batchId,
        source: sourceOrRecord,
        requestedAt: new Date().toISOString(),
      }
    : sourceOrRecord;
  const key = correlationKey(batchId, owner);
  const existing = correlatedCancellations.get(key)?.cancellation;
  const cancellation =
    existing === undefined ||
    (existing.source === 'internal' && requestedCancellation.source !== 'internal')
      ? requestedCancellation
      : existing;
  correlatedCancellations.set(key, {
    owner: { ...owner },
    cancellation: { ...cancellation },
  });
  for (const sibling of siblings) {
    cancelWithRecord(sibling, inducedCancellationFor(sibling, cancellation));
  }
  return siblings.length;
}

/** Cancel only named agents in a batch. Per-agent tombstones close the spawn
 * registration race without cancelling a required designer in the same batch. */
export function cancelCorrelatedAgentOps(
  batchId: string,
  agentNames: readonly string[],
  requestedOwner?: CorrelatedOpOwner,
): number {
  const owner = resolveCorrelationOwner(batchId, 'internal', requestedOwner);
  if (owner === undefined) return 0;
  const selected = new Set(agentNames);
  const siblings = [...ops.values()].filter((op) =>
    op.batchId === batchId && sameOwner(ownerOf(op), owner) &&
    op.agentName !== undefined && selected.has(op.agentName));
  const requestedAt = new Date().toISOString();
  for (const agentName of selected) {
    correlatedAgentCancellations.set(agentCorrelationKey(batchId, owner, agentName), {
      owner: { ...owner },
      cancellation: {
        operationId: siblings.find((op) => op.agentName === agentName)?.opId ?? batchId,
        source: 'internal',
        requestedAt,
      },
    });
  }
  for (const sibling of siblings) {
    cancelWithRecord(sibling, {
      operationId: sibling.opId,
      source: 'internal',
      requestedAt,
    });
  }
  return siblings.length;
}

/** Drop a batch cancellation tombstone after its owner has awaited every
 * member. Active operations retain their own cancellation records. */
export function clearCorrelatedCancellation(
  batchId: string,
  owner?: CorrelatedOpOwner,
): void {
  if (owner !== undefined) {
    correlatedCancellations.delete(correlationKey(batchId, owner));
    for (const key of correlatedAgentCancellations.keys()) {
      if (key.startsWith(`${correlationKey(batchId, owner)}\0`)) {
        correlatedAgentCancellations.delete(key);
      }
    }
    return;
  }
  for (const key of correlatedCancellations.keys()) {
    if (key.startsWith(`${batchId}\0`)) correlatedCancellations.delete(key);
  }
  for (const key of correlatedAgentCancellations.keys()) {
    if (key.startsWith(`${batchId}\0`)) correlatedAgentCancellations.delete(key);
  }
}

/** Escalate a correlated batch to SIGKILL after its SIGTERM grace expires.
 * Only owner-matching children are signalled, and process-group signalling is
 * used only for children explicitly registered as detached group leaders. */
export function forceCancelCorrelatedOps(
  batchId: string,
  requestedOwner?: CorrelatedOpOwner,
): number {
  const owner = resolveCorrelationOwner(batchId, 'internal', requestedOwner);
  if (owner === undefined) return 0;
  const siblings = [...ops.values()].filter(
    (op) => op.batchId === batchId && sameOwner(ownerOf(op), owner),
  );
  for (const sibling of siblings) signalOp(sibling, 'SIGKILL');
  return siblings.length;
}

export function forceCancelCorrelatedAgentOps(
  batchId: string,
  agentNames: readonly string[],
  requestedOwner?: CorrelatedOpOwner,
): number {
  const owner = resolveCorrelationOwner(batchId, 'internal', requestedOwner);
  if (owner === undefined) return 0;
  const selected = new Set(agentNames);
  const siblings = [...ops.values()].filter((op) =>
    op.batchId === batchId && sameOwner(ownerOf(op), owner) &&
    op.agentName !== undefined && selected.has(op.agentName));
  for (const sibling of siblings) signalOp(sibling, 'SIGKILL');
  return siblings.length;
}

function cancelWithRecord(op: InFlightOp, cancellation: OperationCancellation): void {
  if (op.cancellation !== undefined) {
    if (op.cancellation.source !== 'internal') return;
    if (cancellation.source === 'internal') {
      if (op.cancellation.operationId !== cancellation.operationId) {
        op.cancellation = { ...cancellation };
      }
      return;
    }
  }
  // Record synchronously before signalling. Executors read this metadata from
  // their close handlers, so no async boundary may be introduced here.
  const alreadySignalled = op.cancellation !== undefined;
  op.cancellation = { ...cancellation };
  if (alreadySignalled) return;
  signalOp(op, 'SIGTERM');
}

function signalOp(op: InFlightOp, signal: NodeJS.Signals): void {
  try {
    if (
      op.processGroup === true &&
      op.child.pid !== undefined &&
      process.platform !== 'win32'
    ) {
      process.kill(-op.child.pid, signal);
    } else {
      op.child.kill(signal);
    }
  } catch (err) {
    log.warn(`Failed to ${signal} op child`, {
      opId: op.opId,
      error: (err as Error).message,
    });
  }
}

function ownerOf(op: Pick<InFlightOp, 'userId' | 'scope'>): CorrelatedOpOwner {
  return {
    userId: op.userId,
    ...(op.scope !== undefined ? { scope: op.scope } : {}),
  };
}

function sameOwner(left: CorrelatedOpOwner, right: CorrelatedOpOwner): boolean {
  return left.userId === right.userId && left.scope === right.scope;
}

function correlationKey(batchId: string, owner: CorrelatedOpOwner): string {
  return `${batchId}\0${owner.userId}\0${owner.scope ?? ''}`;
}

function agentCorrelationKey(
  batchId: string,
  owner: CorrelatedOpOwner,
  agentName: string,
): string {
  return `${correlationKey(batchId, owner)}\0${agentName}`;
}

function resolveCorrelationOwner(
  batchId: string,
  sourceOrRecord: CancellationSource | OperationCancellation,
  requestedOwner?: CorrelatedOpOwner,
): CorrelatedOpOwner | undefined {
  if (requestedOwner !== undefined) return requestedOwner;
  if (typeof sourceOrRecord !== 'string') {
    const origin = ops.get(sourceOrRecord.operationId);
    if (origin?.batchId === batchId) return ownerOf(origin);
  }
  const owners = new Map<string, CorrelatedOpOwner>();
  for (const op of ops.values()) {
    if (op.batchId !== batchId) continue;
    const owner = ownerOf(op);
    owners.set(correlationKey(batchId, owner), owner);
  }
  return owners.size === 1 ? owners.values().next().value : undefined;
}

function inducedCancellationFor(
  op: InFlightOp,
  cancellation: OperationCancellation,
): OperationCancellation {
  if (
    cancellation.source === 'internal' ||
    op.opId === cancellation.operationId
  ) {
    return cancellation;
  }
  return { ...cancellation, source: 'internal' };
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
