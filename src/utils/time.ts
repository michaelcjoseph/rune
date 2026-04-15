import config from '../config.js';

const tz = config.TIMEZONE;

function getLocalDate(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  return {
    year: Number(parts.find((p) => p.type === 'year')!.value),
    month: Number(parts.find((p) => p.type === 'month')!.value) - 1,
    day: Number(parts.find((p) => p.type === 'day')!.value),
  };
}

function formatDateFilename(date: Date): string {
  const { year, month, day } = getLocalDate(date);
  return `${year}_${String(month + 1).padStart(2, '0')}_${String(day).padStart(2, '0')}.md`;
}

export function getTodayFilename(): string {
  return formatDateFilename(new Date());
}

export function getTodayDate(): string {
  const { year, month, day } = getLocalDate(new Date());
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function getTimestamp(): string {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function getYesterdayFilename(): string {
  const { year, month, day } = getLocalDate(new Date());
  return formatDateFilename(new Date(year, month, day - 1));
}

export function getYesterdayDate(): string {
  const { year, month, day } = getLocalDate(new Date());
  const d = new Date(year, month, day - 1);
  const { year: y, month: m, day: dd } = getLocalDate(d);
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export function getDayOfWeek(): string {
  return new Date().toLocaleDateString('en-US', {
    timeZone: tz,
    weekday: 'long',
  });
}

/**
 * Get the Saturday-through-Friday week range for the current week.
 * Returns journal filenames and formatted display labels.
 */
export function getWeekRange(): { start: string; end: string; filenames: string[] } {
  const now = new Date();
  const { year, month, day } = getLocalDate(now);
  // Use UTC to avoid local-TZ reinterpretation of Chicago-local date components
  const dow = new Date(Date.UTC(year, month, day)).getUTCDay(); // 0=Sun, 6=Sat
  // Days since last Saturday: Saturday=0, Sunday=1, Monday=2, ..., Friday=6
  const daysSinceSat = dow === 6 ? 0 : dow + 1;

  const filenames: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(year, month, day - daysSinceSat + i);
    filenames.push(formatDateFilename(d));
  }

  const satDate = new Date(Date.UTC(year, month, day - daysSinceSat));
  const friDate = new Date(Date.UTC(year, month, day - daysSinceSat + 6));
  const fmt = (d: Date): string => d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

  return { start: fmt(satDate), end: fmt(friDate), filenames };
}

export function getRecentFilenames(days: number): string[] {
  const { year, month, day } = getLocalDate(new Date());
  const filenames: string[] = [];
  for (let i = 0; i < days; i++) {
    filenames.push(formatDateFilename(new Date(year, month, day - i)));
  }
  return filenames;
}

/** Get current month info in the configured timezone. */
export function getMonthInfo(): { month: number; monthName: string; day: number; lastDay: number } {
  const now = new Date();
  const { year, month, day } = getLocalDate(now);
  const monthName = now.toLocaleDateString('en-US', { timeZone: tz, month: 'long' });
  // Last day of the current month: day 0 of next month = last day of this month
  const lastDay = new Date(year, month + 1, 0).getDate();
  return { month: month + 1, monthName, day, lastDay };
}

/** Standardized date context string for agent and one-shot prompts. */
export function getDateContext(): string {
  const now = new Date();
  const formatted = now.toLocaleDateString('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return `Today is ${formatted} (${tz}). Today's journal file: ${getTodayFilename()}`;
}
