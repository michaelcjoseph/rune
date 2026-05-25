import { createLogger } from '../utils/logger.js';

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
  subKind: 'log' | 'progress' | 'output' | 'completed' | 'failed';
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

export type BusEvent = BusMessageEvent | BusAgentEvent | BusMutationEvent | BusOpEvent;

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
