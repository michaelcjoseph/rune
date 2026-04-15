import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSearchVault = vi.fn();
const mockAskClaudeOneShot = vi.fn();
const mockSendLongMessage = vi.fn();
const mockStartTyping = vi.fn();
const mockStopTyping = vi.fn();

vi.mock('../../kb/search.js', () => ({
  searchVault: mockSearchVault,
}));

vi.mock('../../ai/claude.js', () => ({
  askClaudeOneShot: mockAskClaudeOneShot,
}));

vi.mock('../../integrations/telegram/client.js', () => ({
  sendLongMessage: mockSendLongMessage,
  startTyping: mockStartTyping,
  stopTyping: mockStopTyping,
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { handlePG } = await import('./pg.js');

describe('handlePG', () => {
  const mockBot = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
  const chatId = 123;
  const typingHandle = { stop: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mockStartTyping.mockReturnValue(typingHandle);
    mockSendLongMessage.mockResolvedValue(undefined);
  });

  it('shows usage when no topic provided', async () => {
    await handlePG(mockBot, chatId, '');

    expect(mockBot.sendMessage).toHaveBeenCalledWith(chatId, 'Usage: /pg <topic>');
    expect(mockSearchVault).not.toHaveBeenCalled();
    expect(mockStartTyping).not.toHaveBeenCalled();
  });

  it('returns "no matches" when searchVault returns empty array', async () => {
    mockSearchVault.mockReturnValue([]);

    await handlePG(mockBot, chatId, 'startups');

    expect(mockSearchVault).toHaveBeenCalledWith('startups', {
      directory: 'library/graham-essays',
      maxResults: 15,
    });
    expect(mockStopTyping).toHaveBeenCalledWith(typingHandle);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      'No matches for "startups" in Paul Graham\'s essays.',
    );
    expect(mockAskClaudeOneShot).not.toHaveBeenCalled();
  });

  it('calls askClaudeOneShot with search results as context when matches found', async () => {
    const searchResults = [
      { file: 'do-things-that-dont-scale.md', content: 'The most common unscalable thing founders do' },
      { file: 'how-to-get-startup-ideas.md', content: 'The way to get startup ideas is to look for problems' },
    ];
    mockSearchVault.mockReturnValue(searchResults);
    mockAskClaudeOneShot.mockResolvedValue({ text: 'Key insights on startups...', error: null });

    await handlePG(mockBot, chatId, 'startups');

    expect(mockAskClaudeOneShot).toHaveBeenCalledWith(
      expect.stringContaining('Search Paul Graham\'s essays for insights on: startups'),
    );
    expect(mockAskClaudeOneShot).toHaveBeenCalledWith(
      expect.stringContaining('[do-things-that-dont-scale.md] The most common unscalable thing founders do'),
    );
    expect(mockAskClaudeOneShot).toHaveBeenCalledWith(
      expect.stringContaining('[how-to-get-startup-ideas.md] The way to get startup ideas is to look for problems'),
    );
    expect(mockAskClaudeOneShot).toHaveBeenCalledWith(
      expect.stringContaining('2 matches'),
    );
  });

  it('sends synthesized response via sendLongMessage', async () => {
    const searchResults = [
      { file: 'essay.md', content: 'Great hackers tend to clump together' },
    ];
    mockSearchVault.mockReturnValue(searchResults);
    mockAskClaudeOneShot.mockResolvedValue({ text: 'Synthesized insights here', error: null });

    await handlePG(mockBot, chatId, 'hackers');

    expect(mockStopTyping).toHaveBeenCalledWith(typingHandle);
    expect(mockSendLongMessage).toHaveBeenCalledWith(mockBot, chatId, 'Synthesized insights here');
  });

  it('handles Claude error gracefully', async () => {
    mockSearchVault.mockReturnValue([{ file: 'essay.md', content: 'some content' }]);
    mockAskClaudeOneShot.mockResolvedValue({ text: null, error: 'Claude is unavailable' });

    await handlePG(mockBot, chatId, 'wealth');

    expect(mockStopTyping).toHaveBeenCalledWith(typingHandle);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(chatId, 'Error: Claude is unavailable');
    expect(mockSendLongMessage).not.toHaveBeenCalled();
  });

  it('sends fallback text when Claude returns no text and no error', async () => {
    mockSearchVault.mockReturnValue([{ file: 'essay.md', content: 'some content' }]);
    mockAskClaudeOneShot.mockResolvedValue({ text: null, error: null });

    await handlePG(mockBot, chatId, 'wealth');

    expect(mockSendLongMessage).toHaveBeenCalledWith(mockBot, chatId, 'No synthesis generated.');
  });

  it('handles exceptions with error message', async () => {
    mockSearchVault.mockImplementation(() => {
      throw new Error('ripgrep not found');
    });

    await handlePG(mockBot, chatId, 'essays');

    expect(mockStopTyping).toHaveBeenCalledWith(typingHandle);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(chatId, 'Error: ripgrep not found');
  });
});
