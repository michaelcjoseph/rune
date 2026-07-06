/**
 * Production deps binding for the log_workout_done tool — Wave 0 typed stub.
 *
 * The registry calls buildDeps() BEFORE the handler runs, so this must return
 * an object rather than throw; the Wave 0 stub handler never touches deps.
 * Wave 1 replaces this with the real binding (src/health/last-workout.ts
 * readers, appendToJournal, vault git commit).
 */

import type { LogWorkoutDoneDeps } from './log-workout-done.js';

export function buildProductionLogWorkoutDoneDeps(): LogWorkoutDoneDeps {
  // Wave 1 replaces this typed stub with the real production bindings.
  return {} as unknown as LogWorkoutDoneDeps;
}
