import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

const mockStartReview = vi.hoisted(() => vi.fn());
const mockHandleBlog = vi.hoisted(() => vi.fn());

vi.mock('../../config.js', () => ({
  PROJECT_ROOT: '/test/project',
  default: {
    TELEGRAM_USER_ID: 42,
    VAULT_DIR: '/test/vault',
    LOGS_DIR: '/test/logs',
    WORKSPACE_DIR: '/test/workspace',
    PRODUCT_CHAT_FALLBACK_ROOT: '/test/fallback-product-chats',
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
  setSessionExecutor: vi.fn(),
  getSessionMessages: vi.fn(() => []),
  appendMessageToSession: vi.fn(),
  buildSessionSystemPrompt: vi.fn(({ scope }: { scope?: { kind: string; product?: string } } = {}) => [
    'You are Rune, the user\'s second-brain conversational layer.',
    'KNOWLEDGE BASE: kb_query is your FIRST move for domain questions.',
    'kb_search supports type (entity/concept/topic/comparison) and tag filters.',
    'When to skip the KB: named files and structured JSON stores.',
    'The answer is synthesis-quality; adapt minimally.',
    scope?.kind === 'product'
      ? `PRODUCT CHAT: Active product: ${scope.product}. Search the product repo and the second brain via the rune-kb MCP.`
      : '',
  ].join('\n')),
  resolveProductChat: vi.fn((product: string) => ({
    workspace: {
      repoRoot: `/workspace/${product}`,
      workRoot: product === 'writing' ? `/workspace/${product}/docs/rune` : `/workspace/${product}`,
      ...(product === 'writing' ? { scopePath: 'docs/rune' } : {}),
    },
    productContext: {
      product,
      repoPath: `/workspace/${product}`,
      repoDocs: [],
      projects: [],
      worldview: [],
    },
  })),
  resolveProductFallbackWorkspace: vi.fn((product: string) => ({
    repoRoot: `/test/fallback-product-chats/${product}`,
    workRoot: `/test/fallback-product-chats/${product}`,
  })),
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
    { name: 'study', kind: 'slash', description: 'Spaced-repetition quiz session over due wiki concepts.' },
    { name: 'content-triager', kind: 'agent', description: 'Triage content.' },
  ]),
}));
vi.mock('../../utils/intent-log.js', () => ({ appendIntent: vi.fn() }));
vi.mock('../../utils/observation-log.js', () => ({ appendInteraction: vi.fn() }));
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
vi.mock('../commands/done-workout.js', () => ({ handleDoneWorkout: vi.fn() }));
vi.mock('../commands/syllabus.js', () => ({ handleSyllabus: vi.fn() }));
vi.mock('../commands/study.js', () => ({ handleStudy: vi.fn() }));
vi.mock('../commands/health.js', () => ({ handleHealth: vi.fn() }));
vi.mock('../commands/writing-critique.js', () => ({ handleWritingCritique: vi.fn() }));
vi.mock('../commands/seed.js', () => ({ handleSeed: vi.fn() }));
vi.mock('../commands/priorities.js', () => ({ handlePriorities: vi.fn() }));
vi.mock('../commands/cancel.js', () => ({ handleCancel: vi.fn() }));
vi.mock('../commands/new-project.js', () => ({ handleNewProject: vi.fn() }));
vi.mock('../../reviews/new-project.js', () => ({}));
vi.mock('../commands/plan.js', () => ({ handlePlan: vi.fn() }));
vi.mock('../commands/approve.js', () => ({ handleApprove: vi.fn() }));
vi.mock('../../reviews/planning.js', () => ({
  getActivePlanningSession: vi.fn(() => null),
  deletePlanningSession: vi.fn(),
}));
vi.mock('../../reviews/planning-handler.js', () => ({
  handlePlanningTurn: vi.fn(),
  defaultScopingTurn: vi.fn(),
}));
vi.mock('../../kb/engine.js', () => ({ lintKB: vi.fn().mockResolvedValue({ report: 'clean' }) }));
vi.mock('../../reviews/orchestrator.js', () => ({
  startReview: mockStartReview,
  hasActiveReview: vi.fn(() => false),
  handleReviewMessage: vi.fn(),
  registerReviewHandler: vi.fn(),
}));
// handleBlog is mocked like the other command modules — its own unit suite
// (blog.test.ts) pins the createMutation('writing', …) dispatch it performs.
vi.mock('../commands/blog.js', () => ({ handleBlog: mockHandleBlog }));
vi.mock('../../study/sr-session.js', () => ({
  hasActiveSRSession: vi.fn(() => false),
  handleSRMessage: vi.fn(),
}));
vi.mock('./url.js', () => ({
  containsURL: vi.fn((text: string) => /https?:\/\//.test(text)),
  handleURLMessage: vi.fn().mockResolvedValue(undefined),
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
const { handlePlan } = await import('../commands/plan.js');
const { handleApprove } = await import('../commands/approve.js');
const { getActivePlanningSession } = await import('../../reviews/planning.js');
const { handlePlanningTurn } = await import('../../reviews/planning-handler.js');
const { handleSyllabus } = await import('../commands/syllabus.js');
const { handleStudy } = await import('../commands/study.js');
const { handleWritingCritique } = await import('../commands/writing-critique.js');
const {
  getSession,
  createSession,
  appendMessageToSession,
  updateSession,
  setSessionModel,
  buildSessionSystemPrompt,
  resolveProductFallbackWorkspace,
  resolveProductChat,
} = await import('../../vault/sessions.js');
const { askClaudeWithContext } = await import('../../ai/claude.js');
const { hasActiveReview, handleReviewMessage } = await import('../../reviews/orchestrator.js');
const { hasActiveSRSession, handleSRMessage } = await import('../../study/sr-session.js');
const { handleURLMessage } = await import('./url.js');
const { appendInteraction } = await import('../../utils/observation-log.js');
const { handleTextMessage, dispatchText } = await import('./text.js');

const retiredBrand = ['Jar', 'vis'].join('');
const retiredProductSlug = retiredBrand.toLowerCase();
const retiredMcpTool = (name: string) => `mcp__${retiredProductSlug}-kb__${name}`;

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
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call state but preserves mockReturnValue/mockImplementation;
    // re-prime the active-session probes to their "nothing active" defaults so
    // tests that override them don't leak into siblings.
    (getActivePlanningSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (handlePlanningTurn as unknown as ReturnType<typeof vi.fn>).mockReset();
    (hasActiveReview as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (hasActiveSRSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

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

  it('routes /gpt-5.6-terra to the chat model switch', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const setSessionModelMock = setSessionModel as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue(null);
    await handleTextMessage(mockSender(), msg('/gpt-5.6-terra'));
    expect(setSessionModelMock).toHaveBeenCalledWith(100, 'telegram', 'gpt-5.6-terra');
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

  it('routes /plan to handlePlan with empty args', async () => {
    await handleTextMessage(mockSender(), msg('/plan'));
    expect(handlePlan).toHaveBeenCalledWith(expect.anything(), 100, '');
  });

  it('routes /plan with product arg to handlePlan', async () => {
    await handleTextMessage(mockSender(), msg('/plan aura'));
    expect(handlePlan).toHaveBeenCalledWith(expect.anything(), 100, 'aura');
  });

  it('routes /plan with multi-word arg to handlePlan', async () => {
    await handleTextMessage(mockSender(), msg('/plan rune 08-intent-layer'));
    expect(handlePlan).toHaveBeenCalledWith(expect.anything(), 100, 'rune 08-intent-layer');
  });

  it('active planning session takes routing priority over default conversation', async () => {
    const getActivePlanningSessionMock = getActivePlanningSession as unknown as ReturnType<typeof vi.fn>;
    const handlePlanningTurnMock = handlePlanningTurn as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;

    getActivePlanningSessionMock.mockReturnValue({
      id: 'plan-sess-001',
      chatId: 100,
      claudeSessionId: 'claude-001',
      planning: { status: 'scoping', product: 'aura', idea: '', surface: 'chat', history: [], createdAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    });
    handlePlanningTurnMock.mockResolvedValue({ reply: 'What is the core problem you want to solve?', status: 'scoping' });
    getSessionMock.mockReturnValue(null);

    const sender = mockSender();
    await handleTextMessage(sender, msg('I want to build a new feature'));

    expect(handlePlanningTurnMock).toHaveBeenCalled();
    // Default conversation path must NOT have been taken
    expect(askMock).not.toHaveBeenCalled();
    // The planning turn reply should have been sent to the user
    expect(sender.send).toHaveBeenCalledWith(100, 'What is the core problem you want to solve?');
  });

  it('active planning session does not affect routing for other users', async () => {
    const getActivePlanningSessionMock = getActivePlanningSession as unknown as ReturnType<typeof vi.fn>;
    const handlePlanningTurnMock = handlePlanningTurn as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;

    // Planning session exists for chatId 100 only — return null for chatId 999
    getActivePlanningSessionMock.mockImplementation((chatId: number) => {
      if (chatId === 100) {
        return {
          id: 'plan-sess-001',
          chatId: 100,
          claudeSessionId: 'claude-001',
          planning: { status: 'scoping', product: 'aura', idea: '', surface: 'chat', history: [], createdAt: new Date().toISOString() },
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
        };
      }
      return null;
    });
    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'conv-sess-999',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'hello from other user',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'reply to other user', error: null });

    // Message from chatId 999 (a different user) — override chat.id
    const msgFrom999 = {
      message_id: 1,
      date: 1,
      chat: { id: 999, type: 'private' as const },
      from: { id: 42, is_bot: false, first_name: 'Test' },
      text: 'hello from other user',
    };
    await handleTextMessage(mockSender(), msgFrom999);

    // Planning turn must NOT have been invoked for the other user's message
    expect(handlePlanningTurnMock).not.toHaveBeenCalled();
    // Normal conversation flow ran for chatId 999
    expect(askMock).toHaveBeenCalled();
  });

  it('slash commands short-circuit before active-planning-session check', async () => {
    const getActivePlanningSessionMock = getActivePlanningSession as unknown as ReturnType<typeof vi.fn>;
    const handlePlanningTurnMock = handlePlanningTurn as unknown as ReturnType<typeof vi.fn>;

    // Even with an active planning session, /fresh routes to handleFresh
    getActivePlanningSessionMock.mockReturnValue({
      id: 'plan-sess-002',
      chatId: 100,
      claudeSessionId: 'claude-002',
      planning: { status: 'scoping', product: 'rune', idea: '', surface: 'chat', history: [], createdAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    });

    await handleTextMessage(mockSender(), msg('/fresh'));

    expect(handleFresh).toHaveBeenCalledWith(expect.anything(), 100, 'telegram');
    expect(handlePlanningTurnMock).not.toHaveBeenCalled();
  });

  it('/clear short-circuits before active-planning-session check', async () => {
    const getActivePlanningSessionMock = getActivePlanningSession as unknown as ReturnType<typeof vi.fn>;
    const handlePlanningTurnMock = handlePlanningTurn as unknown as ReturnType<typeof vi.fn>;

    getActivePlanningSessionMock.mockReturnValue({
      id: 'plan-sess-003',
      chatId: 100,
      claudeSessionId: 'claude-003',
      planning: { status: 'scoping', product: 'rune', idea: '', surface: 'chat', history: [], createdAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    });

    await handleTextMessage(mockSender(), msg('/clear'));

    expect(handleClear).toHaveBeenCalledWith(expect.anything(), 100, 'telegram');
    expect(handlePlanningTurnMock).not.toHaveBeenCalled();
  });

  it('active planning session does not block /plan itself — /plan rune routes to handlePlan', async () => {
    const getActivePlanningSessionMock = getActivePlanningSession as unknown as ReturnType<typeof vi.fn>;
    const handlePlanningTurnMock = handlePlanningTurn as unknown as ReturnType<typeof vi.fn>;

    // An existing active session does not stop /plan from re-routing to handlePlan
    getActivePlanningSessionMock.mockReturnValue({
      id: 'plan-sess-004',
      chatId: 100,
      claudeSessionId: 'claude-004',
      planning: { status: 'scoping', product: 'aura', idea: '', surface: 'chat', history: [], createdAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    });

    await handleTextMessage(mockSender(), msg('/plan rune'));

    expect(handlePlan).toHaveBeenCalledWith(expect.anything(), 100, 'rune');
    expect(handlePlanningTurnMock).not.toHaveBeenCalled();
  });

  it('routes /approve to handleApprove', async () => {
    await handleTextMessage(mockSender(), msg('/approve'));
    expect(handleApprove).toHaveBeenCalledWith(expect.anything(), 100);
  });

  it('/approve takes priority over active planning routing', async () => {
    const getActivePlanningSessionMock = getActivePlanningSession as unknown as ReturnType<typeof vi.fn>;
    const handlePlanningTurnMock = handlePlanningTurn as unknown as ReturnType<typeof vi.fn>;

    // Even with an active planning session in spec-proposed state, /approve routes to handleApprove
    getActivePlanningSessionMock.mockReturnValue({
      id: 'plan-sess-approve',
      chatId: 100,
      claudeSessionId: 'claude-approve',
      planning: {
        status: 'spec-proposed',
        product: 'rune',
        idea: 'build something',
        surface: 'chat',
        history: [],
        createdAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    });

    await handleTextMessage(mockSender(), msg('/approve'));

    expect(handleApprove).toHaveBeenCalledWith(expect.anything(), 100);
    expect(handlePlanningTurnMock).not.toHaveBeenCalled();
  });

  it('routes /syllabus to handleSyllabus', async () => {
    await handleTextMessage(mockSender(), msg('/syllabus'));
    expect(handleSyllabus).toHaveBeenCalledWith(expect.anything(), 100);
  });

  it('routes bare /study to handleStudy with empty args', async () => {
    await handleTextMessage(mockSender(), msg('/study'));
    expect(handleStudy).toHaveBeenCalledWith(expect.anything(), 100, '');
  });

  it('routes /study 5 to handleStudy with args "5"', async () => {
    await handleTextMessage(mockSender(), msg('/study 5'));
    expect(handleStudy).toHaveBeenCalledWith(expect.anything(), 100, '5');
  });

  it('routes /study status to handleStudy with args "status"', async () => {
    await handleTextMessage(mockSender(), msg('/study status'));
    expect(handleStudy).toHaveBeenCalledWith(expect.anything(), 100, 'status');
  });

  it('/study and /syllabus route to their distinct handlers without collision', async () => {
    await handleTextMessage(mockSender(), msg('/syllabus'));
    expect(handleSyllabus).toHaveBeenCalledTimes(1);
    expect(handleStudy).not.toHaveBeenCalled();

    vi.clearAllMocks();

    await handleTextMessage(mockSender(), msg('/study'));
    expect(handleStudy).toHaveBeenCalledTimes(1);
    expect(handleSyllabus).not.toHaveBeenCalled();
  });

  it('routes /blog to the writing-product command handler, not the legacy review flow', async () => {
    mockHandleBlog.mockResolvedValue(undefined);
    const sender = mockSender();

    await handleTextMessage(sender, msg('/blog operating from memory'));

    expect(mockHandleBlog).toHaveBeenCalledOnce();
    expect(mockHandleBlog).toHaveBeenCalledWith(sender, 100, 'operating from memory');
    expect(mockStartReview).not.toHaveBeenCalled();
  });

  it('routes /writing-critique to the writing critique command handler with the target args', async () => {
    await handleTextMessage(mockSender(), msg('/writing-critique draft about memory'));

    expect(handleWritingCritique).toHaveBeenCalledWith(expect.anything(), 100, 'draft about memory');
  });

  it.each(['/topics', '/voice'])('%s is not a standalone slash command', async command => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'unknown-slash-sess',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: command,
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'conversation fallback', error: null });

    await handleTextMessage(mockSender(), msg(command));

    expect(mockHandleBlog).not.toHaveBeenCalled();
    expect(handleWritingCritique).not.toHaveBeenCalled();
    expect(mockClassify).not.toHaveBeenCalled();
    expect(askMock).toHaveBeenCalledWith(command, 'unknown-slash-sess', expect.any(String), {
      model: 'haiku',
      allowedTools: expect.any(Array),
      opLabel: 'chat',
      voice: true,
    });
  });

  it('routes /start and sends help listing the canonical command catalog', async () => {
    const sender = mockSender();
    await handleTextMessage(sender, msg('/start'));
    const helpText = vi.mocked(sender.send).mock.calls[0]![1] as string;
    // The /start help reorganized into ~13 scan-friendly section headers
    // (Conversation, Planning, Study, etc.). The test pins a representative
    // subset of headers + the commands that were previously easy to confuse
    // (/syllabus vs /study) + the commands that were missing pre-reorg
    // (/plan, /approve, /cancel) so a future regression that drops one is
    // caught.
    expect(helpText).toContain('**Conversation**');
    expect(helpText).toContain('**Planning**');
    expect(helpText).toContain('**Study**');
    // Assert on the bracketed/arg form (or the leading backtick) so the
    // check fails if a command is dropped from its catalog entry but
    // happens to be mentioned in prose elsewhere — a plain `toContain('/plan')`
    // would pass on incidental mentions, defeating the regression guard.
    expect(helpText).toContain('`/syllabus`');
    expect(helpText).toContain('`/study [N|status]`');
    expect(helpText).toContain('`/plan [product]`');
    expect(helpText).toContain('`/approve`');
    expect(helpText).toContain('`/cancel [opId-prefix]`');
  });

  it('/start presents the runtime brand as Rune and does not emit the retired name', async () => {
    const sender = mockSender();
    await handleTextMessage(sender, msg('/start'));

    const helpText = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(helpText).toMatch(/^# Rune\b/);
    expect(helpText).toContain('Rune leans Socratic');
    expect(helpText).not.toMatch(new RegExp(`\\b${retiredBrand}\\b`));
  });

  it('/start describes /blog as a writing-product /rune artifact command, not a review session', async () => {
    const sender = mockSender();
    await handleTextMessage(sender, msg('/start'));

    const helpText = vi.mocked(sender.send).mock.calls[0]![1] as string;
    const blogLine = helpText
      .split('\n')
      .find(line => line.includes('`/blog <topic>`')) ?? '';

    expect(blogLine).toMatch(/writing[- ]product/i);
    expect(blogLine).toMatch(/\/rune(?:\/\{topic\})?/);
    expect(blogLine).not.toMatch(/\b(review|interview|session)\b/i);
    expect(helpText).toMatch(/`\/writing-critique\b/);
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

  it('scrubs configured host paths from successful conversation replies', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'test-sess',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'where are you?',
      model: 'haiku',
    });
    askMock.mockResolvedValue({
      text: 'Working in /test/fallback-product-chats/example',
      error: null,
    });

    const sender = mockSender();
    await handleTextMessage(sender, msg('where are you?'));

    expect(sender.send).toHaveBeenCalledWith(
      100,
      expect.stringContaining('Working in <product-chat-workspace>/example'),
    );
  });

  it('scrubs fallback workspace paths from conversation exceptions', async () => {
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
    askMock.mockRejectedValueOnce(new Error('EACCES: /test/fallback-product-chats/secret'));

    const sender = mockSender();
    await handleTextMessage(sender, msg('hello'));

    expect(sender.send).toHaveBeenCalledWith(
      100,
      'Error: EACCES: <product-chat-workspace>/secret',
    );
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

  it('routes resolver-dispatched study skill to handleStudy via invokeSkill case "study"', async () => {
    vi.mocked(mockClassify).mockResolvedValue(
      classifyResult({ skill: 'study', args: '', confidence: 0.9 }),
    );
    await handleTextMessage(mockSender(), msg('quiz me on my wiki concepts please'));
    expect(handleStudy).toHaveBeenCalledWith(expect.anything(), 100, '');
    expect(handleSyllabus).not.toHaveBeenCalled();
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

  it('calls startTyping with the selected model for a conversation turn', async () => {
    const sender = mockSender();
    await handleTextMessage(sender, msg('hi there'));

    expect(sender.startTyping).toHaveBeenCalledWith(100, 'Asking haiku');
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

describe('dispatchText — product-scoped webview sessions', () => {
  const productScope = { kind: 'product' as const, product: 'rune' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasActiveReview).mockReturnValue(false);
    vi.mocked(hasActiveSRSession).mockReturnValue(false);
    vi.mocked(getActivePlanningSession).mockReturnValue(null);
  });

  function webviewSender(): MessageSender {
    return {
      name: 'webview' as const,
      send: vi.fn().mockResolvedValue(undefined),
      startTyping: vi.fn(),
      stopTyping: vi.fn(),
    };
  }

  it('creates and updates the active product session instead of the global webview session', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const appendMock = appendMessageToSession as unknown as ReturnType<typeof vi.fn>;
    const updateMock = updateSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;

    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'rune-product-session',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'ship it',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'ok', error: null });

    await (dispatchText as any)(webviewSender(), 100, 'ship it', productScope);

    expect(getSessionMock).toHaveBeenCalledWith(100, 'webview', productScope);
    expect(createSessionMock.mock.calls[0]?.slice(0, 3)).toEqual([100, 'webview', 'ship it']);
    expect(createSessionMock.mock.calls[0]?.[4]).toBe(productScope);
    expect(appendMock).toHaveBeenCalledWith(100, 'webview', 'user', 'ship it', productScope);
    expect(updateMock).toHaveBeenCalledWith(100, 'webview', productScope);
  });

  it('routes existing product-scoped chat continuations without consulting a global webview session', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockImplementation((_userId: number, _transport: string, scope?: unknown) => {
      if (scope === productScope) {
        return {
          sessionId: 'existing-product-session',
          lastActivity: new Date().toISOString(),
          messageCount: 2,
          firstMessage: 'first',
          model: 'haiku',
        };
      }
      return null;
    });
    askMock.mockResolvedValue({ text: 'continued', error: null });

    await (dispatchText as any)(webviewSender(), 100, 'continue this', productScope);

    expect(getSessionMock).toHaveBeenCalledWith(100, 'webview', productScope);
    expect(createSession).not.toHaveBeenCalled();
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('routes product-scoped freeform text into an active planning session before normal chat', async () => {
    const getActivePlanningSessionMock = getActivePlanningSession as unknown as ReturnType<typeof vi.fn>;
    const handlePlanningTurnMock = handlePlanningTurn as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;

    getActivePlanningSessionMock.mockReturnValue({
      id: 'plan-product-001',
      chatId: 100,
      claudeSessionId: 'claude-product-001',
      planning: {
        status: 'scoping',
        product: 'rune',
        idea: '',
        surface: 'cockpit',
        history: [],
        createdAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    });
    getSessionMock.mockReturnValue({
      sessionId: 'existing-product-chat',
      lastActivity: new Date().toISOString(),
      messageCount: 2,
      firstMessage: 'first',
      model: 'haiku',
    });
    handlePlanningTurnMock.mockResolvedValue({
      reply: 'What acceptance signal proves this is done?',
      status: 'scoping',
    });

    const sender = webviewSender();
    await (dispatchText as any)(sender, 100, 'scope the next step', productScope);

    expect(getActivePlanningSessionMock).toHaveBeenCalledWith(100);
    expect(handlePlanningTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ scopingTurn: expect.any(Function) }),
      100,
      'scope the next step',
    );
    expect(askMock).not.toHaveBeenCalled();
    expect(mockClassify).not.toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith(100, 'What acceptance signal proves this is done?');
  });

  it('passes product scope through existing chat commands', async () => {
    const sender = webviewSender();

    await (dispatchText as any)(sender, 100, '/fresh', productScope);
    await (dispatchText as any)(sender, 100, '/fresh-full', productScope);
    await (dispatchText as any)(sender, 100, '/clear', productScope);
    await (dispatchText as any)(sender, 100, '/journal scoped note', productScope);

    expect(handleFresh).toHaveBeenCalledWith(expect.anything(), 100, 'webview', productScope);
    expect(handleFreshFull).toHaveBeenCalledWith(expect.anything(), 100, 'webview', productScope);
    expect(handleClear).toHaveBeenCalledWith(expect.anything(), 100, 'webview', productScope);
    expect(handleJournal).toHaveBeenCalledWith(expect.anything(), 100, 'webview', 'scoped note', productScope);
  });

  it('applies model switching to the product-scoped session', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const setSessionModelMock = setSessionModel as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue({
      sessionId: 'existing-product-session',
      lastActivity: new Date().toISOString(),
      messageCount: 2,
      firstMessage: 'first',
      model: 'haiku',
    });

    await (dispatchText as any)(webviewSender(), 100, '/opus', productScope);

    expect(getSessionMock).toHaveBeenCalledWith(100, 'webview', productScope);
    expect(setSessionModelMock).toHaveBeenCalledWith(100, 'webview', 'opus', productScope);
  });

  it('creates a new product-scoped session when model switching starts product chat', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const setSessionModelMock = setSessionModel as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue(null);

    await (dispatchText as any)(webviewSender(), 100, '/sonnet', productScope);

    expect(createSessionMock).toHaveBeenCalledWith(100, 'webview', '/sonnet', undefined, productScope);
    expect(setSessionModelMock).toHaveBeenCalledWith(100, 'webview', 'sonnet', productScope);
  });

  it('runs product-scoped chat in the product repo and routes via the rune-kb MCP', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;

    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'search-scope-session',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'where is the fix?',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'ok', error: null });

    await (dispatchText as any)(webviewSender(), 100, 'where is the fix?', productScope);

    const systemPrompt = askMock.mock.calls[0]![2] as string;
    const options = askMock.mock.calls[0]![3] as { allowedTools: string[]; cwd?: string; writableRoots?: string[] };
    expect(systemPrompt).toMatch(/active product:\s*rune/i);
    expect(systemPrompt).toMatch(/product repo/i);
    expect(systemPrompt).toMatch(/rune-kb/i);
    // The spawn runs from the product repo (not the vault) — the fix for Rune
    // reporting /pkms as its working repo in product chats.
    expect(options.cwd).toBe('/workspace/rune');
    // writableRoots narrows the (non-enforcing under --dangerously-skip-permissions)
    // --add-dir hint to the product repo; it is NOT an OS write boundary. The
    // vault-write boundary is the system prompt + git recoverability.
    expect(options.writableRoots).toEqual(['/workspace/rune']);
    // Product chat gets the scrubbed child env (Rune secrets removed).
    expect((options as any).envMode).toBe('product-chat');
    // The live op-event scope rides through the Claude call metadata so the
    // webview can attach the working pill to this product, not the active panel.
    expect((options as any).product).toBe('rune');
    // Write-enabled: Edit/Write/Bash available (containment is prompt-based, see
    // buildProductIdentityPreamble — not OS-enforced).
    expect(options.allowedTools).toEqual(expect.arrayContaining([
      'Read',
      'Glob',
      'Grep',
      'Edit',
      'Write',
      'Bash',
      'mcp__rune-kb__repo_search',
      'mcp__rune-kb__kb_query',
      'mcp__rune-kb__kb_search',
      'mcp__rune-kb__cockpit_list_runs',
      'mcp__rune-kb__cockpit_inspect_run',
      'mcp__rune-kb__cockpit_active_runs',
    ]));
    expect(options.allowedTools).not.toContain(retiredMcpTool('repo_search'));
    expect(options.allowedTools).not.toContain(retiredMcpTool('kb_query'));
    expect(options.allowedTools).not.toContain(retiredMcpTool('kb_search'));

    // The product prompt is built write-enabled (capability stated honestly).
    const buildPromptMock = buildSessionSystemPrompt as unknown as ReturnType<typeof vi.fn>;
    expect(buildPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: productScope,
      authority: 'product-full-access',
      productContext: expect.objectContaining({ product: 'rune' }),
    }));
  });

  it('runs a scoped product (writing) from repo-root cwd with workRoot as the writableRoots hint', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    const productScope = { kind: 'product' as const, product: 'writing' };

    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'writing-product-session',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'where do you work?',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'ok', error: null });

    await (dispatchText as any)(webviewSender(), 100, 'where do you work?', productScope);

    const options = askMock.mock.calls[0]![3] as { allowedTools: string[]; cwd?: string; writableRoots?: string[]; envMode?: string };
    expect(options.cwd).toBe('/workspace/writing');
    expect(options.writableRoots).toEqual(['/workspace/writing/docs/rune']);
    expect(options.envMode).toBe('product-chat');
    expect(options.allowedTools).toContain('Bash');
  });

  it('keeps global (non-product) chat read-only — no Edit/Write/Bash', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;

    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'global-tools-session',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'hello',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'ok', error: null });

    await (dispatchText as any)(webviewSender(), 100, 'hello');

    const options = askMock.mock.calls[0]![3] as { allowedTools: string[] };
    expect(options.allowedTools).not.toContain('Edit');
    expect(options.allowedTools).not.toContain('Write');
    expect(options.allowedTools).not.toContain('Bash');
    expect(options.allowedTools).not.toContain('mcp__rune-kb__cockpit_list_runs');
    expect(options.allowedTools).not.toContain('mcp__rune-kb__cockpit_inspect_run');
    expect(options.allowedTools).not.toContain('mcp__rune-kb__cockpit_active_runs');
  });

  it('gives an unresolved product constrained workspace editing tools without Cockpit diagnostics', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    const buildPromptMock = buildSessionSystemPrompt as unknown as ReturnType<typeof vi.fn>;

    vi.mocked(resolveProductChat).mockReturnValueOnce(null);
    vi.mocked(resolveProductFallbackWorkspace).mockReturnValueOnce({
      repoRoot: '/test/fallback-product-chats/rune',
      workRoot: '/test/fallback-product-chats/rune',
    });
    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'unresolved-product-session',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'hello',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'ok', error: null });

    await (dispatchText as any)(webviewSender(), 100, 'hello', productScope);

    const options = askMock.mock.calls[0]![3] as {
      allowedTools: string[];
      cwd?: string;
      writableRoots?: string[];
    };
    expect(options.cwd).toBe('/test/fallback-product-chats/rune');
    expect(options.writableRoots).toEqual(['/test/fallback-product-chats/rune']);
    expect(options.allowedTools).toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash']));
    expect(options.allowedTools).not.toContain('mcp__rune-kb__repo_search');
    expect(options.allowedTools).not.toContain('mcp__rune-kb__kb_query');
    expect(options.allowedTools).not.toContain('mcp__rune-kb__cockpit_list_runs');
    expect(options.allowedTools).not.toContain('mcp__rune-kb__cockpit_inspect_run');
    expect(options.allowedTools).not.toContain('mcp__rune-kb__cockpit_active_runs');
    expect(buildPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: productScope,
      authority: 'product-workspace-write',
    }));
  });

  it('does not set a product cwd for global (non-product) chat', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;

    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'global-cwd-session',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'hello',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'ok', error: null });

    await (dispatchText as any)(webviewSender(), 100, 'hello');

    const options = askMock.mock.calls[0]![3] as { cwd?: string; envMode?: string };
    expect(options.cwd).toBeUndefined();
    // Global chat must never get the product-chat env mode (which would scrub
    // the vault-reading env) — it stays on the default (unscrubbed) env.
    expect(options.envMode).toBeUndefined();
  });

  it('passes the product-tailored system prompt built for the active product scope to Claude', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    const buildPromptMock = buildSessionSystemPrompt as unknown as ReturnType<typeof vi.fn>;
    const productPrompt = [
      'PRODUCT PROMPT FOR rune',
      'repo docs: one Node process owns Telegram and HTTP',
      'spec: cockpit deep view',
      'tasks: product-tailored-system-prompt',
      'worldview: operator cockpits preserve judgment',
    ].join('\n');

    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'product-context-session',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'what should I do next?',
      model: 'haiku',
    });
    buildPromptMock.mockReturnValueOnce(productPrompt);
    askMock.mockResolvedValue({ text: 'ok', error: null });

    await (dispatchText as any)(webviewSender(), 100, 'what should I do next?', productScope);

    expect(buildPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: productScope,
    }));
    expect(askMock.mock.calls[0]![2]).toBe(productPrompt);
  });
});

describe('dispatchText — URL routing position (new behavior)', () => {
  // The key change in the diff: URL detection is now checked AFTER
  // review/SR/chat-session checks, not before them. A URL shared
  // mid-thread must stay in the conversation handler; only URL messages
  // with no active session/review/SR should be triaged independently.

  const URL_MSG = 'Check this out https://example.com';

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no active review, no active SR session
    vi.mocked(hasActiveReview).mockReturnValue(false);
    vi.mocked(hasActiveSRSession).mockReturnValue(false);
  });

  it('routes a URL message to handleURLMessage when no session, review, or SR session is active', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue(null);

    await dispatchText(mockSender(), 100, URL_MSG);

    expect(handleURLMessage).toHaveBeenCalledWith(expect.anything(), 100, URL_MSG);
  });

  it('keeps a URL message in the conversation when a chat session is already active', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;

    getSessionMock.mockReturnValue({
      sessionId: 'existing-sess',
      lastActivity: new Date().toISOString(),
      messageCount: 3,
      firstMessage: 'earlier message',
      model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'here is what I found', error: null });

    await dispatchText(mockSender(), 100, URL_MSG);

    // URL triage must NOT have fired
    expect(handleURLMessage).not.toHaveBeenCalled();
    // The conversation path ran instead
    expect(askMock).toHaveBeenCalled();
  });

  it('routes a URL message to handleReviewMessage when an active review is running', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue(null);

    vi.mocked(hasActiveReview).mockReturnValue(true);
    vi.mocked(handleReviewMessage).mockResolvedValue(undefined);

    await dispatchText(mockSender(), 100, URL_MSG);

    expect(handleReviewMessage).toHaveBeenCalledWith(100, URL_MSG, expect.anything());
    expect(handleURLMessage).not.toHaveBeenCalled();
  });

  it('routes a URL message to handleSRMessage when an active SR session is running', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue(null);

    vi.mocked(hasActiveSRSession).mockReturnValue(true);
    vi.mocked(handleSRMessage).mockResolvedValue(undefined);

    await dispatchText(mockSender(), 100, URL_MSG);

    expect(handleSRMessage).toHaveBeenCalledWith(100, URL_MSG, expect.anything());
    expect(handleURLMessage).not.toHaveBeenCalled();
  });

  it('still routes a URL-only message to handleURLMessage when nothing else is active', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue(null);

    const sender = mockSender();
    await dispatchText(sender, 100, 'https://example.com/article');

    expect(handleURLMessage).toHaveBeenCalledTimes(1);
    expect(handleURLMessage).toHaveBeenCalledWith(sender, 100, 'https://example.com/article');
  });
});

// ---------------------------------------------------------------------------
// Observation-log interaction wiring (Phase 6 B1.2)
// ---------------------------------------------------------------------------

describe('handleTextMessage — observation-log interaction wiring (B1.2)', () => {
  beforeEach(() => vi.clearAllMocks());

  const appendInteractionMock = appendInteraction as unknown as ReturnType<typeof vi.fn>;

  it('emits a tg-message InteractionLogRecord per authorized inbound TG message', async () => {
    // B1.3 layers an additional 'command' record on slash dispatches, so we
    // filter to the tg-message record specifically (B1.2's contract).
    await handleTextMessage(mockSender(), msg('/fresh'));
    const tgRecords = appendInteractionMock.mock.calls
      .map((c: unknown[]) => c[0] as { kind?: string })
      .filter((r) => r.kind === 'tg-message');
    expect(tgRecords).toHaveLength(1);
  });

  it('emits NO record when the sender is unauthorized (security gate fires first)', async () => {
    await handleTextMessage(mockSender(), msg('hello', 999));
    expect(appendInteractionMock).not.toHaveBeenCalled();
  });

  it('emits NO record when text is empty (zero-content noise filter)', async () => {
    await handleTextMessage(mockSender(), msg(''));
    expect(appendInteractionMock).not.toHaveBeenCalled();
  });

  function tgRecord(): { kind: string; outcome: string; detail: string; ts: string } {
    const recs = appendInteractionMock.mock.calls
      .map((c: unknown[]) => c[0] as { kind: string; outcome: string; detail: string; ts: string })
      .filter((r) => r.kind === 'tg-message');
    return recs[0]!;
  }

  it('record has kind="tg-message" and outcome="success" on a normal slash command', async () => {
    await handleTextMessage(mockSender(), msg('/fresh'));
    const record = tgRecord();
    expect(record.kind).toBe('tg-message');
    expect(record.outcome).toBe('success');
  });

  it('detail captures the slash command name as route=/<command>', async () => {
    await handleTextMessage(mockSender(), msg('/journal had a great meeting'));
    const record = tgRecord();
    expect(record.detail).toMatch(/route=\/journal/);
  });

  it('detail uses route=conversation for free-form text (no slash prefix)', async () => {
    // Set up the conversation path: no active review, no SR, no session yet — the
    // resolver word-count guard kicks in (3 < 5) so this falls straight to conversation.
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'sess-conv', lastActivity: new Date().toISOString(),
      messageCount: 1, firstMessage: 'hi there', model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'hello back', error: null });

    await handleTextMessage(mockSender(), msg('three word msg'));
    const record = tgRecord();
    expect(record.detail).toMatch(/route=conversation/);
  });

  it('detail NEVER contains the raw message body — strict-discipline invariant', async () => {
    const tricky = 'sensitive content with quotes "x" and a path /Users/me/secrets';
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'sess-t', lastActivity: new Date().toISOString(),
      messageCount: 1, firstMessage: tricky, model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'ok', error: null });

    await handleTextMessage(mockSender(), msg(tricky));
    const record = tgRecord();
    expect(record.detail).not.toContain('sensitive');
    expect(record.detail).not.toContain('/Users/me/secrets');
    expect(record.detail).not.toContain(tricky);
  });

  it('ts field is set to a parseable ISO-8601 string', async () => {
    await handleTextMessage(mockSender(), msg('/fresh'));
    const record = tgRecord();
    expect(typeof record.ts).toBe('string');
    expect(Number.isFinite(Date.parse(record.ts))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Observation-log command wiring (Phase 6 B1.3)
// ---------------------------------------------------------------------------

describe('dispatchText — observation-log command wiring (B1.3)', () => {
  beforeEach(() => vi.clearAllMocks());

  const appendInteractionMock = appendInteraction as unknown as ReturnType<typeof vi.fn>;

  function commandRecords(): unknown[] {
    return appendInteractionMock.mock.calls
      .map((c: unknown[]) => c[0] as { kind?: string })
      .filter((r) => r.kind === 'command');
  }

  it('emits a kind:"command" record per slash invocation', async () => {
    await dispatchText(mockSender(), 100, '/fresh');
    expect(commandRecords()).toHaveLength(1);
  });

  it('detail captures the command name as cmd=<name>', async () => {
    await dispatchText(mockSender(), 100, '/journal had a meeting');
    const rec = commandRecords()[0] as { detail: string };
    expect(rec.detail).toMatch(/cmd=journal/);
  });

  it('outcome is "success" when the handler returns cleanly', async () => {
    await dispatchText(mockSender(), 100, '/fresh');
    const rec = commandRecords()[0] as { outcome: string };
    expect(rec.outcome).toBe('success');
  });

  it('outcome is "failure" when the handler throws (and the error still propagates)', async () => {
    const handleFreshMock = handleFresh as unknown as ReturnType<typeof vi.fn>;
    handleFreshMock.mockRejectedValueOnce(new Error('boom'));

    await expect(dispatchText(mockSender(), 100, '/fresh')).rejects.toThrow('boom');
    const rec = commandRecords()[0] as { outcome: string };
    expect(rec.outcome).toBe('failure');
  });

  it('does NOT emit a command record for non-slash dispatch (conversation)', async () => {
    const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
    const createSessionMock = createSession as unknown as ReturnType<typeof vi.fn>;
    const askMock = askClaudeWithContext as unknown as ReturnType<typeof vi.fn>;
    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'sess-c', lastActivity: new Date().toISOString(),
      messageCount: 1, firstMessage: 'hi', model: 'haiku',
    });
    askMock.mockResolvedValue({ text: 'reply', error: null });

    await dispatchText(mockSender(), 100, 'three word free');
    expect(commandRecords()).toHaveLength(0);
  });

  it('detail NEVER contains the args following the slash command', async () => {
    const sensitiveArgs = 'sensitive vault path /Users/me/secrets and quotes "x"';
    await dispatchText(mockSender(), 100, `/journal ${sensitiveArgs}`);
    const rec = commandRecords()[0] as { detail: string };
    expect(rec.detail).not.toContain('sensitive');
    expect(rec.detail).not.toContain('/Users/me/secrets');
    expect(rec.detail).not.toContain(sensitiveArgs);
  });
});
