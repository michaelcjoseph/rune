import {
  getSession,
  getSessionMessages,
  deleteSession,
  transportLabel,
  type Transport,
  type SessionScope,
} from '../../vault/sessions.js';
import { describeActiveNonChatContext } from './active-context.js';
import { appendToJournal } from '../../vault/journal.js';
import { getTimestamp } from '../../utils/time.js';
import { gitCommitAndPush } from '../../vault/git.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-fresh-full');

function formatMessage(role: 'user' | 'assistant', text: string): string {
  const label = role === 'user' ? 'Me' : 'Rune';
  const lines = text.split('\n');
  const first = `\t- [${label}] ${lines[0] ?? ''}`;
  if (lines.length === 1) return first;
  const rest = lines.slice(1).map((l) => `\t  ${l}`).join('\n');
  return `${first}\n${rest}`;
}

export async function handleFreshFull(
  sender: MessageSender,
  userId: number,
  transport: Transport,
  scope?: SessionScope,
): Promise<void> {
  const session = scope ? getSession(userId, transport, scope) : getSession(userId, transport);
  if (!session) {
    // No chat session — but the user may be in a planning/review/SR context
    // that routes ahead of the chat path and never creates a chat Session.
    // Point them at the right escape hatch instead of the misleading bare
    // "No active conversation to log." that read as a bug.
    const contextMsg = describeActiveNonChatContext(userId);
    await sender.send(userId, contextMsg ?? 'No active conversation to log.');
    return;
  }

  const messages = scope ? getSessionMessages(userId, transport, scope) : getSessionMessages(userId, transport);
  if (messages.length === 0) {
    await sender.send(userId, 'No messages captured in this session — use /fresh for a summary instead.');
    if (scope) deleteSession(userId, transport, scope);
    else deleteSession(userId, transport);
    return;
  }

  sender.startTyping(userId);
  try {
    const transcript = messages.map((m) => formatMessage(m.role, m.text)).join('\n');
    const ts = getTimestamp();
    const entry = `- ${ts} [[rune]] ${transportLabel(transport)} (full transcript)\n${transcript}`;
    appendToJournal(entry);
    log.info('Full transcript logged', { userId, transport, messageCount: messages.length });

    await gitCommitAndPush('Conversation logged (full)');
    if (scope) deleteSession(userId, transport, scope);
    else deleteSession(userId, transport);
    await sender.send(userId, `Full conversation logged (${messages.length} messages). Session reset.`);
  } catch (err) {
    log.error('fresh-full exception', { error: (err as Error).message });
    if (scope) deleteSession(userId, transport, scope);
    else deleteSession(userId, transport);
    await sender.send(userId, `Internal error logging conversation — session reset. Error: ${(err as Error).message}`);
  } finally {
    sender.stopTyping(userId);
  }
}
