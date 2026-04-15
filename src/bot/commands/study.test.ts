import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadVaultFile = vi.fn();

vi.mock('../../vault/files.js', () => ({
  readVaultFile: mockReadVaultFile,
}));

const mockSendLongMessage = vi.fn();

vi.mock('../../integrations/telegram/client.js', () => ({
  sendLongMessage: mockSendLongMessage,
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { handleStudy } = await import('./study.js');

describe('handleStudy', () => {
  const mockBot = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
  const chatId = 123;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns both progress and syllabus when both files exist', async () => {
    const syllabus = '# CS101\n\n- Chapter 1\n- Chapter 2';
    const progress = '{"completed": 3, "total": 10, "current": "Chapter 4"}';

    mockReadVaultFile.mockImplementation((path: string) => {
      if (path === 'study/syllabus.md') return syllabus;
      if (path === 'study/progress.json') return progress;
      return null;
    });

    await handleStudy(mockBot, chatId);

    expect(mockReadVaultFile).toHaveBeenCalledWith('study/syllabus.md');
    expect(mockReadVaultFile).toHaveBeenCalledWith('study/progress.json');
    expect(mockSendLongMessage).toHaveBeenCalledWith(
      mockBot,
      chatId,
      'Progress: completed: 3 | total: 10 | current: Chapter 4\n\n# CS101\n\n- Chapter 1\n- Chapter 2',
    );
  });

  it('returns only progress when syllabus is missing', async () => {
    const progress = '{"completed": 3, "total": 10}';

    mockReadVaultFile.mockImplementation((path: string) => {
      if (path === 'study/syllabus.md') return null;
      if (path === 'study/progress.json') return progress;
      return null;
    });

    await handleStudy(mockBot, chatId);

    expect(mockSendLongMessage).toHaveBeenCalledWith(
      mockBot,
      chatId,
      'Progress: completed: 3 | total: 10',
    );
  });

  it('returns only syllabus when progress.json is missing', async () => {
    const syllabus = '# CS101\n\n- Chapter 1';

    mockReadVaultFile.mockImplementation((path: string) => {
      if (path === 'study/syllabus.md') return syllabus;
      if (path === 'study/progress.json') return null;
      return null;
    });

    await handleStudy(mockBot, chatId);

    expect(mockSendLongMessage).toHaveBeenCalledWith(
      mockBot,
      chatId,
      '# CS101\n\n- Chapter 1',
    );
  });

  it('returns "No study data found" when both files are missing', async () => {
    mockReadVaultFile.mockReturnValue(null);

    await handleStudy(mockBot, chatId);

    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      'No study data found (study/syllabus.md and study/progress.json missing).',
    );
  });

  it('returns "No study data found" when both files are empty', async () => {
    mockReadVaultFile.mockReturnValue('   ');

    await handleStudy(mockBot, chatId);

    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      'No study data found (study/syllabus.md and study/progress.json missing).',
    );
  });

  it('handles malformed JSON in progress.json gracefully by falling back to raw text', async () => {
    const malformedJson = '{not valid json';

    mockReadVaultFile.mockImplementation((path: string) => {
      if (path === 'study/syllabus.md') return null;
      if (path === 'study/progress.json') return malformedJson;
      return null;
    });

    await handleStudy(mockBot, chatId);

    expect(mockSendLongMessage).toHaveBeenCalledWith(
      mockBot,
      chatId,
      'Progress: {not valid json',
    );
  });

  it('sends error message when an exception is thrown', async () => {
    mockReadVaultFile.mockImplementation(() => {
      throw new Error('disk read failed');
    });

    await handleStudy(mockBot, chatId);

    expect(mockBot.sendMessage).toHaveBeenCalledWith(chatId, 'Error: disk read failed');
  });
});
