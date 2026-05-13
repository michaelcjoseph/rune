import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../transport/sender.js';

// --- Mocks ---

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
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
  runAgent: vi.fn(),
}));

vi.mock('../vault/files.js', () => ({
  readVaultFile: vi.fn(),
}));

vi.mock('../vault/git.js', () => ({
  gitCommitAndPush: vi.fn(),
}));

vi.mock('../config.js', () => ({
  default: {
    TELEGRAM_USER_ID: 42,
    VAULT_DIR: '/test/vault',
    TIMEZONE: 'America/Chicago',
  },
  PROJECT_ROOT: '/test/project',
}));

// --- Imports ---

const { registerReviewHandler } = await import('./orchestrator.js');
const { updateReviewSession } = await import('./session.js');
const { askClaudeWithContext, runAgent } = await import('../ai/claude.js');
const { readVaultFile } = await import('../vault/files.js');
const { gitCommitAndPush } = await import('../vault/git.js');

const registerMock = registerReviewHandler as ReturnType<typeof vi.fn>;
const updateSessionMock = updateReviewSession as ReturnType<typeof vi.fn>;
const askClaudeMock = askClaudeWithContext as ReturnType<typeof vi.fn>;
const runAgentMock = runAgent as ReturnType<typeof vi.fn>;
const readVaultMock = readVaultFile as ReturnType<typeof vi.fn>;
const gitMock = gitCommitAndPush as ReturnType<typeof vi.fn>;

// Import module under test — triggers registerReviewHandler side effect
await import('./new-project.js');

// Capture registration before beforeEach clears mocks
const registrationCalls = [...registerMock.mock.calls];
const newProjectHandler = registrationCalls[0]?.[1];

import type { ReviewSession } from './session.js';

// --- Helpers ---

