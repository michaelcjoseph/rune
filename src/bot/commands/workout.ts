import TelegramBot from 'node-telegram-bot-api';
import { writeFileSync, renameSync } from 'node:fs';
import { readVaultFile } from '../../vault/files.js';
import { readEquipment } from '../../vault/equipment.js';
import { readRecentWhoopDays } from '../../vault/whoop-recent.js';
import { runAgent } from '../../ai/claude.js';
import { ensureWhoopSyncedForToday } from '../../jobs/whoop-sync.js';
import { sendLongMessage, startTyping, stopTyping } from '../../integrations/telegram/client.js';
import { toChicagoDate } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';
import config from '../../config.js';

const log = createLogger('cmd-workout');

const LOCATIONS = ['home', 'gym'] as const;
const FOCUSES = ['mobility', 'endurance', 'strength', 'speed', 'power'] as const;
type Location = (typeof LOCATIONS)[number];
type Focus = (typeof FOCUSES)[number];

interface ParsedArgs {
  location: Location | null;
  focus: Focus | null;
  extra: string;
}

interface LastWorkout {
  generated_at: string;
  location: Location | null;
  focus: Focus | null;
  markdown: string;
  structured: object;
}

/** Parse `/workout` args. Tokens matching the location or focus vocabulary
 *  are extracted (last-write-wins); remaining tokens become the
 *  natural-language tail. Returns `null` when args are non-empty but consist
 *  entirely of 1–2 unrecognized tokens — that's a typo case (e.g. `/workout
 *  cardio`) we want to bounce back to the user with a usage line. */
export function parseWorkoutArgs(rawArgs: string): ParsedArgs | null {
  const trimmed = rawArgs.trim();
  if (!trimmed) return { location: null, focus: null, extra: '' };

  const tokens = trimmed.split(/\s+/);
  let location: Location | null = null;
  let focus: Focus | null = null;
  const remaining: string[] = [];

  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if ((LOCATIONS as readonly string[]).includes(lower)) {
      location = lower as Location;
    } else if ((FOCUSES as readonly string[]).includes(lower)) {
      focus = lower as Focus;
    } else {
      remaining.push(tok);
    }
  }

  if (location === null && focus === null && tokens.length <= 2) {
    return null;
  }

  return { location, focus, extra: remaining.join(' ') };
}

function usageMessage(): string {
  return [
    "I didn't recognize those args.",
    `Locations: ${LOCATIONS.join(', ')}`,
    `Focuses: ${FOCUSES.join(', ')}`,
    'Examples: `/workout`, `/workout gym strength`, `/workout home 30min quick`',
  ].join('\n');
}

function readWorkoutsTail(days: number): string {
  const content = readVaultFile('health/workouts.json');
  if (content === null) return '[]';
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return '[]';
  }
  if (!Array.isArray(parsed)) return '[]';
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = toChicagoDate(cutoff);
  const filtered = parsed.filter(
    (w): w is { date?: string } =>
      typeof w === 'object' && w !== null && typeof (w as { date?: unknown }).date === 'string',
  );
  const recent = filtered.filter((w) => (w.date ?? '') >= cutoffStr);
  recent.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return JSON.stringify(recent, null, 2);
}

/** Build the labeled prompt bundle the workout-generator agent expects. */
export function buildWorkoutPrompt(args: ParsedArgs): string {
  const argsLine = [
    args.location ?? '',
    args.focus ?? '',
    args.extra,
  ].filter((s) => s.length > 0).join(' ').trim();

  const goals = readVaultFile('health/goals.md') ?? '';
  const equipment = readEquipment();
  const exercises = readVaultFile('health/exercises.md') ?? '';
  const workoutsTail = readWorkoutsTail(14);
  const whoopDays = readRecentWhoopDays(7);
  const whoopTrends = readVaultFile('health/whoop/trends.md') ?? '';
  const plan = readVaultFile('health/plan.md') ?? '';

  const equipmentBlock = equipment.home || equipment.gym
    ? `## Home\n\n${equipment.home || '[empty]'}\n\n## Gym\n\n${equipment.gym || '[empty]'}`
    : '[health/equipment.md missing — bodyweight-only fallback applies]';

  const whoopBlock = whoopDays.length > 0
    ? JSON.stringify(whoopDays, null, 2)
    : '[]  // no recent Whoop data — recovery-unavailable note applies';

  return [
    `Args: ${argsLine || '(none — infer location and focus)'}`,
    '',
    '## goals (health/goals.md)',
    '',
    goals || '[empty]',
    '',
    '## equipment (health/equipment.md)',
    '',
    equipmentBlock,
    '',
    '## exercises (health/exercises.md)',
    '',
    exercises || '[empty]',
    '',
    '## recent_workouts (last 14 days, newest first)',
    '',
    workoutsTail,
    '',
    '## recent_whoop (last 7 days)',
    '',
    whoopBlock,
    '',
    '## whoop_trends (health/whoop/trends.md)',
    '',
    whoopTrends || '[empty]',
    '',
    '## plan (health/plan.md, optional weekly-template hint)',
    '',
    plan || '[empty]',
    '',
    'Generate today\'s workout per the rules in your system prompt.',
  ].join('\n');
}

/** Best-effort parse of the trailing fenced ```json block in the agent
 *  output. Returns `{}` when no block is present or it doesn't parse. */
export function extractStructured(markdown: string): object {
  const match = markdown.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match || !match[1]) return {};
  try {
    const parsed = JSON.parse(match[1]);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Run the workout-generator agent end-to-end. Returns the markdown on
 *  success and `null` on agent failure (so the caller can decide how to
 *  surface the error). On success, persists `logs/last-workout.json`.
 *  Pre-syncs today's Whoop recovery data first (best-effort, never blocks). */
export async function generateWorkout(args: ParsedArgs): Promise<{ markdown: string } | { error: string }> {
  await ensureWhoopSyncedForToday();
  const prompt = buildWorkoutPrompt(args);
  const result = await runAgent('workout-generator', prompt);
  if (!result.text) {
    return { error: result.error ?? 'Workout generator returned no output.' };
  }
  const entry: LastWorkout = {
    generated_at: new Date().toISOString(),
    location: args.location,
    focus: args.focus,
    markdown: result.text,
    structured: extractStructured(result.text),
  };
  // Atomic write: write to tmp then rename, so a SIGKILL mid-write can't
  // leave a half-written file that /done-workout would refuse to parse.
  // If logs/ is missing or the write fails, surface the error to the caller
  // rather than letting the throw bubble past handleWorkout's catch block.
  try {
    const tmp = config.LAST_WORKOUT_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(entry, null, 2));
    renameSync(tmp, config.LAST_WORKOUT_FILE);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to persist last-workout.json', { error: message });
    return { error: `Generated workout but failed to persist it: ${message}` };
  }
  return { markdown: result.text };
}

export async function handleWorkout(bot: TelegramBot, chatId: number, args = ''): Promise<void> {
  const parsed = parseWorkoutArgs(args);
  if (parsed === null) {
    await bot.sendMessage(chatId, usageMessage());
    return;
  }

  const typing = startTyping(bot, chatId);
  try {
    const result = await generateWorkout(parsed);
    if ('error' in result) {
      log.error('Workout generation failed', { error: result.error });
      await bot.sendMessage(chatId, 'Workout generation failed. Check server logs for details.');
      return;
    }
    await sendLongMessage(bot, chatId, result.markdown);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Workout error', { error: message });
    await bot.sendMessage(chatId, 'Workout generation failed. Check server logs for details.');
  } finally {
    stopTyping(typing);
  }
}
