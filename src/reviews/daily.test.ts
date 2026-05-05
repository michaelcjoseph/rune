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
}));

vi.mock('../ai/claude.js', () => ({
  askClaudeOneShot: vi.fn(),
  runAgent: vi.fn(),
}));

vi.mock('../vault/files.js', () => ({
  readVaultFile: vi.fn(),
}));

vi.mock('../vault/git.js', () => ({
  gitCommitAndPush: vi.fn(),
}));

// --- Imports ---

const { registerReviewHandler } = await import('./orchestrator.js');
const { updateReviewSession } = await import('./session.js');
const { askClaudeOneShot, runAgent } = await import('../ai/claude.js');
const { readVaultFile } = await import('../vault/files.js');
const { gitCommitAndPush } = await import('../vault/git.js');

const registerMock = registerReviewHandler as ReturnType<typeof vi.fn>;
const updateSessionMock = updateReviewSession as ReturnType<typeof vi.fn>;
const askClaudeMock = askClaudeOneShot as ReturnType<typeof vi.fn>;
const runAgentMock = runAgent as ReturnType<typeof vi.fn>;
const readVaultMock = readVaultFile as ReturnType<typeof vi.fn>;
const gitCommitMock = gitCommitAndPush as ReturnType<typeof vi.fn>;

// Import the module under test (triggers registerReviewHandler side effect)
const { dailyHandler } = await import('./daily.js');

// Capture registration call that happened at import time (before beforeEach clears mocks)
const registrationCalls = [...registerMock.mock.calls];

import type { ReviewSession } from './session.js';

// --- Helpers ---

