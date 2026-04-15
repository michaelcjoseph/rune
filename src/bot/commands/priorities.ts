import TelegramBot from 'node-telegram-bot-api';
import { readVaultFile } from '../../vault/files.js';
import { parseTag } from '../../vault/journal.js';
import { getYesterdayFilename } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-priorities');

export async function handlePriorities(bot: TelegramBot, chatId: number): Promise<void> {
  try {
    const yesterdayFile = getYesterdayFilename();
    const content = readVaultFile(`journals/${yesterdayFile}`);

    if (!content?.trim()) {
      await bot.sendMessage(chatId, 'No journal entry from yesterday.');
      return;
    }

    const priorities = parseTag(content, 'priorities');
    if (!priorities?.trim()) {
      await bot.sendMessage(chatId, 'No #priorities tagged in yesterday\'s journal.');
      return;
    }

    await bot.sendMessage(chatId, `Yesterday's priorities:\n\n${priorities}`);
  } catch (err) {
    log.error('Priorities error', { error: (err as Error).message });
    await bot.sendMessage(chatId, `Error: ${(err as Error).message}`);
  }
}
