import TelegramBot from 'node-telegram-bot-api';
import { queryKB, getKBStats } from '../../kb/engine.js';
import { sendLongMessage, startTyping, stopTyping } from '../../integrations/telegram/client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-kb');

export async function handleKB(bot: TelegramBot, chatId: number, args: string): Promise<void> {
  const [subcommand, ...rest] = args.split(' ');
  const body = rest.join(' ').trim();

  switch (subcommand) {
    case 'query':
    case 'q':
      if (!body) {
        await bot.sendMessage(chatId, 'Usage: /kb query <question>');
        return;
      }
      return handleKBQuery(bot, chatId, body);

    case 'stats':
      return handleKBStats(bot, chatId);

    case 'recent':
      return handleKBRecent(bot, chatId);

    default:
      // If no subcommand, treat the entire args as a query
      if (args.trim()) {
        return handleKBQuery(bot, chatId, args.trim());
      }
      await bot.sendMessage(
        chatId,
        'KB Commands:\n/kb query <question>\n/kb stats\n/kb recent',
      );
  }
}

async function handleKBQuery(bot: TelegramBot, chatId: number, question: string): Promise<void> {
  const typing = startTyping(bot, chatId);
  try {
    const result = await queryKB(question);
    stopTyping(typing);
    await sendLongMessage(bot, chatId, result.answer);
  } catch (err) {
    stopTyping(typing);
    log.error('KB query error', { error: (err as Error).message });
    await bot.sendMessage(chatId, `KB query error: ${(err as Error).message}`);
  }
}

async function handleKBStats(bot: TelegramBot, chatId: number): Promise<void> {
  const stats = getKBStats();
  const lines = [
    'Knowledge Base Stats',
    '',
    `Total pages: ${stats.totalPages}`,
    `  Entities: ${stats.entities}`,
    `  Concepts: ${stats.concepts}`,
    `  Topics: ${stats.topics}`,
    `  Comparisons: ${stats.comparisons}`,
  ];
  await bot.sendMessage(chatId, lines.join('\n'));
}

async function handleKBRecent(bot: TelegramBot, chatId: number): Promise<void> {
  const stats = getKBStats();
  if (stats.recentLog.length === 0) {
    await bot.sendMessage(chatId, 'No recent KB activity.');
    return;
  }
  await sendLongMessage(bot, chatId, `Recent KB Activity:\n\n${stats.recentLog.join('\n')}`);
}
