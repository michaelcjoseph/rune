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

/** Union of all bus event kinds. Extended in Phase E (mutation-event). */
export type BusEvent = BusMessageEvent | BusAgentEvent;

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