function makeSession(overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    id: 'sess-np-001',
    chatId: 100,
    type: 'new-project',
    targetDate: '2026-05-12',
    phase: 'prep',
    claudeSessionId: 'claude-np-001',
    topic: null,
    prepContext: null,
    outline: null,
    createdAt: '2026-05-12T08:00:00Z',
    lastActivity: '2026-05-12T08:00:00Z',
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

describe('reviews/new-project', () => {
  let sender: MessageSender;

  beforeEach(() => {
    vi.resetAllMocks();
    sender = makeSender();
  });

  describe('registration', () => {
    it('calls registerReviewHandler with "new-project" at import time', () => {
      expect(registrationCalls).toEqual([['new-project', newProjectHandler]]);
    });
  });

  describe('start — no topic', () => {
    it('sends opening message, starts typing, calls Claude, updates phase to interview', async () => {
      const session = makeSession({ topic: null });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'What would you like to build?', error: null });

      await newProjectHandler.start(session, sender);

      expect(sender.send).toHaveBeenCalledWith(100, 'Starting project planning interview. Send /done to cancel at any time.');
      expect(sender.startTyping).toHaveBeenCalledWith(100);
      expect(askClaudeMock).toHaveBeenCalledWith(
        "Let's plan a new Jarvis project.",
        'claude-np-001',
        expect.any(String),
      );
      expect(sender.stopTyping).toHaveBeenCalledWith(100);
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'interview' });
      expect(sender.send).toHaveBeenCalledWith(100, 'What would you like to build?');
    });

    it('uses DEFAULT_INSTRUCTIONS when skill file is missing', async () => {
      const session = makeSession({ topic: null });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'Opening question', error: null });

      await newProjectHandler.start(session, sender);

      const systemPrompt = askClaudeMock.mock.calls[0]![2] as string;
      expect(systemPrompt).toContain('product interviewer');
      expect(systemPrompt).toContain('Discovery areas');
    });

    it('stores system prompt in prepContext via updateReviewSession', async () => {
      const session = makeSession({ topic: null });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'Opening', error: null });

      await newProjectHandler.start(session, sender);

      // The first updateReviewSession call stores the system prompt as prepContext
      const prepContextCall = updateSessionMock.mock.calls.find(
        (c: any[]) => c[1] && 'prepContext' in c[1],
      );
      expect(prepContextCall).toBeDefined();
      expect(prepContextCall![1].prepContext).toContain('plan a new Jarvis project');
    });
  });

  describe('start — with topic', () => {
    it('uses topic in opener sent to Claude', async () => {
      const session = makeSession({ topic: 'email digest feature' });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'Tell me more.', error: null });

      await newProjectHandler.start(session, sender);

      expect(askClaudeMock).toHaveBeenCalledWith(
        'I want to build: email digest feature',
        'claude-np-001',
        expect.any(String),
      );
    });

    it('includes topic in system prompt opener', async () => {
      const session = makeSession({ topic: 'smart cron builder' });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'Tell me more.', error: null });

      await newProjectHandler.start(session, sender);

      const systemPrompt = askClaudeMock.mock.calls[0]![2] as string;
      expect(systemPrompt).toContain('smart cron builder');
    });
  });

  describe('start — Claude error', () => {
    it('sends error message and sets phase to done when Claude fails', async () => {
      const session = makeSession({ topic: null });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: null, error: 'Service unavailable' });

      await newProjectHandler.start(session, sender);

      expect(sender.stopTyping).toHaveBeenCalledWith(100);
      expect(sender.send).toHaveBeenCalledWith(100, 'Failed to start interview: Service unavailable');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
    });
  });

  describe('handleMessage — /done cancels session', () => {
    it('sets phase to done and sends cancellation message', async () => {
      const session = makeSession({ phase: 'interview' });

      await newProjectHandler.handleMessage(session, '/done', sender);

      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
      expect(sender.send).toHaveBeenCalledWith(100, 'Project planning cancelled.');
      expect(askClaudeMock).not.toHaveBeenCalled();
    });

    it('handles /done case-insensitively', async () => {
      const session = makeSession({ phase: 'interview' });

      await newProjectHandler.handleMessage(session, '/DONE', sender);

      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
      expect(sender.send).toHaveBeenCalledWith(100, 'Project planning cancelled.');
    });
  });

  describe('handleMessage — interview phase (no brief yet)', () => {
    it('forwards message to Claude and sends reply when no brief marker in response', async () => {
      const session = makeSession({
        phase: 'interview',
        prepContext: 'System prompt context stored',
      });
      askClaudeMock.mockResolvedValue({ text: 'What pain point does this solve?', error: null });

      await newProjectHandler.handleMessage(session, 'I want to build a digest feature', sender);

      expect(sender.startTyping).toHaveBeenCalledWith(100);
      expect(askClaudeMock).toHaveBeenCalledWith(
        'I want to build a digest feature',
        'claude-np-001',
        'System prompt context stored',
      );
      expect(sender.stopTyping).toHaveBeenCalledWith(100);
      expect(sender.send).toHaveBeenCalledWith(100, 'What pain point does this solve?');
    });

    it('reconstructs system prompt from prepContext when in-memory map is empty', async () => {
      const session = makeSession({
        phase: 'interview',
        claudeSessionId: 'fresh-session-id',
        prepContext: 'Persisted prompt from disk',
      });
      askClaudeMock.mockResolvedValue({ text: 'Follow-up question', error: null });

      await newProjectHandler.handleMessage(session, 'continuing', sender);

      expect(askClaudeMock).toHaveBeenCalledWith(
        'continuing',
        'fresh-session-id',
        'Persisted prompt from disk',
      );
    });

    it('sends error message when Claude returns an error', async () => {
      const session = makeSession({
        phase: 'interview',
        prepContext: 'Prompt',
      });
      askClaudeMock.mockResolvedValue({ text: null, error: 'Rate limited' });

      await newProjectHandler.handleMessage(session, 'some question', sender);

      expect(sender.send).toHaveBeenCalledWith(100, 'Error: Rate limited');
    });

    it('sends context-lost message and marks done when no system prompt available', async () => {
      // Session without prepContext and a claudeSessionId not in the in-memory map
      const session = makeSession({
        phase: 'interview',
        claudeSessionId: 'unknown-id',
        prepContext: null,
      });

      await newProjectHandler.handleMessage(session, 'hello', sender);

      expect(sender.send).toHaveBeenCalledWith(100, 'Session context lost. Start a new /new-project session.');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
      expect(askClaudeMock).not.toHaveBeenCalled();
    });
  });

  describe('handleMessage — interview phase (brief detected)', () => {
    it('transitions to approval when Claude response contains "## project brief"', async () => {
      // First call start() to populate sessionPrompts
      const session = makeSession({ phase: 'prep' });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'Opening question', error: null });
      await newProjectHandler.start(session, sender);

      vi.clearAllMocks();
      sender = makeSender();

      const briefResponse = `Here's your project brief:

## Project Brief

**Name:** Email Digest
**Slug:** email-digest

### Overview
Send daily digests.`;
      askClaudeMock.mockResolvedValue({ text: briefResponse, error: null });

      const interviewSession = makeSession({ phase: 'interview', claudeSessionId: session.claudeSessionId });
      await newProjectHandler.handleMessage(interviewSession, 'sounds good', sender);

      expect(updateSessionMock).toHaveBeenCalledWith(
        100,
        expect.objectContaining({ phase: 'approval', outline: expect.stringContaining('## Project Brief') }),
      );
      // Sends the full response and the approval prompt
      expect(sender.send).toHaveBeenCalledWith(100, briefResponse);
      expect(sender.send).toHaveBeenCalledWith(
        100,
        expect.stringContaining('yes'),
        expect.objectContaining({ approval: expect.any(Object) }),
      );
    });
  });

  describe('handleMessage — approval phase', () => {
    async function setupApproval(approvalOverrides: Partial<ReviewSession> = {}): Promise<ReviewSession> {
      const session = makeSession({
        phase: 'approval',
        outline: '## Project Brief\n\n**Name:** My Feature\n**Slug:** my-feature\n\n### Overview\nA great feature.',
        ...approvalOverrides,
      });
      return session;
    }

    it('runs project-setup-writer agent and transitions to done on "yes"', async () => {
      const session = await setupApproval();
      readVaultMock.mockReturnValue(null);
      runAgentMock.mockResolvedValue({ text: 'Project files created successfully.', error: null });
      gitMock.mockResolvedValue(undefined);

      await newProjectHandler.handleMessage(session, 'yes', sender);

      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'writeup' });
      expect(runAgentMock).toHaveBeenCalledWith(
        'project-setup-writer',
        expect.stringContaining('## Project Brief'),
      );
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
      expect(sender.send).toHaveBeenCalledWith(
        100,
        expect.stringContaining('Project files created'),
      );
    });

    it('accepts "y", "approve", "confirm", "ok" as approval signals', async () => {
      for (const signal of ['y', 'approve', 'confirm', 'ok']) {
        vi.clearAllMocks();
        sender = makeSender();
        const session = await setupApproval();
        runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
        gitMock.mockResolvedValue(undefined);

        await newProjectHandler.handleMessage(session, signal, sender);

        expect(runAgentMock).toHaveBeenCalledWith('project-setup-writer', expect.any(String));
      }
    });

    it('cancels on "cancel" and sends cancellation message', async () => {
      const session = await setupApproval();

      await newProjectHandler.handleMessage(session, 'cancel', sender);

      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
      expect(sender.send).toHaveBeenCalledWith(100, 'Project planning cancelled.');
      expect(runAgentMock).not.toHaveBeenCalled();
    });

    it('cancels on "no", "n", "skip"', async () => {
      for (const signal of ['no', 'n', 'skip']) {
        vi.clearAllMocks();
        sender = makeSender();
        const session = await setupApproval();

        await newProjectHandler.handleMessage(session, signal, sender);

        expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
        expect(runAgentMock).not.toHaveBeenCalled();
      }
    });

    it('treats unrecognized text as a brief correction, sends it to Claude, and prompts re-approval', async () => {
      const session = await setupApproval();
      const revisedBrief = '## Project Brief\n\n**Name:** My Feature\n**Slug:** new-slug\n\n### Overview\nA great feature.';
      askClaudeMock.mockResolvedValue({ text: revisedBrief, error: null });

      await newProjectHandler.handleMessage(session, 'Change the slug to new-slug', sender);

      // Sends the correction to Claude
      expect(askClaudeMock).toHaveBeenCalledWith(
        'Please revise the Project Brief with this correction: Change the slug to new-slug',
        session.claudeSessionId,
        expect.any(String),
      );
      // Updates outline with Claude's revised brief
      expect(updateSessionMock).toHaveBeenCalledWith(100, { outline: revisedBrief });
      // Re-sends approval prompt
      expect(sender.send).toHaveBeenCalledWith(
        100,
        expect.stringContaining('yes'),
        expect.objectContaining({ approval: expect.any(Object) }),
      );
      expect(runAgentMock).not.toHaveBeenCalled();
    });

    it('sends error and sets done when agent fails', async () => {
      const session = await setupApproval();
      runAgentMock.mockResolvedValue({ text: null, error: 'Agent timed out' });

      await newProjectHandler.handleMessage(session, 'yes', sender);

      expect(sender.send).toHaveBeenCalledWith(100, 'Failed to write project files: Agent timed out');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
    });

    it('runs git commit after successful agent run', async () => {
      const session = await setupApproval({
        outline: '## Project Brief\n\n**Name:** New Feature\n**Slug:** new-feature',
      });
      runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
      gitMock.mockResolvedValue(undefined);

      await newProjectHandler.handleMessage(session, 'yes', sender);

      expect(gitMock).toHaveBeenCalledWith('New project setup: new-feature');
    });

    it('falls back to "new-project" slug when no slug in outline', async () => {
      const session = await setupApproval({
        outline: '## Project Brief\n\n**Name:** Untitled',
      });
      runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
      gitMock.mockResolvedValue(undefined);

      await newProjectHandler.handleMessage(session, 'yes', sender);

      expect(gitMock).toHaveBeenCalledWith('New project setup: new-project');
    });

    it('does not throw when git commit fails — continues to done', async () => {
      const session = await setupApproval();
      runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
      gitMock.mockRejectedValue(new Error('git push failed'));

      // Should not throw
      await expect(newProjectHandler.handleMessage(session, 'yes', sender)).resolves.not.toThrow();
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
    });
  });

  describe('handleMessage — writeup phase (in-progress guard)', () => {
    it('sends a please-wait message and returns without calling Claude', async () => {
      const session = makeSession({ phase: 'writeup' });

      await newProjectHandler.handleMessage(session, 'are you done yet?', sender);

      expect(sender.send).toHaveBeenCalledWith(100, 'Writing project files... please wait.');
      expect(askClaudeMock).not.toHaveBeenCalled();
      expect(runAgentMock).not.toHaveBeenCalled();
    });
  });

  describe('agentPrompt construction', () => {
    it('includes PROJECT_ROOT in the agent prompt', async () => {
      const session = makeSession({
        phase: 'approval',
        outline: '## Project Brief\n\n**Slug:** test-slug',
      });
      runAgentMock.mockResolvedValue({ text: 'Created.', error: null });
      gitMock.mockResolvedValue(undefined);

      await newProjectHandler.handleMessage(session, 'yes', sender);

      const prompt = runAgentMock.mock.calls[0]![1] as string;
      expect(prompt).toContain('/test/project');
      expect(prompt).toContain('## Project Brief');
    });
  });
});
