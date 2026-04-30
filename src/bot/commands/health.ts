import TelegramBot from 'node-telegram-bot-api';
import { startReview } from '../../reviews/orchestrator.js';
import { getTodayDate } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

// Side-effect import: registers the health review handler
import '../../reviews/health.js';

const log = createLogger('cmd-health');

export async function handleHealth(bot: TelegramBot, chatId: number, args: string): Promise<void> {
  log.info('Starting health session', { chatId, focus: args || 'general' });
  await startReview(chatId, 'health', getTodayDate(), bot, args || undefined);
}
