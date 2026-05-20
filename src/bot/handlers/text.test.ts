import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

vi.mock('../../config.js', () => ({
  default: {
    TELEGRAM_USER_ID: 42,
    VAULT_DIR: '/test/vault',
    TIMEZONE: 'America/Chicago',
    RESOLVER_MIN_WORDS: 5,
    RESOLVER_CONFIDENCE_THRESHOLD: 0.7,
    RESOLVER_AMBIGUITY_DELTA: 0.05,
  },
}));

vi.mock('../../vault/sessions.js', () => ({
  getSession: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  setSessionModel: vi.fn(),
  appendMessageToSession: vi.fn(),
}));
vi.mock('../../ai/claude.js', () => ({
  askClaude: vi.fn(),
  askClaudeWithContext: vi.fn(),
  runAgent: vi.fn(),
}));
vi.mock('../resolver.js', () => ({ classifyIntent: vi.fn() }));
vi.mock('../skill-registry.js', () => ({
  getSkillRegistry: vi.fn(() => [
    { name: 'journal', kind: 'slash', description: 'Add to journal.' },
    { name: 'weekly', kind: 'slash', description: 'Weekly review.' },
    { name: 'family', kind: 'slash', description: 'Family mentions.' },
    { name: 'syllabus', kind: 'slash', description: 'Study syllabus.' },
    { name: 'content-triager', kind: 'agent', description: 'Triage content.' },
  ]),
}));
vi.mock('../../utils/intent-log.js', () => ({ appendIntent: vi.fn() }));
vi.mock('../commands/fresh.js', () => ({ handleFresh: vi.fn() }));
vi.mock('../commands/fresh-full.js', () => ({ handleFreshFull: vi.fn() }));
vi.mock('../commands/clear.js', () => ({ handleClear: vi.fn() }));
vi.mock('../commands/journal.js', () => ({ handleJournal: vi.fn() }));
vi.mock('../commands/ask.js', () => ({ handleAsk: vi.fn() }));
vi.mock('../commands/status.js', () => ({ handleStatus: vi.fn() }));
vi.mock('../commands/kb.js', () => ({ handleKB: vi.fn() }));
vi.mock('../commands/ingest.js', () => ({ handleIngest: vi.fn() }));
vi.mock('../commands/prep.js', () => ({ handlePrep: vi.fn() }));
vi.mock('../commands/daily.js', () => ({ handleDaily: vi.fn() }));
vi.mock('../commands/weekly.js', () => ({ handleWeekly: vi.fn() }));
vi.mock('../commands/monthly.js', () => ({ handleMonthly: vi.fn() }));
vi.mock('../commands/quarterly.js', () => ({ handleQuarterly: vi.fn() }));
vi.mock('../commands/yearly.js', () => ({ handleYearly: vi.fn() }));
vi.mock('../commands/learn.js', () => ({ handleLearn: vi.fn() }));
vi.mock('../commands/learn-list.js', () => ({ handleLearnList: vi.fn() }));
vi.mock('../commands/family.js', () => ({ handleFamily: vi.fn() }));
vi.mock('../commands/career.js', () => ({ handleCareer: vi.fn() }));
vi.mock('../commands/workout.js', () => ({ handleWorkout: vi.fn() }));
vi.mock('../commands/syllabus.js', () => ({ handleSyllabus: vi.fn() }));
vi.mock('../commands/health.js', () => ({ handleHealth: vi.fn() }));
vi.mock('../commands/blog.js', () => ({ handleBlog: vi.fn() }));
vi.mock('../commands/seed.js', () => ({ handleSeed: vi.fn() }));
vi.mock('../commands/priorities.js', () => ({ handlePriorities: vi.fn() }));
vi.mock('../commands/cancel.js', () => ({ handleCancel: vi.fn() }));
vi.mock('../commands/new-project.js', () => ({ handleNewProject: vi.fn() }));
vi.mock('../../reviews/new-project.js', () => ({}));
vi.mock('../../kb/engine.js', () => ({ lintKB: vi.fn().mockResolvedValue({ report: 'clean' }) }));
vi.mock('../../reviews/orchestrator.js', () => ({
  hasActiveReview: vi.fn(() => false),
  handleReviewMessage: vi.fn(),
  registerReviewHandler: vi.fn(),
}));

