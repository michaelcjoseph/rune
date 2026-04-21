import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: {
    TIMEZONE: 'America/Chicago',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 123,
  },
}));

const {
  getTodayFilename,
  getTodayDate,
  getTimestamp,
  getDateContext,
  getYesterdayFilename,
  getYesterdayDate,
  getDayOfWeek,
  getRecentFilenames,
  getWeekRange,
  getMonthInfo,
} = await import('./time.js');

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

  describe('getRecentFilenames', () => {
    it('returns the correct number of filenames', () => {
      const result = getRecentFilenames(5);
      expect(result).toHaveLength(5);
    });

    it('returns filenames in reverse chronological order (today first)', () => {
      const result = getRecentFilenames(3);
      expect(result).toEqual([
        '2026_04_07.md',
        '2026_04_06.md',
        '2026_04_05.md',
      ]);
    });

    it('returns only today when days is 1', () => {
      expect(getRecentFilenames(1)).toEqual(['2026_04_07.md']);
    });

    it('handles month boundary correctly', () => {
      // Set to 2026-05-02 12:00 Chicago (17:00 UTC)
      vi.setSystemTime(new Date('2026-05-02T17:00:00.000Z'));
      const result = getRecentFilenames(4);
      expect(result).toEqual([
        '2026_05_02.md',
        '2026_05_01.md',
        '2026_04_30.md',
        '2026_04_29.md',
      ]);
    });

    it('returns empty array when days is 0', () => {
      expect(getRecentFilenames(0)).toEqual([]);
    });
  });

  describe('getTodayDate', () => {
    it('returns YYYY-MM-DD format in Chicago timezone', () => {
      expect(getTodayDate()).toBe('2026-04-07');
    });

    it('handles late UTC that is still prior day in Chicago', () => {
      // 2026-04-08 04:00 UTC = 2026-04-07 23:00 Chicago
      vi.setSystemTime(new Date('2026-04-08T04:00:00.000Z'));
      expect(getTodayDate()).toBe('2026-04-07');
    });
  });

  describe('getYesterdayDate', () => {
    it('returns YYYY-MM-DD for the day before today in Chicago timezone', () => {
      expect(getYesterdayDate()).toBe('2026-04-06');
    });

    it('handles month boundary', () => {
      // 2026-05-01 12:00 Chicago (17:00 UTC) → yesterday is 2026-04-30
      vi.setSystemTime(new Date('2026-05-01T17:00:00.000Z'));
      expect(getYesterdayDate()).toBe('2026-04-30');
    });

    it('handles year boundary', () => {
      // 2026-01-01 12:00 Chicago (18:00 UTC, CST) → yesterday is 2025-12-31
      vi.setSystemTime(new Date('2026-01-01T18:00:00.000Z'));
      expect(getYesterdayDate()).toBe('2025-12-31');
    });
  });

  describe('getWeekRange', () => {
    // Pinned to 2026-04-07 (Tuesday).
    // The week is Sat–Fri, so current week started 2026-04-04 (Sat) and ends 2026-04-10 (Fri).

    it('returns start and end display labels', () => {
      const { start, end } = getWeekRange();
      expect(start).toBe('Apr 4');
      expect(end).toBe('Apr 10');
    });

    it('returns exactly 7 filenames', () => {
      const { filenames } = getWeekRange();
      expect(filenames).toHaveLength(7);
    });

    it('filenames span Saturday through Friday', () => {
      const { filenames } = getWeekRange();
      expect(filenames[0]).toBe('2026_04_04.md'); // Saturday
      expect(filenames[6]).toBe('2026_04_10.md'); // Friday
    });

    it('today (Tuesday) is the fourth file in the week array (index 3)', () => {
      // Sat=0, Sun=1, Mon=2, Tue=3
      const { filenames } = getWeekRange();
      expect(filenames[3]).toBe('2026_04_07.md');
    });

    it('when today is Saturday, Saturday is the first day (daysSinceSat = 0)', () => {
      // 2026-04-04 12:00 Chicago (17:00 UTC) is a Saturday
      vi.setSystemTime(new Date('2026-04-04T17:00:00.000Z'));
      const { filenames, start, end } = getWeekRange();
      expect(filenames[0]).toBe('2026_04_04.md');
      expect(filenames[6]).toBe('2026_04_10.md');
      expect(start).toBe('Apr 4');
      expect(end).toBe('Apr 10');
    });

    it('when today is Friday, it is the last day of the week', () => {
      // 2026-04-10 12:00 Chicago (17:00 UTC) is a Friday
      vi.setSystemTime(new Date('2026-04-10T17:00:00.000Z'));
      const { filenames } = getWeekRange();
      expect(filenames[0]).toBe('2026_04_04.md');
      expect(filenames[6]).toBe('2026_04_10.md');
    });

    it('handles week crossing a month boundary', () => {
      // 2026-04-29 is Wednesday; week start is Sat 2026-04-25, week end is Fri 2026-05-01
      vi.setSystemTime(new Date('2026-04-29T17:00:00.000Z'));
      const { filenames, start, end } = getWeekRange();
      expect(filenames[0]).toBe('2026_04_25.md');
      expect(filenames[6]).toBe('2026_05_01.md');
      expect(start).toBe('Apr 25');
      expect(end).toBe('May 1');
    });

    it('all filenames match YYYY_MM_DD.md pattern', () => {
      const { filenames } = getWeekRange();
      for (const f of filenames) {
        expect(f).toMatch(/^\d{4}_\d{2}_\d{2}\.md$/);
      }
    });
  });

  describe('getMonthInfo', () => {
    it('returns correct month number (1-indexed)', () => {
      expect(getMonthInfo().month).toBe(4); // April
    });

    it('returns correct month name', () => {
      expect(getMonthInfo().monthName).toBe('April');
    });

    it('returns correct day of month', () => {
      expect(getMonthInfo().day).toBe(7);
    });

    it('returns correct lastDay for April (30 days)', () => {
      expect(getMonthInfo().lastDay).toBe(30);
    });

    it('returns lastDay 31 for a 31-day month', () => {
      // January 2026 has 31 days; pin to 2026-01-15 12:00 Chicago (18:00 UTC, CST)
      vi.setSystemTime(new Date('2026-01-15T18:00:00.000Z'));
      expect(getMonthInfo().lastDay).toBe(31);
    });

    it('returns lastDay 28 for a non-leap February', () => {
      // February 2026 is not a leap year; pin to 2026-02-10 12:00 Chicago
      vi.setSystemTime(new Date('2026-02-10T18:00:00.000Z'));
      expect(getMonthInfo().lastDay).toBe(28);
    });

    it('returns lastDay 29 for a leap year February', () => {
      // February 2028 is a leap year; pin to 2028-02-10 12:00 Chicago
      vi.setSystemTime(new Date('2028-02-10T18:00:00.000Z'));
      expect(getMonthInfo().lastDay).toBe(29);
    });

    it('returns month 12 and lastDay 31 in December', () => {
      vi.setSystemTime(new Date('2026-12-15T18:00:00.000Z'));
      const info = getMonthInfo();
      expect(info.month).toBe(12);
      expect(info.monthName).toBe('December');
      expect(info.lastDay).toBe(31);
    });
  });
});
