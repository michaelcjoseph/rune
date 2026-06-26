import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

vi.mock('../../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
  // Required by transitively-imported ai/claude.js (module-load const).
  PROJECT_ROOT: '/tmp/test-project',
}));

vi.mock('../../vault/sessions.js', () => ({
  getSession: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../reviews/planning.js', () => ({
  getActivePlanningSession: vi.fn(() => null),
  abandonActivePlanningSession: vi.fn(),
}));

vi.mock('../../reviews/orchestrator.js', () => ({
  hasActiveReview: vi.fn(() => false),
}));

const { getSession, deleteSession } = await import('../../vault/sessions.js');
const { getActivePlanningSession, abandonActivePlanningSession } = await import('../../reviews/planning.js');
const { handleClear } = await import('./clear.js');

const getSessionMock = getSession as unknown as ReturnType<typeof vi.fn>;
const deleteSessionMock = deleteSession as unknown as ReturnType<typeof vi.fn>;
const getActivePlanningSessionMock = getActivePlanningSession as unknown as ReturnType<typeof vi.fn>;
const abandonActivePlanningSessionMock = abandonActivePlanningSession as unknown as ReturnType<typeof vi.fn>;

function makeSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

describe('handleClear', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // clearAllMocks resets call state but preserves mockReturnValue, so
    // re-prime the active-state probes back to "nothing active" defaults.
    const { hasActiveReview } = await import('../../reviews/orchestrator.js');
    (hasActiveReview as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    getActivePlanningSessionMock.mockReturnValue(null);
  });

  it('sends "No active session to clear." when no session exists', async () => {
    getSessionMock.mockReturnValue(null);
    const sender = makeSender();

    await handleClear(sender, 123, 'telegram');

    expect(sender.send).toHaveBeenCalledWith(123, 'No active session to clear.');
    expect(deleteSessionMock).not.toHaveBeenCalled();
  });

  it('deletes the session and sends "Session cleared." when a session exists', async () => {
    getSessionMock.mockReturnValue({ sessionId: 'sess-abc' });
    const sender = makeSender();

    await handleClear(sender, 456, 'telegram');

    expect(deleteSessionMock).toHaveBeenCalledWith(456, 'telegram');
    expect(sender.send).toHaveBeenCalledWith(456, 'Session cleared.');
  });

  it('does not journal or commit — purely discards the session', async () => {
    getSessionMock.mockReturnValue({ sessionId: 'sess-xyz' });
    const sender = makeSender();

    await handleClear(sender, 789, 'telegram');

    // Only one message sent: the confirmation
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith(789, 'Session cleared.');
    // deleteSession called exactly once
    expect(deleteSessionMock).toHaveBeenCalledTimes(1);
  });

  it('passes the correct chatId to both getSession and deleteSession', async () => {
    const chatId = 99999;
    getSessionMock.mockReturnValue({ sessionId: 'sess-q' });
    const sender = makeSender();

    await handleClear(sender, chatId, 'telegram');

    expect(getSessionMock).toHaveBeenCalledWith(chatId, 'telegram');
    expect(deleteSessionMock).toHaveBeenCalledWith(chatId, 'telegram');
    expect(sender.send).toHaveBeenCalledWith(chatId, 'Session cleared.');
  });

  it('clears the product-scoped webview session when a scope is supplied', async () => {
    const scope = { kind: 'product', product: 'rune' };
    getSessionMock.mockReturnValue({ sessionId: 'sess-product' });
    const sender = makeSender();

    await (handleClear as any)(sender, 456, 'webview', scope);

    expect(getSessionMock).toHaveBeenCalledWith(456, 'webview', scope);
    expect(deleteSessionMock).toHaveBeenCalledWith(456, 'webview', scope);
    expect(sender.send).toHaveBeenCalledWith(456, 'Session cleared.');
  });

  it('abandons planning and surfaces the active-review note when both are live', async () => {
    // Planning + review both active — abandon planning but warn that the review
    // still needs /fresh, so the user is not left guessing about review state.
    const { hasActiveReview } = await import('../../reviews/orchestrator.js');
    (hasActiveReview as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    getSessionMock.mockReturnValue(null);
    getActivePlanningSessionMock.mockReturnValue({
      id: 'plan-sess-xyz',
      chatId: 789,
      claudeSessionId: 'claude-xyz',
      planning: {
        status: 'scoping',
        product: 'rune',
        idea: '',
        surface: 'chat',
        history: [],
        createdAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    });
    const sender = makeSender();

    await handleClear(sender, 789, 'telegram');

    expect(abandonActivePlanningSessionMock).toHaveBeenCalledWith(789);
    const reply = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(reply).toMatch(/planning/i);
    expect(reply).toMatch(/review/i);
    expect(reply).toMatch(/fresh/i);
    (hasActiveReview as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('abandons an active planning session and reports it', async () => {
    // No chat session — the only active state is a planning session.
    getSessionMock.mockReturnValue(null);
    getActivePlanningSessionMock.mockReturnValue({
      id: 'plan-sess-abc',
      chatId: 456,
      claudeSessionId: 'claude-abc',
      planning: {
        status: 'scoping',
        product: 'aura',
        idea: '',
        surface: 'chat',
        history: [],
        createdAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    });
    const sender = makeSender();

    await handleClear(sender, 456, 'telegram');

    expect(abandonActivePlanningSessionMock).toHaveBeenCalledWith(456);
    expect(sender.send).toHaveBeenCalledTimes(1);
    const reply = vi.mocked(sender.send).mock.calls[0]![1] as string;
    // Reply must mention the planning session was abandoned.
    expect(reply).toMatch(/planning/i);
    expect(reply).toMatch(/abandon/i);
    // deleteSession should NOT have been called (no chat session existed)
    expect(deleteSessionMock).not.toHaveBeenCalled();
  });
});
