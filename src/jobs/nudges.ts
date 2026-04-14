import type TelegramBot from 'node-telegram-bot-api';
import { listVaultFiles } from '../vault/files.js';
import { getAllSessions } from '../vault/sessions.js';
import { getKBStats } from '../kb/engine.js';
import { getQueue } from '../kb/queue.js';
import { getWeekRange, getMonthInfo } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';
import config from '../config.js';

const log = createLogger('nudges');

/** Friday 3pm — weekly review nudge with week stats. */
export async function runWeeklyNudge(bot: TelegramBot): Promise<void> {
  try {
    const { start, end, filenames } = getWeekRange();

    // Count journal entries for this week
    const allJournals = new Set(listVaultFiles('journals').map((p) => p.split('/').pop()));
    const journalCount = filenames.filter((f) => allJournals.has(f)).length;

    // Session stats
    const sessions = getAllSessions();
    const sessionCount = sessions.length;
    const messageCount = sessions.reduce((sum, [, s]) => sum + s.messageCount, 0);

    // KB stats
    const kb = getKBStats();
    const queueSize = getQueue().length;

    // Format message
    const lines = [
      `It's Friday — time for your weekly review.`,
      ``,
      `This week (${start}–${end}):`,
      `- ${journalCount} journal ${journalCount === 1 ? 'entry' : 'entries'}`,
      `- ${sessionCount} active ${sessionCount === 1 ? 'session' : 'sessions'}${messageCount > 0 ? ` (${messageCount} messages)` : ''}`,
      `- ${kb.totalPages} wiki pages${queueSize > 0 ? `, ${queueSize} queued for ingestion` : ''}`,
      ``,
      `Send /weekly to start.`,
    ];

    await bot.sendMessage(config.TELEGRAM_USER_ID, lines.join('\n'));
    log.info('Weekly nudge sent', { journalCount, sessionCount, messageCount });
  } catch (err) {
    log.error('Weekly nudge failed', { error: String(err) });
  }
}

/** End-of-month — review reminder with cadence logic. */
export async function runReviewNudge(bot: TelegramBot): Promise<void> {
  try {
    const { month, monthName, day, lastDay } = getMonthInfo();

    // Cron fires on days 28-31; only act on the actual last day
    if (day !== lastDay) {
      log.info('Review nudge skipped — not last day of month', { day, lastDay });
      return;
    }

    // Determine review type based on month
    let reviewType: string;
    let command: string;
    if (month === 12) {
      reviewType = 'yearly';
      command = '/yearly';
    } else if ([3, 6, 9].includes(month)) {
      reviewType = 'quarterly';
      command = '/quarterly';
    } else {
      reviewType = 'monthly';
      command = '/monthly';
    }

    const message = `End of ${monthName} — time for your ${reviewType} review.\n\nSend ${command} to start.`;
    await bot.sendMessage(config.TELEGRAM_USER_ID, message);
    log.info('Review nudge sent', { month, reviewType });
  } catch (err) {
    log.error('Review nudge failed', { error: String(err) });
  }
}
