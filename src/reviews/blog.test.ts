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

// The writer-role loader is mocked so the wiring tests control SOUL/memory
// deterministically — independent of whatever `agents/writer/{SOUL,memory}.md`
// happen to be on disk in this repo (memory.md may not exist yet pre-seed).
vi.mock('../writer/memory.js', () => ({
  composeWriterContext: vi.fn(),
}));

// Phase 2 closure seams — mocked so the sentinel/capture handler tests assert
// blogHandler's behavior without real sentinel parsing, capture, or git commits.
vi.mock('../writer/sentinel.js', () => ({
  detectCompletionSentinel: vi.fn(),
  WRITER_COMPLETION_SENTINEL: '[[WRITER_MEMORY_COMPLETE]]',
}));
vi.mock('../writer/capture.js', () => ({
  captureLessons: vi.fn(),
}));

// --- Imports ---

const { registerReviewHandler } = await import('./orchestrator.js');
const { updateReviewSession } = await import('./session.js');
const { askClaudeWithContext } = await import('../ai/claude.js');
const { readVaultFile } = await import('../vault/files.js');
const { composeWriterContext } = await import('../writer/memory.js');
const { detectCompletionSentinel } = await import('../writer/sentinel.js');
const { captureLessons } = await import('../writer/capture.js');

