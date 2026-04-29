import TelegramBot from 'node-telegram-bot-api';
import { readFileSync, unlinkSync } from 'node:fs';
import { appendToJournal } from '../../vault/journal.js';
import { createLogger } from '../../utils/logger.js';
import config from '../../config.js';

const log = createLogger('cmd-done-workout');

const STALE_HOURS = 48;
const CONFIRM_WINDOW_MS = 10 * 60 * 1000;

interface LastWorkout {
  generated_at: string;
  location: string | null;
  focus: string | null;
  markdown: string;
  structured: object;
}

type ReadResult =
  | { status: 'ok'; entry: LastWorkout }
  | { status: 'missing' }
  | { status: 'corrupt' };

let lastStaleWarnAt: number | null = null;

function isLastWorkoutShape(value: unknown): value is LastWorkout {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['generated_at'] !== 'string') return false;
  if (!Number.isFinite(new Date(v['generated_at']).getTime())) return false;
  if (typeof v['markdown'] !== 'string') return false;
  if (v['location'] !== null && typeof v['location'] !== 'string') return false;
  if (v['focus'] !== null && typeof v['focus'] !== 'string') return false;
  return true;
}

function readLastWorkout(): ReadResult {
  let raw: string;
  try {
    raw = readFileSync(config.LAST_WORKOUT_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    log.error('Failed to read last-workout.json', { error: String(err) });
    return { status: 'corrupt' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.error('Corrupt last-workout.json', { error: String(err) });
    return { status: 'corrupt' };
  }
  if (!isLastWorkoutShape(parsed)) {
    log.error('last-workout.json failed shape validation', { value: parsed });
    return { status: 'corrupt' };
  }
  return { status: 'ok', entry: parsed };
}

function ageHours(generatedAt: string): number {
  const ms = Date.now() - new Date(generatedAt).getTime();
  return ms / 3_600_000;
}

function formatBlock(entry: LastWorkout): string {
  const tag = [entry.location, entry.focus].filter(Boolean).join(' / ') || 'session';
  const ts = new Date(entry.generated_at).toLocaleString('en-US', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: config.TIMEZONE,
  });
  return `#workout\n\n**Generated workout** (${tag}) — ${ts}\n\n${entry.markdown}`;
}

export async function handleDoneWorkout(bot: TelegramBot, chatId: number): Promise<void> {
  const result = readLastWorkout();
  if (result.status === 'missing') {
    await bot.sendMessage(chatId, "Nothing to log — run /workout first.");
    return;
  }
  if (result.status === 'corrupt') {
    await bot.sendMessage(chatId, 'Could not parse the last workout file.');
    return;
  }
  const entry = result.entry;

  const age = ageHours(entry.generated_at);
  if (age > STALE_HOURS) {
    const now = Date.now();
    if (lastStaleWarnAt !== null && now - lastStaleWarnAt <= CONFIRM_WINDOW_MS) {
      lastStaleWarnAt = null;
    } else {
      lastStaleWarnAt = now;
      await bot.sendMessage(
        chatId,
        `This workout was generated ${Math.round(age)} hours ago. Run /done-workout again within 10 minutes to confirm.`,
      );
      return;
    }
  } else {
    lastStaleWarnAt = null;
  }

  try {
    appendToJournal(formatBlock(entry));
  } catch (err) {
    log.error('Journal append failed', { error: String(err) });
    await bot.sendMessage(chatId, 'Could not append to today\'s journal. The workout file is preserved — try again.');
    return;
  }

  try {
    unlinkSync(config.LAST_WORKOUT_FILE);
  } catch (err) {
    // Append succeeded; if the unlink fails the worst case is a duplicate log on
    // a second /done-workout. Log but don't surface to the user.
    log.warn('Could not delete last-workout.json after successful append', { error: String(err) });
  }
  await bot.sendMessage(chatId, 'Logged. Nightly /daily will parse into workouts.json.');
}

/** Test-only — reset the in-memory stale-warning timestamp between tests. */
export function _resetDoneWorkoutState(): void {
  lastStaleWarnAt = null;
}
