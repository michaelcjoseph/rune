import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger to suppress output
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock config
vi.mock('../config.js', () => ({
  default: {
    TG_MAX_MESSAGE_LENGTH: 4096,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 123,
  },
}));

// Mock telegram client
vi.mock('../integrations/telegram/client.js', () => ({
  sendLongMessage: vi.fn().mockResolvedValue(undefined),
  startTyping: vi.fn().mockReturnValue(1),
  stopTyping: vi.fn(),
}));

const { createSenders } = await import('./sender.js');
const { NotificationBus } = await import('./notification-bus.js');
const telegramClient = await import('../integrations/telegram/client.js');

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));
const mockSendLongMessage = vi.mocked(telegramClient.sendLongMessage);

function mockBot() {
  return {
    sendMessage: vi.fn().mockResolvedValue({}),
    sendChatAction: vi.fn().mockResolvedValue(true),
  } as any;
}

function mockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
  } as any;
}

describe('createSenders', () => {
  let bot: ReturnType<typeof mockBot>;
  let bus: InstanceType<typeof NotificationBus>;

  beforeEach(() => {
    bot = mockBot();
    bus = new NotificationBus();
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns an object with tg, webview, and destroy', () => {
      const { tg, webview, destroy } = createSenders(bot, bus);
      expect(tg).toBeDefined();
      expect(webview).toBeDefined();
      expect(typeof destroy).toBe('function');
    });

    it('tg sender has name "telegram"', () => {
      const { tg } = createSenders(bot, bus);
      expect(tg.name).toBe('telegram');
    });

    it('webview sender has name "webview"', () => {
      const { webview } = createSenders(bot, bus);
      expect(webview.name).toBe('webview');
    });

    it('returns distinct instances for tg and webview', () => {
      const { tg, webview } = createSenders(bot, bus);
      expect(tg).not.toBe(webview);
    });
  });

  describe('bus "message" event fan-out', () => {
    it('publishing a message event calls tg.send with the correct userId and text', async () => {
      const { tg } = createSenders(bot, bus);
      const tgSendSpy = vi.spyOn(tg, 'send').mockResolvedValue(undefined);

      bus.publish({ kind: 'message', userId: 42, text: 'hello tg' });

      // Give the microtask queue a tick (void + catch are async)
      await flushMicrotasks();

      expect(tgSendSpy).toHaveBeenCalledOnce();
      expect(tgSendSpy).toHaveBeenCalledWith(42, 'hello tg');
    });

    it('publishing a message event calls webview.send with the correct userId and text', async () => {
      const { webview } = createSenders(bot, bus);
      const webviewSendSpy = vi.spyOn(webview, 'send').mockResolvedValue(undefined);

      bus.publish({ kind: 'message', userId: 42, text: 'hello webview' });

      await flushMicrotasks();

      expect(webviewSendSpy).toHaveBeenCalledOnce();
      expect(webviewSendSpy).toHaveBeenCalledWith(42, 'hello webview');
    });

    it('publishing a message event fans out to both senders', async () => {
      const { tg, webview } = createSenders(bot, bus);
      const tgSendSpy = vi.spyOn(tg, 'send').mockResolvedValue(undefined);
      const webviewSendSpy = vi.spyOn(webview, 'send').mockResolvedValue(undefined);

      bus.publish({ kind: 'message', userId: 99, text: 'broadcast' });

      await flushMicrotasks();

      expect(tgSendSpy).toHaveBeenCalledWith(99, 'broadcast');
      expect(webviewSendSpy).toHaveBeenCalledWith(99, 'broadcast');
    });

    it('multiple published events each fan out to both senders', async () => {
      const { tg, webview } = createSenders(bot, bus);
      const tgSendSpy = vi.spyOn(tg, 'send').mockResolvedValue(undefined);
      const webviewSendSpy = vi.spyOn(webview, 'send').mockResolvedValue(undefined);

      bus.publish({ kind: 'message', userId: 1, text: 'first' });
      bus.publish({ kind: 'message', userId: 2, text: 'second' });

      await flushMicrotasks();

      expect(tgSendSpy).toHaveBeenCalledTimes(2);
      expect(webviewSendSpy).toHaveBeenCalledTimes(2);
    });

    it('tg.send failure is caught and webview.send still executes', async () => {
      const { tg, webview } = createSenders(bot, bus);
      vi.spyOn(tg, 'send').mockRejectedValue(new Error('tg down'));
      const webviewSendSpy = vi.spyOn(webview, 'send').mockResolvedValue(undefined);

      expect(() =>
        bus.publish({ kind: 'message', userId: 1, text: 'error test' }),
      ).not.toThrow();

      await flushMicrotasks();

      expect(webviewSendSpy).toHaveBeenCalledWith(1, 'error test');
    });
  });

  describe('bus "mutation-event" Phase 15 progress fan-out', () => {
    it('publishes orchestrated closeout progress through the existing Telegram and webview senders', async () => {
      const { webview } = createSenders(bot, bus);
      const ws = mockWs();
      webview.register(123, ws);

      bus.publish({
        kind: 'mutation-event',
        mutationId: 'mut-orch-closeout-123456',
        mutationKind: 'orchestrated-work',
        subKind: 'progress',
        ts: '2026-06-19T12:00:00.000Z',
        userId: 123,
        data: {
          event: 'closeout-commit',
          projectSlug: 'demo',
          taskText: 'Render the streak card',
          commitSha: 'abc123456789',
          shortSha: 'abc1234',
          commitSubject: 'jarvis(jarvis): closeout — Render the streak card',
          tasksDone: 3,
          tasksTotal: 12,
          tasksRemaining: 9,
        },
      });

      await flushMicrotasks();

      expect(mockSendLongMessage).toHaveBeenCalledOnce();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).toContain('Render the streak card');
      expect(text).toContain('abc1234');
      expect(text).toMatch(/3\/12 done/i);
      expect(text).toMatch(/9 remaining/i);

      expect(ws.send).toHaveBeenCalledOnce();
      const frame = JSON.parse(ws.send.mock.calls[0]![0]);
      expect(frame).toMatchObject({
        kind: 'mutation-event',
        mutationId: 'mut-orch-closeout-123456',
        mutationKind: 'orchestrated-work',
        subKind: 'progress',
        data: expect.objectContaining({
          event: 'closeout-commit',
          projectSlug: 'demo',
          commitSha: 'abc123456789',
        }),
      });
      expect('userId' in frame).toBe(false);
    });

    it('a webview delivery failure does not block the Telegram merge-success alert', async () => {
      const { webview } = createSenders(bot, bus);
      vi.spyOn(webview, 'onMutationEvent').mockImplementation(() => {
        throw new Error('ws delivery failed');
      });

      expect(() =>
        bus.publish({
          kind: 'mutation-event',
          mutationId: 'mut-orch-merge-123456',
          mutationKind: 'orchestrated-work',
          subKind: 'progress',
          ts: '2026-06-19T12:00:00.000Z',
          userId: 123,
          data: {
            event: 'merge-success',
            projectSlug: 'demo',
            product: 'jarvis',
            branch: 'jarvis-work/demo',
            baseBranch: 'main',
          },
        }),
      ).not.toThrow();

      await flushMicrotasks();

      expect(mockSendLongMessage).toHaveBeenCalledOnce();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text.toLowerCase()).toContain('jarvis/demo');
      expect(text.toLowerCase()).toContain('merged to main');
    });
  });

  describe('bus "run-event" fan-out', () => {
    it('publishing a run-event reaches WebviewSender as a first-class realtime frame', async () => {
      const { webview } = createSenders(bot, bus);
      const ws = mockWs();
      webview.register(123, ws);

      bus.publish({
        kind: 'run-event',
        subKind: 'agents',
        runId: 'run-live-001',
        product: 'aura',
        target: { kind: 'project', slug: '01-mvp' },
        agents: [
          { role: 'qa', active: true },
          { role: 'coder', active: true },
        ],
        ts: '2026-06-23T12:00:00.000Z',
        userId: 123,
      } as any);

      await flushMicrotasks();

      expect(ws.send).toHaveBeenCalledOnce();
      const frame = JSON.parse(ws.send.mock.calls[0]![0]);
      expect(frame).toMatchObject({
        kind: 'run-event',
        subKind: 'agents',
        runId: 'run-live-001',
        product: 'aura',
        target: { kind: 'project', slug: '01-mvp' },
        agents: [
          { role: 'qa', active: true },
          { role: 'coder', active: true },
        ],
      });
      expect('userId' in frame).toBe(false);
    });

    it('a run-event webview delivery failure does not throw out of publish', () => {
      const { webview } = createSenders(bot, bus);
      const runEventSpy = vi.spyOn(webview as any, 'onRunEvent').mockImplementation(() => {
        throw new Error('ws delivery failed');
      });

      expect(() =>
        bus.publish({
          kind: 'run-event',
          subKind: 'state',
          runId: 'run-live-001',
          product: 'aura',
          target: { kind: 'project', slug: '01-mvp' },
          state: 'failed',
          elapsedMs: 65_000,
          outcome: 'failed',
          ts: '2026-06-23T12:01:05.000Z',
          userId: 123,
        } as any),
      ).not.toThrow();
      expect(runEventSpy).toHaveBeenCalledOnce();
    });

    it('after destroy(), run-events are no longer delivered', async () => {
      const { webview, destroy } = createSenders(bot, bus);
      const ws = mockWs();
      webview.register(123, ws);

      destroy();
      bus.publish({
        kind: 'run-event',
        subKind: 'progress',
        runId: 'run-live-001',
        product: 'aura',
        target: { kind: 'project', slug: '01-mvp' },
        tasks: { done: 3, total: 7 },
        ts: '2026-06-23T12:00:05.000Z',
        userId: 123,
      } as any);

      await flushMicrotasks();

      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('bus "op-event" fan-out', () => {
    const TS = '2026-05-14T12:00:00.000Z';

    function makeOpEventStart(userId: number) {
      return {
        kind: 'op-event' as const,
        subKind: 'start' as const,
        opId: 'op-fan-out-test',
        userId,
        opKind: 'agent' as const,
        label: 'wiki-compiler',
        startedAt: TS,
        elapsedMs: 0,
      };
    }

    it('publishing an op-event calls tg.onOpEvent', () => {
      const { tg } = createSenders(bot, bus);
      const spy = vi.spyOn(tg, 'onOpEvent');
      const event = makeOpEventStart(42);
      bus.publish(event as any);
      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith(event);
    });

    it('publishing an op-event calls webview.onOpEvent', () => {
      const { webview } = createSenders(bot, bus);
      const spy = vi.spyOn(webview, 'onOpEvent');
      const event = makeOpEventStart(42);
      bus.publish(event as any);
      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith(event);
    });

    it('publishing an op-event fans out to both tg and webview', () => {
      const { tg, webview } = createSenders(bot, bus);
      const tgSpy = vi.spyOn(tg, 'onOpEvent');
      const wvSpy = vi.spyOn(webview, 'onOpEvent');
      bus.publish(makeOpEventStart(42) as any);
      expect(tgSpy).toHaveBeenCalledOnce();
      expect(wvSpy).toHaveBeenCalledOnce();
    });

    it('after destroy(), op-events are no longer delivered', () => {
      const { tg, webview, destroy } = createSenders(bot, bus);
      const tgSpy = vi.spyOn(tg, 'onOpEvent');
      const wvSpy = vi.spyOn(webview, 'onOpEvent');
      destroy();
      bus.publish(makeOpEventStart(42) as any);
      expect(tgSpy).not.toHaveBeenCalled();
      expect(wvSpy).not.toHaveBeenCalled();
    });
  });
});
