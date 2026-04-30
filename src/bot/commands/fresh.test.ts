import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
}));

vi.mock('../../vault/sessions.js', () => ({
  getSession: vi.fn(),
  deleteSession: vi.fn(),
}));
vi.mock('../../ai/claude.js', () => ({ summarizeSession: vi.fn() }));
vi.mock('../../vault/journal.js', () => ({ appendToJournal: vi.fn() }));
vi.mock('../../utils/time.js', () => ({
  getTimestamp: vi.fn(() => '14:30'),
  getTodayDate: vi.fn(() => '2026-04-14'),
}));
vi.mock('../../vault/files.js', () => ({ writeVaultFile: vi.fn() }));
vi.mock('../../kb/queue.js', () => ({ enqueue: vi.fn() }));
vi.mock('../../vault/git.js', () => ({ gitCommitAndPush: vi.fn() }));
vi.mock('../../integrations/telegram/client.js', () => ({
  startTyping: vi.fn(() => 'typing-handle'),
  stopTyping: vi.fn(),
}));
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const { getSession, deleteSession } = await import('../../vault/sessions.js');
const { summarizeSession } = await import('../../ai/claude.js');
const { appendToJournal } = await import('../../vault/journal.js');
const { gitCommitAndPush } = await import('../../vault/git.js');
const { writeVaultFile } = await import('../../vault/files.js');
const { enqueue } = await import('../../kb/queue.js');
const { parseKBWorthy, saveConversationSource, handleFresh, closeConversation } = await import('./fresh.js');

const writeVaultMock = writeVaultFile as unknown as ReturnType<typeof vi.fn>;
const enqueueMock = enqueue as unknown as ReturnType<typeof vi.fn>;

const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
const deleteSessionMock = deleteSession as unknown as ReturnType<typeof vi.fn>;
const summarizeMock = summarizeSession as unknown as ReturnType<typeof vi.fn>;
const appendMock = appendToJournal as unknown as ReturnType<typeof vi.fn>;
const gitMock = gitCommitAndPush as unknown as ReturnType<typeof vi.fn>;

