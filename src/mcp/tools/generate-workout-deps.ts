/**
 * Production deps binding for the generate_workout tool — Wave 0 typed stub.
 *
 * The registry calls buildDeps() BEFORE the handler runs, so this must return
 * an object rather than throw; the Wave 0 stub handler never touches deps.
 * Wave 1 replaces this with the real binding (generateWorkout with
 * userVisible: false and agentTimeoutMs headroom under the 240s tool budget).
 */

import type { GenerateWorkoutDeps } from './generate-workout.js';

export function buildProductionGenerateWorkoutDeps(): GenerateWorkoutDeps {
  // Wave 1 replaces this typed stub with the real production bindings.
  return {} as unknown as GenerateWorkoutDeps;
}
