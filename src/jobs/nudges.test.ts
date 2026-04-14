import { describe, it, expect, vi, beforeEach } from 'vitest';
import type TelegramBot from 'node-telegram-bot-api';

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

describe('jobs/nudges — runWeeklyNudge', () => {
  let bot: TelegramBot;

  beforeEach(() => {
    vi.clearAllMocks();
    bot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as unknown as TelegramBot;
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

    await runWeeklyNudge(bot);

    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(msg).toContain('Friday');
    expect(msg).toContain('Apr 5');
    expect(msg).toContain('3 journal entries');
    expect(msg).toContain('2 active sessions (15 messages)');
    expect(msg).toContain('11 wiki pages');
    expect(msg).toContain('/weekly');
  });

  it('shows singular forms for 1 entry / 1 session', async () => {
    vi.mocked(listVaultFiles).mockReturnValue(['journals/2026_04_05.md']);
    vi.mocked(getAllSessions).mockReturnValue([
      [123, { sessionId: 'a', lastActivity: '', messageCount: 3, firstMessage: '', model: '' }],
    ]);

    await runWeeklyNudge(bot);

    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(msg).toContain('1 journal entry');
    expect(msg).toContain('1 active session');
  });

  it('shows queued ingestion count when queue is non-empty', async () => {
    vi.mocked(getQueue).mockReturnValue([
      { source: 'articles/foo.md', addedAt: '' },
      { source: 'articles/bar.md', addedAt: '' },
    ]);

    await runWeeklyNudge(bot);

    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(msg).toContain('2 queued for ingestion');
  });

  it('omits message count when no sessions', async () => {
    vi.mocked(getAllSessions).mockReturnValue([]);
    await runWeeklyNudge(bot);

    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(msg).toContain('0 active sessions');
    expect(msg).not.toContain('messages');
  });

  it('does not throw when sendMessage fails', async () => {
    (bot.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('TG down'));
    await expect(runWeeklyNudge(bot)).resolves.toBeUndefined();
  });
});

describe('jobs/nudges — runReviewNudge', () => {
  let bot: TelegramBot;

  beforeEach(() => {
    vi.clearAllMocks();
    bot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as unknown as TelegramBot;
  });

  it('sends monthly nudge on last day of a regular month', async () => {
    vi.mocked(getMonthInfo).mockReturnValue({ month: 5, monthName: 'May', day: 31, lastDay: 31 });
    await runReviewNudge(bot);

    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(msg).toContain('May');
    expect(msg).toContain('monthly');
    expect(msg).toContain('/monthly');
  });

  it('sends quarterly nudge at end of Q1 (March)', async () => {
    vi.mocked(getMonthInfo).mockReturnValue({ month: 3, monthName: 'March', day: 31, lastDay: 31 });
    await runReviewNudge(bot);

    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(msg).toContain('quarterly');
    expect(msg).toContain('/quarterly');
  });

  it('sends quarterly nudge at end of Q2 (June)', async () => {
    vi.mocked(getMonthInfo).mockReturnValue({ month: 6, monthName: 'June', day: 30, lastDay: 30 });
    await runReviewNudge(bot);

    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(msg).toContain('quarterly');
    expect(msg).toContain('/quarterly');
  });

  it('sends quarterly nudge at end of Q3 (September)', async () => {
    vi.mocked(getMonthInfo).mockReturnValue({ month: 9, monthName: 'September', day: 30, lastDay: 30 });
    await runReviewNudge(bot);

    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(msg).toContain('quarterly');
  });

  it('sends yearly nudge at end of December', async () => {
    vi.mocked(getMonthInfo).mockReturnValue({ month: 12, monthName: 'December', day: 31, lastDay: 31 });
    await runReviewNudge(bot);

    const msg = (bot.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(msg).toContain('yearly');
    expect(msg).toContain('/yearly');
  });

  it('skips when not the last day of the month', async () => {
    vi.mocked(getMonthInfo).mockReturnValue({ month: 4, monthName: 'April', day: 28, lastDay: 30 });
    await runReviewNudge(bot);

    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('does not throw when sendMessage fails', async () => {
    vi.mocked(getMonthInfo).mockReturnValue({ month: 4, monthName: 'April', day: 30, lastDay: 30 });
    (bot.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('TG down'));
    await expect(runReviewNudge(bot)).resolves.toBeUndefined();
  });
});