const { classifyIntent: mockClassify } = await import('../resolver.js');
const { appendIntent } = await import('../../utils/intent-log.js');
const { runAgent } = await import('../../ai/claude.js');
const { handleFamily } = await import('../commands/family.js');
const { handleFresh } = await import('../commands/fresh.js');
const { handleFreshFull } = await import('../commands/fresh-full.js');
const { handleClear } = await import('../commands/clear.js');
const { handleJournal } = await import('../commands/journal.js');
const { handleAsk } = await import('../commands/ask.js');
const { handleStatus } = await import('../commands/status.js');
const { handleKB } = await import('../commands/kb.js');
const { handleIngest } = await import('../commands/ingest.js');
const { handleLearn } = await import('../commands/learn.js');
const { handleLearnList } = await import('../commands/learn-list.js');
const { handleCancel } = await import('../commands/cancel.js');
const { handleNewProject } = await import('../commands/new-project.js');
const { handleSyllabus } = await import('../commands/syllabus.js');
const { getSession, createSession } = await import('../../vault/sessions.js');
const { askClaudeWithContext } = await import('../../ai/claude.js');
const { hasActiveReview, handleReviewMessage } = await import('../../reviews/orchestrator.js');
const { handleTextMessage, dispatchText } = await import('./text.js');

function mockSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

function msg(text: string, userId = 42): any {
  return { chat: { id: 100 }, from: { id: userId }, text };
}

