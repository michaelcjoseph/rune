import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

vi.mock('../../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
}));

vi.mock('../../vault/sessions.js', () => ({
  getSession: vi.fn(),
  deleteSession: vi.fn(),
  transportLabel: (t: string) => (t === 'webview' ? 'webview chat' : 'telegram chat'),
}));
vi.mock('../../ai/claude.js', () => ({ summarizeSession: vi.fn() }));
vi.mock('../../vault/journal.js', () => ({ appendToJournal: vi.fn() }));
vi.mock('../../utils/time.js', () => ({
  getTimestamp: vi.fn(() => '14:30'),
  getTodayDate: vi.fn(() => '2026-04-30'),
}));
vi.mock('../../vault/files.js', () => ({ writeVaultFile: vi.fn() }));
vi.mock('../../kb/queue.js', () => ({ enqueue: vi.fn() }));
vi.mock('../../vault/git.js', () => ({ gitCommitAndPush: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const { getSession, deleteSession } = await import('../../vault/sessions.js');
const { summarizeSession } = await import('../../ai/claude.js');
const { appendToJournal } = await import('../../vault/journal.js');
const { gitCommitAndPush } = await import('../../vault/git.js');
const { handleJournal } = await import('./journal.js');

const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
const deleteSessionMock = deleteSession as unknown as ReturnType<typeof vi.fn>;
const summarizeMock = summarizeSession as unknown as ReturnType<typeof vi.fn>;
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

describe('handleJournal', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('source label by transport', () => {
    it('writes "telegram chat" label in journal entry when transport is telegram', async () => {
      getSessionMock.mockReturnValue(null);
      const sender = makeSender();

      await handleJournal(sender, 100, 'telegram', 'walked the dog');

      const entry = appendMock.mock.calls[0]![0] as string;
      expect(entry).toContain('[[jarvis]] telegram chat');
      expect(entry).not.toContain('webview chat');
    });

    it('writes "webview chat" label in journal entry when transport is webview', async () => {
      getSessionMock.mockReturnValue(null);
      const sender = makeSender();

      await handleJournal(sender, 100, 'webview', 'logged from browser');

      const entry = appendMock.mock.calls[0]![0] as string;
      expect(entry).toContain('[[jarvis]] webview chat');
      expect(entry).not.toContain('telegram chat');
    });
  });

  it('appends a literal entry and commits when no session is active', async () => {
    getSessionMock.mockReturnValue(null);
    const sender = makeSender();

    await handleJournal(sender, 100, 'telegram', 'bought groceries');

    const entry = appendMock.mock.calls[0]![0] as string;
    expect(entry).toContain('14:30');
    expect(entry).toContain('\t- bought groceries');
    expect(gitMock).toHaveBeenCalledWith('TG journal entry');
    expect(summarizeMock).not.toHaveBeenCalled();
    expect(deleteSessionMock).not.toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith(100, 'Logged to journal.');
  });

  it('also closes the conversation when a session is active', async () => {
    getSessionMock.mockReturnValue({ sessionId: 'sess-active' });
    summarizeMock.mockResolvedValue({
      text: 'Summary of conversation\nKB-worthy: no',
      error: null,
    });
    const sender = makeSender();

    await handleJournal(sender, 100, 'telegram', 'log this thread');

    // Literal entry written first
    const literalEntry = appendMock.mock.calls[0]![0] as string;
    expect(literalEntry).toContain('\t- log this thread');

    // Then the conversation summary is appended too
    expect(appendMock).toHaveBeenCalledTimes(2);
    const summaryEntry = appendMock.mock.calls[1]![0] as string;
    expect(summaryEntry).toContain('Summary of conversation');

    expect(summarizeMock).toHaveBeenCalledWith('sess-active');
    expect(deleteSessionMock).toHaveBeenCalledWith(100, 'telegram');
    const reply = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(reply).toContain('session reset');
  });

  it('shows KB label and enqueues when session close is KB-worthy', async () => {
    const { enqueue } = await import('../../kb/queue.js');
    const enqueueMock = enqueue as unknown as ReturnType<typeof vi.fn>;

    getSessionMock.mockReturnValue({ sessionId: 'sess-kb' });
    summarizeMock.mockResolvedValue({
      text: 'Deep conversation about product strategy\nKB-worthy: yes',
      error: null,
    });
    const sender = makeSender();

    await handleJournal(sender, 100, 'telegram', 'log kb conversation');

    expect(enqueueMock).toHaveBeenCalled();
    const reply = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(reply).toContain('Saved to KB sources');
    expect(reply).toContain('session reset');
  });

  it('falls back gracefully if summarize fails mid-thread (still resets session)', async () => {
    getSessionMock.mockReturnValue({ sessionId: 'sess-active' });
    summarizeMock.mockResolvedValue({ text: null, error: 'CLI timeout' });
    const sender = makeSender();

    await handleJournal(sender, 100, 'telegram', 'log this');

    expect(deleteSessionMock).toHaveBeenCalledWith(100, 'telegram');
    const reply = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(reply).toContain('Logged to journal');
    expect(reply).toContain('CLI timeout');
  });

  it('shows plain "Logged to journal" (no error detail) when session is gone between check and close', async () => {
    // Simulate: getSession returns a session when journal.ts checks, but
    // closeConversation's internal getSession returns null (race or double-call).
    // The first call returns truthy; the second call (inside closeConversation) returns null.
    getSessionMock
      .mockReturnValueOnce({ sessionId: 'sess-race' }) // journal.ts getSession check
      .mockReturnValueOnce(null);                       // closeConversation's getSession

    const sender = makeSender();

    await handleJournal(sender, 100, 'telegram', 'log racing message');

    const reply = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(reply).toContain('Logged to journal');
    // The no-session branch suppresses the detail so user sees a clean message.
    expect(reply).not.toContain('Conversation summary failed');
  });
});
