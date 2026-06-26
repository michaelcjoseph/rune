import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: '/test/vault',
    TIMEZONE: 'America/Chicago',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 123,
    LOGS_DIR: '/tmp/rune-test-logs',
    get PLAYBOOK_QUEUE_FILE() { return '/tmp/rune-test-logs/playbook-queue.json'; },
    get REVIEW_SESSIONS_FILE() { return '/tmp/rune-test-logs/review-sessions.json'; },
    get SESSIONS_FILE() { return '/tmp/rune-test-logs/tg-sessions.json'; },
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

const { getYearQuarters } = await import('./yearly.js');

describe('getYearQuarters', () => {
  it('returns exactly four quarters', () => {
    expect(getYearQuarters('2026-06-15')).toHaveLength(4);
  });

  it('Q1 spans Jan 1 to Mar 31', () => {
    const quarters = getYearQuarters('2026-01-01');
    expect(quarters[0]!.first).toBe('2026-01-01');
    expect(quarters[0]!.last).toBe('2026-03-31');
  });

  it('Q2 spans Apr 1 to Jun 30', () => {
    const quarters = getYearQuarters('2026-01-01');
    expect(quarters[1]!.first).toBe('2026-04-01');
    expect(quarters[1]!.last).toBe('2026-06-30');
  });

  it('Q3 spans Jul 1 to Sep 30', () => {
    const quarters = getYearQuarters('2026-01-01');
    expect(quarters[2]!.first).toBe('2026-07-01');
    expect(quarters[2]!.last).toBe('2026-09-30');
  });

  it('Q4 spans Oct 1 to Dec 31', () => {
    const quarters = getYearQuarters('2026-01-01');
    expect(quarters[3]!.first).toBe('2026-10-01');
    expect(quarters[3]!.last).toBe('2026-12-31');
  });

  it('quarters are contiguous — Q1 end + 1 day = Q2 start', () => {
    const quarters = getYearQuarters('2026-06-15');
    const q1End = new Date(quarters[0]!.last);
    const q2Start = new Date(quarters[1]!.first);
    q1End.setDate(q1End.getDate() + 1);
    expect(q1End.toISOString().slice(0, 10)).toBe(q2Start.toISOString().slice(0, 10));
  });

  it('quarters are contiguous — Q2 end + 1 day = Q3 start', () => {
    const quarters = getYearQuarters('2026-06-15');
    const q2End = new Date(quarters[1]!.last);
    const q3Start = new Date(quarters[2]!.first);
    q2End.setDate(q2End.getDate() + 1);
    expect(q2End.toISOString().slice(0, 10)).toBe(q3Start.toISOString().slice(0, 10));
  });

  it('quarters are contiguous — Q3 end + 1 day = Q4 start', () => {
    const quarters = getYearQuarters('2026-06-15');
    const q3End = new Date(quarters[2]!.last);
    const q4Start = new Date(quarters[3]!.first);
    q3End.setDate(q3End.getDate() + 1);
    expect(q3End.toISOString().slice(0, 10)).toBe(q4Start.toISOString().slice(0, 10));
  });

  it('Q1 starts on Jan 1 of the year in targetDate', () => {
    const quarters = getYearQuarters('2024-11-30');
    expect(quarters[0]!.first).toBe('2024-01-01');
  });

  it('Q4 ends on Dec 31 of the year in targetDate', () => {
    const quarters = getYearQuarters('2024-11-30');
    expect(quarters[3]!.last).toBe('2024-12-31');
  });

  it('spans the full year from Jan 1 to Dec 31', () => {
    const quarters = getYearQuarters('2026-06-15');
    expect(quarters[0]!.first).toBe('2026-01-01');
    expect(quarters[3]!.last).toBe('2026-12-31');
  });

  it('uses the correct year from targetDate regardless of which date within the year', () => {
    const q = getYearQuarters('2023-07-04');
    expect(q[0]!.first.startsWith('2023')).toBe(true);
    expect(q[3]!.last.startsWith('2023')).toBe(true);
  });

  it('includes correct labels for each quarter', () => {
    const quarters = getYearQuarters('2026-01-01');
    expect(quarters[0]!.label).toBe('Journal Scanner (Q1)');
    expect(quarters[1]!.label).toBe('Journal Scanner (Q2)');
    expect(quarters[2]!.label).toBe('Journal Scanner (Q3)');
    expect(quarters[3]!.label).toBe('Journal Scanner (Q4)');
  });
});