describe('text handler routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ignores messages from unauthorized users', async () => {
    const sender = mockSender();
    await handleTextMessage(sender, msg('hello', 999));
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('routes /fresh', async () => {
    await handleTextMessage(mockSender(), msg('/fresh'));
    expect(handleFresh).toHaveBeenCalledWith(expect.anything(), 100, 'telegram');
  });

  it('routes /fresh-full before /fresh so the more-specific prefix wins', async () => {
    await handleTextMessage(mockSender(), msg('/fresh-full'));
    expect(handleFreshFull).toHaveBeenCalledWith(expect.anything(), 100, 'telegram');
    expect(handleFresh).not.toHaveBeenCalled();
  });

  it('routes /clear to handleClear', async () => {
    await handleTextMessage(mockSender(), msg('/clear'));
    expect(handleClear).toHaveBeenCalledWith(expect.anything(), 100, 'telegram');
  });

  it('/clear does not invoke handleFresh or handleFreshFull', async () => {
    await handleTextMessage(mockSender(), msg('/clear'));
    expect(handleFresh).not.toHaveBeenCalled();
    expect(handleFreshFull).not.toHaveBeenCalled();
  });

  it('/start help text includes /clear description', async () => {
    const sender = mockSender();
    await handleTextMessage(sender, msg('/start'));
    const helpText = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(helpText).toContain('/clear');
    expect(helpText).toContain('discard active session');
  });

  it('routes bare /cancel to handleCancel with empty arg', async () => {
    await handleTextMessage(mockSender(), msg('/cancel'));
    expect(handleCancel).toHaveBeenCalledWith(expect.anything(), 100, '');
  });

  it('routes /cancel <prefix> to handleCancel with the prefix arg', async () => {
    await handleTextMessage(mockSender(), msg('/cancel abc123de'));
    expect(handleCancel).toHaveBeenCalledWith(expect.anything(), 100, 'abc123de');
  });

  it('/cancel does not invoke handleClear', async () => {
    await handleTextMessage(mockSender(), msg('/cancel'));
    expect(handleClear).not.toHaveBeenCalled();
  });

  it('routes /journal with text', async () => {
    await handleTextMessage(mockSender(), msg('/journal bought groceries'));
    expect(handleJournal).toHaveBeenCalledWith(expect.anything(), 100, 'telegram', 'bought groceries');
  });

  it('routes /ask with question', async () => {
    await handleTextMessage(mockSender(), msg('/ask meaning of life'));
    expect(handleAsk).toHaveBeenCalledWith(expect.anything(), 100, 'meaning of life');
  });

  it('routes /kb with args', async () => {
    await handleTextMessage(mockSender(), msg('/kb query test'));
    expect(handleKB).toHaveBeenCalledWith(expect.anything(), 100, 'query test');
  });

  it('routes /ingest with path', async () => {
    await handleTextMessage(mockSender(), msg('/ingest raw/test.md'));
    expect(handleIngest).toHaveBeenCalledWith(expect.anything(), 100, 'raw/test.md');
  });

  it('routes /status', async () => {
    await handleTextMessage(mockSender(), msg('/status'));
    expect(handleStatus).toHaveBeenCalledWith(expect.anything(), 100, 'telegram');
  });

  it('routes /learn with text', async () => {
    await handleTextMessage(mockSender(), msg('/learn prefer terse answers'));
    expect(handleLearn).toHaveBeenCalledWith(expect.anything(), 100, 'prefer terse answers');
  });

  it('routes bare /learn as empty-args (usage hint path)', async () => {
    await handleTextMessage(mockSender(), msg('/learn'));
    expect(handleLearn).toHaveBeenCalledWith(expect.anything(), 100, '');
  });

  it('routes /learn-list to its own handler, not /learn', async () => {
    await handleTextMessage(mockSender(), msg('/learn-list'));
    expect(handleLearnList).toHaveBeenCalledWith(expect.anything(), 100);
    expect(handleLearn).not.toHaveBeenCalled();
  });

  it('does not mistakenly route /learning as /learn', async () => {
    // "/learning" does not equal '/learn' and does not start with '/learn ',
    // so it should fall through to conversation, not invoke handleLearn.
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'test-sess',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: '/learning',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'ok', error: null });
    await handleTextMessage(mockSender(), msg('/learning curve question'));
    expect(handleLearn).not.toHaveBeenCalled();
  });

  it('routes /new-project to handleNewProject with no args', async () => {
    await handleTextMessage(mockSender(), msg('/new-project'));
    expect(handleNewProject).toHaveBeenCalledWith(expect.anything(), 100, '');
  });

  it('routes /new-project with topic args', async () => {
    await handleTextMessage(mockSender(), msg('/new-project email digest feature'));
    expect(handleNewProject).toHaveBeenCalledWith(expect.anything(), 100, 'email digest feature');
  });

  it('routes /syllabus to handleSyllabus', async () => {
    await handleTextMessage(mockSender(), msg('/syllabus'));
    expect(handleSyllabus).toHaveBeenCalledWith(expect.anything(), 100);
  });

  it('routes /start and sends help listing /syllabus', async () => {
    const sender = mockSender();
    await handleTextMessage(sender, msg('/start'));
    const helpText = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(helpText).toContain('**Commands**');
    expect(helpText).toContain('/syllabus');
  });

  it('routes /lint', async () => {
    const sender = mockSender();
    await handleTextMessage(sender, msg('/lint'));
    expect(sender.send).toHaveBeenCalledWith(100, 'clean');
  });

  it('falls through to conversation for plain text', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;

    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'test-sess',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'hello',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'hi there!', error: null });

    await handleTextMessage(mockSender(), msg('hello'));
    expect(createSessionMock).toHaveBeenCalled();
    expect(askMock).toHaveBeenCalledWith('hello', 'test-sess', expect.any(String), { model: 'haiku', allowedTools: expect.any(Array), opLabel: 'chat', voice: true });
  });

  it('appends the mode-visibility footer to conversation replies', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;

    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'test-sess',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'hello',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'hi there!', error: null });

    const sender = mockSender();
    await handleTextMessage(sender, msg('hello'));
    const reply = vi.mocked(sender.send).mock.calls.at(-1)?.[1] as string;
    expect(reply).toContain('hi there!');
    expect(reply).toContain('— chatting · /fresh to end');
  });

  it('ignores empty text', async () => {
    const sender = mockSender();
    await handleTextMessage(sender, msg(''));
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('routes to review handler when review is active and message is not a command', async () => {
    const hasActiveReviewMock = hasActiveReview as unknown as ReturnType<typeof vi.fn>;
    const handleReviewMessageMock = handleReviewMessage as unknown as ReturnType<typeof vi.fn>;
    hasActiveReviewMock.mockReturnValue(true);
    handleReviewMessageMock.mockResolvedValue(undefined);

    const sender = mockSender();
    await handleTextMessage(sender, msg('looks good to me'));

    expect(hasActiveReviewMock).toHaveBeenCalledWith(100);
    expect(handleReviewMessageMock).toHaveBeenCalledWith(100, 'looks good to me', sender);
    // Should NOT fall through to conversation
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    expect(askMock).not.toHaveBeenCalled();
  });

  it('falls through to conversation when no active review', async () => {
    const hasActiveReviewMock = hasActiveReview as unknown as ReturnType<typeof vi.fn>;
    hasActiveReviewMock.mockReturnValue(false);

    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;

    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'test-sess',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'some text',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'reply', error: null });

    await handleTextMessage(mockSender(), msg('some text'));

    const handleReviewMessageMock = handleReviewMessage as unknown as ReturnType<typeof vi.fn>;
    expect(handleReviewMessageMock).not.toHaveBeenCalled();
    expect(askMock).toHaveBeenCalledWith('some text', 'test-sess', expect.any(String), { model: 'haiku', allowedTools: expect.any(Array), opLabel: 'chat', voice: true });
  });

  it('routes /fresh to command handler even during active review', async () => {
    const hasActiveReviewMock = hasActiveReview as unknown as ReturnType<typeof vi.fn>;
    hasActiveReviewMock.mockReturnValue(true);

    await handleTextMessage(mockSender(), msg('/fresh'));

    expect(handleFresh).toHaveBeenCalledWith(expect.anything(), 100, 'telegram');
    const handleReviewMessageMock = handleReviewMessage as unknown as ReturnType<typeof vi.fn>;
    expect(handleReviewMessageMock).not.toHaveBeenCalled();
  });
});

