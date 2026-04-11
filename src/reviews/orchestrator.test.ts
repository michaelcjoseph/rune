import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the session module
vi.mock('./session.js', () => ({
  createReviewSession: vi.fn(),
  getActiveReviewSession: vi.fn(),
  deleteReviewSession: vi.fn(),
}));

// Mock the logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { createReviewSession, getActiveReviewSession, deleteReviewSession } = await import('./session.js');
const { registerReviewHandler, startReview, handleReviewMessage, hasActiveReview } = await import('./orchestrator.js');

import type { ReviewTypeHandler } from './orchestrator.js';
import type { ReviewSession } from './session.js';

const createMock = createReviewSession as ReturnType<typeof vi.fn>;
const getActiveMock = getActiveReviewSession as ReturnType<typeof vi.fn>;
const deleteMock = deleteReviewSession as ReturnType<typeof vi.fn>;

function makeFakeSession(overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    id: 'sess-001',
    chatId: 100,
    type: 'daily',
    targetDate: '2026-04-10',
    phase: 'prep',
    claudeSessionId: 'claude-001',
    prepContext: null,
    outline: null,
    createdAt: '2026-04-10T08:00:00',
    lastActivity: '2026-04-10T08:00:00',
    ...overrides,
  };
}

function makeFakeBot() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

describe('reviews/orchestrator', () => {
  let bot: ReturnType<typeof makeFakeBot>;

  beforeEach(() => {
    vi.clearAllMocks();
    bot = makeFakeBot();
  });

  describe('registerReviewHandler', () => {
    it('adds a handler to the registry so startReview can use it', async () => {
      const handler: ReviewTypeHandler = {
        start: vi.fn().mockResolvedValue(undefined),
        handleMessage: vi.fn().mockResolvedValue(undefined),
      };
      const session = makeFakeSession({ type: 'weekly' });
      getActiveMock.mockReturnValue(null);
      createMock.mockReturnValue(session);

      registerReviewHandler('weekly', handler);
      await startReview(100, 'weekly', '2026-04-07', bot);

      expect(handler.start).toHaveBeenCalledWith(session, bot);
    });
  });

  describe('startReview', () => {
    it('creates a session and calls handler.start', async () => {
      const handler: ReviewTypeHandler = {
        start: vi.fn().mockResolvedValue(undefined),
        handleMessage: vi.fn().mockResolvedValue(undefined),
      };
      const session = makeFakeSession({ type: 'daily' });
      getActiveMock.mockReturnValue(null);
      createMock.mockReturnValue(session);

      registerReviewHandler('daily', handler);
      await startReview(100, 'daily', '2026-04-10', bot);

      expect(createMock).toHaveBeenCalledWith(100, 'daily', '2026-04-10');
      expect(handler.start).toHaveBeenCalledWith(session, bot);
    });

    it('sends error message if no handler registered and does NOT create a session', async () => {
      // 'yearly' has no registered handler
      await startReview(100, 'yearly', '2026-01-01', bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Review type "yearly" is not yet implemented.');
      expect(createMock).not.toHaveBeenCalled();
    });

    it('notifies user when cancelling an active review to start a new one', async () => {
      const handler: ReviewTypeHandler = {
        start: vi.fn().mockResolvedValue(undefined),
        handleMessage: vi.fn().mockResolvedValue(undefined),
      };
      const existingSession = makeFakeSession({ type: 'daily' });
      const newSession = makeFakeSession({ type: 'daily', id: 'sess-002' });
      getActiveMock.mockReturnValue(existingSession);
      createMock.mockReturnValue(newSession);

      registerReviewHandler('daily', handler);
      await startReview(100, 'daily', '2026-04-10', bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(
        100,
        'Cancelling your in-progress daily review to start a new one.',
      );
      expect(createMock).toHaveBeenCalled();
      expect(handler.start).toHaveBeenCalled();
    });

    it('deletes session and sends error if handler.start throws', async () => {
      const handler: ReviewTypeHandler = {
        start: vi.fn().mockRejectedValue(new Error('prep failed')),
        handleMessage: vi.fn().mockResolvedValue(undefined),
      };
      const session = makeFakeSession({ type: 'daily' });
      getActiveMock.mockReturnValue(null);
      createMock.mockReturnValue(session);

      registerReviewHandler('daily', handler);
      await startReview(100, 'daily', '2026-04-10', bot);

      expect(deleteMock).toHaveBeenCalledWith(100);
      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Error starting daily review: prep failed');
    });
  });

  describe('handleReviewMessage', () => {
    it('dispatches to the correct handler', async () => {
      const handler: ReviewTypeHandler = {
        start: vi.fn().mockResolvedValue(undefined),
        handleMessage: vi.fn().mockResolvedValue(undefined),
      };
      const session = makeFakeSession({ type: 'daily', phase: 'interview' });
      getActiveMock.mockReturnValue(session);

      registerReviewHandler('daily', handler);
      await handleReviewMessage(100, 'my response', bot);

      expect(handler.handleMessage).toHaveBeenCalledWith(session, 'my response', bot);
    });

    it('does nothing if no active session', async () => {
      getActiveMock.mockReturnValue(null);

      await handleReviewMessage(100, 'hello', bot);

      expect(bot.sendMessage).not.toHaveBeenCalled();
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it('deletes session if handler is missing for the session type', async () => {
      const session = makeFakeSession({ type: 'quarterly' });
      getActiveMock.mockReturnValue(session);
      // No handler registered for 'quarterly' in this context — clear any previous
      // We need a type that definitely has no handler. Use a fresh import approach.
      // Since 'quarterly' was never registered in these tests, it should work.

      await handleReviewMessage(100, 'hello', bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Review type "quarterly" handler is missing.');
      expect(deleteMock).toHaveBeenCalledWith(100);
    });

    it('sends error but keeps session if handler.handleMessage throws', async () => {
      const handler: ReviewTypeHandler = {
        start: vi.fn().mockResolvedValue(undefined),
        handleMessage: vi.fn().mockRejectedValue(new Error('something broke')),
      };
      const session = makeFakeSession({ type: 'monthly', phase: 'interview' });
      getActiveMock.mockReturnValue(session);

      registerReviewHandler('monthly', handler);
      await handleReviewMessage(100, 'my input', bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Error during monthly review: something broke');
      expect(deleteMock).not.toHaveBeenCalled();
    });
  });

  describe('hasActiveReview', () => {
    it('returns true when there is an active session', () => {
      getActiveMock.mockReturnValue(makeFakeSession());
      expect(hasActiveReview(100)).toBe(true);
    });

    it('returns false when there is no active session', () => {
      getActiveMock.mockReturnValue(null);
      expect(hasActiveReview(100)).toBe(false);
    });
  });
});
