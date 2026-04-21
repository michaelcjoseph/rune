import TelegramBot from 'node-telegram-bot-api';
import { executeMorningPrep } from '../../jobs/morning-prep.js';
import { startTyping, stopTyping } from '../../integrations/telegram/client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-prep');

export async function handlePrep(bot: TelegramBot, chatId: number): Promise<void> {
  const typing = startTyping(bot, chatId);
  try {
    const result = await executeMorningPrep();
    stopTyping(typing);

    if (result.status === 'written') {
      await bot.sendMessage(chatId, 'Morning prep complete. Your journal is ready.');
    } else if (result.status === 'fallback') {
      await bot.sendMessage(
        chatId,
        `Morning prep wrote a fallback — Claude synth failed: ${result.synthError}. Review and edit.`
      );
    } else if (result.status === 'skipped') {
      await bot.sendMessage(chatId, 'Morning prep already written today.');
    }
  } catch (err) {
    stopTyping(typing);
    log.error('Prep command error', { error: (err as Error).message });
    await bot.sendMessage(chatId, `Morning prep failed: ${(err as Error).message}`);
  }
}
