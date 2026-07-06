/**
 * update_workout_plan MCP tool — replaces the weekly workout plan document
 * (health/plan.md). Full-content replace; vault git is the undo path.
 *
 * Wave 0 skeleton: the exported signature and the {@link UpdateWorkoutPlanDeps}
 * contract are FINAL; Wave 1 replaces the stub body with the real
 * implementation + tests. Pure handler: config-free, deps-injected.
 */

import { err, type McpTextResult } from './types.js';

export interface UpdateWorkoutPlanDeps {
  /** Current health/plan.md content, or null when absent. */
  readPlan(): Promise<string | null>;
  /** Replace health/plan.md with the given content. */
  writePlan(content: string): Promise<void>;
  /** Today's date, YYYY-MM-DD, America/Chicago. */
  getTodayDate(): string;
  /** Vault git commit+push — throws on failure. */
  commitAndPush(message: string): Promise<void>;
  sanitizeError?(msg: string): string;
}

export interface UpdateWorkoutPlanInput {
  content: string;
  reason: string;
}

export async function updateWorkoutPlan(
  input: UpdateWorkoutPlanInput,
  deps: UpdateWorkoutPlanDeps,
): Promise<McpTextResult> {
  void input;
  void deps;
  return err('update_workout_plan is not implemented yet');
}
