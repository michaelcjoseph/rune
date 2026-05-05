import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

const mockReadVaultFile = vi.fn();
const mockParseTag = vi.fn();
const mockGetYesterdayFilename = vi.fn();
const mockGetTodayFilename = vi.fn();
const mockGetDayOfWeek = vi.fn();
const mockGetRecentFilenames = vi.fn();

vi.mock('../../vault/files.js', () => ({
  readVaultFile: mockReadVaultFile,
}));

vi.mock('../../vault/journal.js', () => ({
  parseTag: mockParseTag,
}));

vi.mock('../../utils/time.js', () => ({
  getYesterdayFilename: mockGetYesterdayFilename,
  getTodayFilename: mockGetTodayFilename,
  getDayOfWeek: mockGetDayOfWeek,
  getRecentFilenames: mockGetRecentFilenames,
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { handlePriorities } = await import('./priorities.js');

describe('handlePriorities', () => {
  function makeSender(): MessageSender {
    return {
      name: 'telegram' as const,
      send: vi.fn().mockResolvedValue(undefined),
      startTyping: vi.fn(),
      stopTyping: vi.fn(),
    };
  }
  const chatId = 123;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: today is Wednesday 2026-04-22, yesterday 2026-04-21
    mockGetYesterdayFilename.mockReturnValue('2026_04_21.md');
    mockGetTodayFilename.mockReturnValue('2026_04_22.md');
    mockGetDayOfWeek.mockReturnValue('Wednesday');
    // [today, today-1, today-2, today-3, today-4, today-5, today-6]
    mockGetRecentFilenames.mockImplementation((days: number) =>
      [
        '2026_04_22.md', // Wed (today)
        '2026_04_21.md', // Tue
        '2026_04_20.md', // Mon
        '2026_04_19.md', // Sun
        '2026_04_18.md', // Sat
        '2026_04_17.md', // Fri
        '2026_04_16.md', // Thu
      ].slice(0, days),
    );
  });

  it('defaults to yesterday when no args', async () => {
    const journalContent = '# Journal\n\n#priorities\n- Ship feature X\n- Review PR\n';
    mockReadVaultFile.mockReturnValue(journalContent);
    mockParseTag.mockReturnValue('- Ship feature X\n- Review PR');

    const sender = makeSender();
    await handlePriorities(sender, chatId);

    expect(mockReadVaultFile).toHaveBeenCalledWith('journals/2026_04_21.md');
    expect(sender.send).toHaveBeenCalledWith(
      chatId,
      "Yesterday's priorities:\n\n- Ship feature X\n- Review PR",
    );
  });

  it('resolves past day-of-week to correct journal (Monday from Wednesday)', async () => {
    const journalContent = '#priorities\n- Plan sprint\n';
    mockReadVaultFile.mockReturnValue(journalContent);
    mockParseTag.mockReturnValue('- Plan sprint');

    const sender = makeSender();
    await handlePriorities(sender, chatId, 'Monday');

    expect(mockReadVaultFile).toHaveBeenCalledWith('journals/2026_04_20.md');
    expect(sender.send).toHaveBeenCalledWith(
      chatId,
      "Monday's priorities:\n\n- Plan sprint",
    );
  });

  it('resolves same-day day-of-week to today (Wednesday from Wednesday)', async () => {
    mockReadVaultFile.mockReturnValue('#priorities\n- Today thing');
    mockParseTag.mockReturnValue('- Today thing');

    const sender = makeSender();
    await handlePriorities(sender, chatId, 'wednesday');

    expect(mockReadVaultFile).toHaveBeenCalledWith('journals/2026_04_22.md');
    expect(sender.send).toHaveBeenCalledWith(
      chatId,
      "Today's priorities:\n\n- Today thing",
    );
  });

  it('resolves future-named day to last week (Thursday from Wednesday → 6 days ago)', async () => {
    mockReadVaultFile.mockReturnValue('#priorities\n- Old thing');
    mockParseTag.mockReturnValue('- Old thing');

    const sender = makeSender();
    await handlePriorities(sender, chatId, 'Thursday');

    expect(mockReadVaultFile).toHaveBeenCalledWith('journals/2026_04_16.md');
    expect(sender.send).toHaveBeenCalledWith(
      chatId,
      "Thursday's priorities:\n\n- Old thing",
    );
  });

  it('handles "today" keyword', async () => {
    mockReadVaultFile.mockReturnValue('#priorities\n- Thing');
    mockParseTag.mockReturnValue('- Thing');

    const sender = makeSender();
    await handlePriorities(sender, chatId, 'my priorities today');

    expect(mockReadVaultFile).toHaveBeenCalledWith('journals/2026_04_22.md');
    expect(sender.send).toHaveBeenCalledWith(
      chatId,
      "Today's priorities:\n\n- Thing",
    );
  });

  it('handles "yesterday" keyword', async () => {
    mockReadVaultFile.mockReturnValue('#priorities\n- Thing');
    mockParseTag.mockReturnValue('- Thing');

    const sender = makeSender();
    await handlePriorities(sender, chatId, 'priorities yesterday');

    expect(mockReadVaultFile).toHaveBeenCalledWith('journals/2026_04_21.md');
    expect(sender.send).toHaveBeenCalledWith(
      chatId,
      "Yesterday's priorities:\n\n- Thing",
    );
  });

  it('falls back to yesterday when args has no day info', async () => {
    mockReadVaultFile.mockReturnValue('#priorities\n- Thing');
    mockParseTag.mockReturnValue('- Thing');

    const sender = makeSender();
    await handlePriorities(sender, chatId, "what's up");

    expect(mockReadVaultFile).toHaveBeenCalledWith('journals/2026_04_21.md');
    expect(sender.send).toHaveBeenCalledWith(
      chatId,
      "Yesterday's priorities:\n\n- Thing",
    );
  });

  it('sends "No journal entry" when target journal file does not exist', async () => {
    mockReadVaultFile.mockReturnValue(null);

    const sender = makeSender();
    await handlePriorities(sender, chatId, 'Monday');

    expect(mockReadVaultFile).toHaveBeenCalledWith('journals/2026_04_20.md');
    expect(mockParseTag).not.toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith(
      chatId,
      'No journal entry for monday.',
    );
  });

  it('sends "No #priorities tagged" when journal has no tag', async () => {
    const journalContent = '# Journal\n\n#log\nDid stuff';
    mockReadVaultFile.mockReturnValue(journalContent);
    mockParseTag.mockReturnValue(null);

    const sender = makeSender();
    await handlePriorities(sender, chatId);

    expect(mockParseTag).toHaveBeenCalledWith(journalContent, 'priorities');
    expect(sender.send).toHaveBeenCalledWith(
      chatId,
      "No #priorities tagged in yesterday's journal.",
    );
  });

  it('sends error message when an exception is thrown', async () => {
    mockReadVaultFile.mockImplementation(() => {
      throw new Error('disk read failed');
    });

    const sender = makeSender();
    await handlePriorities(sender, chatId);

    expect(sender.send).toHaveBeenCalledWith(chatId, 'Error: disk read failed');
  });
});
