import { describe, it, expect, vi } from 'vitest';
import type { WebSocket as WsWebSocket } from 'ws';

// Mock the 'ws' module so we can create fake WebSocket stubs
const OPEN = 1;
vi.mock('ws', () => ({
  WebSocket: { OPEN },
}));

const { WebviewSender } = await import('./webview-sender.js');

// ---- helpers ----

function makeWs(readyState = OPEN): WsWebSocket {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WsWebSocket;
}

// ---- tests ----

describe('WebviewSender', () => {
  describe('name property', () => {
    it('has name "webview"', () => {
      const sender = new WebviewSender();
      expect(sender.name).toBe('webview');
    });
  });

  describe('startTyping / stopTyping — no-ops', () => {
    it('startTyping does not throw', () => {
      const sender = new WebviewSender();
      expect(() => sender.startTyping(1)).not.toThrow();
    });

    it('stopTyping does not throw', () => {
      const sender = new WebviewSender();
      expect(() => sender.stopTyping(1)).not.toThrow();
    });
  });

  describe('register / unregister', () => {
    it('register adds a connection for userId', async () => {
      const sender = new WebviewSender();
      const ws = makeWs();
      sender.register(1, ws);
      await sender.send(1, 'hello');
      expect(ws.send).toHaveBeenCalledOnce();
    });

    it('unregister removes the connection', async () => {
      const sender = new WebviewSender();
      const ws = makeWs();
      sender.register(1, ws);
      sender.unregister(1, ws);
      await sender.send(1, 'hello');
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('unregister on unknown userId is a no-op', () => {
      const sender = new WebviewSender();
      const ws = makeWs();
      expect(() => sender.unregister(999, ws)).not.toThrow();
    });
  });

  describe('send()', () => {
    it('sends a JSON message frame to registered open connections', async () => {
      const sender = new WebviewSender();
      const ws = makeWs();
      sender.register(1, ws);
      await sender.send(1, 'hello');
      const frame = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
      expect(frame).toEqual({ kind: 'message', text: 'hello' });
    });

    it('skips connections that are not OPEN', async () => {
      const sender = new WebviewSender();
      const ws = makeWs(3); // CLOSING state
      sender.register(1, ws);
      await sender.send(1, 'hello');
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('does nothing when no connections are registered for userId', async () => {
      const sender = new WebviewSender();
      await expect(sender.send(99, 'nobody home')).resolves.toBeUndefined();
    });

    it('includes approval sidecar in the frame when opts.approval is set', async () => {
      const sender = new WebviewSender();
      const ws = makeWs();
      sender.register(1, ws);
      await sender.send(1, 'Approve or cancel?', {
        approval: {
          prompt: 'Make a choice:',
          options: [
            { value: 'yes', label: 'Approve' },
            { value: 'cancel', label: 'Cancel' },
          ],
        },
      });
      const frame = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
      expect(frame.kind).toBe('message');
      expect(frame.text).toBe('Approve or cancel?');
      expect(frame.approval).toMatchObject({
        prompt: 'Make a choice:',
        options: expect.arrayContaining([
          expect.objectContaining({ value: 'yes', label: 'Approve' }),
          expect.objectContaining({ value: 'cancel', label: 'Cancel' }),
        ]),
      });
    });

    it('omits approval field when opts.approval is absent', async () => {
      const sender = new WebviewSender();
      const ws = makeWs();
      sender.register(1, ws);
      await sender.send(1, 'plain message');
      const frame = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
      expect('approval' in frame).toBe(false);
    });

    it('fans out to multiple connections for the same userId', async () => {
      const sender = new WebviewSender();
      const ws1 = makeWs();
      const ws2 = makeWs();
      sender.register(1, ws1);
      sender.register(1, ws2);
      await sender.send(1, 'broadcast');
      expect(ws1.send).toHaveBeenCalledOnce();
      expect(ws2.send).toHaveBeenCalledOnce();
    });
  });

  describe('onAgentEvent()', () => {
    it('forwards agent-event start frame to open connections for the event userId', () => {
      const sender = new WebviewSender();
      const ws = makeWs();
      sender.register(42, ws);
      sender.onAgentEvent({
        kind: 'agent-event',
        subKind: 'start',
        agent: 'wiki-compiler',
        runId: 'run-1',
        userId: 42,
        startedAt: '2026-05-05T00:00:00.000Z',
      });
      expect(ws.send).toHaveBeenCalledOnce();
      const frame = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
      expect(frame.kind).toBe('agent-event');
      expect(frame.subKind).toBe('start');
      expect(frame.agent).toBe('wiki-compiler');
      expect(frame.runId).toBe('run-1');
      // userId must be stripped before crossing the WS boundary
      expect('userId' in frame).toBe(false);
    });

    it('forwards agent-event end frame with durationMs and status', () => {
      const sender = new WebviewSender();
      const ws = makeWs();
      sender.register(42, ws);
      sender.onAgentEvent({
        kind: 'agent-event',
        subKind: 'end',
        agent: 'wiki-compiler',
        runId: 'run-1',
        userId: 42,
        startedAt: '2026-05-05T00:00:00.000Z',
        durationMs: 1234,
        status: 'success',
      });
      const frame = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
      expect(frame.subKind).toBe('end');
      expect(frame.durationMs).toBe(1234);
      expect(frame.status).toBe('success');
    });

    it('does not forward to connections for a different userId', () => {
      const sender = new WebviewSender();
      const ws = makeWs();
      sender.register(42, ws);
      sender.onAgentEvent({
        kind: 'agent-event',
        subKind: 'start',
        agent: 'wiki-compiler',
        runId: 'run-1',
        userId: 99, // different user
        startedAt: '2026-05-05T00:00:00.000Z',
      });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('does nothing when no connections are registered', () => {
      const sender = new WebviewSender();
      expect(() => sender.onAgentEvent({
        kind: 'agent-event',
        subKind: 'start',
        agent: 'kb-query',
        runId: 'run-x',
        userId: 1,
        startedAt: '2026-05-05T00:00:00.000Z',
      })).not.toThrow();
    });

    it('skips connections that are not OPEN', () => {
      const sender = new WebviewSender();
      const ws = makeWs(3); // CLOSING
      sender.register(1, ws);
      sender.onAgentEvent({
        kind: 'agent-event',
        subKind: 'start',
        agent: 'kb-query',
        runId: 'run-y',
        userId: 1,
        startedAt: '2026-05-05T00:00:00.000Z',
      });
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('shutdown()', () => {
    it('closes all connections and clears the registry', async () => {
      const sender = new WebviewSender();
      const ws1 = makeWs();
      const ws2 = makeWs();
      sender.register(1, ws1);
      sender.register(2, ws2);
      sender.shutdown();
      expect(ws1.close).toHaveBeenCalledOnce();
      expect(ws2.close).toHaveBeenCalledOnce();
      // After shutdown, send should do nothing (registry cleared)
      await sender.send(1, 'post-shutdown');
      expect(ws1.send).not.toHaveBeenCalled();
    });
  });
});
