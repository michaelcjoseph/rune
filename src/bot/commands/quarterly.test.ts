import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

const mockStartReview = vi.fn<() => Promise<void>>();
const mockGetTodayDate = vi.fn(() => '2026-04-10');

vi.mock('../../reviews/orchestrator.js', () => ({
  startReview: mockStartReview,
  registerReviewHandler: vi.fn(),
}));

vi.mock('../../utils/time.js', () => ({
  getTodayDate: mockGetTodayDate,
}));

vi.mock('../../reviews/quarterly.js', () => ({}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { resolveQuarter, handleQuarterly } = await import('./quarterly.js');

function makeSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

const CHAT_ID = 100;

describe('resolveQuarter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns last day of current quarter when args is empty', () => {
    // April is Q2, Q2 ends June 30
    expect(resolveQuarter('')).toBe('2026-06-30');
    expect(mockGetTodayDate).toHaveBeenCalledOnce();
  });

  it('resolves Q1', () => {
    expect(resolveQuarter('Q1')).toBe('2026-03-31');
  });

  it('resolves Q2', () => {
    expect(resolveQuarter('Q2')).toBe('2026-06-30');
  });

  it('resolves Q3', () => {
    expect(resolveQuarter('Q3')).toBe('2026-09-30');
  });

  it('resolves Q4', () => {
    expect(resolveQuarter('Q4')).toBe('2026-12-31');
  });

  it('resolves lowercase q1', () => {
    expect(resolveQuarter('q1')).toBe('2026-03-31');
  });

  it('resolves Q1 2025 with year', () => {
    expect(resolveQuarter('Q1 2025')).toBe('2025-03-31');
  });

  it('resolves Q4 2025 with year', () => {
    expect(resolveQuarter('Q4 2025')).toBe('2025-12-31');
  });

  it('returns null for Q0', () => {
    expect(resolveQuarter('Q0')).toBeNull();
  });

  it('returns null for Q5', () => {
    expect(resolveQuarter('Q5')).toBeNull();
  });

  it('returns null for non-quarter strings', () => {
    expect(resolveQuarter('not-a-quarter')).toBeNull();
  });
});

describe('handleQuarterly', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls startReview with resolved date for valid quarter', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const sender = makeSender();

    await handleQuarterly(sender, CHAT_ID, 'Q1');

    expect(mockStartReview).toHaveBeenCalledOnce();
    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'quarterly', '2026-03-31', sender);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('sends error message for invalid input and does not call startReview', async () => {
    const sender = makeSender();

    await handleQuarterly(sender, CHAT_ID, 'not-a-quarter');

    expect(sender.send).toHaveBeenCalledWith(
      CHAT_ID,
      'Invalid quarter format. Use: /quarterly, /quarterly Q1, or /quarterly Q2 2026',
    );
    expect(mockStartReview).not.toHaveBeenCalled();
  });

  it('calls startReview with current quarter when args is empty', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const sender = makeSender();

    await handleQuarterly(sender, CHAT_ID, '');

    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'quarterly', '2026-06-30', sender);
  });
});
