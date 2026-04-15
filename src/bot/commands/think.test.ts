import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStartReview = vi.fn<() => Promise<void>>();
const mockSetThinkTopic = vi.fn();
const mockGetTodayDate = vi.fn(() => '2026-04-14');

vi.mock('../../reviews/orchestrator.js', () => ({
  startReview: mockStartReview,
}));

vi.mock('../../reviews/think.js', () => ({
  setThinkTopic: mockSetThinkTopic,
}));

vi.mock('../../utils/time.js', () => ({
  getTodayDate: mockGetTodayDate,
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { handleThink } = await import('./think.js');

function mockBot() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

const CHAT_ID = 100;

describe('handleThink', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows usage when no topic provided', async () => {
    const bot = mockBot();

    await handleThink(bot, CHAT_ID, '');

    expect(bot.sendMessage).toHaveBeenCalledWith(CHAT_ID, 'Usage: /think <topic>');
    expect(mockStartReview).not.toHaveBeenCalled();
    expect(mockSetThinkTopic).not.toHaveBeenCalled();
  });

  it('sets topic and calls startReview with correct args', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const bot = mockBot();

    await handleThink(bot, CHAT_ID, 'career next steps');

    expect(mockSetThinkTopic).toHaveBeenCalledWith('career next steps');
    expect(mockStartReview).toHaveBeenCalledOnce();
    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'think', '2026-04-14', bot);
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('passes topic text correctly', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const bot = mockBot();

    await handleThink(bot, CHAT_ID, 'should I switch to Rust?');

    expect(mockSetThinkTopic).toHaveBeenCalledWith('should I switch to Rust?');
    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'think', '2026-04-14', bot);
  });
});
