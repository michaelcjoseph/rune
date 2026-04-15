import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStartReview = vi.fn<() => Promise<void>>();
const mockGetTodayDate = vi.fn(() => '2026-04-14');

vi.mock('../../reviews/orchestrator.js', () => ({
  startReview: mockStartReview,
}));

vi.mock('../../utils/time.js', () => ({
  getTodayDate: mockGetTodayDate,
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { handleHealth } = await import('./health.js');

function mockBot() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

const CHAT_ID = 100;

describe('handleHealth', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts health session with no args (general coaching)', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const bot = mockBot();

    await handleHealth(bot, CHAT_ID, '');

    expect(mockStartReview).toHaveBeenCalledOnce();
    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'health', '2026-04-14', bot, undefined);
  });

  it('passes focus as topic when args provided', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const bot = mockBot();

    await handleHealth(bot, CHAT_ID, 'sleep optimization');

    expect(mockStartReview).toHaveBeenCalledOnce();
    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'health', '2026-04-14', bot, 'sleep optimization');
  });

  it('passes undefined topic when no args', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const bot = mockBot();

    await handleHealth(bot, CHAT_ID, '');

    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'health', '2026-04-14', bot, undefined);
  });
});