describe('resolver wiring in text handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const hasActiveReviewMock = hasActiveReview as unknown as ReturnType<typeof vi.fn>;
    hasActiveReviewMock.mockReturnValue(false);

    // Default session setup so the freeform fallback path is exercisable.
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'sess',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'x',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'ok', error: null });
  });

  function classifyResult(overrides: Record<string, unknown> = {}) {
    return {
      skill: 'journal',
      args: '',
      confidence: 0.9,
      second_skill: null,
      second_confidence: 0,
      ambiguous: false,
      raw: '',
      ...overrides,
    };
  }

  it('skips the resolver for messages below the word-count threshold', async () => {
    await handleTextMessage(mockSender(), msg('short msg here'));
    expect(mockClassify).not.toHaveBeenCalled();
    expect(appendIntent).not.toHaveBeenCalled();
  });

  it('calls the resolver for messages at or above the word-count threshold', async () => {
    vi.mocked(mockClassify).mockResolvedValue(classifyResult({ confidence: 0 }));
    await handleTextMessage(mockSender(), msg('one two three four five'));
    expect(mockClassify).toHaveBeenCalled();
  });

  it('invokes handleJournal when the resolver returns a slash kind with high confidence', async () => {
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({ skill: 'journal', args: '11am, called dad', confidence: 0.95 }),
    );
    await handleTextMessage(mockSender(), msg('add this to my journal: 11am, called dad'));
    expect(handleJournal).toHaveBeenCalledWith(expect.anything(), 100, 'telegram', '11am, called dad');
  });

  it('routes resolver-dispatched syllabus skill to handleSyllabus via invokeSkill', async () => {
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({ skill: 'syllabus', args: '', confidence: 0.9 }),
    );
    await handleTextMessage(mockSender(), msg('show me my current study syllabus please'));
    expect(handleSyllabus).toHaveBeenCalledWith(expect.anything(), 100);
  });

  it('falls through to conversation for KB-shaped questions (kb_query is no longer a route)', async () => {
    // kb_query was removed from the registry; the classifier mock will likely
    // return a non-existent skill name for KB-shaped messages, which the
    // dispatcher must report as "failed" and let fall through to chat.
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({ skill: 'kb_query', args: 'what do I know about world models', confidence: 0.9 }),
    );
    await handleTextMessage(mockSender(), msg('what do I know about world models'));
    expect(handleKB).not.toHaveBeenCalled();
    expect(askClaudeWithContext).toHaveBeenCalled();
    // The intent log records the failure so it is auditable.
    const entry = vi.mocked(appendIntent).mock.calls[0]![0];
    expect(entry.outcome).toBe('failed');
    expect(entry.skill_invoked).toBe('kb_query');
  });

  it('invokes runAgent when the resolver returns an agent kind', async () => {
    vi.mocked(runAgent).mockResolvedValue({ text: 'triage output', error: null });
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({ skill: 'content-triager', args: 'some link', confidence: 0.9 }),
    );
    await handleTextMessage(mockSender(), msg('classify this content for me please'));
    expect(runAgent).toHaveBeenCalledWith('content-triager', 'some link');
  });

  it('falls through to conversation when confidence < threshold', async () => {
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({ skill: 'journal', confidence: 0.5 }),
    );
    await handleTextMessage(mockSender(), msg('this is a five word test'));
    expect(handleJournal).not.toHaveBeenCalled();
    expect(askClaudeWithContext).toHaveBeenCalled();
  });

  it('falls through with disambiguation note when top-2 is ambiguous', async () => {
    const sender = mockSender();
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({
        skill: 'journal',
        second_skill: 'weekly',
        confidence: 0.72,
        second_confidence: 0.71,
        ambiguous: true,
      }),
    );
    await handleTextMessage(sender, msg('this could go either way honestly'));
    expect(handleJournal).not.toHaveBeenCalled();
    const notice = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(notice).toContain('/journal');
    expect(notice).toContain('/weekly');
    expect(askClaudeWithContext).toHaveBeenCalled();
  });

  it('appends an intent log entry on every resolver call — outcome routed', async () => {
    vi.mocked(mockClassify).mockResolvedValue(classifyResult({ confidence: 0.95 }));
    await handleTextMessage(mockSender(), msg('one two three four five'));
    expect(appendIntent).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendIntent).mock.calls[0]![0];
    expect(entry.outcome).toBe('routed');
    expect(entry.skill_invoked).toBe('journal');
    expect(entry.confidence).toBe(0.95);
  });

  it('appends outcome=low_confidence when classification is below threshold', async () => {
    vi.mocked(mockClassify).mockResolvedValue(classifyResult({ confidence: 0.3 }));
    await handleTextMessage(mockSender(), msg('one two three four five'));
    expect(appendIntent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendIntent).mock.calls[0]![0].outcome).toBe('low_confidence');
    expect(vi.mocked(appendIntent).mock.calls[0]![0].skill_invoked).toBeNull();
  });

  it('appends outcome=ambiguous when top-2 is within delta', async () => {
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({
        skill: 'journal',
        second_skill: 'weekly',
        confidence: 0.72,
        second_confidence: 0.71,
        ambiguous: true,
      }),
    );
    await handleTextMessage(mockSender(), msg('one two three four five'));
    expect(vi.mocked(appendIntent).mock.calls[0]![0].outcome).toBe('ambiguous');
    expect(vi.mocked(appendIntent).mock.calls[0]![0].skill_invoked).toBeNull();
  });

  it('appends outcome=failed when the routed skill throws', async () => {
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({ skill: 'family', confidence: 0.9 }),
    );
    vi.mocked(handleFamily).mockRejectedValueOnce(new Error('boom'));
    await handleTextMessage(mockSender(), msg('what did I note about family'));
    const entry = vi.mocked(appendIntent).mock.calls[0]![0];
    expect(entry.outcome).toBe('failed');
    expect(entry.skill_invoked).toBe('family');
    // Still falls through to conversation so user is not silent-failed.
    expect(askClaudeWithContext).toHaveBeenCalled();
  });

  it('does NOT call the resolver when an active review is in progress', async () => {
    const hasActiveReviewMock = hasActiveReview as unknown as ReturnType<typeof vi.fn>;
    hasActiveReviewMock.mockReturnValue(true);
    await handleTextMessage(mockSender(), msg('one two three four five'));
    expect(mockClassify).not.toHaveBeenCalled();
    expect(appendIntent).not.toHaveBeenCalled();
  });

  it('does NOT call the resolver for slash commands', async () => {
    await handleTextMessage(mockSender(), msg('/weekly 2025-W10'));
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('logs failed outcome when the resolver picks a skill not in the registry', async () => {
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({ skill: 'ghost-skill', confidence: 0.9 }),
    );
    await handleTextMessage(mockSender(), msg('one two three four five'));
    const entry = vi.mocked(appendIntent).mock.calls[0]![0];
    expect(entry.outcome).toBe('failed');
    expect(entry.skill_invoked).toBe('ghost-skill');
  });

  it('shows slash labels for both skills in the ambiguity notice', async () => {
    const sender = mockSender();
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({
        skill: 'family',
        second_skill: 'journal',
        confidence: 0.72,
        second_confidence: 0.70,
        ambiguous: true,
      }),
    );
    await handleTextMessage(sender, msg('one two three four five six'));
    const notice = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(notice).toContain('/family');
    expect(notice).toContain('/journal');
  });

  it('falls through cleanly when classifyIntent itself throws', async () => {
    vi.mocked(mockClassify).mockRejectedValue(new Error('classifier exploded'));
    await handleTextMessage(mockSender(), msg('one two three four five'));
    // Outer try/catch in tryResolveAndDispatch must swallow the throw and
    // allow the freeform fallback to run; the Telegram polling loop must not
    // see an uncaught rejection.
    expect(askClaudeWithContext).toHaveBeenCalled();
    // No intent-log entry is emitted when the classifier throws before we
    // know the outcome — the log only captures completed classifications.
    expect(appendIntent).not.toHaveBeenCalled();
  });

  describe('invokeSkill — agent kind: startTyping/stopTyping wrapping', () => {
    function agentClassifyResult(overrides: Record<string, unknown> = {}) {
      return {
        skill: 'content-triager',
        args: 'some link',
        confidence: 0.9,
        second_skill: null,
        second_confidence: 0,
        ambiguous: false,
        raw: '',
        ...overrides,
      };
    }

    it('calls startTyping with no explicit label before invoking runAgent (op-event fills it in)', async () => {
      vi.mocked(runAgent).mockResolvedValue({ text: 'result', error: null });
      vi.mocked(mockClassify).mockResolvedValue(agentClassifyResult());

      const sender = mockSender();
      await handleTextMessage(sender, msg('classify this content for me please'));

      // No label passed — runAgent's op-event:start carries the friendly phrase from op-labels.ts.
      expect(sender.startTyping).toHaveBeenCalledWith(100);
    });

    it('calls stopTyping after runAgent succeeds', async () => {
      vi.mocked(runAgent).mockResolvedValue({ text: 'result', error: null });
      vi.mocked(mockClassify).mockResolvedValue(agentClassifyResult());

      const sender = mockSender();
      await handleTextMessage(sender, msg('classify this content for me please'));

      expect(sender.stopTyping).toHaveBeenCalledWith(100);
    });

    it('calls stopTyping in the finally block even when runAgent returns an error', async () => {
      vi.mocked(runAgent).mockResolvedValue({ text: null, error: 'agent failed' });
      vi.mocked(mockClassify).mockResolvedValue(agentClassifyResult());

      const sender = mockSender();
      // The skill throw is caught by tryResolveAndDispatch; no uncaught rejection
      await handleTextMessage(sender, msg('classify this content for me please'));

      expect(sender.stopTyping).toHaveBeenCalledWith(100);
    });

    it('calls stopTyping in the finally block when runAgent throws', async () => {
      vi.mocked(runAgent).mockRejectedValue(new Error('spawn failed'));
      vi.mocked(mockClassify).mockResolvedValue(agentClassifyResult());

      const sender = mockSender();
      await handleTextMessage(sender, msg('classify this content for me please'));

      expect(sender.stopTyping).toHaveBeenCalledWith(100);
    });
  });
});

