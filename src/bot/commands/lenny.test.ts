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

const { handleLenny } = await import('./lenny.js');

describe('handleLenny', () => {
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
    await handleLenny(mockBot, chatId, '');

    expect(mockBot.sendMessage).toHaveBeenCalledWith(chatId, 'Usage: /lenny <topic>');
    expect(mockSearchVault).not.toHaveBeenCalled();
    expect(mockStartTyping).not.toHaveBeenCalled();
  });

  it('returns "no matches" when searchVault returns empty array', async () => {
    mockSearchVault.mockReturnValue([]);

    await handleLenny(mockBot, chatId, 'product-market fit');

    expect(mockSearchVault).toHaveBeenCalledWith('product-market fit', {
      directory: 'library/lennys-podcast',
      maxResults: 15,
    });
    expect(mockStopTyping).toHaveBeenCalledWith(typingHandle);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      'No matches for "product-market fit" in Lenny\'s Podcast transcripts.',
    );
    expect(mockAskClaudeOneShot).not.toHaveBeenCalled();
  });

  it('calls askClaudeOneShot with search results as context when matches found', async () => {
    const searchResults = [
      { file: 'ep-101.md', content: 'Growth is about retention' },
      { file: 'ep-205.md', content: 'Metrics that matter for growth' },
    ];
    mockSearchVault.mockReturnValue(searchResults);
    mockAskClaudeOneShot.mockResolvedValue({ text: 'Key insights on growth...', error: null });

    await handleLenny(mockBot, chatId, 'growth');

    expect(mockAskClaudeOneShot).toHaveBeenCalledWith(
      expect.stringContaining('Search Lenny\'s Podcast transcripts for insights on: growth'),
    );
    expect(mockAskClaudeOneShot).toHaveBeenCalledWith(
      expect.stringContaining('[ep-101.md] Growth is about retention'),
    );
    expect(mockAskClaudeOneShot).toHaveBeenCalledWith(
      expect.stringContaining('[ep-205.md] Metrics that matter for growth'),
    );
    expect(mockAskClaudeOneShot).toHaveBeenCalledWith(
      expect.stringContaining('2 matches'),
    );
  });

  it('sends synthesized response via sendLongMessage', async () => {
    const searchResults = [
      { file: 'ep-101.md', content: 'Growth is about retention' },
    ];
    mockSearchVault.mockReturnValue(searchResults);
    mockAskClaudeOneShot.mockResolvedValue({ text: 'Synthesized insights here', error: null });

    await handleLenny(mockBot, chatId, 'growth');

    expect(mockStopTyping).toHaveBeenCalledWith(typingHandle);
    expect(mockSendLongMessage).toHaveBeenCalledWith(mockBot, chatId, 'Synthesized insights here');
  });

  it('handles Claude error gracefully', async () => {
    mockSearchVault.mockReturnValue([{ file: 'ep-1.md', content: 'some content' }]);
    mockAskClaudeOneShot.mockResolvedValue({ text: null, error: 'Claude is unavailable' });

    await handleLenny(mockBot, chatId, 'hiring');

    expect(mockStopTyping).toHaveBeenCalledWith(typingHandle);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(chatId, 'Error: Claude is unavailable');
    expect(mockSendLongMessage).not.toHaveBeenCalled();
  });

  it('sends fallback text when Claude returns no text and no error', async () => {
    mockSearchVault.mockReturnValue([{ file: 'ep-1.md', content: 'some content' }]);
    mockAskClaudeOneShot.mockResolvedValue({ text: null, error: null });

    await handleLenny(mockBot, chatId, 'hiring');

    expect(mockSendLongMessage).toHaveBeenCalledWith(mockBot, chatId, 'No synthesis generated.');
  });

  it('handles exceptions with error message', async () => {
    mockSearchVault.mockImplementation(() => {
      throw new Error('ripgrep not found');
    });

    await handleLenny(mockBot, chatId, 'onboarding');

    expect(mockStopTyping).toHaveBeenCalledWith(typingHandle);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(chatId, 'Error: ripgrep not found');
  });
});
