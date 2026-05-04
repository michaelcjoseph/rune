import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    { name: 'content-triager', kind: 'agent', description: 'Triage content.' },
  ]),
}));
vi.mock('../../utils/intent-log.js', () => ({ appendIntent: vi.fn() }));
vi.mock('../../integrations/telegram/client.js', () => ({
  sendLongMessage: vi.fn(),
  startTyping: vi.fn(() => setInterval(() => {}, 99999)),
  stopTyping: vi.fn((i: NodeJS.Timeout) => clearInterval(i)),
}));
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
vi.mock('../commands/study.js', () => ({ handleStudy: vi.fn() }));
vi.mock('../commands/health.js', () => ({ handleHealth: vi.fn() }));
vi.mock('../commands/blog.js', () => ({ handleBlog: vi.fn() }));
vi.mock('../commands/seed.js', () => ({ handleSeed: vi.fn() }));
vi.mock('../commands/priorities.js', () => ({ handlePriorities: vi.fn() }));
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
const { getSession, createSession } = await import('../../vault/sessions.js');
const { askClaudeWithContext } = await import('../../ai/claude.js');
const { hasActiveReview, handleReviewMessage } = await import('../../reviews/orchestrator.js');
const { handleTextMessage } = await import('./text.js');

function mockBot() {
  return { sendMessage: vi.fn().mockResolvedValue({}), sendChatAction: vi.fn().mockResolvedValue(true) } as any;
}

function msg(text: string, userId = 42): any {
  return { chat: { id: 100 }, from: { id: userId }, text };
}