const registerMock = registerReviewHandler as ReturnType<typeof vi.fn>;
const updateSessionMock = updateReviewSession as ReturnType<typeof vi.fn>;
const askClaudeMock = askClaudeWithContext as ReturnType<typeof vi.fn>;
const readVaultMock = readVaultFile as ReturnType<typeof vi.fn>;
const composeMock = composeWriterContext as ReturnType<typeof vi.fn>;
const sentinelMock = detectCompletionSentinel as ReturnType<typeof vi.fn>;
const captureMock = captureLessons as ReturnType<typeof vi.fn>;

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
    // Default: SOUL prefixes the base instructions on the system channel; memory
    // is empty (cold start) so the user turn stays exactly the topic line. The
    // base flows through verbatim so the existing system-prompt assertions hold.
    composeMock.mockImplementation((base: string) => ({
      systemInstructions: `WRITER-SOUL-MARKER\n\n${base}`,
      referenceContext: '',
    }));
    armClosureMocks();
  });

  // Re-armable defaults: no sentinel (normal turn) → cleaned === input; capture
  // is a resolved no-op. Hoisted into a helper so the mid-test vi.clearAllMocks()
  // calls below can restore them (otherwise blog.ts's detectCompletionSentinel
  // call would destructure undefined once the handler is implemented).
  function armClosureMocks() {
    sentinelMock.mockImplementation((t: string) => ({ complete: false, cleaned: t }));
    captureMock.mockResolvedValue({ captured: [], committed: false });
  }

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
      expect(readVaultMock).toHaveBeenCalledWith('writing/topics.md');
      expect(sender.send).toHaveBeenCalledWith(100, 'Blog session started: "why testing matters"\nSend /done when finished.');
      expect(sender.startTyping).toHaveBeenCalledWith(100);
      expect(askClaudeMock).toHaveBeenCalledWith(
        'I want to write about: why testing matters',
        'claude-blog-001',
        expect.stringContaining('Custom blog skill instructions'),
        { opLabel: 'review:blog', voice: true },
      );
      // Topic queue is still inlined in the system prompt; writing voice is
      // now injected centrally via the `voice: true` flag (asserted above).
      expect(askClaudeMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.stringContaining('- testing'),
        { opLabel: 'review:blog', voice: true },
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
        { opLabel: 'review:blog', voice: true },
      );
      expect(askClaudeMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.stringContaining('No artifacts or documents until I approve the outline'),
        { opLabel: 'review:blog', voice: true },
      );
    });

    it('opts the blog session into the writing-voice prepend', async () => {
      // Voice.md is no longer inlined here; it's injected centrally inside
      // askClaudeWithContext when the `voice: true` flag is passed. The flag
      // is the contract this handler owes the user — assert it directly.
      const session = makeSession({ topic: 'some topic' });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'Response', error: null });

      await blogHandler.start(session, sender);

      expect(askClaudeMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        { opLabel: 'review:blog', voice: true },
      );
    });
  });

  describe('writer-memory wiring', () => {
    it('injects fenced memory into the first user turn, not the system prompt', async () => {
      const session = makeSession({ topic: 'compounding memory' });
      readVaultMock.mockReturnValue(null);
      composeMock.mockReturnValue({
        systemInstructions: 'WRITER-SOUL-MARKER\n\nbase instructions',
        referenceContext: '<writer-memory>\nWRITER-MEMORY-MARKER lesson\n</writer-memory>',
      });
      askClaudeMock.mockResolvedValue({ text: 'ok', error: null });

      await blogHandler.start(session, sender);

      // askClaudeWithContext signature: (message, sessionId, systemPrompt, opts)
      const firstCall = askClaudeMock.mock.calls[0]!;
      const [userTurn, , systemPrompt] = firstCall;
      // Memory rides the low-authority user turn alongside the topic line...
      expect(userTurn).toContain('WRITER-MEMORY-MARKER');
      expect(userTurn).toContain('I want to write about: compounding memory');
      // ...and the system prompt carries SOUL + base only — memory absent from it.
      expect(systemPrompt).toBe('WRITER-SOUL-MARKER\n\nbase instructions');
      expect(systemPrompt).not.toContain('WRITER-MEMORY-MARKER');
    });

    it('persists systemInstructions (no memory) as prepContext for recovery', async () => {
      const session = makeSession({ topic: 'recovery' });
      readVaultMock.mockReturnValue(null);
      composeMock.mockReturnValue({
        systemInstructions: 'WRITER-SOUL-MARKER\n\nbase',
        referenceContext: '<writer-memory>\nWRITER-MEMORY-MARKER\n</writer-memory>',
      });
      askClaudeMock.mockResolvedValue({ text: 'ok', error: null });

      await blogHandler.start(session, sender);

      // The exact-match pins prepContext to the memory-free systemInstructions —
      // recovery (handleMessage) reads prepContext verbatim, so memory can never
      // reach the system channel on resume.
      expect(updateSessionMock).toHaveBeenCalledWith(100, { prepContext: 'WRITER-SOUL-MARKER\n\nbase' });
    });

    it('cold start (empty memory) → first user turn is just the topic line, no fence', async () => {
      const session = makeSession({ topic: 'cold' });
      readVaultMock.mockReturnValue(null);
      composeMock.mockReturnValue({ systemInstructions: 'SOUL\n\nbase', referenceContext: '' });
      askClaudeMock.mockResolvedValue({ text: 'ok', error: null });

      await blogHandler.start(session, sender);

      const [userTurn] = askClaudeMock.mock.calls[0]!;
      expect(userTurn).toBe('I want to write about: cold');
    });

    it('passes the base blog instructions through composeWriterContext', async () => {
      const session = makeSession({ topic: 'x' });
      readVaultMock.mockImplementation((path: string) =>
        path === '.claude/skills/blog/SKILL.md' ? 'Custom blog skill instructions' : null,
      );
      askClaudeMock.mockResolvedValue({ text: 'ok', error: null });

      await blogHandler.start(session, sender);

      expect(composeMock).toHaveBeenCalledWith(expect.stringContaining('Custom blog skill instructions'));
    });
  });

  describe('completion sentinel (Phase 2)', () => {
    async function startSession(topic = 'sentinel topic') {
      const session = makeSession({ topic });
      readVaultMock.mockReturnValue(null);
      askClaudeMock.mockResolvedValue({ text: 'Initial', error: null });
      await blogHandler.start(session, sender);
      vi.clearAllMocks();
      sender = makeSender();
      // Re-arm defaults cleared above; individual tests override sentinelMock and,
      // when they assert on it, captureMock.
      armClosureMocks();
      composeMock.mockImplementation((base: string) => ({ systemInstructions: base, referenceContext: '' }));
      return session;
    }

    it('closes the session and triggers capture when the assistant emits the sentinel', async () => {
      const session = await startSession();
      const rawWithSentinel = 'Final draft is ready.\n\n[[WRITER_MEMORY_COMPLETE]]';
      askClaudeMock.mockResolvedValue({ text: rawWithSentinel, error: null });
      sentinelMock.mockReturnValue({ complete: true, cleaned: 'Final draft is ready.' });

      await blogHandler.handleMessage(session, 'looks good, ship it', sender);

      // Capture runs exactly once, fed the raw assistant text (with the block).
      expect(captureMock).toHaveBeenCalledTimes(1);
      expect(captureMock).toHaveBeenCalledWith(
        expect.objectContaining({ assistantText: rawWithSentinel }),
      );
      // Session is closed server-side — no reliance on a literal assistant "/done".
      expect(updateSessionMock).toHaveBeenCalledWith(session.chatId, { phase: 'done' });
    });

    it('sends the sentinel-stripped reply, never the raw sentinel text', async () => {
      const session = await startSession();
      askClaudeMock.mockResolvedValue({ text: 'Done.\n\n[[WRITER_MEMORY_COMPLETE]]', error: null });
      sentinelMock.mockReturnValue({ complete: true, cleaned: 'Done.' });

      await blogHandler.handleMessage(session, 'great', sender);

      const sent = (sender.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]).join('\n');
      expect(sent).not.toContain('[[WRITER_MEMORY_COMPLETE]]');
      expect(sender.send).toHaveBeenCalledWith(session.chatId, 'Done.');
    });

    it('does not capture or close on a normal turn (no final-line sentinel)', async () => {
      const session = await startSession();
      askClaudeMock.mockResolvedValue({ text: 'What about the ending?', error: null });
      sentinelMock.mockReturnValue({ complete: false, cleaned: 'What about the ending?' });

      await blogHandler.handleMessage(session, 'still drafting', sender);

      expect(captureMock).not.toHaveBeenCalled();
      expect(updateSessionMock).not.toHaveBeenCalledWith(session.chatId, { phase: 'done' });
      expect(sender.send).toHaveBeenCalledWith(session.chatId, 'What about the ending?');
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
      armClosureMocks();
      askClaudeMock.mockResolvedValue({ text: 'Great point, what about X?', error: null });

      await blogHandler.handleMessage(session, 'The key argument is Y', sender);

      expect(sender.startTyping).toHaveBeenCalledWith(session.chatId);
      expect(askClaudeMock).toHaveBeenCalledWith(
        'The key argument is Y',
        'claude-blog-001',
        expect.stringContaining('test topic'),
        { opLabel: 'review:blog', voice: true },
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
      armClosureMocks();

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
        { opLabel: 'review:blog', voice: true },
      );
      expect(sender.send).toHaveBeenCalledWith(100, 'Continuing the conversation');
    });
  });
});
