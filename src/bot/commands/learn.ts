import TelegramBot from 'node-telegram-bot-api';
import { appendLearning } from '../../vault/learnings.js';

export async function handleLearn(bot: TelegramBot, chatId: number, text: string): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    await bot.sendMessage(
      chatId,
      'Usage: /learn <what you want me to remember>\nExample: /learn Prefer terse answers — no trailing recap after a diff.',
    );
    return;
  }
  appendLearning(trimmed);
  await bot.sendMessage(chatId, 'Logged. I will prepend this to future agent runs.');
}
