import TelegramBot from 'node-telegram-bot-api';
import { askClaudeOneShot } from '../../ai/claude.js';
import { sendLongMessage, startTyping, stopTyping } from '../../integrations/telegram/client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-ask');

export async function handleAsk(bot: TelegramBot, chatId: number, question: string): Promise<void> {
  const typing = startTyping(bot, chatId);
  try {
    const result = await askClaudeOneShot(question);
    stopTyping(typing);

    if (result.error) {
      log.error('Ask error', { error: result.error });
      await bot.sendMessage(chatId, `Error: ${result.error}`);
      return;
    }

    await sendLongMessage(bot, chatId, result.text!);
  } catch (err) {
    stopTyping(typing);
    log.error('Ask exception', { error: (err as Error).message });
    await bot.sendMessage(chatId, `Error: ${(err as Error).message}`);
  }
}
