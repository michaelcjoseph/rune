import { startReview } from '../../reviews/orchestrator.js';
import { getTodayDate } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

// Side-effect import: registers the weekly review handler
import '../../reviews/weekly.js';

const log = createLogger('cmd-weekly');

/** Find the most recent Friday on or before the given YYYY-MM-DD date.
 *  JS getDay(): 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat */
function toFriday(isoDate: string): string {
  const parts = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  const offset = (date.getDay() - 5 + 7) % 7;
  date.setDate(date.getDate() - offset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Resolve a date argument to the target Friday in YYYY-MM-DD format. Returns null if invalid. */
export function resolveFriday(args: string): string | null {
  if (!args) return toFriday(getTodayDate());

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(args)) return toFriday(args);

  // MM/DD or MM-DD → resolve to current year, then find Friday
  const slashMatch = args.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (slashMatch?.[1] && slashMatch[2]) {
    const year = getTodayDate().slice(0, 4);
    const month = slashMatch[1].padStart(2, '0');
    const day = slashMatch[2].padStart(2, '0');
    return toFriday(`${year}-${month}-${day}`);
  }

  return null;
}

export async function handleWeekly(sender: MessageSender, userId: number, args: string): Promise<void> {
  const date = resolveFriday(args);
  if (!date) {
    await sender.send(userId, 'Invalid date format. Use: /weekly, /weekly 2026-04-11, or /weekly 4/11');
    return;
  }

  log.info('Starting weekly review', { userId, date });
  await startReview(userId, 'weekly', date, sender);
}