describe('handleConversation — startTyping label', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const hasActiveReviewMock = hasActiveReview as unknown as ReturnType<typeof vi.fn>;
    hasActiveReviewMock.mockReturnValue(false);
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'conv-sess',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'hi',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'hello back', error: null });
  });

  it('calls startTyping with "Asking Claude" for conversation turn', async () => {
    const sender = mockSender();
    await handleTextMessage(sender, msg('hi there'));

    expect(sender.startTyping).toHaveBeenCalledWith(100, 'Asking Claude');
  });

  it('does not call startTyping with the old "Thinking…" label', async () => {
    const sender = mockSender();
    await handleTextMessage(sender, msg('hi there'));

    const calls = vi.mocked(sender.startTyping).mock.calls;
    expect(calls.every(([, label]) => label !== 'Thinking…')).toBe(true);
  });
});

describe('handleLint — startTyping label', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const hasActiveReviewMock = hasActiveReview as unknown as ReturnType<typeof vi.fn>;
    hasActiveReviewMock.mockReturnValue(false);
  });

  it('calls startTyping with the knowledge base label when /lint is invoked', async () => {
    const sender = mockSender();
    await handleTextMessage(sender, msg('/lint'));

    expect(sender.startTyping).toHaveBeenCalledWith(100, 'Checking knowledge base');
  });

  it('sends the lint report after lintKB completes', async () => {
    const sender = mockSender();
    await handleTextMessage(sender, msg('/lint'));

    expect(sender.send).toHaveBeenCalledWith(100, 'clean');
  });
});

