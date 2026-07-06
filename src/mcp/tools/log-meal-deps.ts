/**
 * Production dependency binding for the `log_meal` MCP tool handler.
 *
 * Kept separate from ./log-meal.ts (the pure handler) because this module
 * pulls src/config.ts (env-var-required at import) through its vault/time
 * imports; src/mcp/server.ts loads it only via dynamic import inside the
 * tool handler.
 */

import config from '../../config.js';
import { readVaultFile, writeVaultFile } from '../../vault/files.js';
import { withFileLock } from '../../intent/backlog-write-lock.js';
import { gitCommitAndPushOrThrow } from '../../vault/git.js';
import { getTodayDate } from '../../utils/time.js';
import { sanitizeMcpError } from './sanitize.js';
import { insertMealLine, type LogMealDeps } from './log-meal.js';

const NUTRITION_PATH = 'health/nutrition.md';

/** Single lock key serializing this tool's read-modify-write on
 *  health/nutrition.md — the MCP endpoint is concurrently callable, and an
 *  unlocked interleaving silently drops a meal line. */
const NUTRITION_LOCK_KEY = 'vault-nutrition';

/** Current wall-clock time as "h:mm" + lowercase am/pm (e.g. "12:30pm"),
 *  America/Chicago — the daily-content-updater meal-line time format.
 *  (src/utils/time.ts's getTimestamp is 24-hour, so it can't be reused.)
 *  The \s+ strip also covers the narrow no-break space some ICU versions
 *  emit before AM/PM. */
function nowTimeString(): string {
  return new Date()
    .toLocaleTimeString('en-US', {
      timeZone: config.TIMEZONE,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** Build the live deps bag: health/nutrition.md read-modify-write under a
 *  per-file mutex (the pure insertion logic lives in ./log-meal.ts), the
 *  America/Chicago clock, and the strict (throwing) vault commit helper. */
export function buildProductionLogMealDeps(): LogMealDeps {
  return {
    appendMealNote: (date, line) =>
      withFileLock(NUTRITION_LOCK_KEY, () => {
        const current = readVaultFile(NUTRITION_PATH);
        const { content, outcome } = insertMealLine(current, date, line);
        if (outcome === 'appended') writeVaultFile(NUTRITION_PATH, content);
        return outcome;
      }),
    getTodayDate,
    nowTimeString,
    commitAndPush: async (message) => {
      await gitCommitAndPushOrThrow(message);
    },
    sanitizeError: sanitizeMcpError,
  };
}
