import TelegramBot from 'node-telegram-bot-api';
import { readVaultFile } from '../../vault/files.js';
import { getDayOfWeek } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-workout');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseDay(args: string): string | null {
  const prefix = args.toLowerCase().match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/)?.[1];
  if (!prefix) return null;
  return DAYS.find(d => d.toLowerCase().startsWith(prefix)) ?? null;
}

function extractDaySection(content: string, day: string): string | null {
  const regex = new RegExp(`^### ${day}\\b[^\\n]*`, 'im');
  const match = regex.exec(content);
  if (!match) return null;
  const start = match.index + match[0].length;
  const nextHeading = content.indexOf('\n### ', start);
  const section = nextHeading === -1
    ? content.slice(start)
    : content.slice(start, nextHeading);
  return section.trim() || null;
}

export async function handleWorkout(bot: TelegramBot, chatId: number, args = ''): Promise<void> {
  try {
    const content = readVaultFile('health/plan.md');

    if (!content?.trim()) {
      await bot.sendMessage(chatId, 'No workout plan found (health/plan.md missing).');
      return;
    }

    const day = parseDay(args) ?? getDayOfWeek();
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
