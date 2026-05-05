import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

const mockReadVaultFile = vi.fn();
const mockGetRecentFilenames = vi.fn();

vi.mock('../../config.js', () => ({
  default: { FAMILY_NAMES: ['Alice', 'Bob'] },
}));

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

const config = (await import('../../config.js')).default as { FAMILY_NAMES: string[] };
const { handleFamily } = await import('./family.js');

describe('handleFamily', () => {
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
    config.FAMILY_NAMES = ['Alice', 'Bob'];
    mockGetRecentFilenames.mockReturnValue(['2026_04_14.md', '2026_04_13.md', '2026_04_12.md']);
  });

  it('returns mention counts when both names appear in journals', async () => {
    mockReadVaultFile
      .mockReturnValueOnce('Took Alice to school. Bob had soccer practice.')
      .mockReturnValueOnce('Alice and Bob played together.')
      .mockReturnValueOnce('Bob napped all afternoon.');

    const sender = makeSender();
    await handleFamily(sender, chatId);

    const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(msg).toContain('Alice: 2 mentions across 2 days');
    expect(msg).toContain('Bob: 3 mentions across 3 days');
  });

  it('flags imbalance when one name has 2x+ more mentions', async () => {
    mockReadVaultFile
      .mockReturnValueOnce('Bob Bob Bob Bob')
      .mockReturnValueOnce('Bob Bob Alice')
      .mockReturnValueOnce(null);

    const sender = makeSender();
    await handleFamily(sender, chatId);

    const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(msg).toContain('Imbalance');
    expect(msg).toContain('Bob');
    expect(msg).toMatch(/\d+\.\dx more than Alice/);
  });

  it('does not flag imbalance when ratio is below 2x', async () => {
    mockReadVaultFile
      .mockReturnValueOnce('Alice Alice Alice')
      .mockReturnValueOnce('Bob Bob')
      .mockReturnValueOnce(null);

    const sender = makeSender();
    await handleFamily(sender, chatId);

    const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(msg).toContain('Alice: 3 mentions');
    expect(msg).toContain('Bob: 2 mentions');
    expect(msg).not.toContain('Imbalance');
  });

  it('returns "No mentions" when no journals contain either name', async () => {
    mockReadVaultFile
      .mockReturnValueOnce('Nothing interesting today.')
      .mockReturnValueOnce('Went to the store.')
      .mockReturnValueOnce('Read a book.');

    const sender = makeSender();
    await handleFamily(sender, chatId);

    expect(sender.send).toHaveBeenCalledWith(
      chatId,
      'No mentions of Alice or Bob in the last 14 days.',
    );
  });

  it('handles missing journal files (readVaultFile returns null)', async () => {
    mockReadVaultFile
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('Alice had a great day.');

    const sender = makeSender();
    await handleFamily(sender, chatId);

    const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(msg).toContain('Alice: 1 mention across 1 day');
    expect(msg).toContain('Bob: 0 mentions across 0 days');
  });

  it('counts word-boundary matches only (e.g. longer names do not match shorter ones)', async () => {
    mockReadVaultFile
      .mockReturnValueOnce('Alicia came over. Alice stayed home.')
      .mockReturnValueOnce('Bobby played outside. Bob read a book.')
      .mockReturnValueOnce(null);

    const sender = makeSender();
    await handleFamily(sender, chatId);

    const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(msg).toContain('Alice: 1 mention across 1 day');
    expect(msg).toContain('Bob: 1 mention across 1 day');
  });

  it('sends error message when an exception is thrown', async () => {
    mockGetRecentFilenames.mockImplementation(() => {
      throw new Error('time exploded');
    });

    const sender = makeSender();
    await handleFamily(sender, chatId);

    expect(sender.send).toHaveBeenCalledWith(chatId, 'Error: time exploded');
  });

  it('prompts to configure FAMILY_NAMES when the env var is empty', async () => {
    config.FAMILY_NAMES = [];

    const sender = makeSender();
    await handleFamily(sender, chatId);

    const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(msg).toContain('FAMILY_NAMES');
    expect(mockGetRecentFilenames).not.toHaveBeenCalled();
  });

  it('skips imbalance heuristic when != 2 names are configured', async () => {
    config.FAMILY_NAMES = ['Alice', 'Bob', 'Carol'];
    mockReadVaultFile
      .mockReturnValueOnce('Alice Alice Alice Alice Alice')
      .mockReturnValueOnce('Bob')
      .mockReturnValueOnce('Carol Carol');

    const sender = makeSender();
    await handleFamily(sender, chatId);

    const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(msg).toContain('Alice: 5 mentions');
    expect(msg).toContain('Bob: 1 mention');
    expect(msg).toContain('Carol: 2 mentions');
    expect(msg).not.toContain('Imbalance');
  });
});
