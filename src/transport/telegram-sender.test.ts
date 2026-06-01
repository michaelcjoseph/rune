import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// Mock config before any module import that reads it
vi.mock('../config.js', () => ({
  default: {
    TG_MAX_MESSAGE_LENGTH: 4096,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 123,
  },
}));

// Mock the telegram client so we can inspect calls without real I/O
const mockSendLongMessage = vi.fn().mockResolvedValue(undefined);
const mockStartTyping = vi.fn().mockReturnValue(42 as unknown as ReturnType<typeof setInterval>);
const mockStopTyping = vi.fn();

vi.mock('../integrations/telegram/client.js', () => ({
  sendLongMessage: mockSendLongMessage,
  startTyping: mockStartTyping,
  stopTyping: mockStopTyping,
}));

const { TelegramSender } = await import('./telegram-sender.js');

function mockBot() {
  return {
    sendMessage: vi.fn().mockResolvedValue({}),
    sendChatAction: vi.fn().mockResolvedValue(true),
  } as any;
}

describe('TelegramSender', () => {
  let bot: ReturnType<typeof mockBot>;
  let sender: InstanceType<typeof TelegramSender>;

  beforeEach(() => {
    bot = mockBot();
    sender = new TelegramSender(bot);
    vi.clearAllMocks();
    // Re-apply default implementation after clearAllMocks
    mockSendLongMessage.mockResolvedValue(undefined);
    mockStartTyping.mockReturnValue(42 as unknown as ReturnType<typeof setInterval>);
  });

  describe('send() delegates to sendLongMessage', () => {
    it('calls sendLongMessage with the bot, userId, and text', async () => {
      await sender.send(100, 'hello world');
      expect(mockSendLongMessage).toHaveBeenCalledOnce();
      expect(mockSendLongMessage).toHaveBeenCalledWith(bot, 100, 'hello world');
    });

    it('passes through for short messages (under 4096 chars)', async () => {
      const text = 'a'.repeat(100);
      await sender.send(100, text);
      expect(mockSendLongMessage).toHaveBeenCalledWith(bot, 100, text);
    });

    it('passes through for a message exactly 4096 chars', async () => {
      const text = 'b'.repeat(4096);
      await sender.send(100, text);
      expect(mockSendLongMessage).toHaveBeenCalledWith(bot, 100, text);
    });

    it('passes through for a message longer than 4096 chars (chunking handled by sendLongMessage)', async () => {
      const text = 'c'.repeat(5000);
      await sender.send(100, text);
      expect(mockSendLongMessage).toHaveBeenCalledWith(bot, 100, text);
    });

    it('awaits the promise returned by sendLongMessage', async () => {
      let resolved = false;
      mockSendLongMessage.mockImplementation(() =>
        new Promise<void>((res) => {
          setTimeout(() => { resolved = true; res(); }, 0);
        }),
      );
      await sender.send(100, 'delayed');
      expect(resolved).toBe(true);
    });
  });

  // Chunking correctness is already covered by src/integrations/telegram/client.test.ts.
  // TelegramSender.send delegates 100% to sendLongMessage, so there is nothing additional to test here.

  describe('startTyping', () => {
    it('calls startTyping from the client with bot and userId', () => {
      sender.startTyping(100);
      expect(mockStartTyping).toHaveBeenCalledWith(bot, 100);
    });

    it('accepts an optional label and ignores it (Telegram uses the native typing indicator)', () => {
      sender.startTyping(100, 'Running agent…');
      // Telegram client is called with only bot and userId — label is not forwarded
      expect(mockStartTyping).toHaveBeenCalledWith(bot, 100);
    });

    it('stores the returned interval so stopTyping can clear it', () => {
      const fakeHandle = 99 as unknown as ReturnType<typeof setInterval>;
      mockStartTyping.mockReturnValue(fakeHandle);

      sender.startTyping(100);
      sender.stopTyping(100);

      expect(mockStopTyping).toHaveBeenCalledWith(fakeHandle);
    });

    it('is idempotent — double startTyping does not create a second interval', () => {
      sender.startTyping(100);
      sender.startTyping(100); // Should be a no-op

      expect(mockStartTyping).toHaveBeenCalledOnce();
    });

    it('manages typing timers per userId independently', () => {
      const handle1 = 1 as unknown as ReturnType<typeof setInterval>;
      const handle2 = 2 as unknown as ReturnType<typeof setInterval>;
      mockStartTyping
        .mockReturnValueOnce(handle1)
        .mockReturnValueOnce(handle2);

      sender.startTyping(100);
      sender.startTyping(200);

      expect(mockStartTyping).toHaveBeenCalledTimes(2);

      sender.stopTyping(100);
      expect(mockStopTyping).toHaveBeenCalledWith(handle1);

      sender.stopTyping(200);
      expect(mockStopTyping).toHaveBeenCalledWith(handle2);
    });
  });

  describe('stopTyping', () => {
    it('calls stopTyping from the client with the stored interval', () => {
      const fakeHandle = 77 as unknown as ReturnType<typeof setInterval>;
      mockStartTyping.mockReturnValue(fakeHandle);

      sender.startTyping(100);
      sender.stopTyping(100);

      expect(mockStopTyping).toHaveBeenCalledWith(fakeHandle);
    });

    it('removes the timer so a subsequent stopTyping is a no-op', () => {
      sender.startTyping(100);
      sender.stopTyping(100);
      vi.clearAllMocks();

      sender.stopTyping(100); // Already cleared
      expect(mockStopTyping).not.toHaveBeenCalled();
    });

    it('is a no-op when the userId is not typing', () => {
      sender.stopTyping(999); // Never started
      expect(mockStopTyping).not.toHaveBeenCalled();
    });
  });

  // ---- op-event tracker tests (onOpEvent) ----

  const TS = '2026-05-14T12:00:00.000Z';

  function makeOpEventStart(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'op-event' as const,
      subKind: 'start' as const,
      opId: 'test-op-id-1234',
      userId: 100,
      opKind: 'agent' as const,
      label: 'wiki-compiler',
      startedAt: TS,
      elapsedMs: 0,
      ...overrides,
    };
  }

  function makeOpEventProgress(opId = 'test-op-id-1234', overrides: Record<string, unknown> = {}) {
    return {
      kind: 'op-event' as const,
      subKind: 'progress' as const,
      opId,
      userId: 100,
      opKind: 'agent' as const,
      label: 'wiki-compiler',
      startedAt: TS,
      elapsedMs: 5000,
      ...overrides,
    };
  }

  function makeOpEventEnd(opId = 'test-op-id-1234', overrides: Record<string, unknown> = {}) {
    return {
      kind: 'op-event' as const,
      subKind: 'end' as const,
      opId,
      userId: 100,
      opKind: 'agent' as const,
      label: 'wiki-compiler',
      startedAt: TS,
      elapsedMs: 12000,
      status: 'success' as const,
      ...overrides,
    };
  }

  describe('onMutationEvent — work-run outcome rendering', () => {
    /** Build a work-run terminal BusMutationEvent. */
    function workRunEvent(subKind: 'completed' | 'failed', data: Record<string, unknown>) {
      return {
        kind: 'mutation-event' as const,
        mutationId: 'abcd1234-5678-90ab-cdef-1234567890ab',
        mutationKind: 'work-run',
        subKind,
        ts: new Date().toISOString(),
        data: { projectSlug: 'demo', ...data },
        userId: 123,
      } as any;
    }

    const noopWorkProduct = {
      commitCount: 0,
      commitShas: [],
      filesChanged: [],
      diffstat: '',
      dirty: false,
      untracked: false,
      transitions: { tasksNewlyChecked: 0, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 },
    };

    /** Wait one macrotask so the fire-and-forget `void this.send()` resolves. */
    async function flush() {
      await new Promise((r) => setTimeout(r, 0));
    }

    it('a noop outcome never renders as "finished" success', async () => {
      sender.onMutationEvent(
        workRunEvent('completed', { outcome: 'noop', reason: 'no commits, no task transitions, clean tree', workProduct: noopWorkProduct }),
      );
      await flush();
      expect(mockSendLongMessage).toHaveBeenCalledOnce();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).not.toMatch(/finished/i);
      expect(text.toLowerCase()).toContain('no-op');
      expect(text).toContain('demo');
    });

    it('a dirty-uncommitted outcome reads as a warning, not success', async () => {
      sender.onMutationEvent(
        workRunEvent('completed', {
          outcome: 'dirty-uncommitted',
          reason: 'no commits but the working tree is dirty/untracked',
          workProduct: { ...noopWorkProduct, dirty: true },
        }),
      );
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).not.toMatch(/finished/i);
      expect(text.toLowerCase()).toMatch(/dirty|uncommitted/);
    });

    it('a branch-complete outcome notes all tasks checked on the branch (not yet on main)', async () => {
      sender.onMutationEvent(
        workRunEvent('completed', {
          outcome: 'branch-complete',
          reason: '2 commit(s), all original tasks checked',
          workProduct: { ...noopWorkProduct, commitCount: 2, transitions: { tasksNewlyChecked: 3, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 } },
        }),
      );
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).toContain('✅');
      expect(text.toLowerCase()).toMatch(/branch|not yet|main/);
    });

    it('a partial outcome carries the commits + tasks X/Y summary', async () => {
      sender.onMutationEvent(
        workRunEvent('completed', {
          outcome: 'partial',
          reason: '1 commit(s), 2 task(s) still unchecked',
          workProduct: { ...noopWorkProduct, commitCount: 1, transitions: { tasksNewlyChecked: 1, tasksRemaining: 2, tasksAdded: 0, tasksRemoved: 0 } },
        }),
      );
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).not.toMatch(/finished/i);
      // commits + remaining tasks surfaced
      expect(text).toMatch(/1/);
      expect(text).toMatch(/2/);
    });

    it('a failed outcome renders the reason', async () => {
      sender.onMutationEvent(
        workRunEvent('failed', { outcome: 'failed', reason: 'exited with code 1' }),
      );
      await flush();
      const text = mockSendLongMessage.mock.calls[0]![2] as string;
      expect(text).toContain('❌');
      expect(text).toContain('exited with code 1');
    });

    it('ignores non-terminal work-run events (output/progress)', async () => {
      sender.onMutationEvent(workRunEvent('completed', { outcome: 'noop', workProduct: noopWorkProduct }));
      // override subKind to a non-terminal value
      sender.onMutationEvent({ ...workRunEvent('completed', {}), subKind: 'output', data: { line: 'x' } } as any);
      await flush();
      // only the terminal event produced a message
      expect(mockSendLongMessage).toHaveBeenCalledOnce();
    });
  });

  describe('onOpEvent — classifier filter', () => {
    it('ignores start events for classifier ops', () => {
      const event = makeOpEventStart({ opKind: 'classifier' });
      sender.onOpEvent(event as any);
      expect(bot.sendMessage).not.toHaveBeenCalled();
    });

    it('ignores progress events for classifier ops', () => {
      const event = makeOpEventProgress('x', { opKind: 'classifier' });
      sender.onOpEvent(event as any);
      expect(bot.sendMessage).not.toHaveBeenCalled();
    });

    it('ignores end events for classifier ops', () => {
      const event = makeOpEventEnd('x', { opKind: 'classifier' });
      sender.onOpEvent(event as any);
      expect(bot.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('onOpEvent — start sends tracker message', () => {
    it('calls bot.sendMessage with a formatted tracker text on start', () => {
      const event = makeOpEventStart();
      sender.onOpEvent(event as any);
      expect(bot.sendMessage).toHaveBeenCalledOnce();
      const [userId, text] = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(userId).toBe(100);
      expect(text).toContain('wiki-compiler');
      expect(text).toContain('/cancel');
    });

    it('formats elapsed seconds from elapsedMs', async () => {
      const event = makeOpEventStart({ elapsedMs: 15000 });
      sender.onOpEvent(event as any);
      expect(bot.sendMessage).toHaveBeenCalledOnce();
      const [, text] = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(text).toContain('15s');
    });
  });

  describe('onOpEvent — progress edits tracker message (throttled)', () => {
    it('does not edit when no tracker exists for that opId', async () => {
      const event = makeOpEventProgress('unknown-op');
      sender.onOpEvent(event as any);
      expect(bot.editMessageText).toBeUndefined();
    });

    it('does not call editMessageText before throttle window expires', async () => {
      // The bot already has sendMessage from mockBot().
      // Ensure editMessageText is defined on bot so we can spy on it.
      bot.editMessageText = vi.fn().mockResolvedValue({});

      const start = makeOpEventStart();
      sender.onOpEvent(start as any);
      // Flush microtasks so the sendMessage .then() callback fires and stores the tracker.
      await new Promise(r => setTimeout(r, 0));

      // Immediately send a progress event — the tracker was just stored but
      // lastEditTs was set to Date.now() at creation, so the 10s throttle
      // prevents any edit call this soon.
      const progress = makeOpEventProgress(start.opId, { elapsedMs: 100 });
      sender.onOpEvent(progress as any);
      expect(bot.editMessageText).not.toHaveBeenCalled();
    });
  });

  describe('onOpEvent — end deletes tracker message', () => {
    it('does not call deleteMessage when no tracker exists for that opId', async () => {
      bot.deleteMessage = vi.fn().mockResolvedValue(true);
      const event = makeOpEventEnd('unknown-op-id');
      sender.onOpEvent(event as any);
      expect(bot.deleteMessage).not.toHaveBeenCalled();
    });

    it('calls deleteMessage after start+end sequence (async resolve)', async () => {
      bot.sendMessage = vi.fn().mockResolvedValue({ message_id: 999 });
      bot.deleteMessage = vi.fn().mockResolvedValue(true);

      const start = makeOpEventStart({ opId: 'del-op-1' });
      sender.onOpEvent(start as any);

      // Flush microtasks so the .then() callback runs and tracker is stored
      await new Promise(r => setTimeout(r, 0));

      const end = makeOpEventEnd('del-op-1');
      sender.onOpEvent(end as any);

      // Flush again for the delete promise
      await new Promise(r => setTimeout(r, 0));

      expect(bot.deleteMessage).toHaveBeenCalledOnce();
      const [chatId, msgId] = (bot.deleteMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(chatId).toBe(100); // userId
      expect(msgId).toBe(999);  // message_id from sendMessage
    });
  });

  describe('shutdown — trackers cleared', () => {
    it('clears trackers map without throwing', () => {
      // Just verify shutdown doesn't throw even with pending trackers
      sender.onOpEvent(makeOpEventStart() as any);
      expect(() => sender.shutdown()).not.toThrow();
    });
  });
});
