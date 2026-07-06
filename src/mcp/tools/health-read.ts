/**
 * Health read tools — whoop_snapshot / health_trends / workout_history /
 * nutrition_log / health_doc (MCP health expansion).
 *
 * Wave 0 skeleton: the exported signatures and the {@link HealthReadDeps}
 * contract are FINAL; Wave 1 replaces the stub bodies with the real
 * implementations + tests. Pure handlers: config-free, deps-injected, never
 * throw (always return an McpTextResult).
 */

import type { WorkoutRecord } from '../../vault/workouts.js';
import { err, type McpTextResult } from './types.js';

export interface HealthReadDeps {
  /** Best-effort Whoop sync for today (must not throw into the handler). */
  ensureSynced(): Promise<void>;
  /** Parsed health/whoop/{date}.json, or null when the day file is absent. */
  readWhoopDay(date: string): Promise<unknown | null>;
  /** Parsed whoop day files for the inclusive date range (missing days skipped). */
  readWhoopRange(start: string, end: string): Promise<unknown[]>;
  /** Entries from health/workouts.json within the last `days`, newest first. */
  readRecentWorkouts(days: number): Promise<WorkoutRecord[]>;
  /** Raw vault doc content, or null when the file is absent. */
  readVaultDoc(relPath: string): Promise<string | null>;
  /** Today's date, YYYY-MM-DD, America/Chicago. */
  getTodayDate(): string;
  sanitizeError?(msg: string): string;
}

export interface HealthTrendsInput {
  startDate?: string;
  endDate?: string;
}

export interface WorkoutHistoryInput {
  days?: number;
}

export interface NutritionLogInput {
  days?: number;
}

export type HealthDocName = 'plan' | 'goals' | 'equipment' | 'exercises';

export interface HealthDocInput {
  doc: HealthDocName;
}

export async function whoopSnapshot(deps: HealthReadDeps): Promise<McpTextResult> {
  void deps;
  return err('whoop_snapshot is not implemented yet');
}

export async function healthTrends(
  input: HealthTrendsInput,
  deps: HealthReadDeps,
): Promise<McpTextResult> {
  void input;
  void deps;
  return err('health_trends is not implemented yet');
}

export async function workoutHistory(
  input: WorkoutHistoryInput,
  deps: HealthReadDeps,
): Promise<McpTextResult> {
  void input;
  void deps;
  return err('workout_history is not implemented yet');
}

export async function nutritionLog(
  input: NutritionLogInput,
  deps: HealthReadDeps,
): Promise<McpTextResult> {
  void input;
  void deps;
  return err('nutrition_log is not implemented yet');
}

export async function healthDoc(
  input: HealthDocInput,
  deps: HealthReadDeps,
): Promise<McpTextResult> {
  void input;
  void deps;
  return err('health_doc is not implemented yet');
}
