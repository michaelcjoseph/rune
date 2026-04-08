import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: {
    TIMEZONE: 'America/Chicago',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 123,
  },
}));

const { getTodayFilename, getTimestamp, getDateContext } = await import('./time.js');

describe('time utils', () => {
  beforeEach(() => {
    // Fix to 2026-04-07 14:30:00 Chicago time (19:30 UTC)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-07T19:30:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('getTodayFilename returns YYYY_MM_DD.md in Chicago timezone', () => {
    expect(getTodayFilename()).toBe('2026_04_07.md');
  });

  it('getTimestamp returns HH:MM in 24h format', () => {
    expect(getTimestamp()).toBe('14:30');
  });

  it('handles date boundary — late UTC is still same day in Chicago', () => {
    // 2026-04-08 04:00 UTC = 2026-04-07 23:00 Chicago (CDT)
    vi.setSystemTime(new Date('2026-04-08T04:00:00.000Z'));
    expect(getTodayFilename()).toBe('2026_04_07.md');
  });

  it('getDateContext includes day of week, date, timezone, and journal filename', () => {
    const ctx = getDateContext();
    expect(ctx).toContain('Tuesday');
    expect(ctx).toContain('April 7, 2026');
    expect(ctx).toContain('America/Chicago');
    expect(ctx).toContain('2026_04_07.md');
  });
});
