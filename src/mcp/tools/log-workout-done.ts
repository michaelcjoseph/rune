/**
 * log_workout_done MCP tool — logs the last generated workout as completed in
 * today's journal (mirrors Telegram /done-workout; the nightly pipeline
 * parses the #workout block into health/workouts.json).
 *
 * Wave 0 skeleton: the exported signature and the {@link LogWorkoutDoneDeps}
 * contract are FINAL; Wave 1 replaces the stub body with the real
 * implementation + tests. Pure handler: config-free, deps-injected.
 */

import type { LastWorkout } from '../../health/last-workout.js';
import { err, type McpTextResult } from './types.js';

export interface LogWorkoutDoneDeps {
  readLastWorkout():
    | { status: 'ok'; entry: LastWorkout }
    | { status: 'missing' }
    | { status: 'corrupt' };
  /** Build the #workout journal block for the entry. */
  formatBlock(entry: LastWorkout): string;
  appendToJournal(text: string): Promise<string> | string;
  clearLastWorkout(): void;
  nowMs(): number;
  /** Vault git commit+push — throws on failure. */
  commitAndPush(message: string): Promise<void>;
  sanitizeError?(msg: string): string;
}

export interface LogWorkoutDoneInput {
  notes?: string;
  confirm_stale?: boolean;
}

export async function logWorkoutDone(
  input: LogWorkoutDoneInput,
  deps: LogWorkoutDoneDeps,
): Promise<McpTextResult> {
  void input;
  void deps;
  return err('log_workout_done is not implemented yet');
}
