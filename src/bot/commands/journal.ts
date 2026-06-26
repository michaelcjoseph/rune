import { appendToJournal } from '../../vault/journal.js';
import { getTimestamp } from '../../utils/time.js';
import { gitCommitAndPush } from '../../vault/git.js';
import { getSession, transportLabel, type Transport, type SessionScope } from '../../vault/sessions.js';
import { closeConversation } from './fresh.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-journal');

export async function handleJournal(
  sender: MessageSender,
  userId: number,
  transport: Transport,
  text: string,
  scope?: SessionScope,
): Promise<void> {
  const ts = getTimestamp();
  const entry = `- ${ts} [[rune]] ${transportLabel(transport)}\n\t- ${text}`;
  appendToJournal(entry);

  // If a multi-turn conversation is active, journaling closes the thread.
  // Mirrors /fresh: summarize the chat, append the summary, enqueue if
  // KB-worthy, commit, delete the session. The user's literal entry above
  // remains uncommitted here so closeConversation's single commit captures
  // both the literal entry and the summary together.
  if (!(scope ? getSession(userId, transport, scope) : getSession(userId, transport))) {
    await gitCommitAndPush('TG journal entry');
    await sender.send(userId, 'Logged to journal.');
    return;
  }

  sender.startTyping(userId);
  const result = await closeConversation(userId, transport, scope);
  sender.stopTyping(userId);

  if (!result.ok) {
    if (result.error !== 'no-session') {
      log.error('Journal session-close failed', { userId, error: result.error });
    }
    // closeConversation only commits on its success path. On failure (or the
    // 'no-session' race) the literal entry above is still uncommitted, so we
    // commit it here as a fallback to keep the working tree clean.
    await gitCommitAndPush('TG journal entry');
    const detail = result.error === 'no-session'
      ? ''
      : `\n(Conversation summary failed: ${result.error}. Session reset.)`;
    await sender.send(userId, `Logged to journal.${detail}`);
    return;
  }

  const kbLabel = result.isKBWorthy ? '\n\nSaved to KB sources for ingestion.' : '';
  await sender.send(userId,
    `Logged to journal. Conversation summary saved, session reset.\n\n${result.journalSummary}${kbLabel}`,
  );
}
