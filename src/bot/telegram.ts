import TelegramBot from 'node-telegram-bot-api';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';
import { handleTextMessage } from './handlers/text.js';
import { handlePhotoMessage } from './handlers/photo.js';

const log = createLogger('telegram');

export function createBot(): TelegramBot {
  const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });

  bot.on('message', (msg) => {
    if (msg.text) {
      handleTextMessage(bot, msg).catch((err) => {
        log.error('Unhandled error in text handler', { error: (err as Error).message });
      });
    } else if (msg.photo) {
      handlePhotoMessage(bot, msg).catch((err) => {
        log.error('Unhandled error in photo handler', { error: (err as Error).message });
      });
    }
  });

  bot.on('polling_error', (err) => {
    log.error('Polling error', { error: err.message });
  });

  log.info('Telegram bot started (polling mode)');
  return bot;
}