describe('VAULT_SYSTEM_PROMPT_BASE — kb_query guidance', () => {
  // These tests verify the updated system prompt content introduced in the diff:
  // the KB section was expanded from a single MCP TOOLS line into structured
  // bullet points that make kb_query the first move for domain questions.
  beforeEach(() => {
    vi.clearAllMocks();
    const hasActiveReviewMock = hasActiveReview as unknown as ReturnType<typeof vi.fn>;
    hasActiveReviewMock.mockReturnValue(false);
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'prompt-sess',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'hello',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'ok', error: null });
  });

  it('passes a system prompt that names kb_query as the FIRST move for domain questions', async () => {
    await handleTextMessage(mockSender(), msg('hello there'));
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    const systemPrompt = askMock.mock.calls[0]![2] as string;
    // The updated prompt makes kb_query the explicit first move
    expect(systemPrompt).toContain('kb_query');
    expect(systemPrompt).toMatch(/FIRST move/i);
  });

  it('passes a system prompt that includes kb_search bullet with tag-filter description', async () => {
    await handleTextMessage(mockSender(), msg('hello there'));
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    const systemPrompt = askMock.mock.calls[0]![2] as string;
    expect(systemPrompt).toContain('kb_search');
    // The new bullet explicitly mentions type/tag filtering
    expect(systemPrompt).toContain('type (entity/concept/topic/comparison)');
  });

  it('passes a system prompt that includes "When to skip the KB" guidance', async () => {
    await handleTextMessage(mockSender(), msg('hello there'));
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    const systemPrompt = askMock.mock.calls[0]![2] as string;
    // New bullet added in the diff
    expect(systemPrompt).toContain('When to skip the KB');
  });

  it('passes a system prompt that frames kb_query output as synthesis-quality', async () => {
    await handleTextMessage(mockSender(), msg('hello there'));
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    const systemPrompt = askMock.mock.calls[0]![2] as string;
    // The softened phrasing — allows minimal adaptation but discourages re-querying.
    expect(systemPrompt).toContain('synthesis-quality');
    expect(systemPrompt).toContain('adapt minimally');
  });
});

