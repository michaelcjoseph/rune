import TelegramBot from 'node-telegram-bot-api';
import { readVaultFile } from '../../vault/files.js';
import { sendLongMessage } from '../../integrations/telegram/client.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-study');

function formatProgress(raw: string): string {
  try {
    const data = JSON.parse(raw);
    const parts: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      parts.push(`${key}: ${value}`);
    }
    return parts.join(' | ');
  } catch {
    return raw.trim();
  }
}

export async function handleStudy(bot: TelegramBot, chatId: number): Promise<void> {
  try {
    const syllabus = readVaultFile('study/syllabus.md');
    const progress = readVaultFile('study/progress.json');

    if (!syllabus?.trim() && !progress?.trim()) {
      await bot.sendMessage(chatId, 'No study data found (study/syllabus.md and study/progress.json missing).');
      return;
    }

    const sections: string[] = [];

    if (progress?.trim()) {
      sections.push(`Progress: ${formatProgress(progress)}`);
    }

    if (syllabus?.trim()) {
      sections.push(syllabus.trim());
    }

    await sendLongMessage(bot, chatId, sections.join('\n\n'));
  } catch (err) {
    log.error('Study error', { error: (err as Error).message });
    await bot.sendMessage(chatId, `Error: ${(err as Error).message}`);
  }
}
