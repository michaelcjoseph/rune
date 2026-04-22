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
  PROJECT_ROOT: '/test/project',
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
vi.mock('../jobs/proposal-queue.js', () => ({
  getPendingProposals: vi.fn(() => []),
  clearApprovedProposals: vi.fn(),
}));
vi.mock('../kb/queue.js', () => ({ enqueue: vi.fn() }));

const { getQuarterMonths, getQuarterLabel } = await import('./quarterly.js');

describe('getQuarterMonths', () => {
  it('Q1 starts at January and ends at March', () => {
    const months = getQuarterMonths('2026-01-15');
    expect(months).toHaveLength(3);
    expect(months[0]!.first).toBe('2026-01-01');
    expect(months[0]!.last).toBe('2026-01-31');
    expect(months[2]!.first).toBe('2026-03-01');
    expect(months[2]!.last).toBe('2026-03-31');
  });

  it('month 3 (March) is still in Q1', () => {
    const months = getQuarterMonths('2026-03-31');
    expect(months[0]!.first).toBe('2026-01-01');
    expect(months[2]!.last).toBe('2026-03-31');
  });

  it('Q2 starts at April and ends at June', () => {
    const months = getQuarterMonths('2026-04-01');
    expect(months[0]!.first).toBe('2026-04-01');
    expect(months[2]!.last).toBe('2026-06-30');
  });

  it('month 7 (July) starts Q3', () => {
    const months = getQuarterMonths('2026-07-01');
    expect(months[0]!.first).toBe('2026-07-01');
    expect(months[2]!.last).toBe('2026-09-30');
  });

  it('Q4 spans October through December', () => {
    const months = getQuarterMonths('2026-10-15');
    expect(months[0]!.first).toBe('2026-10-01');
    expect(months[0]!.last).toBe('2026-10-31');
    expect(months[2]!.first).toBe('2026-12-01');
    expect(months[2]!.last).toBe('2026-12-31');
  });

  it('month 12 (December) is in Q4', () => {
    const months = getQuarterMonths('2026-12-31');
    expect(months[0]!.first).toBe('2026-10-01');
    expect(months[2]!.last).toBe('2026-12-31');
  });

  it('returns exactly three months for every quarter', () => {
    ['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01'].forEach(d => {
      expect(getQuarterMonths(d)).toHaveLength(3);
    });
  });

  it('labels include month names', () => {
    const months = getQuarterMonths('2026-01-01');
    expect(months[0]!.label).toContain('January');
    expect(months[1]!.label).toContain('February');
    expect(months[2]!.label).toContain('March');
  });

  it('handles February leap year within Q1', () => {
    const months = getQuarterMonths('2024-02-15');
    expect(months[1]!.first).toBe('2024-02-01');
    expect(months[1]!.last).toBe('2024-02-29');
  });
});

describe('getQuarterLabel', () => {
  it('returns Q1 for January', () => {
    expect(getQuarterLabel('2026-01-15')).toBe('Q1 2026');
  });

  it('returns Q1 for March', () => {
    expect(getQuarterLabel('2026-03-31')).toBe('Q1 2026');
  });

  it('returns Q2 for April', () => {
    expect(getQuarterLabel('2026-04-01')).toBe('Q2 2026');
  });

  it('returns Q2 for June', () => {
    expect(getQuarterLabel('2026-06-30')).toBe('Q2 2026');
  });

  it('returns Q3 for July', () => {
    expect(getQuarterLabel('2026-07-01')).toBe('Q3 2026');
  });

  it('returns Q3 for September', () => {
    expect(getQuarterLabel('2026-09-30')).toBe('Q3 2026');
  });

  it('returns Q4 for October', () => {
    expect(getQuarterLabel('2026-10-01')).toBe('Q4 2026');
  });

  it('returns Q4 for December', () => {
    expect(getQuarterLabel('2026-12-31')).toBe('Q4 2026');
  });

  it('includes the correct year', () => {
    expect(getQuarterLabel('2024-06-15')).toBe('Q2 2024');
  });
});
