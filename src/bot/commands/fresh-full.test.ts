import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

vi.mock('../../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
}));

vi.mock('../../vault/sessions.js', () => ({
  getSession: vi.fn(),
  getSessionMessages: vi.fn(),
  deleteSession: vi.fn(),
  transportLabel: (t: string) => (t === 'webview' ? 'webview chat' : 'telegram chat'),
}));
vi.mock('../../vault/journal.js', () => ({ appendToJournal: vi.fn() }));
vi.mock('../../utils/time.js', () => ({
  getTimestamp: vi.fn(() => '14:30'),
  getTodayDate: vi.fn(() => '2026-04-14'),
}));
vi.mock('../../vault/git.js', () => ({ gitCommitAndPush: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));
// active-context pulls in planning/orchestrator/sr-session (which transitively
// load ai/claude.js and read config at module-load). Mock it directly so the
// suite controls the non-chat-context branch without that import chain.
vi.mock('./active-context.js', () => ({ describeActiveNonChatContext: vi.fn(() => null) }));

const { getSession, getSessionMessages, deleteSession } = await import('../../vault/sessions.js');
const { describeActiveNonChatContext } = await import('./active-context.js');
const describeActiveNonChatContextMock = describeActiveNonChatContext as unknown as ReturnType<typeof vi.fn>;
const { appendToJournal } = await import('../../vault/journal.js');
const { gitCommitAndPush } = await import('../../vault/git.js');
const { handleFreshFull } = await import('./fresh-full.js');

const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
const getSessionMessagesMock = getSessionMessages as unknown as ReturnType<typeof vi.fn>;
const deleteSessionMock = deleteSession as unknown as ReturnType<typeof vi.fn>;
const appendMock = appendToJournal as unknown as ReturnType<typeof vi.fn>;
const gitMock = gitCommitAndPush as unknown as ReturnType<typeof vi.fn>;

function makeSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

describe('bot/commands/fresh-full', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('no active session', () => {
    it('sends "No active conversation" and does not log or commit', async () => {
      getSessionMock.mockReturnValue(null);
      const sender = makeSender();

      await handleFreshFull(sender, 123, 'telegram');

      expect(sender.send).toHaveBeenCalledWith(123, 'No active conversation to log.');
      expect(appendMock).not.toHaveBeenCalled();
      expect(gitMock).not.toHaveBeenCalled();
      expect(deleteSessionMock).not.toHaveBeenCalled();
    });

    it('surfaces the non-chat-context escape hatch when one is active', async () => {
      getSessionMock.mockReturnValue(null);
      describeActiveNonChatContextMock.mockReturnValue(
        "You're in a planning session, not a chat — /approve to scaffold the spec, or /clear to abandon it.",
      );
      const sender = makeSender();

      await handleFreshFull(sender, 123, 'telegram');

      expect(sender.send).toHaveBeenCalledWith(
        123,
        "You're in a planning session, not a chat — /approve to scaffold the spec, or /clear to abandon it.",
      );
      expect(appendMock).not.toHaveBeenCalled();
      expect(gitMock).not.toHaveBeenCalled();
    });
  });

  describe('session exists but no captured messages', () => {
    it('tells user to use /fresh instead, deletes session, does not commit', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-1' });
      getSessionMessagesMock.mockReturnValue([]);
      const sender = makeSender();

      await handleFreshFull(sender, 123, 'telegram');

      expect(sender.send).toHaveBeenCalledWith(
        123,
        'No messages captured in this session — use /fresh for a summary instead.',
      );
      expect(deleteSessionMock).toHaveBeenCalledWith(123, 'telegram');
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
      const sender = makeSender();

      await handleFreshFull(sender, 123, 'telegram');

      expect(appendMock).toHaveBeenCalledTimes(1);
      const entry = appendMock.mock.calls[0]![0] as string;
      expect(entry).toContain('14:30');
      expect(entry).toContain('[[rune]]');
      expect(entry).toContain('[Me]');
      expect(entry).toContain('[Rune]');
      expect(entry).toContain('Hello');
      expect(entry).toContain('Hi there!');
    });

    it('commits with message "Conversation logged (full)"', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-ok' });
      getSessionMessagesMock.mockReturnValue([
        { role: 'user', text: 'Test', ts: '2026-04-14T14:00:00Z' },
      ]);
      const sender = makeSender();

      await handleFreshFull(sender, 123, 'telegram');

      expect(gitMock).toHaveBeenCalledWith('Conversation logged (full)');
    });

    it('deletes session after logging', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-ok' });
      getSessionMessagesMock.mockReturnValue([
        { role: 'user', text: 'Test', ts: '2026-04-14T14:00:00Z' },
      ]);
      const sender = makeSender();

      await handleFreshFull(sender, 123, 'telegram');

      expect(deleteSessionMock).toHaveBeenCalledWith(123, 'telegram');
    });

    it('sends confirmation with message count', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-ok' });
      getSessionMessagesMock.mockReturnValue([
        { role: 'user', text: 'Msg A', ts: '2026-04-14T14:00:00Z' },
        { role: 'assistant', text: 'Reply A', ts: '2026-04-14T14:00:01Z' },
        { role: 'user', text: 'Msg B', ts: '2026-04-14T14:00:02Z' },
      ]);
      const sender = makeSender();

      await handleFreshFull(sender, 123, 'telegram');

      expect(sender.send).toHaveBeenCalledWith(
        123,
        'Full conversation logged (3 messages). Session reset.',
      );
    });

    it('formats multi-line assistant messages with indented continuation lines', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-ok' });
      getSessionMessagesMock.mockReturnValue([
        { role: 'assistant', text: 'Line one\nLine two\nLine three', ts: '2026-04-14T14:00:00Z' },
      ]);
      const sender = makeSender();

      await handleFreshFull(sender, 123, 'telegram');

      const entry = appendMock.mock.calls[0]![0] as string;
      expect(entry).toContain('\t- [Rune] Line one');
      expect(entry).toContain('\t  Line two');
      expect(entry).toContain('\t  Line three');
    });
  });

  describe('webview transport label', () => {
    it('writes "webview chat" in the journal entry when transport is webview', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-web' });
      getSessionMessagesMock.mockReturnValue([
        { role: 'user', text: 'Hello from webview', ts: '2026-04-14T14:00:00Z' },
      ]);
      const sender = makeSender();

      await handleFreshFull(sender, 123, 'webview');

      const entry = appendMock.mock.calls[0]![0] as string;
      expect(entry).toContain('[[rune]] webview chat (full transcript)');
      expect(entry).not.toContain('telegram chat');
    });

    it('writes "telegram chat" in the journal entry when transport is telegram', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-tg' });
      getSessionMessagesMock.mockReturnValue([
        { role: 'user', text: 'Hello from TG', ts: '2026-04-14T14:00:00Z' },
      ]);
      const sender = makeSender();

      await handleFreshFull(sender, 456, 'telegram');

      const entry = appendMock.mock.calls[0]![0] as string;
      expect(entry).toContain('[[rune]] telegram chat (full transcript)');
      expect(entry).not.toContain('webview chat');
    });
  });

  describe('error handling', () => {
    it('deletes session and sends error message when appendToJournal throws', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-err' });
      getSessionMessagesMock.mockReturnValue([
        { role: 'user', text: 'Test', ts: '2026-04-14T14:00:00Z' },
      ]);
      appendMock.mockImplementation(() => { throw new Error('disk full'); });
      const sender = makeSender();

      await handleFreshFull(sender, 123, 'telegram');

      expect(deleteSessionMock).toHaveBeenCalledWith(123, 'telegram');
      expect(sender.send).toHaveBeenCalledWith(
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
      const sender = makeSender();

      await expect(handleFreshFull(sender, 123, 'telegram')).resolves.not.toThrow();
    });
  });
});
