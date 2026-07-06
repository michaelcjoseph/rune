/**
 * Production dependency binding for the `update_workout_plan` MCP tool
 * handler.
 *
 * Kept separate from ./update-workout-plan.ts (the pure handler) because
 * this module pulls src/config.ts (env-var-required at import) through its
 * vault/time imports; src/mcp/server.ts loads it only via dynamic import
 * inside the tool handler.
 */

import { readVaultFile, writeVaultFile } from '../../vault/files.js';
import { withFileLock } from '../../intent/backlog-write-lock.js';
import { gitCommitAndPushOrThrow } from '../../vault/git.js';
import { getTodayDate } from '../../utils/time.js';
import { sanitizeMcpError } from './sanitize.js';
import type { UpdateWorkoutPlanDeps } from './update-workout-plan.js';

const PLAN_PATH = 'health/plan.md';

/** Single lock key serializing this tool's writes to health/plan.md — the
 *  MCP endpoint is concurrently callable. */
const PLAN_LOCK_KEY = 'vault-plan';

/** Build the live deps bag: health/plan.md read/replace (write under a
 *  per-file mutex), the America/Chicago date, and the strict (throwing)
 *  vault commit helper. */
export function buildProductionUpdateWorkoutPlanDeps(): UpdateWorkoutPlanDeps {
  return {
    readPlan: async () => readVaultFile(PLAN_PATH),
    writePlan: (content) => withFileLock(PLAN_LOCK_KEY, () => writeVaultFile(PLAN_PATH, content)),
    getTodayDate,
    commitAndPush: async (message) => {
      await gitCommitAndPushOrThrow(message);
    },
    sanitizeError: sanitizeMcpError,
  };
}
