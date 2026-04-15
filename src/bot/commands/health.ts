import TelegramBot from 'node-telegram-bot-api';
import { startReview } from '../../reviews/orchestrator.js';
import { setHealthFocus } from '../../reviews/health.js';
import { getTodayDate } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-health');

export async function handleHealth(bot: TelegramBot, chatId: number, args: string): Promise<void> {
  log.info('Starting health session', { chatId, focus: args || 'general' });
  if (args) setHealthFocus(args);
  await startReview(chatId, 'health', getTodayDate(), bot);
}
