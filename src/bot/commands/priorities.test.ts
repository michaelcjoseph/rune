import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadVaultFile = vi.fn();
const mockParseTag = vi.fn();
const mockGetYesterdayFilename = vi.fn();

vi.mock('../../vault/files.js', () => ({
  readVaultFile: mockReadVaultFile,
}));

vi.mock('../../vault/journal.js', () => ({
  parseTag: mockParseTag,
}));

vi.mock('../../utils/time.js', () => ({
  getYesterdayFilename: mockGetYesterdayFilename,
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
  const mockBot = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
  const chatId = 123;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetYesterdayFilename.mockReturnValue('2026-04-13.md');
  });

  it('sends priorities when yesterday journal has #priorities content', async () => {
    const journalContent = '# Journal\n\n#priorities\n- Ship feature X\n- Review PR\n\n#log\nDid stuff';
    mockReadVaultFile.mockReturnValue(journalContent);
    mockParseTag.mockReturnValue('- Ship feature X\n- Review PR');

    await handlePriorities(mockBot, chatId);

    expect(mockReadVaultFile).toHaveBeenCalledWith('journals/2026-04-13.md');
    expect(mockParseTag).toHaveBeenCalledWith(journalContent, 'priorities');
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      "Yesterday's priorities:\n\n- Ship feature X\n- Review PR",
    );
  });

  it('sends "No journal entry" when yesterday journal file does not exist', async () => {
    mockReadVaultFile.mockReturnValue(null);

    await handlePriorities(mockBot, chatId);

    expect(mockReadVaultFile).toHaveBeenCalledWith('journals/2026-04-13.md');
    expect(mockParseTag).not.toHaveBeenCalled();
    expect(mockBot.sendMessage).toHaveBeenCalledWith(chatId, 'No journal entry from yesterday.');
  });

  it('sends "No #priorities tagged" when journal exists but has no #priorities tag', async () => {
    const journalContent = '# Journal\n\n#log\nDid stuff';
    mockReadVaultFile.mockReturnValue(journalContent);
    mockParseTag.mockReturnValue(null);

    await handlePriorities(mockBot, chatId);

    expect(mockParseTag).toHaveBeenCalledWith(journalContent, 'priorities');
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      "No #priorities tagged in yesterday's journal.",
    );
  });

  it('sends "No journal entry" when file content is empty string', async () => {
    mockReadVaultFile.mockReturnValue('');

    await handlePriorities(mockBot, chatId);

    expect(mockParseTag).not.toHaveBeenCalled();
    expect(mockBot.sendMessage).toHaveBeenCalledWith(chatId, 'No journal entry from yesterday.');
  });

  it('sends error message when an exception is thrown', async () => {
    mockReadVaultFile.mockImplementation(() => {
      throw new Error('disk read failed');
    });

    await handlePriorities(mockBot, chatId);

    expect(mockBot.sendMessage).toHaveBeenCalledWith(chatId, 'Error: disk read failed');
  });
});
