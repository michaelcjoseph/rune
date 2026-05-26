import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockGetActiveReviewSession = vi.fn();
const mockDeleteReviewSession = vi.fn();

vi.mock('../../reviews/session.js', () => ({
  getActiveReviewSession: mockGetActiveReviewSession,
  deleteReviewSession: mockDeleteReviewSession,
}));

const { handleCancelReview } = await import('./cancel-review.js');

function mockSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-uuid',
    chatId: 42,
    type: 'weekly',
    targetDate: '2026-05-22',
    phase: 'interview',
    claudeSessionId: 'claude-uuid',
    topic: null,
    prepContext: 'prep',
    outline: null,
    createdAt: '2026-05-23T02:46:40.000Z',
    lastActivity: '2026-05-23T02:49:26.000Z',
    ...overrides,
  };
}

describe('handleCancelReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveReviewSession.mockReturnValue(null);
  });

  it('sends "No active review." when no session exists', async () => {
    const sender = mockSender();
    await handleCancelReview(sender, 42);
    expect(sender.send).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledWith(42, 'No active review.');
    expect(mockDeleteReviewSession).not.toHaveBeenCalled();
  });

  it('calls deleteReviewSession with the userId when a session exists', async () => {
    mockGetActiveReviewSession.mockReturnValue(makeSession());
    await handleCancelReview(mockSender(), 42);
    expect(mockDeleteReviewSession).toHaveBeenCalledOnce();
    expect(mockDeleteReviewSession).toHaveBeenCalledWith(42);
  });

  it('confirms cancellation with type, targetDate, and phase', async () => {
    mockGetActiveReviewSession.mockReturnValue(makeSession({
      type: 'weekly',
      targetDate: '2026-05-22',
      phase: 'interview',
    }));
    const sender = mockSender();
    await handleCancelReview(sender, 42);
    const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(msg).toContain('weekly');
    expect(msg).toContain('2026-05-22');
    expect(msg).toContain('interview');
  });

  it('reads metadata before deletion so the confirmation is accurate', async () => {
    const session = makeSession({ type: 'monthly', targetDate: '2026-04-30', phase: 'outline' });
    mockGetActiveReviewSession.mockReturnValue(session);
    const sender = mockSender();
    await handleCancelReview(sender, 42);
    const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(msg).toContain('monthly');
    expect(msg).toContain('2026-04-30');
    expect(msg).toContain('outline');
  });

  it('passes the userId through as the review chatId', async () => {
    mockGetActiveReviewSession.mockReturnValue(makeSession());
    await handleCancelReview(mockSender(), 999);
    expect(mockGetActiveReviewSession).toHaveBeenCalledWith(999);
    expect(mockDeleteReviewSession).toHaveBeenCalledWith(999);
  });
});
