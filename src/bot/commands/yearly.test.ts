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

vi.mock('../../reviews/yearly.js', () => ({}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { resolveYear, handleYearly } = await import('./yearly.js');

function mockBot() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

const CHAT_ID = 100;

describe('resolveYear', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns Dec 31 of current year when args is empty', () => {
    expect(resolveYear('')).toBe('2026-12-31');
    expect(mockGetTodayDate).toHaveBeenCalledOnce();
  });

  it('resolves a 4-digit year', () => {
    expect(resolveYear('2025')).toBe('2025-12-31');
  });

  it('resolves current year explicitly', () => {
    expect(resolveYear('2026')).toBe('2026-12-31');
  });

  it('returns null for 2-digit year', () => {
    expect(resolveYear('25')).toBeNull();
  });

  it('returns null for non-numeric strings', () => {
    expect(resolveYear('not-a-year')).toBeNull();
  });

  it('returns null for 5-digit number', () => {
    expect(resolveYear('20260')).toBeNull();
  });
});

describe('handleYearly', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls startReview with resolved date for valid year', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const bot = mockBot();

    await handleYearly(bot, CHAT_ID, '2025');

    expect(mockStartReview).toHaveBeenCalledOnce();
    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'yearly', '2025-12-31', bot);
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('sends error message for invalid input and does not call startReview', async () => {
    const bot = mockBot();

    await handleYearly(bot, CHAT_ID, 'not-a-year');

    expect(bot.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      'Invalid year format. Use: /yearly or /yearly 2025',
    );
    expect(mockStartReview).not.toHaveBeenCalled();
  });

  it('calls startReview with current year when args is empty', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const bot = mockBot();

    await handleYearly(bot, CHAT_ID, '');

    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'yearly', '2026-12-31', bot);
  });
});
