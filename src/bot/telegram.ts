import TelegramBot from 'node-telegram-bot-api';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';
import { handleTextMessage } from './handlers/text.js';

const log = createLogger('telegram');

export function createBot(): TelegramBot {
  const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });

  bot.on('message', (msg) => {
    if (msg.text) {
      handleTextMessage(bot, msg).catch((err) => {
        log.error('Unhandled error in text handler', { error: (err as Error).message });
      });
    }
    // Photo and URL handlers will be added in Phase 4
  });

  bot.on('polling_error', (err) => {
    log.error('Polling error', { error: err.message });
  });

  log.info('Telegram bot started (polling mode)');
  return bot;
}
