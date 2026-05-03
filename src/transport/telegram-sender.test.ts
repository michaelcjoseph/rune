import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
});
