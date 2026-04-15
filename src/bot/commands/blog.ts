import TelegramBot from 'node-telegram-bot-api';
import { startReview } from '../../reviews/orchestrator.js';
import { getTodayDate } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-blog');

export async function handleBlog(bot: TelegramBot, chatId: number, args: string): Promise<void> {
  if (!args) {
    await bot.sendMessage(chatId, 'Usage: /blog <topic>');
    return;
  }

  log.info('Starting blog session', { chatId, topic: args });
  await startReview(chatId, 'blog', getTodayDate(), bot, args);
}
