import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStartReview = vi.fn<() => Promise<void>>();
const mockGetTodayDate = vi.fn(() => '2026-04-10');

vi.mock('../../reviews/orchestrator.js', () => ({
  startReview: mockStartReview,
}));

vi.mock('../../utils/time.js', () => ({
  getTodayDate: mockGetTodayDate,
}));

vi.mock('../../reviews/weekly.js', () => ({}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { resolveFriday, handleWeekly } = await import('./weekly.js');

function mockBot() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

const CHAT_ID = 100;

describe('resolveFriday', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns most recent Friday when args is empty (today is Friday)', () => {
    mockGetTodayDate.mockReturnValue('2026-04-10'); // Friday
    expect(resolveFriday('')).toBe('2026-04-10');
    expect(mockGetTodayDate).toHaveBeenCalledOnce();
  });

  it('returns most recent Friday when today is Thursday', () => {
    mockGetTodayDate.mockReturnValue('2026-04-16'); // Thursday
    expect(resolveFriday('')).toBe('2026-04-10');
  });

  it('resolves Friday YYYY-MM-DD to same day', () => {
    // Apr 10 2026 = Friday
    expect(resolveFriday('2026-04-10')).toBe('2026-04-10');
  });

  it('resolves Saturday to previous Friday', () => {
    // Sat Apr 11 -> Fri Apr 10
    expect(resolveFriday('2026-04-11')).toBe('2026-04-10');
  });

  it('resolves Sunday to previous Friday', () => {
    // Sun Apr 12 -> Fri Apr 10
    expect(resolveFriday('2026-04-12')).toBe('2026-04-10');
  });

  it('resolves Monday to previous Friday', () => {
    // Mon Apr 13 -> Fri Apr 10 (back 3 days)
    expect(resolveFriday('2026-04-13')).toBe('2026-04-10');
  });

  it('resolves Thursday to previous Friday', () => {
    // Thu Apr 16 -> Fri Apr 10 (back 6 days)
    expect(resolveFriday('2026-04-16')).toBe('2026-04-10');
  });

  it('resolves M/DD to current year then finds Friday', () => {
    // 4/12 -> 2026-04-12 (Sunday) -> 2026-04-10 (Friday)
    expect(resolveFriday('4/12')).toBe('2026-04-10');
  });

  it('resolves MM/DD Friday to same day', () => {
    expect(resolveFriday('04/10')).toBe('2026-04-10');
  });

  it('resolves M-DD with dash separator', () => {
    // 4-11 -> 2026-04-11 (Saturday) -> 2026-04-10 (Friday)
    expect(resolveFriday('4-11')).toBe('2026-04-10');
  });

  it('returns null for non-date strings', () => {
    expect(resolveFriday('not-a-date')).toBeNull();
  });

  it('returns null for YYYY/MM/DD format', () => {
    expect(resolveFriday('2026/04/10')).toBeNull();
  });

  it('handles month boundary (Friday crosses into previous month)', () => {
    // Wed Apr 1 2026 -> offset=(3-5+7)%7=5, Apr 1-5 = Mar 27 (Friday)
    expect(resolveFriday('2026-04-01')).toBe('2026-03-27');
  });
});

describe('handleWeekly', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls startReview with resolved Friday for valid input', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const bot = mockBot();

    // Apr 11 2026 = Saturday -> resolves to Apr 10 (Friday)
    await handleWeekly(bot, CHAT_ID, '2026-04-11');

    expect(mockStartReview).toHaveBeenCalledOnce();
    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'weekly', '2026-04-10', bot);
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('sends error message for invalid date and does not call startReview', async () => {
    const bot = mockBot();

    await handleWeekly(bot, CHAT_ID, 'not-a-date');

    expect(bot.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      'Invalid date format. Use: /weekly, /weekly 2026-04-11, or /weekly 4/11',
    );
    expect(mockStartReview).not.toHaveBeenCalled();
  });

  it('calls startReview with today when today is Friday and args is empty', async () => {
    mockGetTodayDate.mockReturnValue('2026-04-10'); // Friday
    mockStartReview.mockResolvedValue(undefined);
    const bot = mockBot();

    await handleWeekly(bot, CHAT_ID, '');

    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'weekly', '2026-04-10', bot);
  });

  it('calls startReview with previous Friday when today is Thursday', async () => {
    mockGetTodayDate.mockReturnValue('2026-04-16'); // Thursday
    mockStartReview.mockResolvedValue(undefined);
    const bot = mockBot();

    await handleWeekly(bot, CHAT_ID, '');

    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'weekly', '2026-04-10', bot);
  });
});
