import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
}));

vi.mock('../../vault/sessions.js', () => ({
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  deleteSession: vi.fn(),
}));
vi.mock('../../vault/journal.js', () => ({ appendToJournal: vi.fn() }));
vi.mock('../../utils/time.js', () => ({
  getTimestamp: vi.fn(() => '14:30'),
  getTodayDate: vi.fn(() => '2026-04-14'),
}));
vi.mock('../../vault/git.js', () => ({ gitCommitAndPush: vi.fn() }));
vi.mock('../../integrations/telegram/client.js', () => ({
  startTyping: vi.fn(() => 'typing-handle'),
  stopTyping: vi.fn(),
}));
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const { getSession, getSessionMessages, deleteSession } = await import('../../vault/sessions.js');
const { appendToJournal } = await import('../../vault/journal.js');
const { gitCommitAndPush } = await import('../../vault/git.js');
const { handleFreshFull } = await import('./fresh-full.js');

const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
const getSessionMessagesMock = getSessionMessages as unknown as ReturnType<typeof vi.fn>;
const deleteSessionMock = deleteSession as unknown as ReturnType<typeof vi.fn>;
const appendMock = appendToJournal as unknown as ReturnType<typeof vi.fn>;
const gitMock = gitCommitAndPush as unknown as ReturnType<typeof vi.fn>;

function makeBotMock() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

describe('bot/commands/fresh-full', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('no active session', () => {
    it('sends "No active conversation" and does not log or commit', async () => {
      getSessionMock.mockReturnValue(null);
      const bot = makeBotMock();

      await handleFreshFull(bot, 123);

      expect(bot.sendMessage).toHaveBeenCalledWith(123, 'No active conversation to log.');
      expect(appendMock).not.toHaveBeenCalled();
      expect(gitMock).not.toHaveBeenCalled();
      expect(deleteSessionMock).not.toHaveBeenCalled();
    });
  });

  describe('session exists but no captured messages', () => {
    it('tells user to use /fresh instead, deletes session, does not commit', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-1' });
      getSessionMessagesMock.mockReturnValue([]);
      const bot = makeBotMock();

      await handleFreshFull(bot, 123);

      expect(bot.sendMessage).toHaveBeenCalledWith(
        123,
        'No messages captured in this session — use /fresh for a summary instead.',
      );
      expect(deleteSessionMock).toHaveBeenCalledWith(123);
      expect(appendMock).not.toHaveBeenCalled();
      expect(gitMock).not.toHaveBeenCalled();
    });
  });

  describe('successful transcript logging', () => {
    it('appends journal entry with speaker-labelled transcript', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-ok' });
      getSessionMessagesMock.mockReturnValue([
        { role: 'user', text: 'Hello', ts: '2026-04-14T14:00:00Z' },
        { role: 'assistant', text: 'Hi there!', ts: '2026-04-14T14:00:01Z' },
      ]);
      const bot = makeBotMock();

      await handleFreshFull(bot, 123);

      expect(appendMock).toHaveBeenCalledTimes(1);
      const entry = appendMock.mock.calls[0]![0] as string;
      expect(entry).toContain('14:30');
      expect(entry).toContain('[[jarvis]]');
      expect(entry).toContain('[Me]');
      expect(entry).toContain('[Jarvis]');
      expect(entry).toContain('Hello');
      expect(entry).toContain('Hi there!');
    });

    it('commits with message "TG conversation logged (full)"', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-ok' });
      getSessionMessagesMock.mockReturnValue([
        { role: 'user', text: 'Test', ts: '2026-04-14T14:00:00Z' },
      ]);
      const bot = makeBotMock();

      await handleFreshFull(bot, 123);

      expect(gitMock).toHaveBeenCalledWith('TG conversation logged (full)');
    });

    it('deletes session after logging', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-ok' });
      getSessionMessagesMock.mockReturnValue([
        { role: 'user', text: 'Test', ts: '2026-04-14T14:00:00Z' },
      ]);
      const bot = makeBotMock();

      await handleFreshFull(bot, 123);

      expect(deleteSessionMock).toHaveBeenCalledWith(123);
    });

    it('sends confirmation with message count', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-ok' });
      getSessionMessagesMock.mockReturnValue([
        { role: 'user', text: 'Msg A', ts: '2026-04-14T14:00:00Z' },
        { role: 'assistant', text: 'Reply A', ts: '2026-04-14T14:00:01Z' },
        { role: 'user', text: 'Msg B', ts: '2026-04-14T14:00:02Z' },
      ]);
      const bot = makeBotMock();

      await handleFreshFull(bot, 123);

      expect(bot.sendMessage).toHaveBeenCalledWith(
        123,
        'Full conversation logged (3 messages). Session reset.',
      );
    });

    it('formats multi-line assistant messages with indented continuation lines', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-ok' });
      getSessionMessagesMock.mockReturnValue([
        { role: 'assistant', text: 'Line one\nLine two\nLine three', ts: '2026-04-14T14:00:00Z' },
      ]);
      const bot = makeBotMock();

      await handleFreshFull(bot, 123);

      const entry = appendMock.mock.calls[0]![0] as string;
      expect(entry).toContain('\t- [Jarvis] Line one');
      expect(entry).toContain('\t  Line two');
      expect(entry).toContain('\t  Line three');
    });
  });

  describe('error handling', () => {
    it('deletes session and sends error message when appendToJournal throws', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-err' });
      getSessionMessagesMock.mockReturnValue([
        { role: 'user', text: 'Test', ts: '2026-04-14T14:00:00Z' },
      ]);
      appendMock.mockImplementation(() => { throw new Error('disk full'); });
      const bot = makeBotMock();

      await handleFreshFull(bot, 123);

      expect(deleteSessionMock).toHaveBeenCalledWith(123);
      expect(bot.sendMessage).toHaveBeenCalledWith(
        123,
        expect.stringContaining('disk full'),
      );
      expect(gitMock).not.toHaveBeenCalled();
    });

    it('never throws — catches all exceptions', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-boom' });
      getSessionMessagesMock.mockReturnValue([
        { role: 'user', text: 'Test', ts: '2026-04-14T14:00:00Z' },
      ]);
      appendMock.mockImplementation(() => { throw new Error('unexpected'); });
      const bot = makeBotMock();

      await expect(handleFreshFull(bot, 123)).resolves.not.toThrow();
    });
  });
});
