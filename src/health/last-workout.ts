/**
 * Shared reader/formatter for `logs/last-workout.json` — the artifact
 * generateWorkout persists so the "log it as done" flows (Telegram
 * /done-workout and the MCP log_workout_done tool) stay consistent.
 * Extracted from src/bot/commands/done-workout.ts (behavior-preserving).
 */

import { readFileSync, unlinkSync } from 'node:fs';
import { createLogger } from '../utils/logger.js';
import config from '../config.js';

const log = createLogger('last-workout');

export interface LastWorkout {
  generated_at: string;
  location: string | null;
  focus: string | null;
  markdown: string;
  structured: object;
}

export type LastWorkoutReadResult =
  | { status: 'ok'; entry: LastWorkout }
  | { status: 'missing' }
  | { status: 'corrupt' };

export function isLastWorkoutShape(value: unknown): value is LastWorkout {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['generated_at'] !== 'string') return false;
  if (!Number.isFinite(new Date(v['generated_at']).getTime())) return false;
  if (typeof v['markdown'] !== 'string') return false;
  if (v['location'] !== null && typeof v['location'] !== 'string') return false;
  if (v['focus'] !== null && typeof v['focus'] !== 'string') return false;
  return true;
}

export function readLastWorkout(): LastWorkoutReadResult {
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

/** Build the `#workout` journal block the nightly pipeline parses into
 *  `health/workouts.json`. */
export function formatBlock(entry: LastWorkout): string {
  const tag = [entry.location, entry.focus].filter(Boolean).join(' / ') || 'session';
  const ts = new Date(entry.generated_at).toLocaleString('en-US', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: config.TIMEZONE,
  });
  return `#workout\n\n**Generated workout** (${tag}) — ${ts}\n\n${entry.markdown}`;
}

/** Best-effort delete of the last-workout artifact after a successful log.
 *  Never throws: if the delete fails the worst case is a duplicate log on a
 *  second attempt, so a failure is logged rather than surfaced. */
export function clearLastWorkout(): void {
  try {
    unlinkSync(config.LAST_WORKOUT_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    log.warn('Could not delete last-workout.json after successful append', { error: String(err) });
  }
}
