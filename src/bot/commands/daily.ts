import TelegramBot from 'node-telegram-bot-api';
import { startReview } from '../../reviews/orchestrator.js';
import { getTodayDate } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

// Side-effect import: registers the daily review handler
import '../../reviews/daily.js';

const log = createLogger('cmd-daily');

/** Resolve a date argument to YYYY-MM-DD format. Returns null if invalid. */
export function resolveDate(args: string): string | null {
  if (!args) return getTodayDate();

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(args)) return args;

  // MM/DD or MM-DD → resolve to current year
  const slashMatch = args.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (slashMatch?.[1] && slashMatch[2]) {
    const year = getTodayDate().slice(0, 4);
    const month = slashMatch[1].padStart(2, '0');
    const day = slashMatch[2].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  return null;
}

export async function handleDaily(bot: TelegramBot, chatId: number, args: string): Promise<void> {
  const date = resolveDate(args);
  if (!date) {
    await bot.sendMessage(chatId, 'Invalid date format. Use: /daily, /daily 2026-04-10, or /daily 4/10');
    return;
  }

  log.info('Starting daily review', { chatId, date });
  await startReview(chatId, 'daily', date, bot);
}
