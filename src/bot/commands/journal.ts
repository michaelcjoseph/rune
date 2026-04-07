import TelegramBot from 'node-telegram-bot-api';
import { appendToJournal } from '../../vault/journal.js';
import { getTimestamp } from '../../utils/time.js';
import { gitCommitAndPush } from '../../vault/git.js';

export async function handleJournal(bot: TelegramBot, chatId: number, text: string): Promise<void> {
  const ts = getTimestamp();
  const entry = `- ${ts} [[jarvis]] telegram chat\n\t- ${text}`;
  appendToJournal(entry);
  gitCommitAndPush('TG journal entry');
  await bot.sendMessage(chatId, 'Logged to journal.');
}
