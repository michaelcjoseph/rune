import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

vi.mock('../vault/sessions.js', () => ({
  getAllSessions: vi.fn(),
  deleteSession: vi.fn(),
  transportLabel: (t: string) => (t === 'webview' ? 'webview chat' : 'telegram chat'),
}));
vi.mock('../ai/claude.js', () => ({ summarizeSession: vi.fn() }));
vi.mock('../vault/journal.js', () => ({ appendToJournal: vi.fn() }));
vi.mock('../utils/time.js', () => ({ getTimestamp: vi.fn(() => '23:00') }));
vi.mock('../vault/git.js', () => ({ gitCommitAndPush: vi.fn() }));

const { getAllSessions, deleteSession } = await import('../vault/sessions.js');
const { summarizeSession } = await import('../ai/claude.js');
const { appendToJournal } = await import('../vault/journal.js');
const { gitCommitAndPush } = await import('../vault/git.js');
const { captureSessions } = await import('./capture.js');

const getAllMock = getAllSessions as unknown as ReturnType<typeof vi.fn>;
const deleteMock = deleteSession as unknown as ReturnType<typeof vi.fn>;
const summaryMock = summarizeSession as unknown as ReturnType<typeof vi.fn>;
const appendMock = appendToJournal as unknown as ReturnType<typeof vi.fn>;
const gitMock = gitCommitAndPush as unknown as ReturnType<typeof vi.fn>;

describe('jobs/capture', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns { captured: 0 } when no sessions exist', async () => {
    getAllMock.mockReturnValue([]);
    const result = await captureSessions();
    expect(result).toEqual({ captured: 0 });
    expect(summaryMock).not.toHaveBeenCalled();
    expect(appendMock).not.toHaveBeenCalled();
    expect(gitMock).not.toHaveBeenCalled();
  });

  it('summarizes each session, appends to journal, deletes, and commits', async () => {
    getAllMock.mockReturnValue([
      { userId: 101, transport: 'telegram', session: { sessionId: 'sess-1', lastActivity: '', messageCount: 2, firstMessage: 'hi' } },
      { userId: 202, transport: 'webview', session: { sessionId: 'sess-2', lastActivity: '', messageCount: 5, firstMessage: 'hey' } },
    ]);
    summaryMock
      .mockResolvedValueOnce({ text: 'Summary line 1', error: null })
      .mockResolvedValueOnce({ text: 'Summary line 2', error: null });

    const result = await captureSessions();
    expect(result).toEqual({ captured: 2 });
    expect(summaryMock).toHaveBeenCalledWith('sess-1');
    expect(summaryMock).toHaveBeenCalledWith('sess-2');
    expect(appendMock).toHaveBeenCalledTimes(2);
    expect(deleteMock).toHaveBeenCalledWith(101, 'telegram');
    expect(deleteMock).toHaveBeenCalledWith(202, 'webview');
    expect(gitMock).toHaveBeenCalledWith('Conversations captured (nightly)');
  });

  it('does not delete sessions with empty summary text', async () => {
    getAllMock.mockReturnValue([
      { userId: 101, transport: 'telegram', session: { sessionId: 'sess-1', lastActivity: '', messageCount: 1, firstMessage: 'hi' } },
    ]);
    summaryMock.mockResolvedValue({ text: '', error: null });

    const result = await captureSessions();
    expect(result).toEqual({ captured: 0 });
    // Only successfully captured sessions are deleted
    expect(deleteMock).not.toHaveBeenCalled();
    expect(gitMock).not.toHaveBeenCalled();
  });

  it('continues processing when one session fails to summarize', async () => {
    getAllMock.mockReturnValue([
      { userId: 101, transport: 'telegram', session: { sessionId: 'sess-bad', lastActivity: '', messageCount: 1, firstMessage: 'hi' } },
      { userId: 202, transport: 'telegram', session: { sessionId: 'sess-good', lastActivity: '', messageCount: 1, firstMessage: 'hey' } },
    ]);
    summaryMock
      .mockRejectedValueOnce(new Error('Claude CLI crashed'))
      .mockResolvedValueOnce({ text: 'Good summary', error: null });

    const result = await captureSessions();
    expect(result).toEqual({ captured: 1 });
    // Only the successfully captured session (202) is deleted
    expect(deleteMock).not.toHaveBeenCalledWith(101, 'telegram');
    expect(deleteMock).toHaveBeenCalledWith(202, 'telegram');
    expect(gitMock).toHaveBeenCalled();
  });

  it('passes source parameter to git commit message', async () => {
    getAllMock.mockReturnValue([
      { userId: 101, transport: 'telegram', session: { sessionId: 'sess-1', lastActivity: '', messageCount: 1, firstMessage: 'hi' } },
    ]);
    summaryMock.mockResolvedValue({ text: 'Summary', error: null });

    await captureSessions('http');
    expect(gitMock).toHaveBeenCalledWith('Conversations captured (http)');
  });

  it('formats journal entry with timestamp and indented summary lines', async () => {
    getAllMock.mockReturnValue([
      { userId: 101, transport: 'telegram', session: { sessionId: 'sess-1', lastActivity: '', messageCount: 1, firstMessage: 'hi' } },
    ]);
    summaryMock.mockResolvedValue({ text: 'Line A\nLine B', error: null });

    await captureSessions();

    const entry = appendMock.mock.calls[0]![0] as string;
    expect(entry).toContain('23:00');
    expect(entry).toContain('[[rune]]');
    expect(entry).toContain('\t- Line A');
    expect(entry).toContain('\t- Line B');
  });

  it('uses webview chat label for webview sessions and telegram chat for tg', async () => {
    getAllMock.mockReturnValue([
      { userId: 101, transport: 'telegram', session: { sessionId: 'sess-tg', lastActivity: '', messageCount: 1, firstMessage: 'hi' } },
      { userId: 202, transport: 'webview', session: { sessionId: 'sess-web', lastActivity: '', messageCount: 1, firstMessage: 'hi' } },
    ]);
    summaryMock
      .mockResolvedValueOnce({ text: 'A', error: null })
      .mockResolvedValueOnce({ text: 'B', error: null });

    await captureSessions();

    const entries = appendMock.mock.calls.map(c => c[0] as string);
    expect(entries.some(e => e.includes('telegram chat'))).toBe(true);
    expect(entries.some(e => e.includes('webview chat'))).toBe(true);
  });

  it('deletes captured product-scoped sessions with their scope so nightly capture does not leave them stranded', async () => {
    const scope = { kind: 'product', product: 'rune' };
    getAllMock.mockReturnValue([
      {
        userId: 202,
        transport: 'webview',
        scope,
        session: { sessionId: 'sess-product', lastActivity: '', messageCount: 3, firstMessage: 'repo question' },
      },
    ]);
    summaryMock.mockResolvedValue({ text: 'Scoped summary', error: null });

    const result = await captureSessions();

    expect(result).toEqual({ captured: 1 });
    expect(deleteMock).toHaveBeenCalledWith(202, 'webview', scope);
  });
});
