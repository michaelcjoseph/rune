import TelegramBot from 'node-telegram-bot-api';
import { runLibrarySync } from '../../jobs/lenny-sync.js';
import { sendLongMessage, startTyping, stopTyping } from '../../integrations/telegram/client.js';

export async function handleLibrarySync(bot: TelegramBot, chatId: number): Promise<void> {
  await bot.sendMessage(chatId, 'Syncing Lenny library...');
  const typingTimer = startTyping(bot, chatId);
  try {
    const result = await runLibrarySync();
    const msg = result.status === 'error'
      ? `Library sync failed: ${result.detail}`
      : `Library sync complete: ${result.detail}`;
    await sendLongMessage(bot, chatId, msg);
  } finally {
    stopTyping(typingTimer);
  }
}
