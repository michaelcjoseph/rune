import TelegramBot from 'node-telegram-bot-api';
import { startReview } from '../../reviews/orchestrator.js';
import { getTodayDate } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

// Side-effect import: registers the think review handler
import '../../reviews/think.js';

const log = createLogger('cmd-think');

export async function handleThink(bot: TelegramBot, chatId: number, args: string): Promise<void> {
  if (!args) {
    await bot.sendMessage(chatId, 'Usage: /think <topic>');
    return;
  }

  log.info('Starting think session', { chatId, topic: args });
  await startReview(chatId, 'think', getTodayDate(), bot, args);
}
