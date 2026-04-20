import TelegramBot from 'node-telegram-bot-api';
import { readVaultFile } from '../../vault/files.js';
import { getRecentFilenames } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-family');

const NAMES = ['Sam', 'Jude'];
const SCAN_DAYS = 14;

function countMentions(content: string, name: string): number {
  const regex = new RegExp(`\\b${name}\\b`, 'gi');
  return (content.match(regex) || []).length;
}

export async function handleFamily(bot: TelegramBot, chatId: number): Promise<void> {
  try {
    const filenames = getRecentFilenames(SCAN_DAYS);
    const counts: Record<string, { total: number; days: number }> = {};

    for (const name of NAMES) {
      counts[name] = { total: 0, days: 0 };
    }

    for (const filename of filenames) {
      const content = readVaultFile(`journals/${filename}`);
      if (!content?.trim()) continue;

      for (const name of NAMES) {
        const n = countMentions(content, name);
        if (n > 0) {
          counts[name]!.total += n;
          counts[name]!.days += 1;
        }
      }
    }

    const allZero = NAMES.every((name) => counts[name]!.total === 0);
    if (allZero) {
      await bot.sendMessage(chatId, `No mentions of ${NAMES.join(' or ')} in the last ${SCAN_DAYS} days.`);
      return;
    }

    const lines = [`Family mentions (last ${SCAN_DAYS} days):`, ''];
    for (const name of NAMES) {
      const { total, days } = counts[name]!;
      lines.push(`${name}: ${total} mention${total !== 1 ? 's' : ''} across ${days} day${days !== 1 ? 's' : ''}`);
    }

    const [a, b] = NAMES as [string, string];
    if (counts[a]!.total > 0 && counts[b]!.total > 0) {
      const ratio = Math.max(counts[a]!.total, counts[b]!.total) / Math.min(counts[a]!.total, counts[b]!.total);
      if (ratio >= 2) {
        const more = counts[a]!.total > counts[b]!.total ? a : b;
        const less = more === a ? b : a;
        lines.push('', `Imbalance: ${more} mentioned ${ratio.toFixed(1)}x more than ${less}`);
      }
    }

    await bot.sendMessage(chatId, lines.join('\n'));
  } catch (err) {
    log.error('Family error', { error: (err as Error).message });
    await bot.sendMessage(chatId, `Error: ${(err as Error).message}`);
  }
}
