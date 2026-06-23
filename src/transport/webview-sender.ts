import { WebSocket } from 'ws';
import type { MessageSender, SendOpts } from './sender.js';
import type { BusAgentEvent, BusMutationEvent, BusOpEvent, BusRunEvent } from './notification-bus.js';
import { createLogger } from '../utils/logger.js';
import { redactSecrets } from '../utils/redact-secrets.js';

const log = createLogger('webview-sender');

export class WebviewSender implements MessageSender {
  readonly name = 'webview' as const;

  private readonly connections = new Map<number, Set<WebSocket>>();

  register(userId: number, ws: WebSocket): void {
    let conns = this.connections.get(userId);
    if (!conns) {
      conns = new Set();
      this.connections.set(userId, conns);
    }
    conns.add(ws);
    log.info('webview connection registered', { count: conns.size });
  }

  unregister(userId: number, ws: WebSocket): void {
    const conns = this.connections.get(userId);
    if (!conns) return;
    conns.delete(ws);
    if (conns.size === 0) this.connections.delete(userId);
    log.info('webview connection unregistered', { remaining: conns.size });
  }

  async send(userId: number, text: string, opts?: SendOpts): Promise<void> {
    const frame = JSON.stringify({
      kind: 'message',
      text,
      ...(opts?.approval ? { approval: opts.approval } : {}),
    });
    this.broadcast(userId, frame, true);
  }

  startTyping(userId: number, label = 'Thinking…'): void {
    this.broadcast(userId, JSON.stringify({ kind: 'status', label }));
  }

  stopTyping(userId: number): void {
    this.broadcast(userId, JSON.stringify({ kind: 'status', label: null }));
  }

  /** Forward an agent-event bus message to all connected WS clients for the given userId.
   *  Strips userId from the WS frame — it is used only for routing and must not cross the WS boundary. */
  onAgentEvent(event: BusAgentEvent): void {
    const { userId, ...rest } = event;
    this.broadcast(userId, JSON.stringify(rest));
  }

  /** Forward a mutation-event bus message to all connected WS clients for the given userId.
   *  Strips userId before forwarding — it is used only for routing. */
  onMutationEvent(event: BusMutationEvent): void {
    const { userId, ...rest } = event;
    this.broadcast(userId, JSON.stringify(rest));
  }

  /** Forward an op-event bus message to all connected WS clients for the given userId.
   *  Strips userId before forwarding — it is used only for routing.
   *  Classifier ops (sub-second resolver calls) are dropped at the boundary
   *  so they never reach the wire, matching TelegramSender behaviour. */
  onOpEvent(event: BusOpEvent): void {
    if (event.opKind === 'classifier') return;
    const { userId, ...rest } = event;
    this.broadcast(userId, JSON.stringify(rest));
  }

  /** Forward a run-event bus message to all connected WS clients for the given userId.
   *  Strips userId before forwarding and redacts live log lines at the WS boundary. */
  onRunEvent(event: BusRunEvent): void {
    const { userId, ...rest } = event;
    const frame = rest.subKind === 'log'
      ? { ...rest, lines: rest.lines.map((line) => redactSecrets(line)) }
      : rest;
    this.broadcast(userId, JSON.stringify(frame));
  }

  private broadcast(userId: number, frame: string, logErrors = false): void {
    const conns = this.connections.get(userId);
    if (!conns || conns.size === 0) return;
    for (const ws of conns) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(frame);
        } catch (err) {
          if (logErrors) log.error('ws.send error', { error: (err as Error).message });
        }
      }
    }
  }

  /** Close all open connections and clear the registry. */
  shutdown(): void {
    for (const conns of this.connections.values()) {
      for (const ws of conns) {
        try { ws.close(); } catch { /* ignore */ }
      }
    }
    this.connections.clear();
  }
}
