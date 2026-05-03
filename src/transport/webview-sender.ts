import type { MessageSender, SendOpts } from './sender.js';

/** WebviewSender implements MessageSender for the browser WebSocket transport.
 *  Phase A: all sends and typing indicators are no-ops.
 *  Phase B: add connections Map<number, Set<WebSocket>>, register/unregister, and
 *  implement send() to serialize { kind: 'message', text, approval? } to each
 *  registered connection (check ws.readyState === WebSocket.OPEN before sending). */
export class WebviewSender implements MessageSender {
  readonly name = 'webview' as const;

  async send(_userId: number, _text: string, _opts?: SendOpts): Promise<void> {
    // Phase A no-op.
  }

  startTyping(_userId: number): void {
    // Typing indicator is purely client-side in the webview.
  }

  stopTyping(_userId: number): void {
    // No-op.
  }

  /** Clean up any open connections. Phase A no-op; Phase B closes WS handles. */
  shutdown(): void {
    // No-op in Phase A.
  }
}