function makeSession(overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    id: 'sess-daily-001',
    chatId: 100,
    type: 'daily',
    targetDate: '2026-04-10',
    phase: 'prep',
    claudeSessionId: 'claude-001',
    topic: null,
    prepContext: null,
    outline: null,
    createdAt: '2026-04-10T08:00:00',
    lastActivity: '2026-04-10T08:00:00',
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

describe('reviews/daily', () => {
  let sender: MessageSender;

  beforeEach(() => {
    vi.clearAllMocks();
    sender = makeSender();
  });

  describe('registration', () => {
    it('calls registerReviewHandler with "daily" and the handler at import time', () => {
      // Registration happens at module load (before beforeEach clears mocks),
      // so we check the snapshot captured right after import.
      expect(registrationCalls).toEqual([['daily', dailyHandler]]);
    });
  });

  describe('start', () => {
    it('notifies user and sets phase to done when journal is empty', async () => {
      const session = makeSession();
      readVaultMock.mockReturnValue('');

      await dailyHandler.start(session, sender);

      expect(sender.send).toHaveBeenCalledWith(100, 'No journal found for 2026-04-10. Nothing to process.');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
    });

    it('notifies user and sets phase to done when journal is null/missing', async () => {
      const session = makeSession();
      readVaultMock.mockReturnValue(null);

      await dailyHandler.start(session, sender);

      expect(sender.send).toHaveBeenCalledWith(100, 'No journal found for 2026-04-10. Nothing to process.');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
    });

    it('analyzes journal with tags, shows proposals, sets phase to approval', async () => {
      const session = makeSession();
      readVaultMock.mockReturnValue('Did a #workout today, ran 5k\n#crm Met with John');
      askClaudeMock.mockResolvedValue({
        text: '**#workout** → health/workouts.json\n- Ran 5k\n\n**#crm** → pages/crm.json\n- Met with John',
        error: null,
      });

      await dailyHandler.start(session, sender);

      expect(sender.send).toHaveBeenCalledWith(100, 'Reading journal for 2026-04-10...');
      expect(sender.startTyping).toHaveBeenCalledWith(100);
      expect(askClaudeMock).toHaveBeenCalledOnce();
      expect(sender.stopTyping).toHaveBeenCalledWith(100);
      expect(updateSessionMock).toHaveBeenCalledWith(100, {
        prepContext: '**#workout** → health/workouts.json\n- Ran 5k\n\n**#crm** → pages/crm.json\n- Met with John',
        phase: 'approval',
      });
      expect(sender.send).toHaveBeenCalledWith(
        100,
        expect.stringContaining('Reply *yes* to apply these updates or *cancel* to skip.'),
      );
    });

    it('sends message and sets phase to done when Claude says no updates needed', async () => {
      const session = makeSession();
      readVaultMock.mockReturnValue('Just a regular day, no tags.');
      askClaudeMock.mockResolvedValue({
        text: 'No JSON updates needed. The journal entry describes a regular day.',
        error: null,
      });

      await dailyHandler.start(session, sender);

      expect(sender.send).toHaveBeenCalledWith(100, 'No JSON updates needed. The journal entry describes a regular day.');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
      // Should NOT set phase to approval
      expect(updateSessionMock).not.toHaveBeenCalledWith(100, expect.objectContaining({ phase: 'approval' }));
    });

    it('sends error message and sets phase to done on Claude error', async () => {
      const session = makeSession();
      readVaultMock.mockReturnValue('Some journal content');
      askClaudeMock.mockResolvedValue({ text: null, error: 'Claude unavailable' });

      await dailyHandler.start(session, sender);

      expect(sender.stopTyping).toHaveBeenCalledWith(100);
      expect(sender.send).toHaveBeenCalledWith(100, 'Failed to analyze journal: Claude unavailable');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
    });

    it('sends error message with "empty response" when Claude returns no text and no error', async () => {
      const session = makeSession();
      readVaultMock.mockReturnValue('Some journal content');
      askClaudeMock.mockResolvedValue({ text: null, error: null });

      await dailyHandler.start(session, sender);

      expect(sender.send).toHaveBeenCalledWith(100, 'Failed to analyze journal: empty response');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
    });

    it('uses correct journal filename with underscores', async () => {
      const session = makeSession({ targetDate: '2026-01-15' });
      readVaultMock.mockReturnValue(null);

      await dailyHandler.start(session, sender);

      expect(readVaultMock).toHaveBeenCalledWith('journals/2026_01_15.md');
    });
  });

  describe('handleMessage', () => {
    describe('approval phase', () => {
      it('runs json-updater agent and git commits on "yes"', async () => {
        const session = makeSession({ phase: 'approval', prepContext: 'proposed updates here' });
        runAgentMock.mockResolvedValue({ text: 'Updated 2 files.', error: null });

        await dailyHandler.handleMessage(session, 'yes', sender);

        expect(sender.send).toHaveBeenCalledWith(100, 'Applying updates...');
        expect(sender.startTyping).toHaveBeenCalledWith(100);
        expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'updates' });
        expect(runAgentMock).toHaveBeenCalledWith('json-updater', expect.stringContaining('proposed updates here'));
        expect(sender.stopTyping).toHaveBeenCalledWith(100);
        expect(gitCommitMock).toHaveBeenCalledWith('Daily review: 2026-04-10');
        expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
        expect(sender.send).toHaveBeenCalledWith(100, 'Daily review complete.\n\nUpdated 2 files.');
      });

      it.each(['yes', 'y', 'approve', 'confirm', 'ok', 'YES', ' Yes '])('accepts approval word: "%s"', async (word) => {
        const session = makeSession({ phase: 'approval', prepContext: 'updates' });
        runAgentMock.mockResolvedValue({ text: 'Done.', error: null });

        await dailyHandler.handleMessage(session, word, sender);

        expect(runAgentMock).toHaveBeenCalled();
      });

      it('shows "Updates applied." when agent returns no text', async () => {
        const session = makeSession({ phase: 'approval', prepContext: 'updates' });
        runAgentMock.mockResolvedValue({ text: '', error: null });

        await dailyHandler.handleMessage(session, 'yes', sender);

        expect(sender.send).toHaveBeenCalledWith(100, 'Daily review complete.\n\nUpdates applied.');
      });

      it('sends error and sets phase to done when agent fails', async () => {
        const session = makeSession({ phase: 'approval', prepContext: 'updates' });
        runAgentMock.mockResolvedValue({ text: null, error: 'Agent crashed' });

        await dailyHandler.handleMessage(session, 'yes', sender);

        expect(sender.stopTyping).toHaveBeenCalledWith(100);
        expect(sender.send).toHaveBeenCalledWith(100, 'JSON update failed: Agent crashed');
        expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
        expect(gitCommitMock).not.toHaveBeenCalled();
      });

      it('cancels and sets phase to done on "cancel"', async () => {
        const session = makeSession({ phase: 'approval', prepContext: 'updates' });

        await dailyHandler.handleMessage(session, 'cancel', sender);

        expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
        expect(sender.send).toHaveBeenCalledWith(100, 'Daily review cancelled.');
        expect(runAgentMock).not.toHaveBeenCalled();
      });

      it.each(['no', 'n', 'cancel', 'skip', 'NO', ' Skip '])('accepts cancel word: "%s"', async (word) => {
        const session = makeSession({ phase: 'approval', prepContext: 'updates' });

        await dailyHandler.handleMessage(session, word, sender);

        expect(sender.send).toHaveBeenCalledWith(100, 'Daily review cancelled.');
      });

      it('prompts user on unrecognized text', async () => {
        const session = makeSession({ phase: 'approval', prepContext: 'updates' });

        await dailyHandler.handleMessage(session, 'maybe later', sender);

        expect(sender.send).toHaveBeenCalledWith(100, 'Reply *yes* to apply updates or *cancel* to skip.');
        expect(runAgentMock).not.toHaveBeenCalled();
        expect(updateSessionMock).not.toHaveBeenCalled();
      });
    });

    it('does not throw for unexpected phase', async () => {
      const session = makeSession({ phase: 'interview' });

      await expect(dailyHandler.handleMessage(session, 'hello', sender)).resolves.toBeUndefined();
    });
  });
});
