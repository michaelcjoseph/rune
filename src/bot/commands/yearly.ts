import { startReview } from '../../reviews/orchestrator.js';
import { getTodayDate } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

// Side-effect import: registers the yearly review handler
import '../../reviews/yearly.js';

const log = createLogger('cmd-yearly');

/** Resolve a year argument to Dec 31 of that year (YYYY-MM-DD). Returns null if invalid. */
export function resolveYear(args: string): string | null {
  const currentYear = Number(getTodayDate().slice(0, 4));

  if (!args) return `${currentYear}-12-31`;

  // 4-digit year: "2025", "2026"
  if (/^\d{4}$/.test(args)) return `${args}-12-31`;

  return null;
}

export async function handleYearly(sender: MessageSender, userId: number, args: string): Promise<void> {
  const date = resolveYear(args);
  if (!date) {
    await sender.send(userId, 'Invalid year format. Use: /yearly or /yearly 2025');
    return;
  }

  log.info('Starting yearly review', { userId, date });
  await startReview(userId, 'yearly', date, sender);
}
