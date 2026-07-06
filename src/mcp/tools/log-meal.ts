/**
 * log_meal MCP tool — appends a meal note to the nutrition log
 * (health/nutrition.md under the day's heading, matching the
 * daily-content-updater format).
 *
 * Wave 0 skeleton: the exported signature and the {@link LogMealDeps}
 * contract are FINAL; Wave 1 replaces the stub body with the real
 * implementation + tests. Pure handler: config-free, deps-injected.
 */

import { err, type McpTextResult } from './types.js';

export interface LogMealDeps {
  /** Append one meal line under the given date's heading; 'duplicate' when
   *  the identical line is already present for that date. */
  appendMealNote(date: string, line: string): Promise<'appended' | 'duplicate'>;
  /** Today's date, YYYY-MM-DD, America/Chicago. */
  getTodayDate(): string;
  /** Current wall-clock time string, e.g. "12:30pm", America/Chicago. */
  nowTimeString(): string;
  /** Vault git commit+push — throws on failure. */
  commitAndPush(message: string): Promise<void>;
  sanitizeError?(msg: string): string;
}

export interface LogMealInput {
  description: string;
  meal?: string;
  time?: string;
  date?: string;
}

export async function logMeal(
  input: LogMealInput,
  deps: LogMealDeps,
): Promise<McpTextResult> {
  void input;
  void deps;
  return err('log_meal is not implemented yet');
}
