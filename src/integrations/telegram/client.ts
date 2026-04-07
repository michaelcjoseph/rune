import TelegramBot from 'node-telegram-bot-api';
import config from '../../config.js';

function chunkMessage(text: string, maxLen = config.TG_MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Find last newline within maxLen
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  return chunks;
}

export async function sendLongMessage(bot: TelegramBot, chatId: number, text: string): Promise<void> {
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk);
  }
}

export function startTyping(bot: TelegramBot, chatId: number): ReturnType<typeof setInterval> {
  bot.sendChatAction(chatId, 'typing').catch(() => {});
  const interval = setInterval(() => {
    bot.sendChatAction(chatId, 'typing').catch(() => {});
  }, 4000);
  return interval;
}

export function stopTyping(interval: ReturnType<typeof setInterval>): void {
  clearInterval(interval);
}