describe('text handler routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ignores messages from unauthorized users', async () => {
    const bot = mockBot();
    await handleTextMessage(bot, msg('hello', 999));
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('routes /fresh', async () => {
    await handleTextMessage(mockBot(), msg('/fresh'));
    expect(handleFresh).toHaveBeenCalledWith(expect.anything(), 100);
  });

  it('routes /fresh-full before /fresh so the more-specific prefix wins', async () => {
    await handleTextMessage(mockBot(), msg('/fresh-full'));
    expect(handleFreshFull).toHaveBeenCalledWith(expect.anything(), 100);
    expect(handleFresh).not.toHaveBeenCalled();
  });

  it('routes /clear to handleClear', async () => {
    await handleTextMessage(mockBot(), msg('/clear'));
    expect(handleClear).toHaveBeenCalledWith(expect.anything(), 100);
  });

  it('/clear does not invoke handleFresh or handleFreshFull', async () => {
    await handleTextMessage(mockBot(), msg('/clear'));
    expect(handleFresh).not.toHaveBeenCalled();
    expect(handleFreshFull).not.toHaveBeenCalled();
  });

  it('/start help text includes /clear description', async () => {
    const bot = mockBot();
    await handleTextMessage(bot, msg('/start'));
    const helpText = bot.sendMessage.mock.calls[0][1] as string;
    expect(helpText).toContain('/clear');
    expect(helpText).toContain('discard active session');
  });

  it('routes /journal with text', async () => {
    await handleTextMessage(mockBot(), msg('/journal bought groceries'));
    expect(handleJournal).toHaveBeenCalledWith(expect.anything(), 100, 'bought groceries');
  });

  it('routes /ask with question', async () => {
    await handleTextMessage(mockBot(), msg('/ask meaning of life'));
    expect(handleAsk).toHaveBeenCalledWith(expect.anything(), 100, 'meaning of life');
  });

  it('routes /kb with args', async () => {
    await handleTextMessage(mockBot(), msg('/kb query test'));
    expect(handleKB).toHaveBeenCalledWith(expect.anything(), 100, 'query test');
  });

  it('routes /ingest with path', async () => {
    await handleTextMessage(mockBot(), msg('/ingest raw/test.md'));
    expect(handleIngest).toHaveBeenCalledWith(expect.anything(), 100, 'raw/test.md');
  });

  it('routes /status', async () => {
    await handleTextMessage(mockBot(), msg('/status'));
    expect(handleStatus).toHaveBeenCalledWith(expect.anything(), 100);
  });

  it('routes /learn with text', async () => {
    await handleTextMessage(mockBot(), msg('/learn prefer terse answers'));
    expect(handleLearn).toHaveBeenCalledWith(expect.anything(), 100, 'prefer terse answers');
  });

  it('routes bare /learn as empty-args (usage hint path)', async () => {
    await handleTextMessage(mockBot(), msg('/learn'));
    expect(handleLearn).toHaveBeenCalledWith(expect.anything(), 100, '');
  });

  it('routes /learn-list to its own handler, not /learn', async () => {
    await handleTextMessage(mockBot(), msg('/learn-list'));
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
    await handleTextMessage(mockBot(), msg('/learning curve question'));
    expect(handleLearn).not.toHaveBeenCalled();
  });

  it('routes /start and sends help', async () => {
    const bot = mockBot();
    await handleTextMessage(bot, msg('/start'));
    expect(bot.sendMessage).toHaveBeenCalledWith(100, expect.stringContaining('Commands:'));
  });

  it('routes /lint', async () => {
    const bot = mockBot();
    await handleTextMessage(bot, msg('/lint'));
    const { sendLongMessage } = await import('../../integrations/telegram/client.js');
    expect(sendLongMessage).toHaveBeenCalledWith(expect.anything(), 100, 'clean');
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

    await handleTextMessage(mockBot(), msg('hello'));
    expect(createSessionMock).toHaveBeenCalled();
    expect(askMock).toHaveBeenCalledWith('hello', 'test-sess', expect.any(String), 'haiku', expect.any(Array));
  });

  it('appends the mode-visibility footer to conversation replies', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    const { sendLongMessage } = await import('../../integrations/telegram/client.js');
    const sendLongMock = sendLongMessage as unknown as ReturnType<typeof vi.fn>;

    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'test-sess',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'hello',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'hi there!', error: null });

    await handleTextMessage(mockBot(), msg('hello'));
    const reply = sendLongMock.mock.calls.at(-1)?.[2] as string;
    expect(reply).toContain('hi there!');
    expect(reply).toContain('— chatting · /fresh to end');
  });

  it('ignores empty text', async () => {
    const bot = mockBot();
    await handleTextMessage(bot, msg(''));
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('routes to review handler when review is active and message is not a command', async () => {
    const hasActiveReviewMock = hasActiveReview as unknown as ReturnType<typeof vi.fn>;
    const handleReviewMessageMock = handleReviewMessage as unknown as ReturnType<typeof vi.fn>;
    hasActiveReviewMock.mockReturnValue(true);
    handleReviewMessageMock.mockResolvedValue(undefined);

    const bot = mockBot();
    await handleTextMessage(bot, msg('looks good to me'));

    expect(hasActiveReviewMock).toHaveBeenCalledWith(100);
    expect(handleReviewMessageMock).toHaveBeenCalledWith(100, 'looks good to me', bot);
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

    await handleTextMessage(mockBot(), msg('some text'));

    const handleReviewMessageMock = handleReviewMessage as unknown as ReturnType<typeof vi.fn>;
    expect(handleReviewMessageMock).not.toHaveBeenCalled();
    expect(askMock).toHaveBeenCalledWith('some text', 'test-sess', expect.any(String), 'haiku', expect.any(Array));
  });

  it('routes /fresh to command handler even during active review', async () => {
    const hasActiveReviewMock = hasActiveReview as unknown as ReturnType<typeof vi.fn>;
    hasActiveReviewMock.mockReturnValue(true);

    await handleTextMessage(mockBot(), msg('/fresh'));

    expect(handleFresh).toHaveBeenCalledWith(expect.anything(), 100);
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
    await handleTextMessage(mockBot(), msg('short msg here'));
    expect(mockClassify).not.toHaveBeenCalled();
    expect(appendIntent).not.toHaveBeenCalled();
  });

  it('calls the resolver for messages at or above the word-count threshold', async () => {
    vi.mocked(mockClassify).mockResolvedValue(classifyResult({ confidence: 0 }));
    await handleTextMessage(mockBot(), msg('one two three four five'));
    expect(mockClassify).toHaveBeenCalled();
  });

  it('invokes handleJournal when the resolver returns a slash kind with high confidence', async () => {
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({ skill: 'journal', args: '11am, called dad', confidence: 0.95 }),
    );
    await handleTextMessage(mockBot(), msg('add this to my journal: 11am, called dad'));
    expect(handleJournal).toHaveBeenCalledWith(expect.anything(), 100, '11am, called dad');
  });

  it('falls through to conversation for KB-shaped questions (kb_query is no longer a route)', async () => {
    // kb_query was removed from the registry; the classifier mock will likely
    // return a non-existent skill name for KB-shaped messages, which the
    // dispatcher must report as "failed" and let fall through to chat.
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({ skill: 'kb_query', args: 'what do I know about world models', confidence: 0.9 }),
    );
    await handleTextMessage(mockBot(), msg('what do I know about world models'));
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
    await handleTextMessage(mockBot(), msg('classify this content for me please'));
    expect(runAgent).toHaveBeenCalledWith('content-triager', 'some link');
  });

  it('falls through to conversation when confidence < threshold', async () => {
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({ skill: 'journal', confidence: 0.5 }),
    );
    await handleTextMessage(mockBot(), msg('this is a five word test'));
    expect(handleJournal).not.toHaveBeenCalled();
    expect(askClaudeWithContext).toHaveBeenCalled();
  });

  it('falls through with disambiguation note when top-2 is ambiguous', async () => {
    const bot = mockBot();
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({
        skill: 'journal',
        second_skill: 'weekly',
        confidence: 0.72,
        second_confidence: 0.71,
        ambiguous: true,
      }),
    );
    await handleTextMessage(bot, msg('this could go either way honestly'));
    expect(handleJournal).not.toHaveBeenCalled();
    const notice = bot.sendMessage.mock.calls[0][1] as string;
    expect(notice).toContain('/journal');
    expect(notice).toContain('/weekly');
    expect(askClaudeWithContext).toHaveBeenCalled();
  });

  it('appends an intent log entry on every resolver call — outcome routed', async () => {
    vi.mocked(mockClassify).mockResolvedValue(classifyResult({ confidence: 0.95 }));
    await handleTextMessage(mockBot(), msg('one two three four five'));
    expect(appendIntent).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendIntent).mock.calls[0]![0];
    expect(entry.outcome).toBe('routed');
    expect(entry.skill_invoked).toBe('journal');
    expect(entry.confidence).toBe(0.95);
  });

  it('appends outcome=low_confidence when classification is below threshold', async () => {
    vi.mocked(mockClassify).mockResolvedValue(classifyResult({ confidence: 0.3 }));
    await handleTextMessage(mockBot(), msg('one two three four five'));
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
    await handleTextMessage(mockBot(), msg('one two three four five'));
    expect(vi.mocked(appendIntent).mock.calls[0]![0].outcome).toBe('ambiguous');
    expect(vi.mocked(appendIntent).mock.calls[0]![0].skill_invoked).toBeNull();
  });

  it('appends outcome=failed when the routed skill throws', async () => {
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({ skill: 'family', confidence: 0.9 }),
    );
    vi.mocked(handleFamily).mockRejectedValueOnce(new Error('boom'));
    await handleTextMessage(mockBot(), msg('what did I note about family'));
    const entry = vi.mocked(appendIntent).mock.calls[0]![0];
    expect(entry.outcome).toBe('failed');
    expect(entry.skill_invoked).toBe('family');
    // Still falls through to conversation so user is not silent-failed.
    expect(askClaudeWithContext).toHaveBeenCalled();
  });

  it('does NOT call the resolver when an active review is in progress', async () => {
    const hasActiveReviewMock = hasActiveReview as unknown as ReturnType<typeof vi.fn>;
    hasActiveReviewMock.mockReturnValue(true);
    await handleTextMessage(mockBot(), msg('one two three four five'));
    expect(mockClassify).not.toHaveBeenCalled();
    expect(appendIntent).not.toHaveBeenCalled();
  });

  it('does NOT call the resolver for slash commands', async () => {
    await handleTextMessage(mockBot(), msg('/weekly 2025-W10'));
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('logs failed outcome when the resolver picks a skill not in the registry', async () => {
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({ skill: 'ghost-skill', confidence: 0.9 }),
    );
    await handleTextMessage(mockBot(), msg('one two three four five'));
    const entry = vi.mocked(appendIntent).mock.calls[0]![0];
    expect(entry.outcome).toBe('failed');
    expect(entry.skill_invoked).toBe('ghost-skill');
  });

  it('shows slash labels for both skills in the ambiguity notice', async () => {
    const bot = mockBot();
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({
        skill: 'family',
        second_skill: 'journal',
        confidence: 0.72,
        second_confidence: 0.70,
        ambiguous: true,
      }),
    );
    await handleTextMessage(bot, msg('one two three four five six'));
    const notice = bot.sendMessage.mock.calls[0][1] as string;
    expect(notice).toContain('/family');
    expect(notice).toContain('/journal');
  });

  it('falls through cleanly when classifyIntent itself throws', async () => {
    vi.mocked(mockClassify).mockRejectedValue(new Error('classifier exploded'));
    await handleTextMessage(mockBot(), msg('one two three four five'));
    // Outer try/catch in tryResolveAndDispatch must swallow the throw and
    // allow the freeform fallback to run; the Telegram polling loop must not
    // see an uncaught rejection.
    expect(askClaudeWithContext).toHaveBeenCalled();
    // No intent-log entry is emitted when the classifier throws before we
    // know the outcome — the log only captures completed classifications.
    expect(appendIntent).not.toHaveBeenCalled();
  });
});
