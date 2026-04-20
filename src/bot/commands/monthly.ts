import TelegramBot from 'node-telegram-bot-api';
import { startReview } from '../../reviews/orchestrator.js';
import { getTodayDate } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

// Side-effect import: registers the monthly review handler
import '../../reviews/monthly.js';

const log = createLogger('cmd-monthly');

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Get last day of month as YYYY-MM-DD */
function lastDayOfMonth(year: number, month: number): string {
  const last = new Date(year, month, 0);
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
}

/** Resolve a month argument to the last day of that month (YYYY-MM-DD). Returns null if invalid. */
export function resolveMonth(args: string): string | null {
  const today = getTodayDate();
  const currentYear = Number(today.slice(0, 4));
  const currentMonth = Number(today.slice(5, 7));

  if (!args) return lastDayOfMonth(currentYear, currentMonth);

  // Month name: "april", "apr"
  const monthNum = MONTH_NAMES[args.toLowerCase()];
  if (monthNum) return lastDayOfMonth(currentYear, monthNum);

  // YYYY-MM: "2026-04"
  const ymMatch = args.match(/^(\d{4})-(\d{1,2})$/);
  if (ymMatch?.[1] && ymMatch[2]) {
    const m = Number(ymMatch[2]);
    if (m >= 1 && m <= 12) return lastDayOfMonth(Number(ymMatch[1]), m);
    return null;
  }

  // MM or single number: "04" or "4"
  const numMatch = args.match(/^(\d{1,2})$/);
  if (numMatch?.[1]) {
    const m = Number(numMatch[1]);
    if (m >= 1 && m <= 12) return lastDayOfMonth(currentYear, m);
  }

  return null;
}

export async function handleMonthly(bot: TelegramBot, chatId: number, args: string): Promise<void> {
  const date = resolveMonth(args);
  if (!date) {
    await bot.sendMessage(chatId, 'Invalid month format. Use: /monthly, /monthly april, /monthly 04, or /monthly 2026-04');
    return;
  }

  log.info('Starting monthly review', { chatId, date });
  await startReview(chatId, 'monthly', date, bot);
}
