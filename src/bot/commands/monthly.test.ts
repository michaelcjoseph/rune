import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStartReview = vi.fn<() => Promise<void>>();
const mockGetTodayDate = vi.fn(() => '2026-04-10');

vi.mock('../../reviews/orchestrator.js', () => ({
  startReview: mockStartReview,
  registerReviewHandler: vi.fn(),
}));

vi.mock('../../utils/time.js', () => ({
  getTodayDate: mockGetTodayDate,
}));

vi.mock('../../reviews/monthly.js', () => ({}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { resolveMonth, handleMonthly } = await import('./monthly.js');

function mockBot() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

const CHAT_ID = 100;

describe('resolveMonth', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns last day of current month when args is empty', () => {
    expect(resolveMonth('')).toBe('2026-04-30');
    expect(mockGetTodayDate).toHaveBeenCalledOnce();
  });

  it('resolves full month name', () => {
    expect(resolveMonth('january')).toBe('2026-01-31');
  });

  it('resolves abbreviated month name', () => {
    expect(resolveMonth('feb')).toBe('2026-02-28');
  });

  it('resolves month name case-insensitively', () => {
    expect(resolveMonth('APRIL')).toBe('2026-04-30');
  });

  it('resolves YYYY-MM format', () => {
    expect(resolveMonth('2025-12')).toBe('2025-12-31');
  });

  it('resolves two-digit month number', () => {
    expect(resolveMonth('04')).toBe('2026-04-30');
  });

  it('resolves single-digit month number', () => {
    expect(resolveMonth('1')).toBe('2026-01-31');
  });

  it('returns null for invalid month number', () => {
    expect(resolveMonth('13')).toBeNull();
  });

  it('returns null for zero', () => {
    expect(resolveMonth('0')).toBeNull();
  });

  it('returns null for non-month strings', () => {
    expect(resolveMonth('not-a-month')).toBeNull();
  });

  it('returns null for YYYY-MM with invalid month', () => {
    expect(resolveMonth('2026-13')).toBeNull();
    expect(resolveMonth('2026-00')).toBeNull();
  });

  it('resolves may (3-letter abbreviation equals full name)', () => {
    expect(resolveMonth('may')).toBe('2026-05-31');
  });
});

describe('handleMonthly', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls startReview with resolved date for valid month', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const bot = mockBot();

    await handleMonthly(bot, CHAT_ID, 'april');

    expect(mockStartReview).toHaveBeenCalledOnce();
    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'monthly', '2026-04-30', bot);
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('sends error message for invalid input and does not call startReview', async () => {
    const bot = mockBot();

    await handleMonthly(bot, CHAT_ID, 'not-a-month');

    expect(bot.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      'Invalid month format. Use: /monthly, /monthly april, /monthly 04, or /monthly 2026-04',
    );
    expect(mockStartReview).not.toHaveBeenCalled();
  });

  it('calls startReview with current month when args is empty', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const bot = mockBot();

    await handleMonthly(bot, CHAT_ID, '');

    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'monthly', '2026-04-30', bot);
  });
});
