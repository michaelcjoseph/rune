import { createLogger } from '../utils/logger.js';
import type { SupervisedRun } from '../intent/supervision.js';
import { redactSecrets } from '../utils/redact-secrets.js';

const log = createLogger('notification-bus');

export interface BusMessageEvent {
  kind: 'message';
  userId: number;
  text: string;
}

export interface BusAgentEventStart {
  kind: 'agent-event';
  subKind: 'start';
  agent: string;
  runId: string;
  userId: number;
  startedAt: string;
}

export interface BusAgentEventEnd {
  kind: 'agent-event';
  subKind: 'end';
  agent: string;
  runId: string;
  userId: number;
  startedAt: string;
  durationMs: number;
  status: 'success' | 'error';
}

export type BusAgentEvent = BusAgentEventStart | BusAgentEventEnd;

export interface BusMutationEvent {
  kind: 'mutation-event';
  mutationId: string;
  /** The descriptor's kind (e.g. `'work-run'`, `'gen-eval-loop'`). Surfaced
   *  on the event so subscribers like TelegramSender can specialize their
   *  rendering per mutation kind without re-reading the registry — Phase 6
   *  C5 uses this to emit ✅/⏸/💥 structured notifications for
   *  gen-eval-loop terminal events while keeping the generic
   *  `/work --auto on <slug>` summary for everything else. Imported as
   *  `string` (not `MutationKind`) to keep `notification-bus.ts` free of
   *  the mutations-pipeline circular dependency; the publisher in
   *  `src/transport/mutations.ts` is the one that sets it correctly. */
  mutationKind: string;
  subKind: 'start' | 'log' | 'progress' | 'output' | 'keep-alive' | 'completed' | 'failed';
  ts: string;
  data?: unknown;
  userId: number;
}

/** Granular per-Claude-CLI-spawn lifecycle. Distinct from BusAgentEvent
 *  (one-per-runAgent) — every execClaude() call emits an op-event so chat /
 *  one-shot / classifier paths get the same visibility + cancel surface. */
export type OpKind = 'agent' | 'chat' | 'one-shot' | 'classifier';

export interface BusOpEventBase {
  kind: 'op-event';
  opId: string;
  userId: number;
  opKind: OpKind;
  label: string;
  agent?: string;
  startedAt: string;
  elapsedMs: number;
  /** Short user-facing description of the current activity inside this op,
   *  e.g. "Read: knowledge/index.md" or "KB query: capital flows". Populated
   *  from Claude's stream-json tool_use events when the op is user-visible. */
  detail?: string;
}

export interface BusOpEventStart extends BusOpEventBase {
  subKind: 'start';
}

export interface BusOpEventProgress extends BusOpEventBase {
  subKind: 'progress';
}

export interface BusOpEventEnd extends BusOpEventBase {
  subKind: 'end';
  status: 'success' | 'error' | 'cancelled';
  error?: string;
}

export type BusOpEvent = BusOpEventStart | BusOpEventProgress | BusOpEventEnd;

export interface BusRunTarget {
  kind: 'project' | 'bug';
  slug: string;
}

export interface BusRunAgent {
  role: string;
  active: boolean;
  model?: string;
}

export type BusRunState = 'running' | 'parked' | 'completed' | 'no-op' | 'partial' | 'failed';
export type BusRunOutcome = 'completed' | 'no-op' | 'partial' | 'failed';

interface BusRunEventBase {
  kind: 'run-event';
  runId: string;
  product: string;
  target: BusRunTarget;
  ts: string;
  userId: number;
}

export interface BusRunProgressEvent extends BusRunEventBase {
  subKind: 'progress';
  tasks: { done: number; total: number };
}

export interface BusRunAgentsEvent extends BusRunEventBase {
  subKind: 'agents';
  agents: BusRunAgent[];
}

export interface BusRunLogEvent extends BusRunEventBase {
  subKind: 'log';
  lines: string[];
}

export interface BusRunStateEvent extends BusRunEventBase {
  subKind: 'state';
  state: BusRunState;
  elapsedMs: number;
  outcome?: BusRunOutcome;
}

