import TelegramBot from 'node-telegram-bot-api';
import { getSession, deleteSession } from '../../vault/sessions.js';
import { summarizeSession } from '../../ai/claude.js';
import { appendToJournal, getTimestamp } from '../../vault/journal.js';
import { gitCommitAndPush } from '../../vault/git.js';
import { startTyping, stopTyping } from '../../integrations/telegram/client.js';

export async function handleFresh(bot: TelegramBot, chatId: number): Promise<void> {
  const session = getSession(chatId);
  if (!session) {
    await bot.sendMessage(chatId, 'No active conversation to summarize.');
    return;
  }

  const typing = startTyping(bot, chatId);
  try {
    const result = await summarizeSession(session.sessionId);
    stopTyping(typing);

    const ts = getTimestamp();

    if (result.error) {
      deleteSession(chatId);
      await bot.sendMessage(chatId, `Could not summarize conversation — session reset.\nError: ${result.error}`);
      return;
    }

    const entry = `${ts} - [tg] ${result.text}`;
    appendToJournal(entry);
    gitCommitAndPush('TG conversation logged');

    deleteSession(chatId);
    await bot.sendMessage(chatId, `Conversation logged. Session reset.\n\n${result.text}`);
  } catch (err) {
    stopTyping(typing);
    deleteSession(chatId);
    await bot.sendMessage(chatId, `Error logging conversation: ${(err as Error).message}. Session reset.`);
  }
}
