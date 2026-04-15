import TelegramBot from 'node-telegram-bot-api';
import { startReview } from '../../reviews/orchestrator.js';
import { setThinkTopic } from '../../reviews/think.js';
import { getTodayDate } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-think');

export async function handleThink(bot: TelegramBot, chatId: number, args: string): Promise<void> {
  if (!args) {
    await bot.sendMessage(chatId, 'Usage: /think <topic>');
    return;
  }

  log.info('Starting think session', { chatId, topic: args });
  setThinkTopic(args);
  await startReview(chatId, 'think', getTodayDate(), bot);
}
