import TelegramBot from 'node-telegram-bot-api';
import { deleteSession, getSession } from '../../vault/sessions.js';
import { hasActiveReview } from '../../reviews/orchestrator.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('clear');

export async function handleClear(bot: TelegramBot, chatId: number): Promise<void> {
  const session = getSession(chatId);
  if (!session) {
    await bot.sendMessage(chatId, 'No active session to clear.');
    return;
  }
  if (hasActiveReview(chatId)) {
    await bot.sendMessage(chatId, 'Active review in progress — use /fresh to close it first.');
    return;
  }
  deleteSession(chatId);
  log.info('Session cleared', { chatId });
  await bot.sendMessage(chatId, 'Session cleared.');
}
