import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

const mockStartReview = vi.fn<() => Promise<void>>();
const mockGetTodayDate = vi.fn(() => '2026-05-12');

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

// Prevent the side-effect import from pulling in reviews/new-project.ts →
// session.ts → config.ts → required env var checks.
vi.mock('../../reviews/new-project.js', () => ({}));

const { handleNewProject } = await import('./new-project.js');

function makeSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

const CHAT_ID = 100;

describe('handleNewProject', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls startReview with type "new-project" and todays date', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const sender = makeSender();

    await handleNewProject(sender, CHAT_ID, '');

    expect(mockStartReview).toHaveBeenCalledOnce();
    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'new-project', '2026-05-12', sender, undefined);
  });

  it('passes trimmed topic when args are provided', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const sender = makeSender();

    await handleNewProject(sender, CHAT_ID, '  email digest feature  ');

    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'new-project', '2026-05-12', sender, 'email digest feature');
  });

  it('passes undefined topic (not empty string) when args are empty', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const sender = makeSender();

    await handleNewProject(sender, CHAT_ID, '');

    const call = mockStartReview.mock.calls[0]!;
    // 5th arg is topic — must be undefined, not ''
    expect(call[4]).toBeUndefined();
  });

  it('passes undefined topic when args are whitespace only', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const sender = makeSender();

    await handleNewProject(sender, CHAT_ID, '   ');

    const call = mockStartReview.mock.calls[0]!;
    expect(call[4]).toBeUndefined();
  });

  it('uses todays date from getTodayDate utility', async () => {
    mockGetTodayDate.mockReturnValue('2026-01-01');
    mockStartReview.mockResolvedValue(undefined);
    const sender = makeSender();

    await handleNewProject(sender, CHAT_ID, 'something');

    expect(mockStartReview).toHaveBeenCalledWith(CHAT_ID, 'new-project', '2026-01-01', sender, 'something');
  });

  it('does not send any direct messages — leaves messaging to startReview', async () => {
    mockStartReview.mockResolvedValue(undefined);
    const sender = makeSender();

    await handleNewProject(sender, CHAT_ID, 'my project idea');

    expect(sender.send).not.toHaveBeenCalled();
  });
});
