import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('./orchestrator.js', () => ({
  registerReviewHandler: vi.fn(),
}));

vi.mock('./session.js', () => ({
  updateReviewSession: vi.fn(),
  deleteReviewSession: vi.fn(),
}));

vi.mock('../ai/claude.js', () => ({
  askClaudeWithContext: vi.fn(),
}));

vi.mock('../vault/files.js', () => ({
  readVaultFile: vi.fn(),
}));

vi.mock('../integrations/telegram/client.js', () => ({
  sendLongMessage: vi.fn().mockResolvedValue(undefined),
  startTyping: vi.fn().mockReturnValue('typing-handle'),
  stopTyping: vi.fn(),
}));

// --- Imports ---

const { registerReviewHandler } = await import('./orchestrator.js');
const { updateReviewSession } = await import('./session.js');
const { askClaudeWithContext } = await import('../ai/claude.js');
const { readVaultFile } = await import('../vault/files.js');
const { sendLongMessage, startTyping, stopTyping } = await import('../integrations/telegram/client.js');

const registerMock = registerReviewHandler as ReturnType<typeof vi.fn>;
const updateSessionMock = updateReviewSession as ReturnType<typeof vi.fn>;
const askClaudeMock = askClaudeWithContext as ReturnType<typeof vi.fn>;
const readVaultMock = readVaultFile as ReturnType<typeof vi.fn>;
const sendLongMock = sendLongMessage as ReturnType<typeof vi.fn>;
const startTypingMock = startTyping as ReturnType<typeof vi.fn>;
const stopTypingMock = stopTyping as ReturnType<typeof vi.fn>;

// Import module under test (triggers registerReviewHandler side effect)
const { setThinkTopic } = await import('./think.js');

// Capture registration call before beforeEach clears mocks
const registrationCalls = [...registerMock.mock.calls];
const thinkHandler = registrationCalls[0]?.[1];

import type { ReviewSession } from './session.js';

// --- Helpers ---

function makeSession(overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    id: 'sess-think-001',
    chatId: 100,
    type: 'think',
    targetDate: '2026-04-14',
    phase: 'prep',
    claudeSessionId: 'claude-think-001',
    prepContext: null,
    outline: null,
    createdAt: '2026-04-14T08:00:00',
    lastActivity: '2026-04-14T08:00:00',
    ...overrides,
  };
}

function makeBot() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

// --- Tests ---

describe('reviews/think', () => {
  let bot: ReturnType<typeof makeBot>;

  beforeEach(() => {
    vi.clearAllMocks();
    bot = makeBot();
    startTypingMock.mockReturnValue('typing-handle');
  });

  describe('registration', () => {
    it('calls registerReviewHandler with "think" at import time', () => {
      expect(registrationCalls).toEqual([['think', thinkHandler]]);
    });
  });

  describe('start', () => {
    it('reads skill file and sends first message via askClaudeWithContext', async () => {
      const session = makeSession();
      setThinkTopic('career planning');
      readVaultMock.mockReturnValue('Custom skill instructions here');
      askClaudeMock.mockResolvedValue({ text: 'What aspects of your career are you thinking about?', error: null });

      await thinkHandler.start(session, bot);

      expect(readVaultMock).toHaveBeenCalledWith('.claude/skills/think/SKILL.md');
      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Thinking session started: "career planning"\nSend /done when finished.');
      expect(startTypingMock).toHaveBeenCalledWith(bot, 100);
      expect(askClaudeMock).toHaveBeenCalledWith(
        'I want to think through: career planning',
        'claude-think-001',
        expect.stringContaining('Custom skill instructions here'),
      );
      expect(stopTypingMock).toHaveBeenCalledWith('typing-handle');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'interview' });
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, 'What aspects of your career are you thinking about?');
    });

    it('uses default instructions when skill file is missing', async () => {
      const session = makeSession();
      setThinkTopic('productivity systems');
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'Tell me more about what you mean.', error: null });

      await thinkHandler.start(session, bot);

      expect(askClaudeMock).toHaveBeenCalledWith(
        'I want to think through: productivity systems',
        'claude-think-001',
        expect.stringContaining('Help me think through this'),
      );
      expect(askClaudeMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.stringContaining('Ask more than tell'),
      );
    });

    it('handles Claude error on start', async () => {
      const session = makeSession();
      setThinkTopic('test topic');
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: null, error: 'Claude unavailable' });

      await thinkHandler.start(session, bot);

      expect(stopTypingMock).toHaveBeenCalledWith('typing-handle');
      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Failed to start thinking session: Claude unavailable');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
    });
  });

  describe('handleMessage', () => {
    it('forwards messages to Claude with system prompt', async () => {
      // First start a session to populate sessionPrompts
      const session = makeSession();
      setThinkTopic('test topic');
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'Initial response', error: null });
      await thinkHandler.start(session, bot);

      vi.clearAllMocks();
      startTypingMock.mockReturnValue('typing-handle');
      askClaudeMock.mockResolvedValue({ text: 'Good point, what about X?', error: null });

      await thinkHandler.handleMessage(session, 'I think the key issue is Y', bot);

      expect(startTypingMock).toHaveBeenCalledWith(bot, session.chatId);
      expect(askClaudeMock).toHaveBeenCalledWith(
        'I think the key issue is Y',
        'claude-think-001',
        expect.stringContaining('test topic'),
      );
      expect(stopTypingMock).toHaveBeenCalledWith('typing-handle');
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, 'Good point, what about X?');
    });

    it('ends the session on /done', async () => {
      // Start a session first
      const session = makeSession();
      setThinkTopic('wrap up topic');
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'Initial', error: null });
      await thinkHandler.start(session, bot);

      vi.clearAllMocks();

      await thinkHandler.handleMessage(session, '/done', bot);

      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Thinking session ended.');
      expect(askClaudeMock).not.toHaveBeenCalled();
    });

    it('handles missing system prompt gracefully', async () => {
      // Create a session with a claudeSessionId that has no stored prompt
      const session = makeSession({ claudeSessionId: 'unknown-session-id' });

      await thinkHandler.handleMessage(session, 'hello', bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Session context lost. Start a new /think session.');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
      expect(askClaudeMock).not.toHaveBeenCalled();
    });
  });
});
