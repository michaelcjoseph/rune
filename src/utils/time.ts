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

export function getDayOfWeek(): string {
  return new Date().toLocaleDateString('en-US', {
    timeZone: tz,
    weekday: 'long',
  });
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
