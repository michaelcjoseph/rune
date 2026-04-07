import TelegramBot from 'node-telegram-bot-api';
import { askClaudeOneShot } from '../../ai/claude.js';
import { sendLongMessage, startTyping, stopTyping } from '../../integrations/telegram/client.js';

export async function handleAsk(bot: TelegramBot, chatId: number, question: string): Promise<void> {
  const typing = startTyping(bot, chatId);
  try {
    const result = await askClaudeOneShot(question);
    stopTyping(typing);

    if (result.error) {
      await bot.sendMessage(chatId, `Error: ${result.error}`);
      return;
    }

    await sendLongMessage(bot, chatId, result.text!);
  } catch (err) {
    stopTyping(typing);
    await bot.sendMessage(chatId, `Error: ${(err as Error).message}`);
  }
}
