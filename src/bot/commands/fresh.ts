import { getSession, deleteSession, transportLabel, type Transport } from '../../vault/sessions.js';
import { summarizeSession } from '../../ai/claude.js';
import { appendToJournal } from '../../vault/journal.js';
import { getTimestamp, getTodayDate } from '../../utils/time.js';
import { gitCommitAndPush } from '../../vault/git.js';
import { writeVaultFile } from '../../vault/files.js';
import { enqueue } from '../../kb/queue.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

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

export type CloseConversationResult =
  | { ok: true; journalSummary: string; isKBWorthy: boolean }
  | { ok: false; error: string };

/** Summarize the active conversation, append the summary to today's journal,
 *  optionally enqueue it to the KB, commit, and delete the session. Used by
 *  /fresh and by /journal (which closes the thread after a journal write).
 *  Returns metadata so callers can surface a tailored confirmation. Never
 *  throws — errors are returned as { ok: false }. */
export async function closeConversation(
  chatId: number,
  transport: Transport,
): Promise<CloseConversationResult> {
  const session = getSession(chatId, transport);
  if (!session) return { ok: false, error: 'no-session' };

  try {
    const result = await summarizeSession(session.sessionId);

    if (result.error) {
      log.error('Summarize error', { error: result.error, sessionId: session.sessionId });
      deleteSession(chatId, transport);
      return { ok: false, error: result.error };
    }

    const { isKBWorthy, journalSummary } = parseKBWorthy(result.text ?? '');
    log.info('Session classified', { sessionId: session.sessionId, isKBWorthy });

    const ts = getTimestamp();
    const summaryLines = journalSummary.split('\n').map((l) => `\t- ${l}`).join('\n');
    const entry = `- ${ts} [[jarvis]] ${transportLabel(transport)}\n${summaryLines}`;
    appendToJournal(entry);

    if (isKBWorthy) {
      const sourcePath = saveConversationSource(journalSummary);
      enqueue(sourcePath);
    }

    await gitCommitAndPush('Conversation logged');
    deleteSession(chatId, transport);
    return { ok: true, journalSummary, isKBWorthy };
  } catch (err) {
    log.error('closeConversation exception', { error: (err as Error).message });
    deleteSession(chatId, transport);
    return { ok: false, error: (err as Error).message };
  }
}

export async function handleFresh(
  sender: MessageSender,
  userId: number,
  transport: Transport,
): Promise<void> {
  const session = getSession(userId, transport);
  if (!session) {
    await sender.send(userId, 'No active conversation to summarize.');
    return;
  }

  sender.startTyping(userId);
  const result = await closeConversation(userId, transport);
  sender.stopTyping(userId);

  if (!result.ok) {
    log.error('Fresh: closeConversation failed', { error: result.error });
    await sender.send(userId, `Could not summarize conversation — session reset. Error: ${result.error}`);
    return;
  }

  const kbLabel = result.isKBWorthy ? '\n\nSaved to KB sources for ingestion.' : '';
  await sender.send(userId, `Conversation logged. Session reset.\n\n${result.journalSummary}${kbLabel}`);
}
