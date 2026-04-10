import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: {
    TIMEZONE: 'America/Chicago',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 123,
  },
}));

const { getTodayFilename, getTimestamp, getDateContext, getYesterdayFilename, getDayOfWeek } = await import('./time.js');

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

  describe('getYesterdayFilename', () => {
    it('returns YYYY_MM_DD.md format', () => {
      const result = getYesterdayFilename();
      expect(result).toMatch(/^\d{4}_\d{2}_\d{2}\.md$/);
    });

    it('returns the day before today in Chicago timezone', () => {
      // Pinned to 2026-04-07 Chicago, so yesterday is 2026-04-06
      expect(getYesterdayFilename()).toBe('2026_04_06.md');
    });

    it('handles month boundary — yesterday crosses into previous month', () => {
      // 2026-05-01 12:00 Chicago (17:00 UTC) → yesterday is 2026-04-30
      vi.setSystemTime(new Date('2026-05-01T17:00:00.000Z'));
      expect(getYesterdayFilename()).toBe('2026_04_30.md');
    });

    it('handles year boundary — Jan 1 yesterday is Dec 31 prior year', () => {
      // 2026-01-01 12:00 Chicago (18:00 UTC, CST) → yesterday is 2025-12-31
      vi.setSystemTime(new Date('2026-01-01T18:00:00.000Z'));
      expect(getYesterdayFilename()).toBe('2025_12_31.md');
    });

    it('handles timezone boundary — early UTC on a new day is still yesterday in Chicago', () => {
      // 2026-04-08 04:00 UTC = 2026-04-07 23:00 Chicago → yesterday is 2026-04-06
      vi.setSystemTime(new Date('2026-04-08T04:00:00.000Z'));
      expect(getYesterdayFilename()).toBe('2026_04_06.md');
    });
  });

  describe('getDayOfWeek', () => {
    it('returns a valid weekday name', () => {
      const validDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      expect(validDays).toContain(getDayOfWeek());
    });

    it('returns Tuesday for the pinned date (2026-04-07)', () => {
      expect(getDayOfWeek()).toBe('Tuesday');
    });

    it('returns correct day across timezone boundary', () => {
      // 2026-04-08 04:00 UTC = 2026-04-07 23:00 Chicago → still Tuesday
      vi.setSystemTime(new Date('2026-04-08T04:00:00.000Z'));
      expect(getDayOfWeek()).toBe('Tuesday');
    });

    it('returns Monday when pinned to a Monday', () => {
      // 2026-04-06 12:00 Chicago (17:00 UTC) is a Monday
      vi.setSystemTime(new Date('2026-04-06T17:00:00.000Z'));
      expect(getDayOfWeek()).toBe('Monday');
    });
  });
});
