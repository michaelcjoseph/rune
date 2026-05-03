import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../config.js', () => ({
  default: {
    TELEGRAM_USER_ID: 12345,
    VAULT_DIR: '/tmp/test-vault',
    TIMEZONE: 'America/Chicago',
  },
}));

vi.mock('../vault/files.js', () => ({
  listVaultFiles: vi.fn(() => []),
}));

vi.mock('../vault/sessions.js', () => ({
  getAllSessions: vi.fn(() => []),
}));

vi.mock('../kb/engine.js', () => ({
  getKBStats: vi.fn(() => ({
    entities: 5,
    concepts: 3,
    topics: 2,
    comparisons: 1,
    totalPages: 11,
    recentLog: [],
  })),
}));

vi.mock('../kb/queue.js', () => ({
  getQueue: vi.fn(() => []),
}));

vi.mock('../utils/time.js', () => ({
  getWeekRange: vi.fn(() => ({
    start: 'Apr 5',
    end: 'Apr 11',
    filenames: [
      '2026_04_05.md', '2026_04_06.md', '2026_04_07.md',
      '2026_04_08.md', '2026_04_09.md', '2026_04_10.md', '2026_04_11.md',
    ],
  })),
  getMonthInfo: vi.fn(() => ({
    month: 4,
    monthName: 'April',
    day: 30,
    lastDay: 30,
  })),
}));

const { listVaultFiles } = await import('../vault/files.js');
const { getAllSessions } = await import('../vault/sessions.js');
const { getQueue } = await import('../kb/queue.js');
const { getMonthInfo } = await import('../utils/time.js');
const { runWeeklyNudge, runReviewNudge } = await import('./nudges.js');

function mockBus() {
  return { publish: vi.fn() } as any;
}

describe('jobs/nudges — runWeeklyNudge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a nudge message with week stats', async () => {
    vi.mocked(listVaultFiles).mockReturnValue([
      'journals/2026_04_05.md',
      'journals/2026_04_07.md',
      'journals/2026_04_09.md',
    ]);
    vi.mocked(getAllSessions).mockReturnValue([
      [123, { sessionId: 'a', lastActivity: '', messageCount: 10, firstMessage: '', model: '' }],
      [456, { sessionId: 'b', lastActivity: '', messageCount: 5, firstMessage: '', model: '' }],
    ]);
    const bus = mockBus();

    await runWeeklyNudge(bus);

    expect(bus.publish).toHaveBeenCalledOnce();
    const { text } = bus.publish.mock.calls[0][0] as { kind: string; userId: number; text: string };
    expect(text).toContain('Friday');
    expect(text).toContain('Apr 5');
    expect(text).toContain('3 journal entries');
    expect(text).toContain('2 active sessions (15 messages)');
    expect(text).toContain('11 wiki pages');
    expect(text).toContain('/weekly');
  });

  it('shows singular forms for 1 entry / 1 session', async () => {
    vi.mocked(listVaultFiles).mockReturnValue(['journals/2026_04_05.md']);
    vi.mocked(getAllSessions).mockReturnValue([
      [123, { sessionId: 'a', lastActivity: '', messageCount: 3, firstMessage: '', model: '' }],
    ]);
    const bus = mockBus();

    await runWeeklyNudge(bus);

    const { text } = bus.publish.mock.calls[0][0] as { kind: string; userId: number; text: string };
    expect(text).toContain('1 journal entry');
    expect(text).toContain('1 active session');
  });

  it('shows queued ingestion count when queue is non-empty', async () => {
    vi.mocked(getQueue).mockReturnValue([
      { source: 'articles/foo.md', addedAt: '' },
      { source: 'articles/bar.md', addedAt: '' },
    ]);
    const bus = mockBus();

    await runWeeklyNudge(bus);

    const { text } = bus.publish.mock.calls[0][0] as { kind: string; userId: number; text: string };
    expect(text).toContain('2 queued for ingestion');
  });

  it('omits message count when no sessions', async () => {
    vi.mocked(getAllSessions).mockReturnValue([]);
    const bus = mockBus();
    await runWeeklyNudge(bus);

    const { text } = bus.publish.mock.calls[0][0] as { kind: string; userId: number; text: string };
    expect(text).toContain('0 active sessions');
    expect(text).not.toContain('messages');
  });

  it('does not throw even if bus.publish throws', async () => {
    const bus = { publish: vi.fn().mockImplementation(() => { throw new Error('bus down'); }) } as any;
    await expect(runWeeklyNudge(bus)).resolves.toBeUndefined();
  });
});

describe('jobs/nudges — runReviewNudge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends monthly nudge on last day of a regular month', async () => {
    vi.mocked(getMonthInfo).mockReturnValue({ month: 5, monthName: 'May', day: 31, lastDay: 31 });
    const bus = mockBus();
    await runReviewNudge(bus);

    const { text } = bus.publish.mock.calls[0][0] as { kind: string; userId: number; text: string };
    expect(text).toContain('May');
    expect(text).toContain('monthly');
    expect(text).toContain('/monthly');
  });

  it('sends quarterly nudge at end of Q1 (March)', async () => {
    vi.mocked(getMonthInfo).mockReturnValue({ month: 3, monthName: 'March', day: 31, lastDay: 31 });
    const bus = mockBus();
    await runReviewNudge(bus);

    const { text } = bus.publish.mock.calls[0][0] as { kind: string; userId: number; text: string };
    expect(text).toContain('quarterly');
    expect(text).toContain('/quarterly');
  });

  it('sends quarterly nudge at end of Q2 (June)', async () => {
    vi.mocked(getMonthInfo).mockReturnValue({ month: 6, monthName: 'June', day: 30, lastDay: 30 });
    const bus = mockBus();
    await runReviewNudge(bus);

    const { text } = bus.publish.mock.calls[0][0] as { kind: string; userId: number; text: string };
    expect(text).toContain('quarterly');
    expect(text).toContain('/quarterly');
  });

  it('sends quarterly nudge at end of Q3 (September)', async () => {
    vi.mocked(getMonthInfo).mockReturnValue({ month: 9, monthName: 'September', day: 30, lastDay: 30 });
    const bus = mockBus();
    await runReviewNudge(bus);

    const { text } = bus.publish.mock.calls[0][0] as { kind: string; userId: number; text: string };
    expect(text).toContain('quarterly');
  });

  it('sends yearly nudge at end of December', async () => {
    vi.mocked(getMonthInfo).mockReturnValue({ month: 12, monthName: 'December', day: 31, lastDay: 31 });
    const bus = mockBus();
    await runReviewNudge(bus);

    const { text } = bus.publish.mock.calls[0][0] as { kind: string; userId: number; text: string };
    expect(text).toContain('yearly');
    expect(text).toContain('/yearly');
  });

  it('skips when not the last day of the month', async () => {
    vi.mocked(getMonthInfo).mockReturnValue({ month: 4, monthName: 'April', day: 28, lastDay: 30 });
    const bus = mockBus();
    await runReviewNudge(bus);

    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('does not throw even if bus.publish throws', async () => {
    vi.mocked(getMonthInfo).mockReturnValue({ month: 4, monthName: 'April', day: 30, lastDay: 30 });
    const bus = { publish: vi.fn().mockImplementation(() => { throw new Error('bus down'); }) } as any;
    await expect(runReviewNudge(bus)).resolves.toBeUndefined();
  });
});
