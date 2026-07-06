/**
 * Production deps binding for the update_workout_plan tool — Wave 0 typed
 * stub.
 *
 * The registry calls buildDeps() BEFORE the handler runs, so this must return
 * an object rather than throw; the Wave 0 stub handler never touches deps.
 * Wave 1 replaces this with the real binding (health/plan.md read/write via
 * src/vault/files.ts, vault git commit).
 */

import type { UpdateWorkoutPlanDeps } from './update-workout-plan.js';

export function buildProductionUpdateWorkoutPlanDeps(): UpdateWorkoutPlanDeps {
  // Wave 1 replaces this typed stub with the real production bindings.
  return {} as unknown as UpdateWorkoutPlanDeps;
}
