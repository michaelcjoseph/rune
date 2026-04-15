import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadVaultFile = vi.fn();
const mockGetRecentFilenames = vi.fn();

vi.mock('../../vault/files.js', () => ({
  readVaultFile: mockReadVaultFile,
}));

vi.mock('../../utils/time.js', () => ({
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

const { handleFamily } = await import('./family.js');

describe('handleFamily', () => {
  const mockBot = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
  const chatId = 123;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRecentFilenames.mockReturnValue(['2026_04_14.md', '2026_04_13.md', '2026_04_12.md']);
  });

  it('returns mention counts when both names appear in journals', async () => {
    mockReadVaultFile
      .mockReturnValueOnce('Took Sam to school. Jude had soccer practice.')
      .mockReturnValueOnce('Sam and Jude played together.')
      .mockReturnValueOnce('Jude napped all afternoon.');

    await handleFamily(mockBot, chatId);

    const msg = mockBot.sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain('Sam: 2 mentions across 2 days');
    expect(msg).toContain('Jude: 3 mentions across 3 days');
  });

  it('flags imbalance when one name has 2x+ more mentions', async () => {
    mockReadVaultFile
      .mockReturnValueOnce('Jude Jude Jude Jude')
      .mockReturnValueOnce('Jude Jude Sam')
      .mockReturnValueOnce(null);

    await handleFamily(mockBot, chatId);

    const msg = mockBot.sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain('Imbalance');
    expect(msg).toContain('Jude');
    expect(msg).toMatch(/\d+\.\dx more than Sam/);
  });

  it('does not flag imbalance when ratio is below 2x', async () => {
    mockReadVaultFile
      .mockReturnValueOnce('Sam Sam Sam')
      .mockReturnValueOnce('Jude Jude')
      .mockReturnValueOnce(null);

    await handleFamily(mockBot, chatId);

    const msg = mockBot.sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain('Sam: 3 mentions');
    expect(msg).toContain('Jude: 2 mentions');
    expect(msg).not.toContain('Imbalance');
  });

  it('returns "No mentions" when no journals contain either name', async () => {
    mockReadVaultFile
      .mockReturnValueOnce('Nothing interesting today.')
      .mockReturnValueOnce('Went to the store.')
      .mockReturnValueOnce('Read a book.');

    await handleFamily(mockBot, chatId);

    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      'No mentions of Sam or Jude in the last 14 days.',
    );
  });

  it('handles missing journal files (readVaultFile returns null)', async () => {
    mockReadVaultFile
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('Sam had a great day.');

    await handleFamily(mockBot, chatId);

    const msg = mockBot.sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain('Sam: 1 mention across 1 day');
    expect(msg).toContain('Jude: 0 mentions across 0 days');
  });

  it('counts word-boundary matches only (e.g. "Samantha" does not match "Sam")', async () => {
    mockReadVaultFile
      .mockReturnValueOnce('Samantha came over. Sam stayed home.')
      .mockReturnValueOnce('Judean hills are pretty. Jude played outside.')
      .mockReturnValueOnce(null);

    await handleFamily(mockBot, chatId);

    const msg = mockBot.sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain('Sam: 1 mention across 1 day');
    expect(msg).toContain('Jude: 1 mention across 1 day');
  });

  it('sends error message when an exception is thrown', async () => {
    mockGetRecentFilenames.mockImplementation(() => {
      throw new Error('time exploded');
    });

    await handleFamily(mockBot, chatId);

    expect(mockBot.sendMessage).toHaveBeenCalledWith(chatId, 'Error: time exploded');
  });
});