describe('bot/commands/fresh', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('parseKBWorthy', () => {
    it('extracts KB-worthy: yes as isKBWorthy true', () => {
      const summary = 'Some summary content\nKB-worthy: yes\nMore content';
      const result = parseKBWorthy(summary);
      expect(result.isKBWorthy).toBe(true);
    });

    it('extracts KB-worthy: no as isKBWorthy false', () => {
      const summary = 'Some summary content\nKB-worthy: no\nMore content';
      const result = parseKBWorthy(summary);
      expect(result.isKBWorthy).toBe(false);
    });

    it('defaults to false when KB-worthy line is missing', () => {
      const summary = 'Some summary content\nMore content';
      const result = parseKBWorthy(summary);
      expect(result.isKBWorthy).toBe(false);
    });

    it('strips KB-worthy line from journal summary', () => {
      const summary = 'Line one\nKB-worthy: yes\nLine three';
      const result = parseKBWorthy(summary);
      expect(result.journalSummary).toBe('Line one\nLine three');
      expect(result.journalSummary).not.toContain('KB-worthy');
    });

    it('preserves all non-KB-worthy lines', () => {
      const summary = 'First line\nSecond line\nKB-worthy: no\nFourth line';
      const result = parseKBWorthy(summary);
      expect(result.journalSummary).toBe('First line\nSecond line\nFourth line');
    });

    it('handles KB-worthy as the only line', () => {
      const result = parseKBWorthy('KB-worthy: yes');
      expect(result.isKBWorthy).toBe(true);
      expect(result.journalSummary).toBe('');
    });

    it('is case-insensitive for the yes/no value', () => {
      expect(parseKBWorthy('KB-worthy: Yes').isKBWorthy).toBe(true);
      expect(parseKBWorthy('KB-worthy: YES').isKBWorthy).toBe(true);
      expect(parseKBWorthy('KB-worthy: No').isKBWorthy).toBe(false);
    });

    it('is case-insensitive for the key', () => {
      expect(parseKBWorthy('kb-worthy: yes').isKBWorthy).toBe(true);
      expect(parseKBWorthy('KB-Worthy: yes').isKBWorthy).toBe(true);
    });

    it('handles KB-worthy at the first line', () => {
      const result = parseKBWorthy('KB-worthy: yes\nActual summary here');
      expect(result.isKBWorthy).toBe(true);
      expect(result.journalSummary).toBe('Actual summary here');
    });

    it('handles KB-worthy at the last line', () => {
      const result = parseKBWorthy('Actual summary here\nKB-worthy: no');
      expect(result.isKBWorthy).toBe(false);
      expect(result.journalSummary).toBe('Actual summary here');
    });
  });

  describe('saveConversationSource', () => {
    it('writes summary to knowledge/raw/conversations/ with timestamped filename', () => {
      const path = saveConversationSource('Topic: Transformers\nDiscussion: Deep dive');
      expect(path).toMatch(/^knowledge\/raw\/conversations\/conversation-2026-04-14-1430\d{2}\.md$/);
      expect(writeVaultMock).toHaveBeenCalledWith(path, 'Topic: Transformers\nDiscussion: Deep dive');
    });

    it('returns the vault-relative path', () => {
      const path = saveConversationSource('some content');
      expect(path).toMatch(/^knowledge\/raw\/conversations\//);
    });
  });

  describe('closeConversation', () => {
    it('returns { ok: false, error: "no-session" } when no session exists', async () => {
      getSessionMock.mockReturnValue(null);

      const result = await closeConversation(123);

      expect(result).toEqual({ ok: false, error: 'no-session' });
      expect(summarizeMock).not.toHaveBeenCalled();
    });

    it('returns { ok: true } with journalSummary and isKBWorthy on success', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-ok' });
      summarizeMock.mockResolvedValue({
        text: 'Good discussion\nKB-worthy: yes',
        error: null,
      });

      const result = await closeConversation(123);

      expect(result).toMatchObject({ ok: true, journalSummary: 'Good discussion', isKBWorthy: true });
      expect(appendMock).toHaveBeenCalled();
      expect(deleteSessionMock).toHaveBeenCalledWith(123);
      expect(gitMock).toHaveBeenCalledWith('TG conversation logged');
    });

    it('returns { ok: true, isKBWorthy: false } and does not enqueue when KB-worthy: no', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-ok' });
      summarizeMock.mockResolvedValue({
        text: 'Short chat\nKB-worthy: no',
        error: null,
      });

      const result = await closeConversation(123);

      expect(result).toMatchObject({ ok: true, isKBWorthy: false });
      expect(writeVaultMock).not.toHaveBeenCalled();
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('returns { ok: false } with error string when summarizeSession returns error', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-err' });
      summarizeMock.mockResolvedValue({ text: null, error: 'CLI timeout' });

      const result = await closeConversation(123);

      expect(result).toEqual({ ok: false, error: 'CLI timeout' });
      expect(deleteSessionMock).toHaveBeenCalledWith(123);
      expect(appendMock).not.toHaveBeenCalled();
    });

    it('returns { ok: false } and deletes session when summarizeSession throws', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-throw' });
      summarizeMock.mockRejectedValue(new Error('network error'));

      const result = await closeConversation(123);

      expect(result).toEqual({ ok: false, error: 'network error' });
      expect(deleteSessionMock).toHaveBeenCalledWith(123);
    });

    it('never throws — catches all exceptions and returns ok: false', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-x' });
      summarizeMock.mockRejectedValue(new Error('unexpected boom'));

      await expect(closeConversation(123)).resolves.toMatchObject({ ok: false });
    });
  });

  describe('handleFresh', () => {
    function makeBotMock() {
      return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
    }

    it('sends "No active conversation" when no session exists', async () => {
      getSessionMock.mockReturnValue(null);
      const bot = makeBotMock();

      await handleFresh(bot, 123);

      expect(bot.sendMessage).toHaveBeenCalledWith(123, 'No active conversation to summarize.');
      expect(summarizeMock).not.toHaveBeenCalled();
    });

    it('sends error message when summarizeSession returns error', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-1' });
      summarizeMock.mockResolvedValue({ text: null, error: 'Claude broke' });
      const bot = makeBotMock();

      await handleFresh(bot, 123);

      expect(deleteSessionMock).toHaveBeenCalledWith(123);
      expect(bot.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('Could not summarize'));
      expect(appendMock).not.toHaveBeenCalled();
    });

    it('saves conversation source and shows label when KB-worthy is yes', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-1' });
      summarizeMock.mockResolvedValue({
        text: 'Deep discussion about transformers\nKB-worthy: yes',
        error: null,
      });
      const bot = makeBotMock();

      await handleFresh(bot, 123);

      expect(writeVaultMock).toHaveBeenCalledWith(
        expect.stringContaining('knowledge/raw/conversations/'),
        'Deep discussion about transformers',
      );
      expect(enqueueMock).toHaveBeenCalledWith(
        expect.stringContaining('knowledge/raw/conversations/'),
      );
      const msg = bot.sendMessage.mock.calls[0][1] as string;
      expect(msg).toContain('Saved to KB sources');
      expect(msg).not.toContain('KB-worthy: yes');
      expect(msg).toContain('Conversation logged');
    });

    it('does not save, enqueue, or show KB label when KB-worthy is no', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-1' });
      summarizeMock.mockResolvedValue({
        text: 'Quick chat about weather\nKB-worthy: no',
        error: null,
      });
      const bot = makeBotMock();

      await handleFresh(bot, 123);

      expect(writeVaultMock).not.toHaveBeenCalled();
      expect(enqueueMock).not.toHaveBeenCalled();
      const msg = bot.sendMessage.mock.calls[0][1] as string;
      expect(msg).not.toContain('KB-worthy');
      expect(msg).toContain('Conversation logged');
    });

    it('appends journal entry without KB-worthy line', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-1' });
      summarizeMock.mockResolvedValue({
        text: 'Summary line\nKB-worthy: yes',
        error: null,
      });
      const bot = makeBotMock();

      await handleFresh(bot, 123);

      const entry = appendMock.mock.calls[0]![0] as string;
      expect(entry).toContain('14:30');
      expect(entry).toContain('[[jarvis]]');
      expect(entry).toContain('\t- Summary line');
      expect(entry).not.toContain('KB-worthy');
    });

    it('deletes session and commits after successful summary', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-1' });
      summarizeMock.mockResolvedValue({
        text: 'A summary\nKB-worthy: no',
        error: null,
      });
      const bot = makeBotMock();

      await handleFresh(bot, 123);

      expect(deleteSessionMock).toHaveBeenCalledWith(123);
      expect(gitMock).toHaveBeenCalledWith('TG conversation logged');
    });

    it('handles exception by resetting session and notifying user', async () => {
      getSessionMock.mockReturnValue({ sessionId: 'sess-1' });
      summarizeMock.mockRejectedValue(new Error('CLI timeout'));
      const bot = makeBotMock();

      await handleFresh(bot, 123);

      expect(deleteSessionMock).toHaveBeenCalledWith(123);
      expect(bot.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining('CLI timeout'));
    });
  });
});
