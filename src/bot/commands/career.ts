import TelegramBot from 'node-telegram-bot-api';
import { readVaultFile } from '../../vault/files.js';
import { getTodayDate } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-career');

const INACTIVE_STATUSES = ['rejected', 'withdrawn', 'accepted'];
const STALE_DAYS = 14;

interface Application {
  company: string;
  role: string;
  status: string;
  dateApplied: string;
  lastUpdated: string;
}

function daysBetween(dateStr: string, todayStr: string): number {
  const d = new Date(dateStr + 'T00:00:00');
  const t = new Date(todayStr + 'T00:00:00');
  return Math.round((t.getTime() - d.getTime()) / 86_400_000);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export async function handleCareer(bot: TelegramBot, chatId: number): Promise<void> {
  try {
    const raw = readVaultFile('career/applications.json');

    if (!raw?.trim()) {
      await bot.sendMessage(chatId, 'No applications file found (career/applications.json).');
      return;
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      await bot.sendMessage(chatId, 'Invalid format: career/applications.json should be a JSON array.');
      return;
    }
    const apps: Application[] = parsed;
    const active = apps.filter((a) => !INACTIVE_STATUSES.includes(a.status.toLowerCase()));

    if (active.length === 0) {
      await bot.sendMessage(chatId, 'No active applications.');
      return;
    }

    const today = getTodayDate();
    const withAge = active.map((a) => ({
      ...a,
      daysStale: daysBetween(a.lastUpdated, today),
    }));
    withAge.sort((a, b) => b.daysStale - a.daysStale);

    const lines: string[] = ['Active applications:', ''];
    let staleCount = 0;

    for (const app of withAge) {
      const stale = app.daysStale >= STALE_DAYS;
      if (stale) staleCount++;
      const flag = stale ? '!! ' : '';
      lines.push(`${flag}${app.company} — ${app.role}`);
      lines.push(`   ${app.status} | Applied: ${formatDate(app.dateApplied)} | Last update: ${app.daysStale}d ago`);
      lines.push('');
    }

    lines.push(`${active.length} active | ${staleCount} stale (${STALE_DAYS}+ days)`);

    await bot.sendMessage(chatId, lines.join('\n'));
  } catch (err) {
    log.error('Career error', { error: (err as Error).message });
    await bot.sendMessage(chatId, `Error: ${(err as Error).message}`);
  }
}
