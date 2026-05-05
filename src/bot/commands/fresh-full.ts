import { getSession, getSessionMessages, deleteSession } from '../../vault/sessions.js';
import { appendToJournal } from '../../vault/journal.js';
import { getTimestamp } from '../../utils/time.js';
import { gitCommitAndPush } from '../../vault/git.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-fresh-full');

function formatMessage(role: 'user' | 'assistant', text: string): string {
  const label = role === 'user' ? 'Me' : 'Jarvis';
  const lines = text.split('\n');
  const first = `\t- [${label}] ${lines[0] ?? ''}`;
  if (lines.length === 1) return first;
  const rest = lines.slice(1).map((l) => `\t  ${l}`).join('\n');
  return `${first}\n${rest}`;
}

export async function handleFreshFull(sender: MessageSender, userId: number): Promise<void> {
  const session = getSession(userId);
  if (!session) {
    await sender.send(userId, 'No active conversation to log.');
    return;
  }

  const messages = getSessionMessages(userId);
  if (messages.length === 0) {
    await sender.send(userId, 'No messages captured in this session — use /fresh for a summary instead.');
    deleteSession(userId);
    return;
  }

  sender.startTyping(userId);
  try {
    const transcript = messages.map((m) => formatMessage(m.role, m.text)).join('\n');
    const ts = getTimestamp();
    const entry = `- ${ts} [[jarvis]] telegram chat (full transcript)\n${transcript}`;
    appendToJournal(entry);
    log.info('Full transcript logged', { userId, messageCount: messages.length });

    await gitCommitAndPush('TG conversation logged (full)');
    deleteSession(userId);
    await sender.send(userId, `Full conversation logged (${messages.length} messages). Session reset.`);
  } catch (err) {
    log.error('fresh-full exception', { error: (err as Error).message });
    deleteSession(userId);
    await sender.send(userId, `Internal error logging conversation — session reset. Error: ${(err as Error).message}`);
  } finally {
    sender.stopTyping(userId);
  }
}
