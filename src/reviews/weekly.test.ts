import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: '/test/vault',
    TIMEZONE: 'America/Chicago',
    TELEGRAM_USER_ID: 123,
    LOGS_DIR: '/tmp/jarvis-test-logs',
  },
  PROJECT_ROOT: '/test/project',
}));

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
  onReviewSessionDeleted: vi.fn(),
}));

vi.mock('../ai/claude.js', () => ({
  askClaudeWithContext: vi.fn(),
  askClaudeOneShot: vi.fn(),
  runAgent: vi.fn(),
  AGENT_NOT_FOUND_PREFIX: 'Agent not found:',
}));

vi.mock('../vault/files.js', () => ({
  readVaultFile: vi.fn(),
  listVaultFiles: vi.fn(() => []),
  vaultFileExists: vi.fn(() => false),
}));

vi.mock('../vault/git.js', () => ({
  gitCommitAndPush: vi.fn(),
}));

vi.mock('../integrations/telegram/client.js', () => ({
  sendLongMessage: vi.fn().mockResolvedValue(undefined),
  startTyping: vi.fn().mockReturnValue('typing-handle'),
  stopTyping: vi.fn(),
}));

vi.mock('../jobs/proposal-queue.js', () => ({
  getPendingProposals: vi.fn(() => []),
  clearApprovedProposals: vi.fn(),
}));

vi.mock('../jobs/playbook-extract.js', () => ({
  getPendingPlaybookDrafts: vi.fn(() => []),
  extractPlaybookDrafts: vi.fn(),
  clearApprovedPlaybookDrafts: vi.fn(),
}));

vi.mock('../kb/queue.js', () => ({
  enqueue: vi.fn(),
  dequeue: vi.fn(),
  clearQueue: vi.fn(),
  getQueue: vi.fn(() => []),
}));

// --- Imports ---

const { registerReviewHandler } = await import('./orchestrator.js');
const { updateReviewSession } = await import('./session.js');
const { askClaudeWithContext, askClaudeOneShot, runAgent } = await import('../ai/claude.js');
const { readVaultFile } = await import('../vault/files.js');
const { gitCommitAndPush } = await import('../vault/git.js');
const { sendLongMessage, startTyping, stopTyping } = await import('../integrations/telegram/client.js');
const { enqueue: enqueueKB } = await import('../kb/queue.js');

const registerMock = registerReviewHandler as ReturnType<typeof vi.fn>;
const updateSessionMock = updateReviewSession as ReturnType<typeof vi.fn>;
const askClaudeCtxMock = askClaudeWithContext as ReturnType<typeof vi.fn>;
const askClaudeOneShotMock = askClaudeOneShot as ReturnType<typeof vi.fn>;
const runAgentMock = runAgent as ReturnType<typeof vi.fn>;
const readVaultMock = readVaultFile as ReturnType<typeof vi.fn>;
const gitCommitMock = gitCommitAndPush as ReturnType<typeof vi.fn>;
const sendLongMock = sendLongMessage as ReturnType<typeof vi.fn>;
const startTypingMock = startTyping as ReturnType<typeof vi.fn>;
const stopTypingMock = stopTyping as ReturnType<typeof vi.fn>;
const enqueueKBMock = enqueueKB as ReturnType<typeof vi.fn>;

// Import the module under test (triggers registerReviewHandler side effect)
const { weeklyHandler, detectOutline } = await import('./weekly.js');

// Capture registration call that happened at import time
const registrationCalls = [...registerMock.mock.calls];

import type { ReviewSession } from './session.js';

// --- Helpers ---

function makeSession(overrides: Partial<ReviewSession> = {}): ReviewSession {
  return {
    id: 'sess-weekly-001',
    chatId: 100,
    type: 'weekly',
    targetDate: '2026-04-10', // Friday
    phase: 'prep',
    claudeSessionId: 'claude-weekly-001',
    topic: null,
    prepContext: null,
    outline: null,
    createdAt: '2026-04-10T08:00:00',
    lastActivity: '2026-04-10T08:00:00',
    ...overrides,
  };
}

function makeBot() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

// --- Tests ---