describe('dispatchText — active-session bypass (new behavior)', () => {
  // When an in-flight chat session exists the resolver must be skipped entirely
  // and the message must be routed directly to handleConversation. This prevents
  // continuation messages in an active thread from being hijacked by the resolver
  // at ≥0.7 confidence and accidentally closing the session.
  beforeEach(() => {
    vi.clearAllMocks();
    const hasActiveReviewMock = hasActiveReview as unknown as ReturnType<typeof vi.fn>;
    hasActiveReviewMock.mockReturnValue(false);
  });

  it('skips the resolver when a session is active and goes straight to conversation', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;

    // Session already exists — continuation message
    getSessionMock.mockReturnValue({
      sessionId: 'existing-sess',
      lastActivity: new Date().toISOString(),
      messageCount: 3,
      firstMessage: 'earlier message',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'reply', error: null });

    const sender = mockSender();
    // Long enough message that the resolver would normally run (≥5 words)
    await dispatchText(sender, 100, 'one two three four five words here');

    // Resolver must NOT have been called
    expect(mockClassify).not.toHaveBeenCalled();
    // Conversation path was taken (askClaudeWithContext invoked)
    expect(askMock).toHaveBeenCalled();
  });

  it('does NOT bypass the resolver when no session exists', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;

    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'new-sess',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'x',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'ok', error: null });
    vi.mocked(mockClassify).mockResolvedValue({
      skill: 'journal',
      args: '',
      confidence: 0,
      second_skill: null,
      second_confidence: 0,
      ambiguous: false,
      raw: '',
    });

    const sender = mockSender();
    await dispatchText(sender, 100, 'one two three four five words here');

    // Resolver was called because no session was active
    expect(mockClassify).toHaveBeenCalled();
  });
});

