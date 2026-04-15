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
  onReviewSessionDeleted: vi.fn(),
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
await import('./health.js');

// Capture registration call before beforeEach clears mocks
const registrationCalls = [...registerMock.mock.calls];
const healthHandler = registrationCalls[0]?.[1];

import type { ReviewSession } from './session.js';

// --- Helpers ---

function makeSession(overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    id: 'sess-health-001',
    chatId: 100,
    type: 'health',
    targetDate: '2026-04-14',
    phase: 'prep',
    claudeSessionId: 'claude-health-001',
    topic: null,
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

describe('reviews/health', () => {
  let bot: ReturnType<typeof makeBot>;

  beforeEach(() => {
    vi.clearAllMocks();
    bot = makeBot();
    startTypingMock.mockReturnValue('typing-handle');
  });

  describe('registration', () => {
    it('calls registerReviewHandler with "health" at import time', () => {
      expect(registrationCalls).toEqual([['health', healthHandler]]);
    });
  });

  describe('start', () => {
    it('reads skill file and health context, sends first message', async () => {
      const session = makeSession({ topic: 'sleep optimization' });
      readVaultMock.mockImplementation((path: string) => {
        if (path === '.claude/skills/health/SKILL.md') return 'Custom health skill instructions';
        if (path === 'health/whoop/trends.md') return 'HRV trending up';
        if (path === 'health/plan.md') return 'PPL split, 4x/week';
        return null;
      });
      askClaudeMock.mockResolvedValue({ text: 'Let me look at your sleep data.', error: null });

      await healthHandler.start(session, bot);

      expect(readVaultMock).toHaveBeenCalledWith('.claude/skills/health/SKILL.md');
      expect(readVaultMock).toHaveBeenCalledWith('health/whoop/trends.md');
      expect(readVaultMock).toHaveBeenCalledWith('health/plan.md');
      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Health session started: "sleep optimization"\nSend /done when finished.');
      expect(startTypingMock).toHaveBeenCalledWith(bot, 100);
      expect(askClaudeMock).toHaveBeenCalledWith(
        'I want to discuss: sleep optimization',
        'claude-health-001',
        expect.stringContaining('Custom health skill instructions'),
      );
      expect(stopTypingMock).toHaveBeenCalledWith('typing-handle');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'interview' });
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, 'Let me look at your sleep data.');
    });

    it('uses default instructions when skill file is missing', async () => {
      const session = makeSession({ topic: 'nutrition' });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'What are your nutrition goals?', error: null });

      await healthHandler.start(session, bot);

      expect(askClaudeMock).toHaveBeenCalledWith(
        'I want to discuss: nutrition',
        'claude-health-001',
        expect.stringContaining('You are a health coach'),
      );
      expect(askClaudeMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.stringContaining('Ask clarifying questions before giving advice'),
      );
    });

    it('includes Whoop trends in system prompt when available', async () => {
      const session = makeSession({ topic: 'recovery' });
      readVaultMock.mockImplementation((path: string) => {
        if (path === 'health/whoop/trends.md') return 'Recovery score: 85%, HRV: 65ms';
        if (path === 'health/plan.md') return null;
        return null;
      });
      askClaudeMock.mockResolvedValue({ text: 'Your recovery looks good.', error: null });

      await healthHandler.start(session, bot);

      expect(askClaudeMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.stringContaining('Recovery score: 85%, HRV: 65ms'),
      );
      expect(askClaudeMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.stringContaining('Recent Health Trends'),
      );
    });

    it('handles Claude error on start', async () => {
      const session = makeSession({ topic: 'test' });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: null, error: 'Claude unavailable' });

      await healthHandler.start(session, bot);

      expect(stopTypingMock).toHaveBeenCalledWith('typing-handle');
      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Failed to start health session: Claude unavailable');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
    });
  });

  describe('handleMessage', () => {
    it('forwards messages to Claude with system prompt', async () => {
      // First start a session to populate sessionPrompts
      const session = makeSession({ topic: 'sleep' });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'Initial response', error: null });
      await healthHandler.start(session, bot);

      vi.clearAllMocks();
      startTypingMock.mockReturnValue('typing-handle');
      askClaudeMock.mockResolvedValue({ text: 'You should try magnesium before bed.', error: null });

      await healthHandler.handleMessage(session, 'I have trouble falling asleep', bot);

      expect(startTypingMock).toHaveBeenCalledWith(bot, session.chatId);
      expect(askClaudeMock).toHaveBeenCalledWith(
        'I have trouble falling asleep',
        'claude-health-001',
        expect.stringContaining('sleep'),
      );
      expect(stopTypingMock).toHaveBeenCalledWith('typing-handle');
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, 'You should try magnesium before bed.');
    });

    it('ends the session on /done', async () => {
      // Start a session first
      const session = makeSession({ topic: 'exercise' });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'Initial', error: null });
      await healthHandler.start(session, bot);

      vi.clearAllMocks();

      await healthHandler.handleMessage(session, '/done', bot);

      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Health session ended.');
      expect(askClaudeMock).not.toHaveBeenCalled();
    });

    it('reconstructs from prepContext when sessionPrompts is empty', async () => {
      // Create a session with prepContext but no stored prompt (simulates server restart)
      const session = makeSession({
        claudeSessionId: 'reconstructed-session',
        prepContext: 'Persisted system prompt from previous run',
      });

      askClaudeMock.mockResolvedValue({ text: 'Reconstructed response', error: null });

      await healthHandler.handleMessage(session, 'continuing conversation', bot);

      expect(askClaudeMock).toHaveBeenCalledWith(
        'continuing conversation',
        'reconstructed-session',
        'Persisted system prompt from previous run',
      );
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, 'Reconstructed response');
    });

    it('handles missing system prompt gracefully', async () => {
      const session = makeSession({ claudeSessionId: 'unknown-session-id' });

      await healthHandler.handleMessage(session, 'hello', bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Session context lost. Start a new /health session.');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
      expect(askClaudeMock).not.toHaveBeenCalled();
    });
  });
});
