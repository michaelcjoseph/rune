import { describe, it, expect, vi } from 'vitest';

// Mock config before importing the module under test
vi.mock('../../config.js', () => ({
  default: {
    TG_MAX_MESSAGE_LENGTH: 4096,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 123,
  },
}));

// Use dynamic import after mock setup
const { sendLongMessage, startTyping, stopTyping } = await import('./client.js');

function mockBot() {
  return {
    sendMessage: vi.fn().mockResolvedValue({}),
    sendChatAction: vi.fn().mockResolvedValue(true),
  } as any;
}

describe('chunkMessage (via sendLongMessage)', () => {
  it('sends short messages as a single chunk', async () => {
    const bot = mockBot();
    await sendLongMessage(bot, 123, 'hello');
    expect(bot.sendMessage).toHaveBeenCalledOnce();
    expect(bot.sendMessage).toHaveBeenCalledWith(123, 'hello');
  });

  it('splits long messages at newline boundaries', async () => {
    const bot = mockBot();
    const line = 'x'.repeat(2000);
    const text = `${line}\n${line}\n${line}`;
    await sendLongMessage(bot, 123, text);
    expect(bot.sendMessage.mock.calls.length).toBeGreaterThan(1);
  });

  it('handles messages with no newlines', async () => {
    const bot = mockBot();
    const text = 'x'.repeat(5000);
    await sendLongMessage(bot, 123, text);
    expect(bot.sendMessage.mock.calls.length).toBe(2);
  });
});

describe('typing indicators', () => {
  it('startTyping sends typing action and returns interval', () => {
    vi.useFakeTimers();
    const bot = mockBot();
    const interval = startTyping(bot, 123);
    expect(bot.sendChatAction).toHaveBeenCalledWith(123, 'typing');
    stopTyping(interval);
    vi.useRealTimers();
  });

  it('stopTyping clears the interval', () => {
    vi.useFakeTimers();
    const bot = mockBot();
    const interval = startTyping(bot, 123);
    stopTyping(interval);
    // Advance time — no more calls should happen
    const callCount = bot.sendChatAction.mock.calls.length;
    vi.advanceTimersByTime(10000);
    expect(bot.sendChatAction.mock.calls.length).toBe(callCount);
    vi.useRealTimers();
  });
});
