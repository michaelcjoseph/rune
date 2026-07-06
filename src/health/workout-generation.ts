/**
 * Workout-generation pipeline — prompt bundle + workout-generator agent run +
 * `logs/last-workout.json` persistence. Extracted from
 * src/bot/commands/workout.ts (behavior-preserving) so both the Telegram
 * /workout command and the MCP generate_workout tool share one entry point.
 */

import { writeFileSync, renameSync } from 'node:fs';
import { readVaultFile } from '../vault/files.js';
import { readEquipment } from '../vault/equipment.js';
import { readRecentWhoopDays } from '../vault/whoop-recent.js';
import { readRecentWorkouts } from '../vault/workouts.js';
import { runAgent } from '../ai/claude.js';
import { ensureWhoopSyncedForToday } from '../jobs/whoop-sync.js';
import { createLogger } from '../utils/logger.js';
import config from '../config.js';
import type { LastWorkout } from './last-workout.js';

const log = createLogger('workout-generation');

export const LOCATIONS = ['home', 'gym'] as const;
export const FOCUSES = ['mobility', 'endurance', 'strength', 'speed', 'power'] as const;
export type Location = (typeof LOCATIONS)[number];
export type Focus = (typeof FOCUSES)[number];

export interface ParsedArgs {
  location: Location | null;
  focus: Focus | null;
  extra: string;
}

export interface GenerateWorkoutOpts {
  /** Threads into runAgent — default true (the Telegram bot behavior). MCP
   *  callers pass false so the run does not surface as a user-visible op. */
  userVisible?: boolean;
  /** Agent timeout override in ms — default undefined (runAgent's default). */
  agentTimeoutMs?: number;
}

/** Build the labeled prompt bundle the workout-generator agent expects. */
export function buildWorkoutPrompt(args: ParsedArgs): string {
  const argsLine = [
    args.location ?? '',
    args.focus ?? '',
    args.extra,
  ].filter((s) => s.length > 0).join(' ').trim();

  const overrideFields: string[] = [];
  if (args.location) overrideFields.push('location');
  if (args.focus) overrideFields.push('focus');
  const overrideNote = overrideFields.length > 0
    ? `Args precedence: user-supplied ${overrideFields.join(' and ')} overrides any conflicting day-of-week prescription in plan.md. Use plan.md only for week-phase calibration (RPE, load targets) and weekly-target accounting.`
    : '';

  const goals = readVaultFile('health/goals.md') ?? '';
  const equipment = readEquipment();
  const exercises = readVaultFile('health/exercises.md') ?? '';
  const workoutsTail = JSON.stringify(readRecentWorkouts(14), null, 2);
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
    ...(overrideNote ? [overrideNote] : []),
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
 *  success and `{ error }` on agent failure (so the caller can decide how to
 *  surface it). On success, persists `logs/last-workout.json`.
 *  Pre-syncs today's Whoop recovery data first (best-effort, never blocks). */
export async function generateWorkout(
  args: ParsedArgs,
  opts?: GenerateWorkoutOpts,
): Promise<{ markdown: string } | { error: string }> {
  await ensureWhoopSyncedForToday();
  const prompt = buildWorkoutPrompt(args);
  const result = await runAgent(
    'workout-generator',
    prompt,
    opts?.agentTimeoutMs,
    opts?.userVisible ?? true,
  );
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
