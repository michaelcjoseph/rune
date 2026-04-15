import TelegramBot from 'node-telegram-bot-api';
import { getSession, deleteSession } from '../../vault/sessions.js';
import { summarizeSession } from '../../ai/claude.js';
import { appendToJournal } from '../../vault/journal.js';
import { getTimestamp, getTodayDate } from '../../utils/time.js';
import { gitCommitAndPush } from '../../vault/git.js';
import { writeVaultFile } from '../../vault/files.js';
import { enqueue } from '../../kb/queue.js';
import { startTyping, stopTyping } from '../../integrations/telegram/client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-fresh');

export function saveConversationSource(summary: string): string {
  const date = getTodayDate();
  const time = getTimestamp().replace(':', '');
  const secs = String(new Date().getSeconds()).padStart(2, '0');
  const filename = `conversation-${date}-${time}${secs}.md`;
  const path = `knowledge/raw/conversations/${filename}`;
  writeVaultFile(path, summary);
  log.info('Saved conversation source', { path });
  return path;
}

export function parseKBWorthy(summary: string): { isKBWorthy: boolean; journalSummary: string } {
  const lines = summary.split('\n');
  const kbLine = lines.find((l) => l.trim().toLowerCase().startsWith('kb-worthy:'));
  const isKBWorthy = kbLine ? kbLine.split(':').slice(1).join(':').trim().toLowerCase() === 'yes' : false;
  const journalSummary = lines
    .filter((l) => !l.trim().toLowerCase().startsWith('kb-worthy:'))
    .join('\n')
    .trim();
  return { isKBWorthy, journalSummary };
}

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

    const { isKBWorthy, journalSummary } = parseKBWorthy(result.text ?? '');
    log.info('Session classified', { sessionId: session.sessionId, isKBWorthy });

    const summaryLines = journalSummary.split('\n').map((l) => `\t- ${l}`).join('\n');
    const entry = `- ${ts} [[jarvis]] telegram chat\n${summaryLines}`;
    appendToJournal(entry);

    if (isKBWorthy) {
      const sourcePath = saveConversationSource(journalSummary);
      enqueue(sourcePath);
    }

    await gitCommitAndPush('TG conversation logged');

    deleteSession(chatId);

    const kbLabel = isKBWorthy ? '📚 Saved to KB sources for ingestion.' : '';
    const message = `Conversation logged. Session reset.\n\n${journalSummary}${kbLabel ? '\n\n' + kbLabel : ''}`;
    await bot.sendMessage(chatId, message);
  } catch (err) {
    stopTyping(typing);
    log.error('Fresh exception', { error: (err as Error).message });
    deleteSession(chatId);
    await bot.sendMessage(chatId, `Error logging conversation: ${(err as Error).message}. Session reset.`);
  }
}
