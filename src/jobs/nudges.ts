import type TelegramBot from 'node-telegram-bot-api';
import { createLogger } from '../utils/logger.js';

const log = createLogger('nudges');

/** Friday 3pm — weekly review nudge with week stats. Fleshed out in Phase 7. */
export async function runWeeklyNudge(_bot: TelegramBot): Promise<void> {
  log.info('Weekly nudge fired (not yet implemented)');
}

/** End-of-month — review reminder with cadence logic. Fleshed out in Phase 7. */
export async function runReviewNudge(_bot: TelegramBot): Promise<void> {
  log.info('Review nudge fired (not yet implemented)');
}
