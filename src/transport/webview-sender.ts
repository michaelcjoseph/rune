import { WebSocket } from 'ws';
import type { MessageSender, SendOpts } from './sender.js';
import type { BusAgentEvent, BusMutationEvent } from './notification-bus.js';
import { createLogger } from '../utils/logger.js';

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
    const conns = this.connections.get(userId);
    if (!conns || conns.size === 0) return;
    const frame = JSON.stringify({
      kind: 'message',
      text,
      ...(opts?.approval ? { approval: opts.approval } : {}),
    });
    for (const ws of conns) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(frame);
        } catch (err) {
          log.error('ws.send error', { error: (err as Error).message });
        }
      }
    }
  }

  startTyping(_userId: number): void {
    // Typing indicator is client-side in the webview.
  }

  stopTyping(_userId: number): void {
    // No-op.
  }

  /** Forward an agent-event bus message to all connected WS clients for the given userId.
   *  Strips userId from the WS frame — it is used only for routing and must not cross the WS boundary. */
  onAgentEvent(event: BusAgentEvent): void {
    const conns = this.connections.get(event.userId);
    if (!conns || conns.size === 0) return;
    const { userId: _drop, ...rest } = event;
    const frame = JSON.stringify(rest);
    for (const ws of conns) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(frame); } catch { /* drop if closed */ }
      }
    }
  }

  /** Forward a mutation-event bus message to all connected WS clients for the given userId.
   *  Strips userId before forwarding — it is used only for routing. */
  onMutationEvent(event: BusMutationEvent): void {
    const conns = this.connections.get(event.userId);
    if (!conns || conns.size === 0) return;
    const { userId: _drop, ...rest } = event;
    const frame = JSON.stringify(rest);
    for (const ws of conns) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(frame); } catch { /* drop if closed */ }
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
