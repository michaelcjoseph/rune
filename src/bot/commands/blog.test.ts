import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStartReview = vi.fn<() => Promise<void>>();
const mockGetTodayDate = vi.fn(() => '2026-04-14');

vi.mock('../../reviews/orchestrator.js', () => ({
  startReview: mockStartReview,
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

// Mock the side-effect import that registers the blog review handler;
// without this, importing blog.ts pulls in reviews/blog.ts → reviews/session.ts
// → config.ts, which throws on missing TELEGRAM_BOT_TOKEN in test environments.
vi.mock('../../reviews/blog.js', () => ({}));

const { handleBlog } = await import('./blog.js');

function mockBot() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

const CHAT_ID = 100;

describe('handleBlog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows usage when no topic provided', async () => {
    const bot = mockBot();

    await handleBlog(bot, CHAT_ID, '');

    expect(bot.sendMessage).toHaveBeenCalledWith(CHAT_ID, 'Usage: /blog <topic>');
    expect(mockStartReview).not.toHaveBeenCalled();
  });

  it('sets topic and calls startReview with correct args', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const bot = mockBot();

    await handleBlog(bot, CHAT_ID, 'why testing matters');

    expect(mockStartReview).toHaveBeenCalledOnce();
    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'blog', '2026-04-14', bot, 'why testing matters');
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });
});