describe('reviews/weekly', () => {
  let bot: ReturnType<typeof makeBot>;

  beforeEach(() => {
    vi.clearAllMocks();
    bot = makeBot();
    startTypingMock.mockReturnValue('typing-handle');
  });

  // 1. detectOutline
  describe('detectOutline', () => {
    it('returns outline text when marker is found', () => {
      const response = 'Here is the summary.\n\nWeek in Review outline:\n- Point A\n- Point B';
      const result = detectOutline(response, 'week in review outline:');
      expect(result).toBe('Week in Review outline:\n- Point A\n- Point B');
    });

    it('is case-insensitive', () => {
      const response = 'WEEK IN REVIEW OUTLINE:\n- Something';
      expect(detectOutline(response, 'week in review outline:')).toBe('WEEK IN REVIEW OUTLINE:\n- Something');
    });

    it('returns null when marker is not found', () => {
      expect(detectOutline('No outline here.', 'week in review outline:')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(detectOutline('', 'week in review outline:')).toBeNull();
    });
  });

  describe('registration', () => {
    it('calls registerReviewHandler with "weekly" and the handler at import time', () => {
      expect(registrationCalls).toEqual([['weekly', weeklyHandler]]);
    });
  });

  describe('start', () => {
    // 2. Spawns both scanner agents in parallel
    it('spawns journal-scanner and system-scanner in parallel', async () => {
      const session = makeSession();
      runAgentMock.mockResolvedValue({ text: 'scan result', error: null });
      readVaultMock.mockReturnValue(null);
      askClaudeCtxMock.mockResolvedValue({ text: 'Hello, let us begin.', error: null });

      await weeklyHandler.start(session, bot);

      expect(runAgentMock).toHaveBeenCalledTimes(2);
      expect(runAgentMock).toHaveBeenCalledWith('journal-scanner', expect.stringContaining('start_date: 2026_04_04'));
      expect(runAgentMock).toHaveBeenCalledWith('journal-scanner', expect.stringContaining('end_date: 2026_04_10'));
      expect(runAgentMock).toHaveBeenCalledWith('system-scanner', expect.stringContaining('systems:'));
    });

    // 3. Combines scanner results into prepContext, stores on session
    it('combines scanner results and stores prepContext on session', async () => {
      const session = makeSession();
      runAgentMock
        .mockResolvedValueOnce({ text: 'journal data', error: null })
        .mockResolvedValueOnce({ text: 'system data', error: null });
      readVaultMock.mockReturnValue(null);
      askClaudeCtxMock.mockResolvedValue({ text: 'Starting interview.', error: null });

      await weeklyHandler.start(session, bot);

      expect(updateSessionMock).toHaveBeenCalledWith(100, {
        prepContext: expect.stringContaining('journal data'),
      });
      expect(updateSessionMock).toHaveBeenCalledWith(100, {
        prepContext: expect.stringContaining('system data'),
      });
    });

    // 3b. Surfaces KB activity digest in prepContext when log.md has entries in the window
    it('includes KB activity digest in prepContext when knowledge/log.md has entries in the window', async () => {
      // targetDate = 2026-04-10 (Friday) → window: 2026-04-04 (Saturday) … 2026-04-10.
      const session = makeSession();
      runAgentMock.mockResolvedValue({ text: 'scan', error: null });

      // Controlled fixture: one INGEST entry with a prefixed-wiki page so resolveCategory
      // classifies by path and resolveDirection can read frontmatter from readVaultFile.
      readVaultMock.mockImplementation((path: string) => {
        if (path === 'knowledge/log.md') {
          return `# Log\n\n[2026-04-08 10:00] [INGEST] Test entry.\n  Sources: [[raw/articles/foo]]\n  Pages touched: [[wiki/entities/alice]]\n`;
        }
        if (path === 'knowledge/wiki/entities/alice.md') {
          return '---\ntype: entity\ncreated: 2026-04-08\nlast-verified: 2026-04-08\n---';
        }
        return null;
      });
      askClaudeCtxMock.mockResolvedValue({ text: 'Beginning.', error: null });

      await weeklyHandler.start(session, bot);

      expect(updateSessionMock).toHaveBeenCalledWith(100, {
        prepContext: expect.stringContaining('# KB Activity'),
      });
      expect(updateSessionMock).toHaveBeenCalledWith(100, {
        prepContext: expect.stringContaining('[[wiki/entities/alice]]'),
      });
    });

    // 3c. Suppresses the KB activity section when log.md has no entries in the window
    it('does not include KB activity section when log.md is empty in the window', async () => {
      const session = makeSession();
      runAgentMock.mockResolvedValue({ text: 'scan', error: null });
      readVaultMock.mockReturnValue(null); // log.md missing
      askClaudeCtxMock.mockResolvedValue({ text: 'Beginning.', error: null });

      await weeklyHandler.start(session, bot);

      // No call with a prepContext that includes "# KB Activity"
      const kbCalls = updateSessionMock.mock.calls.filter(
        (call) => typeof call[1]?.prepContext === 'string' && call[1].prepContext.includes('# KB Activity'),
      );
      expect(kbCalls).toHaveLength(0);
    });

    // 4. Reads SKILL.md from vault, builds system prompt
    it('reads SKILL.md from vault for interview instructions', async () => {
      const session = makeSession();
      runAgentMock.mockResolvedValue({ text: 'data', error: null });
      readVaultMock.mockReturnValue('## Step 2: Interview\nAsk about goals.\n## Step 4: Writeup');
      askClaudeCtxMock.mockResolvedValue({ text: 'Let us review.', error: null });

      await weeklyHandler.start(session, bot);

      expect(readVaultMock).toHaveBeenCalledWith('.claude/skills/weekly/SKILL.md');
      // System prompt passed to askClaudeWithContext should contain extracted instructions
      expect(askClaudeCtxMock).toHaveBeenCalledWith(
        expect.any(String),
        session.claudeSessionId,
        expect.stringContaining('Ask about goals'),
      );
    });

    // 5. Calls askClaudeWithContext to start interview
    it('calls askClaudeWithContext with begin message', async () => {
      const session = makeSession();
      runAgentMock.mockResolvedValue({ text: 'data', error: null });
      readVaultMock.mockReturnValue(null);
      askClaudeCtxMock.mockResolvedValue({ text: 'Welcome to the review.', error: null });

      await weeklyHandler.start(session, bot);

      expect(askClaudeCtxMock).toHaveBeenCalledWith(
        "Let's begin the weekly review.",
        session.claudeSessionId,
        expect.stringContaining('weekly review interview'),
      );
    });

    // 6. Transitions to 'interview' phase
    it('transitions to interview phase on success', async () => {
      const session = makeSession();
      runAgentMock.mockResolvedValue({ text: 'data', error: null });
      readVaultMock.mockReturnValue(null);
      askClaudeCtxMock.mockResolvedValue({ text: 'Let us start.', error: null });

      await weeklyHandler.start(session, bot);

      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'interview' });
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, 'Let us start.');
      expect(stopTypingMock).toHaveBeenCalledWith('typing-handle');
    });

    // 7. If both scanners fail -> sends error, sets phase to done
    it('sends error and sets done when both scanners fail', async () => {
      const session = makeSession();
      runAgentMock
        .mockResolvedValueOnce({ text: null, error: 'journal failed' })
        .mockResolvedValueOnce({ text: null, error: 'system failed' });

      await weeklyHandler.start(session, bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Prep agents failed. Cannot start review.');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
      expect(askClaudeCtxMock).not.toHaveBeenCalled();
      expect(stopTypingMock).toHaveBeenCalledWith('typing-handle');
    });

    // 8. Falls back to default instructions if SKILL.md not found
    it('uses default instructions when SKILL.md is not found', async () => {
      const session = makeSession();
      runAgentMock.mockResolvedValue({ text: 'data', error: null });
      readVaultMock.mockReturnValue(null);
      askClaudeCtxMock.mockResolvedValue({ text: 'Starting.', error: null });

      await weeklyHandler.start(session, bot);

      expect(askClaudeCtxMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.stringContaining('Conduct a weekly review interview'),
      );
    });

    // 9. If askClaudeWithContext fails -> sends error, sets phase to done
    it('sends error and sets done when askClaudeWithContext fails', async () => {
      const session = makeSession();
      runAgentMock.mockResolvedValue({ text: 'data', error: null });
      readVaultMock.mockReturnValue(null);
      askClaudeCtxMock.mockResolvedValue({ text: null, error: 'Claude down' });

      await weeklyHandler.start(session, bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Failed to start interview: Claude down');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
    });

    it('falls back gracefully when one scanner fails but the other succeeds', async () => {
      const session = makeSession();
      runAgentMock
        .mockResolvedValueOnce({ text: null, error: 'journal failed' })
        .mockResolvedValueOnce({ text: 'system data', error: null });
      readVaultMock.mockReturnValue(null);
      askClaudeCtxMock.mockResolvedValue({ text: 'Starting.', error: null });

      await weeklyHandler.start(session, bot);

      // Should still proceed (not both failed)
      expect(updateSessionMock).toHaveBeenCalledWith(100, {
        prepContext: expect.stringContaining('journal-scanner failed'),
      });
      expect(updateSessionMock).toHaveBeenCalledWith(100, {
        prepContext: expect.stringContaining('system data'),
      });
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'interview' });
    });

    it('sends initial notification', async () => {
      const session = makeSession();
      runAgentMock.mockResolvedValue({ text: 'data', error: null });
      readVaultMock.mockReturnValue(null);
      askClaudeCtxMock.mockResolvedValue({ text: 'Hi.', error: null });

      await weeklyHandler.start(session, bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(100, expect.stringContaining('weekly review'));
    });
  });

  describe('handleMessage - interview phase', () => {
    // 10. Relays message to askClaudeWithContext with system prompt
    it('relays user message to askClaudeWithContext', async () => {
      // First start a session to populate sessionPrompts
      const session = makeSession();
      runAgentMock.mockResolvedValue({ text: 'data', error: null });
      readVaultMock.mockReturnValue(null);
      askClaudeCtxMock.mockResolvedValue({ text: 'Welcome.', error: null });
      await weeklyHandler.start(session, bot);

      vi.clearAllMocks();
      startTypingMock.mockReturnValue('typing-handle');
      const interviewSession = makeSession({ phase: 'interview' });
      askClaudeCtxMock.mockResolvedValue({ text: 'Tell me more about projects.', error: null });

      await weeklyHandler.handleMessage(interviewSession, 'I worked on thesis', bot);

      expect(askClaudeCtxMock).toHaveBeenCalledWith(
        'I worked on thesis',
        session.claudeSessionId,
        expect.stringContaining('weekly review interview'),
      );
    });

    // 11. When response contains outline marker -> stores outline, transitions to approval
    it('detects outline and transitions to approval phase', async () => {
      const session = makeSession();
      runAgentMock.mockResolvedValue({ text: 'data', error: null });
      readVaultMock.mockReturnValue(null);
      askClaudeCtxMock.mockResolvedValue({ text: 'Welcome.', error: null });
      await weeklyHandler.start(session, bot);

      vi.clearAllMocks();
      startTypingMock.mockReturnValue('typing-handle');
      const interviewSession = makeSession({ phase: 'interview' });
      askClaudeCtxMock.mockResolvedValue({
        text: 'Great summary.\n\nWeek in Review outline:\n- Projects\n- Health',
        error: null,
      });

      await weeklyHandler.handleMessage(interviewSession, 'That covers everything', bot);

      expect(updateSessionMock).toHaveBeenCalledWith(100, {
        outline: 'Week in Review outline:\n- Projects\n- Health',
        phase: 'approval',
      });
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, expect.stringContaining('Week in Review outline:'));
      expect(bot.sendMessage).toHaveBeenCalledWith(100, expect.stringContaining('Reply *yes*'));
    });

    // 12. When response has no outline -> sends response, stays in interview
    it('stays in interview when no outline detected', async () => {
      const session = makeSession();
      runAgentMock.mockResolvedValue({ text: 'data', error: null });
      readVaultMock.mockReturnValue(null);
      askClaudeCtxMock.mockResolvedValue({ text: 'Welcome.', error: null });
      await weeklyHandler.start(session, bot);

      vi.clearAllMocks();
      startTypingMock.mockReturnValue('typing-handle');
      const interviewSession = makeSession({ phase: 'interview' });
      askClaudeCtxMock.mockResolvedValue({ text: 'What about your health this week?', error: null });

      await weeklyHandler.handleMessage(interviewSession, 'I did some running', bot);

      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, 'What about your health this week?');
      expect(updateSessionMock).not.toHaveBeenCalledWith(100, expect.objectContaining({ phase: 'approval' }));
    });

    // 13. Crash recovery: reconstructs system prompt from prepContext
    it('reconstructs system prompt from prepContext when missing', async () => {
      // Use a unique claudeSessionId that has no cached prompt (simulates process restart)
      const session = makeSession({ phase: 'interview', prepContext: 'recovered context data', claudeSessionId: 'fresh-restarted-session' });
      readVaultMock.mockReturnValue(null);
      askClaudeCtxMock.mockResolvedValue({ text: 'Continuing interview.', error: null });

      await weeklyHandler.handleMessage(session, 'Where were we?', bot);

      expect(readVaultMock).toHaveBeenCalledWith('.claude/skills/weekly/SKILL.md');
      expect(askClaudeCtxMock).toHaveBeenCalledWith(
        'Where were we?',
        session.claudeSessionId,
        expect.stringContaining('recovered context data'),
      );
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, 'Continuing interview.');
    });

    // 14. If system prompt and prepContext both missing -> error, sets done
    it('sends error when both system prompt and prepContext are missing', async () => {
      const session = makeSession({ phase: 'interview', prepContext: null, claudeSessionId: 'orphan-session' });

      await weeklyHandler.handleMessage(session, 'hello', bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(100, expect.stringContaining('Session error'));
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
    });

    it('sends error message when askClaudeWithContext returns error during interview', async () => {
      const session = makeSession({ phase: 'interview', prepContext: 'some context' });
      readVaultMock.mockReturnValue(null);
      askClaudeCtxMock.mockResolvedValue({ text: null, error: 'timeout' });

      await weeklyHandler.handleMessage(session, 'hello', bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Error: timeout');
      expect(stopTypingMock).toHaveBeenCalledWith('typing-handle');
    });
  });

  describe('handleMessage - approval phase', () => {
    // 15. "yes" -> calls runWriteupAndUpdates
    it('triggers writeup on "yes"', async () => {
      const session = makeSession({
        phase: 'approval',
        outline: 'Week in Review outline:\n- Projects',
        prepContext: 'prep data',
      });
      // review-writer success
      runAgentMock.mockResolvedValue({ text: 'Review written.', error: null });
      // askClaudeOneShot for analysis
      askClaudeOneShotMock.mockResolvedValue({
        text: '{"projects": false, "psychology": false, "json_updates": false}',
        error: null,
      });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'writeup' });
      expect(runAgentMock).toHaveBeenCalledWith('review-writer', expect.stringContaining('weekly'));
      expect(gitCommitMock).toHaveBeenCalledWith('Weekly review: 2026-04-10');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
    });

    it.each(['yes', 'y', 'approve', 'confirm', 'ok'])('accepts approval word: "%s"', async (word) => {
      const session = makeSession({
        phase: 'approval',
        outline: 'outline',
        prepContext: 'prep',
      });
      runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
      askClaudeOneShotMock.mockResolvedValue({ text: '{}', error: null });

      await weeklyHandler.handleMessage(session, word, bot);

      expect(runAgentMock).toHaveBeenCalledWith('review-writer', expect.any(String));
    });

    // 16. "cancel" -> sets done
    it('cancels review on "cancel"', async () => {
      const session = makeSession({ phase: 'approval', outline: 'outline' });

      await weeklyHandler.handleMessage(session, 'cancel', bot);

      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Weekly review cancelled.');
      expect(runAgentMock).not.toHaveBeenCalled();
    });

    it.each(['no', 'n', 'cancel', 'skip'])('accepts cancel word: "%s"', async (word) => {
      const session = makeSession({ phase: 'approval', outline: 'outline' });

      await weeklyHandler.handleMessage(session, word, bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Weekly review cancelled.');
    });

    // 17. Other text -> stores as edited outline, asks for confirmation
    it('stores edited outline on unrecognized text', async () => {
      const session = makeSession({ phase: 'approval', outline: 'old outline' });

      await weeklyHandler.handleMessage(session, 'Here is my revised outline with more detail', bot);

      expect(updateSessionMock).toHaveBeenCalledWith(100, {
        outline: 'Here is my revised outline with more detail',
      });
      expect(bot.sendMessage).toHaveBeenCalledWith(100, expect.stringContaining('Outline updated'));
    });
  });

  describe('handleMessage - writeup/updates phases', () => {
    // 18. Sends "Still processing..." message
    it('sends still processing for writeup phase', async () => {
      const session = makeSession({ phase: 'writeup' });

      await weeklyHandler.handleMessage(session, 'hello', bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Still processing... please wait.');
    });

    it('sends still processing for updates phase', async () => {
      const session = makeSession({ phase: 'updates' });

      await weeklyHandler.handleMessage(session, 'what is happening', bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Still processing... please wait.');
    });
  });

  describe('runWriteupAndUpdates (via approval "yes")', () => {
    function approvalSession(overrides: Partial<ReviewSession> = {}) {
      return makeSession({
        phase: 'approval',
        outline: 'Week in Review outline:\n- Item A\n- Item B',
        prepContext: 'Full prep context here',
        ...overrides,
      });
    }

    // 19. Spawns review-writer agent
    it('spawns review-writer with correct parameters', async () => {
      const session = approvalSession();
      runAgentMock.mockResolvedValue({ text: 'Written.', error: null });
      askClaudeOneShotMock.mockResolvedValue({ text: '{}', error: null });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(runAgentMock).toHaveBeenCalledWith('review-writer', expect.stringContaining('review_type: weekly'));
      expect(runAgentMock).toHaveBeenCalledWith('review-writer', expect.stringContaining('target_date: 2026-04-10'));
      expect(runAgentMock).toHaveBeenCalledWith('review-writer', expect.stringContaining('approved_outline:'));
      expect(runAgentMock).toHaveBeenCalledWith('review-writer', expect.stringContaining('conversation_context:'));
    });

    // 20. Uses askClaudeOneShot to determine needed post-agents
    it('asks Claude to determine which post agents to run', async () => {
      const session = approvalSession();
      runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
      askClaudeOneShotMock.mockResolvedValue({
        text: '{"projects": true, "psychology": false, "json_updates": false}',
        error: null,
      });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(askClaudeOneShotMock).toHaveBeenCalledWith(expect.stringContaining('post-interview updates'));
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'updates' });
    });

    // 21. Spawns post-interview agents in parallel based on analysis
    it('spawns only the agents flagged as needed', async () => {
      const session = approvalSession();
      // review-writer
      runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
      askClaudeOneShotMock.mockResolvedValue({
        text: '{"projects": true, "psychology": false, "json_updates": true}',
        error: null,
      });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      // review-writer + project-updater + json-updater = 3 calls (no psychology-updater, no worldview, no playbook)
      expect(runAgentMock).toHaveBeenCalledTimes(3);
      expect(runAgentMock).toHaveBeenCalledWith('project-updater', expect.any(String));
      expect(runAgentMock).toHaveBeenCalledWith('json-updater', expect.any(String));
      expect(runAgentMock).not.toHaveBeenCalledWith('psychology-updater', expect.any(String));
      expect(runAgentMock).not.toHaveBeenCalledWith('worldview-updater', expect.any(String));
      expect(runAgentMock).not.toHaveBeenCalledWith('playbook-updater', expect.any(String));
    });

    it('spawns worldview-updater when worldview flag is true', async () => {
      const session = approvalSession();
      runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
      askClaudeOneShotMock.mockResolvedValue({
        text: '{"projects": false, "psychology": false, "json_updates": false, "worldview": true, "playbook": false}',
        error: null,
      });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(runAgentMock).toHaveBeenCalledWith('worldview-updater', expect.any(String));
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, expect.stringContaining('Worldview updated.'));
    });

    it('spawns playbook-updater when playbook flag is true', async () => {
      const session = approvalSession();
      runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
      askClaudeOneShotMock.mockResolvedValue({
        text: '{"projects": false, "psychology": false, "json_updates": false, "worldview": false, "playbook": true}',
        error: null,
      });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(runAgentMock).toHaveBeenCalledWith('playbook-updater', expect.any(String));
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, expect.stringContaining('Playbook entries added.'));
    });

    it('enqueues playbook.md for KB ingestion after playbook-updater succeeds', async () => {
      const session = approvalSession();
      runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
      askClaudeOneShotMock.mockResolvedValue({
        text: '{"projects": false, "psychology": false, "json_updates": false, "worldview": false, "playbook": true}',
        error: null,
      });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(enqueueKBMock).toHaveBeenCalledWith('pages/playbook.md');
    });

    it('spawns proposal-updater and calls clearApprovedProposals when proposals flag is true', async () => {
      const { clearApprovedProposals } = await import('../jobs/proposal-queue.js');
      const session = approvalSession();
      runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
      askClaudeOneShotMock.mockResolvedValue({
        text: '{"projects": false, "psychology": false, "json_updates": false, "worldview": false, "playbook": false, "proposals": true}',
        error: null,
      });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(runAgentMock).toHaveBeenCalledWith('proposal-updater', expect.any(String));
      expect(vi.mocked(clearApprovedProposals)).toHaveBeenCalled();
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, expect.stringContaining('Ask-Twice proposals actioned'));
    });

    it('does NOT call clearApprovedProposals when proposal-updater fails', async () => {
      const { clearApprovedProposals } = await import('../jobs/proposal-queue.js');
      const session = approvalSession();
      runAgentMock
        .mockResolvedValueOnce({ text: 'Review written.', error: null })
        .mockResolvedValueOnce({ text: null, error: 'agent failed' });
      askClaudeOneShotMock.mockResolvedValue({
        text: '{"projects": false, "psychology": false, "json_updates": false, "worldview": false, "playbook": false, "proposals": true}',
        error: null,
      });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(vi.mocked(clearApprovedProposals)).not.toHaveBeenCalled();
    });

    it('enqueues touched project files for KB ingestion after project-updater succeeds', async () => {
      const session = approvalSession();
      runAgentMock
        .mockResolvedValueOnce({ text: 'Review written.', error: null })
        .mockResolvedValueOnce({ text: '## projects/project-alpha.md\n- Added weekly summary\n## projects/project-beta.md\n- Updated thesis', error: null });
      askClaudeOneShotMock.mockResolvedValue({
        text: '{"projects": true, "psychology": false, "json_updates": false, "worldview": false, "playbook": false}',
        error: null,
      });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(enqueueKBMock).toHaveBeenCalledWith('projects/project-alpha.md');
      expect(enqueueKBMock).toHaveBeenCalledWith('projects/project-beta.md');
    });

    it('enqueues touched world-view files for KB ingestion after worldview-updater succeeds', async () => {
      const session = approvalSession();
      runAgentMock
        .mockResolvedValueOnce({ text: 'Review written.', error: null })
        .mockResolvedValueOnce({ text: 'Modified world-view/ai.md with new paragraph on world models', error: null });
      askClaudeOneShotMock.mockResolvedValue({
        text: '{"projects": false, "psychology": false, "json_updates": false, "worldview": true, "playbook": false}',
        error: null,
      });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(enqueueKBMock).toHaveBeenCalledWith('world-view/ai.md');
    });

    it('does not enqueue archived projects', async () => {
      const session = approvalSession();
      runAgentMock
        .mockResolvedValueOnce({ text: 'Review written.', error: null })
        .mockResolvedValueOnce({ text: '## projects/archive/old.md\n- Shouldn\'t touch\n## projects/project-alpha.md\n- Should touch', error: null });
      askClaudeOneShotMock.mockResolvedValue({
        text: '{"projects": true, "psychology": false, "json_updates": false, "worldview": false, "playbook": false}',
        error: null,
      });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(enqueueKBMock).toHaveBeenCalledWith('projects/project-alpha.md');
      expect(enqueueKBMock).not.toHaveBeenCalledWith('projects/archive/old.md');
    });

    it('spawns all post agents when analysis parse fails', async () => {
      const session = approvalSession();
      runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
      askClaudeOneShotMock.mockResolvedValue({ text: 'not valid json', error: null });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      // review-writer + all 6 post agents = 7
      expect(runAgentMock).toHaveBeenCalledTimes(7);
      expect(runAgentMock).toHaveBeenCalledWith('project-updater', expect.any(String));
      expect(runAgentMock).toHaveBeenCalledWith('psychology-updater', expect.any(String));
      expect(runAgentMock).toHaveBeenCalledWith('json-updater', expect.any(String));
      expect(runAgentMock).toHaveBeenCalledWith('worldview-updater', expect.any(String));
      expect(runAgentMock).toHaveBeenCalledWith('playbook-updater', expect.any(String));
      expect(runAgentMock).toHaveBeenCalledWith('proposal-updater', expect.any(String));
    });

    it('spawns no post agents when none are flagged', async () => {
      const session = approvalSession();
      runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
      askClaudeOneShotMock.mockResolvedValue({
        text: '{"projects": false, "psychology": false, "json_updates": false}',
        error: null,
      });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      // Only review-writer
      expect(runAgentMock).toHaveBeenCalledTimes(1);
      expect(runAgentMock).toHaveBeenCalledWith('review-writer', expect.any(String));
    });

    // 22. Git commits
    it('git commits after all agents complete', async () => {
      const session = approvalSession();
      runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
      askClaudeOneShotMock.mockResolvedValue({ text: '{}', error: null });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(gitCommitMock).toHaveBeenCalledWith('Weekly review: 2026-04-10');
    });

    it('continues even if git commit fails', async () => {
      const session = approvalSession();
      runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
      askClaudeOneShotMock.mockResolvedValue({ text: '{}', error: null });
      gitCommitMock.mockImplementation(() => { throw new Error('git failed'); });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      // Should still complete
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, expect.stringContaining('Weekly review complete'));
    });

    // 23. Sends completion summary with accurate agent results
    it('sends summary with successful agent results', async () => {
      const session = approvalSession();
      runAgentMock.mockResolvedValue({ text: 'Done.', error: null });
      askClaudeOneShotMock.mockResolvedValue({
        text: '{"projects": true, "psychology": true, "json_updates": true}',
        error: null,
      });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, expect.stringContaining('Review written to journal.'));
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, expect.stringContaining('Project pages updated.'));
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, expect.stringContaining('Psychology profile updated.'));
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, expect.stringContaining('JSON data updated.'));
    });

    it('reports failed post agents in summary', async () => {
      const session = approvalSession();
      runAgentMock
        .mockResolvedValueOnce({ text: 'Review written.', error: null }) // review-writer
        .mockResolvedValueOnce({ text: null, error: 'project agent failed' }) // project-updater
        .mockResolvedValueOnce({ text: 'Updated.', error: null }); // json-updater
      askClaudeOneShotMock.mockResolvedValue({
        text: '{"projects": true, "psychology": false, "json_updates": true}',
        error: null,
      });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, expect.stringContaining('Project update failed.'));
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, expect.stringContaining('JSON data updated.'));
    });

    it('reports missing post agents distinctly from failures', async () => {
      const session = approvalSession();
      runAgentMock
        .mockResolvedValueOnce({ text: 'Review written.', error: null }) // review-writer
        .mockResolvedValueOnce({ text: null, error: 'Agent not found: project-updater' }) // missing agent file
        .mockResolvedValueOnce({ text: 'Updated.', error: null }); // json-updater
      askClaudeOneShotMock.mockResolvedValue({
        text: '{"projects": true, "psychology": false, "json_updates": true}',
        error: null,
      });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, expect.stringContaining('Projects skipped (agent missing)'));
      expect(sendLongMock).not.toHaveBeenCalledWith(bot, 100, expect.stringContaining('Project update failed.'));
      expect(sendLongMock).toHaveBeenCalledWith(bot, 100, expect.stringContaining('JSON data updated.'));
    });

    // 24. review-writer failure -> sends error, sets done
    it('sends error and sets done when review-writer fails', async () => {
      const session = approvalSession();
      runAgentMock.mockResolvedValue({ text: null, error: 'Writer crashed' });

      await weeklyHandler.handleMessage(session, 'yes', bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(100, 'Review write-up failed: Writer crashed');
      expect(updateSessionMock).toHaveBeenCalledWith(100, { phase: 'done' });
      // Should not proceed to post-agents or git
      expect(askClaudeOneShotMock).not.toHaveBeenCalled();
      expect(gitCommitMock).not.toHaveBeenCalled();
    });
  });

  describe('handleMessage - unexpected phase', () => {
    it('does not throw for unexpected phase', async () => {
      const session = makeSession({ phase: 'done' });
      await expect(weeklyHandler.handleMessage(session, 'hello', bot)).resolves.toBeUndefined();
    });
  });
});
