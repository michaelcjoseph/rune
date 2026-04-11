import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStartReview = vi.fn<() => Promise<void>>();
const mockGetTodayDate = vi.fn(() => '2026-04-10');

vi.mock('../../reviews/orchestrator.js', () => ({
  startReview: mockStartReview,
}));

vi.mock('../../utils/time.js', () => ({
  getTodayDate: mockGetTodayDate,
}));

vi.mock('../../reviews/daily.js', () => ({}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { resolveDate, handleDaily } = await import('./daily.js');

function mockBot() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

const CHAT_ID = 100;

describe('resolveDate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns today when args is empty string', () => {
    expect(resolveDate('')).toBe('2026-04-10');
    expect(mockGetTodayDate).toHaveBeenCalledOnce();
  });

  it('returns YYYY-MM-DD as-is', () => {
    expect(resolveDate('2026-04-10')).toBe('2026-04-10');
  });

  it('resolves M/DD to current year with padding', () => {
    expect(resolveDate('4/10')).toBe('2026-04-10');
  });

  it('resolves MM/DD to current year', () => {
    expect(resolveDate('04/10')).toBe('2026-04-10');
  });

  it('resolves M-DD with dash separator', () => {
    expect(resolveDate('4-10')).toBe('2026-04-10');
  });

  it('pads single-digit month and day', () => {
    expect(resolveDate('12/5')).toBe('2026-12-05');
  });

  it('returns null for non-date strings', () => {
    expect(resolveDate('not-a-date')).toBeNull();
  });

  it('returns null for YYYY/MM/DD format', () => {
    expect(resolveDate('2026/04/10')).toBeNull();
  });
});

describe('handleDaily', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls startReview with resolved date for valid input', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const bot = mockBot();

    await handleDaily(bot, CHAT_ID, '2026-04-10');

    expect(mockStartReview).toHaveBeenCalledOnce();
    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'daily', '2026-04-10', bot);
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('sends error message for invalid date and does not call startReview', async () => {
    const bot = mockBot();

    await handleDaily(bot, CHAT_ID, 'not-a-date');

    expect(bot.sendMessage).toHaveBeenCalledWith(
      CHAT_ID,
      'Invalid date format. Use: /daily, /daily 2026-04-10, or /daily 4/10',
    );
    expect(mockStartReview).not.toHaveBeenCalled();
  });

  it('calls startReview with today when args is empty', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const bot = mockBot();

    await handleDaily(bot, CHAT_ID, '');

    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'daily', '2026-04-10', bot);
  });
});
