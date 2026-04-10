import { describe, it, expect, vi } from 'vitest';
import type TelegramBot from 'node-telegram-bot-api';

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { runWeeklyNudge, runReviewNudge } = await import('./nudges.js');

describe('jobs/nudges — runWeeklyNudge', () => {
  it('is a callable function', () => {
    expect(typeof runWeeklyNudge).toBe('function');
  });

  it('resolves without throwing', async () => {
    const bot = {} as TelegramBot;
    await expect(runWeeklyNudge(bot)).resolves.toBeUndefined();
  });
});

describe('jobs/nudges — runReviewNudge', () => {
  it('is a callable function', () => {
    expect(typeof runReviewNudge).toBe('function');
  });

  it('resolves without throwing', async () => {
    const bot = {} as TelegramBot;
    await expect(runReviewNudge(bot)).resolves.toBeUndefined();
  });
});
