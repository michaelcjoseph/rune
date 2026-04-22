import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: '/test/vault',
    TIMEZONE: 'America/Chicago',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 123,
    LOGS_DIR: '/tmp/jarvis-test-logs',
    get PLAYBOOK_QUEUE_FILE() { return '/tmp/jarvis-test-logs/playbook-queue.json'; },
    get REVIEW_SESSIONS_FILE() { return '/tmp/jarvis-test-logs/review-sessions.json'; },
    get SESSIONS_FILE() { return '/tmp/jarvis-test-logs/tg-sessions.json'; },
  },
}));
vi.mock('./orchestrator.js', () => ({ registerReviewHandler: vi.fn() }));
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
vi.mock('../vault/files.js', () => ({ readVaultFile: vi.fn() }));
vi.mock('../vault/git.js', () => ({ gitCommitAndPush: vi.fn() }));
vi.mock('../integrations/telegram/client.js', () => ({
  sendLongMessage: vi.fn(),
  startTyping: vi.fn(() => null),
  stopTyping: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../jobs/playbook-extract.js', () => ({ getPendingPlaybookDrafts: vi.fn(() => []) }));
vi.mock('../jobs/proposal-queue.js', () => ({ getPendingProposals: vi.fn(() => []) }));
vi.mock('../kb/queue.js', () => ({ enqueue: vi.fn() }));

const { getMonthRange } = await import('./monthly.js');

describe('getMonthRange', () => {
  it('returns correct first and last for a normal mid-year month', () => {
    const { first, last } = getMonthRange('2026-06-15');
    expect(first).toBe('2026-06-01');
    expect(last).toBe('2026-06-30');
  });

  it('handles January 31 — first is Jan 1, last is Jan 31', () => {
    const { first, last } = getMonthRange('2026-01-31');
    expect(first).toBe('2026-01-01');
    expect(last).toBe('2026-01-31');
  });

  it('handles February in a non-leap year (2023) — last day is 28', () => {
    const { first, last } = getMonthRange('2023-02-14');
    expect(first).toBe('2023-02-01');
    expect(last).toBe('2023-02-28');
  });

  it('handles February in a leap year (2024) — last day is 29', () => {
    const { first, last } = getMonthRange('2024-02-10');
    expect(first).toBe('2024-02-01');
    expect(last).toBe('2024-02-29');
  });

  it('handles December — last day is Dec 31', () => {
    const { first, last } = getMonthRange('2025-12-01');
    expect(first).toBe('2025-12-01');
    expect(last).toBe('2025-12-31');
  });

  it('returns correct range for a month at the start of the year (January)', () => {
    const { first, last } = getMonthRange('2026-01-01');
    expect(first).toBe('2026-01-01');
    expect(last).toBe('2026-01-31');
  });

  it('first and last are always in the same year-month', () => {
    const { first, last } = getMonthRange('2026-09-20');
    expect(first.slice(0, 7)).toBe('2026-09');
    expect(last.slice(0, 7)).toBe('2026-09');
  });

  it('handles April — last day is 30 (30-day month)', () => {
    const { first, last } = getMonthRange('2026-04-15');
    expect(first).toBe('2026-04-01');
    expect(last).toBe('2026-04-30');
  });
});
