import TelegramBot from 'node-telegram-bot-api';
import { getSession, getSessionMessages, deleteSession } from '../../vault/sessions.js';
import { appendToJournal } from '../../vault/journal.js';
import { getTimestamp } from '../../utils/time.js';
import { gitCommitAndPush } from '../../vault/git.js';
import { startTyping, stopTyping } from '../../integrations/telegram/client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-fresh-full');

function formatMessage(role: 'user' | 'assistant', text: string): string {
  const label = role === 'user' ? 'Me' : 'Jarvis';
  const lines = text.split('\n');
  const first = `\t- [${label}] ${lines[0] ?? ''}`;
  if (lines.length === 1) return first;
  const rest = lines.slice(1).map((l) => `\t  ${l}`).join('\n');
  return `${first}\n${rest}`;
}

export async function handleFreshFull(bot: TelegramBot, chatId: number): Promise<void> {
  const session = getSession(chatId);
  if (!session) {
    await bot.sendMessage(chatId, 'No active conversation to log.');
    return;
  }

  const messages = getSessionMessages(chatId);
  if (messages.length === 0) {
    await bot.sendMessage(chatId, 'No messages captured in this session — use /fresh for a summary instead.');
    deleteSession(chatId);
    return;
  }

  const typing = startTyping(bot, chatId);
  try {
    const transcript = messages.map((m) => formatMessage(m.role, m.text)).join('\n');
    const ts = getTimestamp();
    const entry = `- ${ts} [[jarvis]] telegram chat (full transcript)\n${transcript}`;
    appendToJournal(entry);
    log.info('Full transcript logged', { chatId, messageCount: messages.length });

    await gitCommitAndPush('TG conversation logged (full)');
    deleteSession(chatId);
    await bot.sendMessage(chatId, `Full conversation logged (${messages.length} messages). Session reset.`);
  } catch (err) {
    log.error('fresh-full exception', { error: (err as Error).message });
    deleteSession(chatId);
    await bot.sendMessage(chatId, 'Internal error logging conversation — check server logs. Session reset.');
  } finally {
    stopTyping(typing);
  }
}
