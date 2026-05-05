import TelegramBot from 'node-telegram-bot-api';
import type { MessageSender } from '../transport/sender.js';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';
import { handleTextMessage } from './handlers/text.js';
import { handlePhotoMessage } from './handlers/photo.js';

const log = createLogger('telegram');

export function createBot(): TelegramBot {
  return new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
}

/** Wire message handlers to an already-created bot. Called after senders are ready. */
export function wireHandlers(bot: TelegramBot, sender: MessageSender): void {
  bot.on('message', (msg) => {
    if (msg.text) {
      handleTextMessage(sender, msg).catch((err) => {
        log.error('Unhandled error in text handler', { error: (err as Error).message });
      });
    } else if (msg.photo) {
      handlePhotoMessage(bot, sender, msg).catch((err) => {
        log.error('Unhandled error in photo handler', { error: (err as Error).message });
      });
    }
  });

  bot.on('polling_error', (err: any) => {
    const cause = err.cause;
    log.error('Polling error', {
      code: err.code,
      causeCode: cause?.code,
      causeMessage: cause?.message,
      statusCode: err.response?.statusCode,
    });
  });

  log.info('Telegram bot started (polling mode)');
}
