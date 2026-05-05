import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

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

function makeSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

const CHAT_ID = 100;

describe('handleBlog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows usage when no topic provided', async () => {
    const sender = makeSender();

    await handleBlog(sender, CHAT_ID, '');

    expect(sender.send).toHaveBeenCalledWith(CHAT_ID, 'Usage: /blog <topic>');
    expect(mockStartReview).not.toHaveBeenCalled();
  });

  it('sets topic and calls startReview with correct args', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const sender = makeSender();

    await handleBlog(sender, CHAT_ID, 'why testing matters');

    expect(mockStartReview).toHaveBeenCalledOnce();
    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'blog', '2026-04-14', sender, 'why testing matters');
    expect(sender.send).not.toHaveBeenCalled();
  });
});