export type BusRunEvent =
  | BusRunProgressEvent
  | BusRunAgentsEvent
  | BusRunLogEvent
  | BusRunStateEvent;

type BusRunEventBaseInput = Omit<BusRunEventBase, 'kind'>;

export interface RunEventTaskRecord {
  rolesInvoked: string[];
  modelChoices?: Record<string, string>;
}

export function buildRunProgressEventFromCommitPoll(
  input: BusRunEventBaseInput & { tasks: { done: number; total: number } },
): BusRunProgressEvent {
  return {
    kind: 'run-event',
    subKind: 'progress',
    runId: input.runId,
    product: input.product,
    target: input.target,
    ts: input.ts,
    userId: input.userId,
    tasks: { done: input.tasks.done, total: input.tasks.total },
  };
}

export function buildRunAgentsEventFromTaskRecords(
  input: BusRunEventBaseInput & { records: RunEventTaskRecord[] },
): BusRunAgentsEvent {
  const seen = new Set<string>();
  const agents: BusRunAgent[] = [];
  for (const record of input.records) {
    for (const role of record.rolesInvoked) {
      if (seen.has(role)) continue;
      seen.add(role);
      const model = record.modelChoices?.[role];
      agents.push({
        role,
        active: true,
        ...(model !== undefined ? { model } : {}),
      });
    }
  }
  return {
    kind: 'run-event',
    subKind: 'agents',
    runId: input.runId,
    product: input.product,
    target: input.target,
    ts: input.ts,
    userId: input.userId,
    agents,
  };
}

export function buildRunLogEventFromTranscriptTail(
  input: BusRunEventBaseInput & { lines: string[] },
): BusRunLogEvent {
  return {
    kind: 'run-event',
    subKind: 'log',
    runId: input.runId,
    product: input.product,
    target: input.target,
    ts: input.ts,
    userId: input.userId,
    lines: input.lines.map((line) => redactSecrets(line)),
  };
}

export function buildRunStateEventFromSupervision(
  input: BusRunEventBaseInput & { run: SupervisedRun; now: number; outcome?: BusRunOutcome },
): BusRunStateEvent {
  const started = Date.parse(input.run.startedAt);
  const elapsedMs = Number.isNaN(started) ? 0 : Math.max(0, input.now - started);
  const state = stateFromSupervision(input.run.status, input.outcome);
  return {
    kind: 'run-event',
    subKind: 'state',
    runId: input.runId,
    product: input.product,
    target: input.target,
    ts: input.ts,
    userId: input.userId,
    state,
    elapsedMs,
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
  };
}

function stateFromSupervision(status: SupervisedRun['status'], outcome?: BusRunOutcome): BusRunState {
  if (outcome !== undefined) return outcome;
  switch (status) {
    case 'blocked-on-human':
      return 'parked';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'unknown':
      return 'failed';
    case 'running':
      return 'running';
  }
}

export type BusEvent = BusMessageEvent | BusAgentEvent | BusMutationEvent | BusOpEvent | BusRunEvent;

type BusEventKind = BusEvent['kind'];
type HandlerFor<K extends BusEventKind> = (event: Extract<BusEvent, { kind: K }>) => void;

/** Typed event bus for fan-out from cron jobs and handlers to registered senders.
 *  Wraps each subscriber call in try/catch so one failing handler never blocks the others. */
export class NotificationBus {
  private handlers = new Map<string, Set<(event: BusEvent) => void>>();

  publish(event: BusEvent): void {
    const handlers = this.handlers.get(event.kind);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err) {
        log.error('Bus subscriber threw', { kind: event.kind, error: (err as Error).message });
      }
    }
  }

  on<K extends BusEventKind>(kind: K, handler: HandlerFor<K>): void {
    let set = this.handlers.get(kind);
    if (!set) {
      set = new Set();
      this.handlers.set(kind, set);
    }
    set.add(handler as (event: BusEvent) => void);
  }

  off<K extends BusEventKind>(kind: K, handler: HandlerFor<K>): void {
    this.handlers.get(kind)?.delete(handler as (event: BusEvent) => void);
  }
}
