import TelegramBot from 'node-telegram-bot-api';
import { readVaultFile } from '../../vault/files.js';
import { getDayOfWeek } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-workout');

function extractDaySection(content: string, day: string): string | null {
  const regex = new RegExp(`^## ${day}\\b`, 'im');
  const match = regex.exec(content);
  if (!match) return null;
  const start = match.index + match[0].length;
  const nextHeading = content.indexOf('\n## ', start);
  const section = nextHeading === -1
    ? content.slice(start)
    : content.slice(start, nextHeading);
  return section.trim() || null;
}

export async function handleWorkout(bot: TelegramBot, chatId: number): Promise<void> {
  try {
    const content = readVaultFile('health/plan.md');

    if (!content?.trim()) {
      await bot.sendMessage(chatId, 'No workout plan found (health/plan.md missing).');
      return;
    }

    const day = getDayOfWeek();
    const section = extractDaySection(content, day);

    if (!section) {
      await bot.sendMessage(chatId, `No workout prescription for ${day}.`);
      return;
    }

    await bot.sendMessage(chatId, `${day}'s workout:\n\n${section}`);
  } catch (err) {
    log.error('Workout error', { error: (err as Error).message });
    await bot.sendMessage(chatId, `Error: ${(err as Error).message}`);
  }
}
