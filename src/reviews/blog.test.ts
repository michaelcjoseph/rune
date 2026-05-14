import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../transport/sender.js';

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

// --- Imports ---

const { registerReviewHandler } = await import('./orchestrator.js');
const { updateReviewSession } = await import('./session.js');
const { askClaudeWithContext } = await import('../ai/claude.js');
const { readVaultFile } = await import('../vault/files.js');

const registerMock = registerReviewHandler as ReturnType<typeof vi.fn>;
const updateSessionMock = updateReviewSession as ReturnType<typeof vi.fn>;
const askClaudeMock = askClaudeWithContext as ReturnType<typeof vi.fn>;
const readVaultMock = readVaultFile as ReturnType<typeof vi.fn>;

// Import module under test (triggers registerReviewHandler side effect)
await import('./blog.js');

// Capture registration call before beforeEach clears mocks
const registrationCalls = [...registerMock.mock.calls];
const blogHandler = registrationCalls[0]?.[1];

import type { ReviewSession } from './session.js';

// --- Helpers ---

function makeSession(overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    id: 'sess-blog-001',
    chatId: 100,
    type: 'blog',
    targetDate: '2026-04-14',
    phase: 'prep',
    claudeSessionId: 'claude-blog-001',
    topic: null,
    prepContext: null,
    outline: null,
    createdAt: '2026-04-14T08:00:00',
    lastActivity: '2026-04-14T08:00:00',
    ...overrides,
  };
}

function makeSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

// --- Tests ---

describe('reviews/blog', () => {
  let sender: MessageSender;

  beforeEach(() => {
    vi.clearAllMocks();
    sender = makeSender();
  });

  describe('registration', () => {
    it('calls registerReviewHandler with "blog" at import time', () => {
      expect(registrationCalls).toEqual([['blog', blogHandler]]);
    });
  });

  describe('start', () => {
    it('reads skill file and writing context, sends first message', async () => {
      const session = makeSession({ topic: 'why testing matters' });
      readVaultMock.mockImplementation((path: string) => {
        if (path === '.claude/skills/blog/SKILL.md') return 'Custom blog skill instructions';
        if (path === 'writing/voice.md') return 'Conversational, direct tone';
        if (path === 'writing/topics.md') return '- testing\n- dev workflows';
        return null;
      });
      askClaudeMock.mockResolvedValue({ text: 'What angle are you thinking for this post?', error: null });

      await blogHandler.start(session, sender);

      expect(readVaultMock).toHaveBeenCalledWith('.claude/skills/blog/SKILL.md');
      expect(readVaultMock).toHaveBeenCalledWith('writing/voice.md');
      expect(readVaultMock).toHaveBeenCalledWith('writing/topics.md');
      expect(sender.send).toHaveBeenCalledWith(100, 'Blog session started: "why testing matters"\nSend /done when finished.');
      expect(sender.startTyping).toHaveBeenCalledWith(100);
      expect(askClaudeMock).toHaveBeenCalledWith(
        'I want to write about: why testing matters',
        'claude-blog-001',
        expect.stringContaining('Custom blog skill instructions'),
        undefined,
        undefined,
        'review:blog',
      );
      // Verify writing context is included in system prompt
      expect(askClaudeMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.stringContaining('Conversational, direct tone'),
        undefined,
        undefined,
        'review:blog',
      );
      expect(askClaudeMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.stringContaining('- testing'),
        undefined,
        undefined,
        'review:blog',
      );
      expect(sender.stopTyping).toHaveBeenCalledWith(100);
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'interview' });
      expect(sender.send).toHaveBeenCalledWith(100, 'What angle are you thinking for this post?');
    });

    it('uses default instructions when skill file is missing', async () => {
      const session = makeSession({ topic: 'productivity systems' });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'Tell me more about what you mean.', error: null });

      await blogHandler.start(session, sender);

      expect(askClaudeMock).toHaveBeenCalledWith(
        'I want to write about: productivity systems',
        'claude-blog-001',
        expect.stringContaining('interview-style conversation'),
        undefined,
        undefined,
        'review:blog',
      );
      expect(askClaudeMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.stringContaining('No artifacts or documents until I approve the outline'),
        undefined,
        undefined,
        'review:blog',
      );
    });

    it('includes voice.md in system prompt when available', async () => {
      const session = makeSession({ topic: 'some topic' });
      readVaultMock.mockImplementation((path: string) => {
        if (path === 'writing/voice.md') return 'My voice: plain English, no jargon';
        return null;
      });
      askClaudeMock.mockResolvedValue({ text: 'Response', error: null });

      await blogHandler.start(session, sender);

      expect(askClaudeMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.stringContaining('Writing Voice & Style'),
        undefined,
        undefined,
        'review:blog',
      );
      expect(askClaudeMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.stringContaining('My voice: plain English, no jargon'),
        undefined,
        undefined,
        'review:blog',
      );
    });
  });

  describe('handleMessage', () => {
    it('forwards messages to Claude with system prompt', async () => {
      // Start a session first to populate sessionPrompts
      const session = makeSession({ topic: 'test topic' });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'Initial response', error: null });
      await blogHandler.start(session, sender);

      vi.clearAllMocks();
      sender = makeSender();
      askClaudeMock.mockResolvedValue({ text: 'Great point, what about X?', error: null });

      await blogHandler.handleMessage(session, 'The key argument is Y', sender);

      expect(sender.startTyping).toHaveBeenCalledWith(session.chatId);
      expect(askClaudeMock).toHaveBeenCalledWith(
        'The key argument is Y',
        'claude-blog-001',
        expect.stringContaining('test topic'),
        undefined,
        undefined,
        'review:blog',
      );
      expect(sender.stopTyping).toHaveBeenCalledWith(100);
      expect(sender.send).toHaveBeenCalledWith(100, 'Great point, what about X?');
    });

    it('ends the session on /done', async () => {
      // Start a session first
      const session = makeSession({ topic: 'wrap up topic' });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'Initial', error: null });
      await blogHandler.start(session, sender);

      vi.clearAllMocks();
      sender = makeSender();

      await blogHandler.handleMessage(session, '/done', sender);

      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
      expect(sender.send).toHaveBeenCalledWith(100, 'Blog session ended.');
      expect(askClaudeMock).not.toHaveBeenCalled();
    });

    it('reconstructs system prompt from prepContext when sessionPrompts is empty', async () => {
      // Create a session with prepContext but no stored sessionPrompt
      const session = makeSession({
        claudeSessionId: 'fresh-session-id',
        prepContext: 'Reconstructed system prompt for blog',
      });

      askClaudeMock.mockResolvedValue({ text: 'Continuing the conversation', error: null });

      await blogHandler.handleMessage(session, 'picking up where we left off', sender);

      expect(askClaudeMock).toHaveBeenCalledWith(
        'picking up where we left off',
        'fresh-session-id',
        'Reconstructed system prompt for blog',
        undefined,
        undefined,
        'review:blog',
      );
      expect(sender.send).toHaveBeenCalledWith(100, 'Continuing the conversation');
    });
  });
});
