import { readVaultFile } from '../../vault/files.js';
import { parseTag } from '../../vault/journal.js';
import {
  getDayOfWeek,
  getRecentFilenames,
  getTodayFilename,
  getYesterdayFilename,
} from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-priorities');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type Target = { filename: string; label: string };

function resolveTarget(args: string): Target {
  const lower = args.toLowerCase();

  if (/\btoday\b/.test(lower)) {
    return { filename: getTodayFilename(), label: "Today's" };
  }
  if (/\byesterday\b/.test(lower)) {
    return { filename: getYesterdayFilename(), label: "Yesterday's" };
  }

  const prefix = lower.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/)?.[1];
  const dayName = prefix ? DAYS.find(d => d.toLowerCase().startsWith(prefix)) : undefined;
  if (dayName) {
    const todayDow = DAYS.indexOf(getDayOfWeek());
    const targetDow = DAYS.indexOf(dayName);
    const daysBack = (todayDow - targetDow + 7) % 7;
    const filename = getRecentFilenames(daysBack + 1)[daysBack];
    if (filename) {
      return { filename, label: daysBack === 0 ? "Today's" : `${dayName}'s` };
    }
  }

  return { filename: getYesterdayFilename(), label: "Yesterday's" };
}

export async function handlePriorities(sender: MessageSender, userId: number, args = ''): Promise<void> {
  try {
    const { filename, label } = resolveTarget(args);
    const content = readVaultFile(`journals/${filename}`);

    if (!content?.trim()) {
      await sender.send(userId, `No journal entry for ${label.toLowerCase().replace("'s", '')}.`);
      return;
    }

    const priorities = parseTag(content, 'priorities');
    if (!priorities?.trim()) {
      await sender.send(userId, `No #priorities tagged in ${label.toLowerCase()} journal.`);
      return;
    }

    await sender.send(userId, `${label} priorities:\n\n${priorities}`);
  } catch (err) {
    log.error('Priorities error', { error: (err as Error).message });
    await sender.send(userId, `Error: ${(err as Error).message}`);
  }
}
