import TelegramBot from 'node-telegram-bot-api';
import { appendToJournal } from '../../vault/journal.js';
import { getTimestamp } from '../../utils/time.js';
import { gitCommitAndPush } from '../../vault/git.js';
import { getSession } from '../../vault/sessions.js';
import { closeConversation } from './fresh.js';
import { startTyping, stopTyping } from '../../integrations/telegram/client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-journal');

export async function handleJournal(bot: TelegramBot, chatId: number, text: string): Promise<void> {
  const ts = getTimestamp();
  const entry = `- ${ts} [[jarvis]] telegram chat\n\t- ${text}`;
  appendToJournal(entry);

  // If a multi-turn conversation is active, journaling closes the thread.
  // Mirrors /fresh: summarize the chat, append the summary, enqueue if
  // KB-worthy, commit, delete the session. The user's literal entry above
  // remains uncommitted here so closeConversation's single commit captures
  // both the literal entry and the summary together.
  if (!getSession(chatId)) {
    await gitCommitAndPush('TG journal entry');
    await bot.sendMessage(chatId, 'Logged to journal.');
    return;
  }

  const typing = startTyping(bot, chatId);
  const result = await closeConversation(chatId);
  stopTyping(typing);

  if (!result.ok) {
    if (result.error !== 'no-session') {
      log.error('Journal session-close failed', { chatId, error: result.error });
    }
    // closeConversation only commits on its success path. On failure (or the
    // 'no-session' race) the literal entry above is still uncommitted, so we
    // commit it here as a fallback to keep the working tree clean.
    await gitCommitAndPush('TG journal entry');
    const detail = result.error === 'no-session'
      ? ''
      : `\n(Conversation summary failed: ${result.error}. Session reset.)`;
    await bot.sendMessage(chatId, `Logged to journal.${detail}`);
    return;
  }

  const kbLabel = result.isKBWorthy ? '\n\nSaved to KB sources for ingestion.' : '';
  await bot.sendMessage(
    chatId,
    `Logged to journal. Conversation summary saved, session reset.\n\n${result.journalSummary}${kbLabel}`,
  );
}