describe('dispatchText — webview transport derivation', () => {
  // sender.name === 'webview' must cause transport='webview' to be derived.
  // Commands that accept a transport argument must receive 'webview', not 'telegram'.
  beforeEach(() => {
    vi.clearAllMocks();
    const hasActiveReviewMock = hasActiveReview as unknown as ReturnType<typeof vi.fn>;
    hasActiveReviewMock.mockReturnValue(false);
  });

  function webviewSender(): MessageSender {
    return {
      name: 'webview' as const,
      send: vi.fn().mockResolvedValue(undefined),
      startTyping: vi.fn(),
      stopTyping: vi.fn(),
    };
  }

  it('derives transport=webview from sender.name for /fresh', async () => {
    await dispatchText(webviewSender(), 100, '/fresh');
    expect(handleFresh).toHaveBeenCalledWith(expect.anything(), 100, 'webview');
  });

  it('derives transport=webview from sender.name for /fresh-full', async () => {
    await dispatchText(webviewSender(), 100, '/fresh-full');
    expect(handleFreshFull).toHaveBeenCalledWith(expect.anything(), 100, 'webview');
  });

  it('derives transport=webview from sender.name for /clear', async () => {
    await dispatchText(webviewSender(), 100, '/clear');
    expect(handleClear).toHaveBeenCalledWith(expect.anything(), 100, 'webview');
  });

  it('derives transport=webview from sender.name for /journal', async () => {
    await dispatchText(webviewSender(), 100, '/journal bought coffee');
    expect(handleJournal).toHaveBeenCalledWith(expect.anything(), 100, 'webview', 'bought coffee');
  });

  it('derives transport=webview from sender.name for /status', async () => {
    await dispatchText(webviewSender(), 100, '/status');
    expect(handleStatus).toHaveBeenCalledWith(expect.anything(), 100, 'webview');
  });

  it('derives transport=telegram for any non-webview sender name', async () => {
    // A hypothetical future sender name that is not 'webview' should still
    // derive telegram transport (the else branch of the ternary).
    const unknownSender: MessageSender = {
      name: 'telegram' as const,
      send: vi.fn().mockResolvedValue(undefined),
      startTyping: vi.fn(),
      stopTyping: vi.fn(),
    };
    await dispatchText(unknownSender, 100, '/fresh');
    expect(handleFresh).toHaveBeenCalledWith(expect.anything(), 100, 'telegram');
  });

  it('passes webview transport to handleConversation → createSession', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;

    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'web-sess',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'hi from webview',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'hi back', error: null });

    await dispatchText(webviewSender(), 100, 'hi from webview');

    // createSession must have been called with 'webview' transport (4th arg is model from config, may be undefined in test env)
    expect(createSessionMock).toHaveBeenCalledOnce();
    const [uid, transport, firstMsg] = createSessionMock.mock.calls[0] as [number, string, string];
    expect(uid).toBe(100);
    expect(transport).toBe('webview');
    expect(firstMsg).toBe('hi from webview');
  });
});
