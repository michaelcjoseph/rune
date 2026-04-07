import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  default: { TELEGRAM_USER_ID: 42, VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

vi.mock('../../vault/sessions.js', () => ({
  getSession: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
}));
vi.mock('../../ai/claude.js', () => ({ askClaude: vi.fn() }));
vi.mock('../../integrations/telegram/client.js', () => ({
  sendLongMessage: vi.fn(),
  startTyping: vi.fn(() => setInterval(() => {}, 99999)),
  stopTyping: vi.fn((i: NodeJS.Timeout) => clearInterval(i)),
}));
vi.mock('../commands/fresh.js', () => ({ handleFresh: vi.fn() }));
vi.mock('../commands/journal.js', () => ({ handleJournal: vi.fn() }));
vi.mock('../commands/ask.js', () => ({ handleAsk: vi.fn() }));
vi.mock('../commands/status.js', () => ({ handleStatus: vi.fn() }));
vi.mock('../commands/kb.js', () => ({ handleKB: vi.fn() }));
vi.mock('../commands/ingest.js', () => ({ handleIngest: vi.fn() }));
vi.mock('../../kb/engine.js', () => ({ lintKB: vi.fn().mockResolvedValue({ report: 'clean' }) }));

const { handleFresh } = await import('../commands/fresh.js');
const { handleJournal } = await import('../commands/journal.js');
const { handleAsk } = await import('../commands/ask.js');
const { handleStatus } = await import('../commands/status.js');
const { handleKB } = await import('../commands/kb.js');
const { handleIngest } = await import('../commands/ingest.js');
const { getSession, createSession } = await import('../../vault/sessions.js');
const { askClaude } = await import('../../ai/claude.js');
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
    const askClaudeMock = askClaude as unknown as ReturnType<typeof vi.fn>;

    getSessionMock.mockReturnValue(null);
    createSessionMock.mockReturnValue({
      sessionId: 'test-sess',
      lastActivity: new Date().toISOString(),
      messageCount: 1,
      firstMessage: 'hello',
    });
    askClaudeMock.mockResolvedValue({ text: 'hi there!', error: null });

    await handleTextMessage(mockBot(), msg('hello'));
    expect(createSessionMock).toHaveBeenCalled();
    expect(askClaudeMock).toHaveBeenCalledWith('hello', 'test-sess');
  });

  it('ignores empty text', async () => {
    const bot = mockBot();
    await handleTextMessage(bot, msg(''));
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });
});
