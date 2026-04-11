import TelegramBot from 'node-telegram-bot-api';
import { startReview } from '../../reviews/orchestrator.js';
import { getTodayDate } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

// Side-effect import: registers the quarterly review handler
import '../../reviews/quarterly.js';

const log = createLogger('cmd-quarterly');

/** Get last day of a quarter as YYYY-MM-DD */
function lastDayOfQuarter(year: number, quarter: number): string {
  const endMonth = quarter * 3;
  const last = new Date(year, endMonth, 0);
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
}

/** Resolve a quarter argument to the last day of that quarter (YYYY-MM-DD). Returns null if invalid. */
export function resolveQuarter(args: string): string | null {
  const today = getTodayDate();
  const currentYear = Number(today.slice(0, 4));
  const currentMonth = Number(today.slice(5, 7));
  const currentQuarter = Math.ceil(currentMonth / 3);

  if (!args) return lastDayOfQuarter(currentYear, currentQuarter);

  // Q1, Q2, Q3, Q4 (current year)
  const qMatch = args.match(/^[Qq](\d)$/);
  if (qMatch?.[1]) {
    const q = Number(qMatch[1]);
    if (q >= 1 && q <= 4) return lastDayOfQuarter(currentYear, q);
  }

  // Q1 2026, Q2 2025, etc.
  const qYearMatch = args.match(/^[Qq](\d)\s+(\d{4})$/);
  if (qYearMatch?.[1] && qYearMatch[2]) {
    const q = Number(qYearMatch[1]);
    const y = Number(qYearMatch[2]);
    if (q >= 1 && q <= 4) return lastDayOfQuarter(y, q);
  }

  return null;
}

export async function handleQuarterly(bot: TelegramBot, chatId: number, args: string): Promise<void> {
  const date = resolveQuarter(args);
  if (!date) {
    await bot.sendMessage(chatId, 'Invalid quarter format. Use: /quarterly, /quarterly Q1, or /quarterly Q2 2026');
    return;
  }

  log.info('Starting quarterly review', { chatId, date });
  await startReview(chatId, 'quarterly', date, bot);
}
