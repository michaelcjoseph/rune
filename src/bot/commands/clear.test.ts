import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
}));

vi.mock('../../vault/sessions.js', () => ({
  getSession: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const { getSession, deleteSession } = await import('../../vault/sessions.js');
const { handleClear } = await import('./clear.js');

const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
const deleteSessionMock = deleteSession as unknown as ReturnType<typeof vi.fn>;

function makeBotMock() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

describe('handleClear', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends "No active session to clear." when no session exists', async () => {
    getSessionMock.mockReturnValue(null);
    const bot = makeBotMock();

    await handleClear(bot, 123);

    expect(bot.sendMessage).toHaveBeenCalledWith(123, 'No active session to clear.');
    expect(deleteSessionMock).not.toHaveBeenCalled();
  });

  it('deletes the session and sends "Session cleared." when a session exists', async () => {
    getSessionMock.mockReturnValue({ sessionId: 'sess-abc' });
    const bot = makeBotMock();

    await handleClear(bot, 456);

    expect(deleteSessionMock).toHaveBeenCalledWith(456);
    expect(bot.sendMessage).toHaveBeenCalledWith(456, 'Session cleared.');
  });

  it('does not journal or commit — purely discards the session', async () => {
    getSessionMock.mockReturnValue({ sessionId: 'sess-xyz' });
    const bot = makeBotMock();

    await handleClear(bot, 789);

    // Only one message sent: the confirmation
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).toHaveBeenCalledWith(789, 'Session cleared.');
    // deleteSession called exactly once
    expect(deleteSessionMock).toHaveBeenCalledTimes(1);
  });

  it('passes the correct chatId to both getSession and deleteSession', async () => {
    const chatId = 99999;
    getSessionMock.mockReturnValue({ sessionId: 'sess-q' });
    const bot = makeBotMock();

    await handleClear(bot, chatId);

    expect(getSessionMock).toHaveBeenCalledWith(chatId);
    expect(deleteSessionMock).toHaveBeenCalledWith(chatId);
    expect(bot.sendMessage).toHaveBeenCalledWith(chatId, 'Session cleared.');
  });
});
