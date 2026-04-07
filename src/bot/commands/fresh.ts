import TelegramBot from 'node-telegram-bot-api';
import { getSession, deleteSession } from '../../vault/sessions.js';
import { summarizeSession } from '../../ai/claude.js';
import { appendToJournal } from '../../vault/journal.js';
import { getTimestamp } from '../../utils/time.js';
import { gitCommitAndPush } from '../../vault/git.js';
import { startTyping, stopTyping } from '../../integrations/telegram/client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-fresh');

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
      log.error('Summarize error', { error: result.error, sessionId: session.sessionId });
      deleteSession(chatId);
      await bot.sendMessage(chatId, `Could not summarize conversation — session reset.\nError: ${result.error}`);
      return;
    }

    const summaryLines = result.text!.split('\n').map((l) => `\t- ${l}`).join('\n');
    const entry = `- ${ts} [[jarvis]] telegram chat\n${summaryLines}`;
    appendToJournal(entry);
    gitCommitAndPush('TG conversation logged');

    deleteSession(chatId);
    await bot.sendMessage(chatId, `Conversation logged. Session reset.\n\n${result.text}`);
  } catch (err) {
    stopTyping(typing);
    log.error('Fresh exception', { error: (err as Error).message });
    deleteSession(chatId);
    await bot.sendMessage(chatId, `Error logging conversation: ${(err as Error).message}. Session reset.`);
  }
}
