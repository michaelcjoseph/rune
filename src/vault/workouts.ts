/**
 * Typed reader for the agent-written training log `health/workouts.json`.
 * Extracted from src/bot/commands/workout.ts so the MCP health tools and the
 * Telegram /workout prompt builder share one parser.
 */

import { readVaultFile } from './files.js';
import { toChicagoDate } from '../utils/time.js';

/** One completed-workout entry in `health/workouts.json`. The file is written
 *  by the json-updater agent, so every field is optional/loose on purpose —
 *  never assume more shape than a string `date` (the only field the recency
 *  filter relies on). */
export interface WorkoutRecord {
  id?: string;
  date?: string;
  type?: string;
  duration_minutes?: number;
  exercises?: unknown;
  notes?: string;
  journal_ref?: string;
  [key: string]: unknown;
}

/** Parse `health/workouts.json` and return the entries from the last `days`
 *  days, newest first. A missing, corrupt, or non-array file yields `[]` —
 *  a thin or absent training log is a normal state, not an error. */
export function readRecentWorkouts(days: number): WorkoutRecord[] {
  const content = readVaultFile('health/workouts.json');
  if (content === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = toChicagoDate(cutoff);
  const filtered = parsed.filter(
    (w): w is WorkoutRecord =>
      typeof w === 'object' && w !== null && typeof (w as { date?: unknown }).date === 'string',
  );
  const recent = filtered.filter((w) => (w.date ?? '') >= cutoffStr);
  recent.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return recent;
}
