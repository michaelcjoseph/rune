import config from '../config.js';

const tz = config.TIMEZONE;

export function getTodayFilename(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const year = parts.find((p) => p.type === 'year')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  const day = parts.find((p) => p.type === 'day')!.value;

  return `${year}_${month}_${day}.md`;
}

export function getTimestamp(): string {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
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

