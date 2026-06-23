import { getSession, deleteSession, transportLabel, type Transport, type SessionScope } from '../../vault/sessions.js';
import { summarizeSession } from '../../ai/claude.js';
import { appendToJournal, saveConversationSource } from '../../vault/journal.js';
import { getTimestamp } from '../../utils/time.js';
import { gitCommitAndPush } from '../../vault/git.js';
import { enqueue } from '../../kb/queue.js';
import { abandonActivePlanningSession, getActivePlanningSession } from '../../reviews/planning.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-fresh');

// Relocated to src/vault/journal.ts (project 16) so non-bot surfaces can
// reuse it; re-exported here for existing callers/tests.
export { saveConversationSource } from '../../vault/journal.js';

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

function planningMatchesScope(
  planning: ReturnType<typeof getActivePlanningSession>,
  scope?: SessionScope,
): boolean {
  if (!planning) return false;
  if (!scope || scope.kind === 'global') return true;
  return planning.planning.product === scope.product;
}

/** Summarize the active conversation, append the summary to today's journal,
 *  optionally enqueue it to the KB, commit, and delete the session. Used by
 *  /fresh and by /journal (which closes the thread after a journal write).
 *  Returns metadata so callers can surface a tailored confirmation. Never
 *  throws — errors are returned as { ok: false }. */
export async function closeConversation(
  chatId: number,
  transport: Transport,
  scope?: SessionScope,
): Promise<CloseConversationResult> {
  const session = scope ? getSession(chatId, transport, scope) : getSession(chatId, transport);
  if (!session) return { ok: false, error: 'no-session' };

  try {
    const result = await summarizeSession(session.sessionId);

    if (result.error) {
      log.error('Summarize error', { error: result.error, sessionId: session.sessionId });
      if (scope) deleteSession(chatId, transport, scope);
      else deleteSession(chatId, transport);
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
    if (scope) deleteSession(chatId, transport, scope);
    else deleteSession(chatId, transport);
    return { ok: true, journalSummary, isKBWorthy };
  } catch (err) {
    log.error('closeConversation exception', { error: (err as Error).message });
    if (scope) deleteSession(chatId, transport, scope);
    else deleteSession(chatId, transport);
    return { ok: false, error: (err as Error).message };
  }
}

export async function handleFresh(
  sender: MessageSender,
  userId: number,
  transport: Transport,
  scope?: SessionScope,
): Promise<void> {
  // Active planning session is an escape hatch the spec promises (`/clear` or
  // `/fresh` abandons it). If there's a planning session and no chat session
  // to summarize, abandon and exit cleanly — don't try to summarize an empty
  // conversation. If both exist, the planning session is abandoned first and
  // the normal chat-summary flow continues.
  const planning = getActivePlanningSession(userId);
  const scopedPlanning = planningMatchesScope(planning, scope);
  const session = scope ? getSession(userId, transport, scope) : getSession(userId, transport);
  if (scopedPlanning && !session) {
    abandonActivePlanningSession(userId);
    log.info('Planning session abandoned via /fresh', { userId, transport });
    await sender.send(userId, 'Planning session abandoned.');
    return;
  }
  if (scopedPlanning) {
    abandonActivePlanningSession(userId);
    log.info('Planning session abandoned via /fresh (chat session also closing)', { userId, transport });
  }
  if (!session) {
    await sender.send(userId, 'No active conversation to summarize.');
    return;
  }

  sender.startTyping(userId);
  const result = await closeConversation(userId, transport, scope);
  sender.stopTyping(userId);

  if (!result.ok) {
    log.error('Fresh: closeConversation failed', { error: result.error });
    await sender.send(userId, `Could not summarize conversation — session reset. Error: ${result.error}`);
    return;
  }

  const kbLabel = result.isKBWorthy ? '\n\nSaved to KB sources for ingestion.' : '';
  await sender.send(userId, `Conversation logged. Session reset.\n\n${result.journalSummary}${kbLabel}`);
}
