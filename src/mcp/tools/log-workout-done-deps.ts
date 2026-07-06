/**
 * Production dependency binding for the `log_workout_done` MCP tool handler.
 *
 * Kept separate from ./log-workout-done.ts (the pure handler) because this
 * module pulls src/config.ts (env-var-required at import) through its
 * vault/health imports; src/mcp/server.ts imports THIS module lazily
 * (dynamic import inside the tool handler) so building the MCP server never
 * forces a config load.
 *
 * NOTE on vault git concurrency: commitAndPush shares the vault working tree
 * with every other vault committer (nightly, /fresh, morning prep, log_idea).
 * `git add -A` commits whatever is dirty at that moment — the long-standing
 * vault-wide serialization gap, not introduced here. The journal append
 * itself is serialized below.
 */

import { appendToJournal } from '../../vault/journal.js';
import { withFileLock } from '../../intent/backlog-write-lock.js';
import { gitCommitAndPushOrThrow } from '../../vault/git.js';
import {
  clearLastWorkout,
  formatBlock,
  readLastWorkout,
} from '../../health/last-workout.js';
import { sanitizeMcpError } from './sanitize.js';
import type { LogWorkoutDoneDeps } from './log-workout-done.js';

/** Single lock key serializing all journal appends from the remote MCP
 *  surface — MUST match log-conversation-deps.ts's key so the concurrently
 *  callable MCP endpoints never interleave the logical read-modify-write on
 *  today's journal file. */
const JOURNAL_LOCK_KEY = 'vault-journal-append';

/** Build the live deps bag: the shared last-workout reader/formatter/clearer,
 *  the lock-serialized journal append, and the strict (throwing) vault commit
 *  helper. */
export function buildProductionLogWorkoutDoneDeps(): LogWorkoutDoneDeps {
  return {
    readLastWorkout,
    formatBlock,
    appendToJournal: (text) => withFileLock(JOURNAL_LOCK_KEY, () => appendToJournal(text)),
    clearLastWorkout,
    nowMs: () => Date.now(),
    commitAndPush: async (message) => {
      await gitCommitAndPushOrThrow(message);
    },
    sanitizeError: sanitizeMcpError,
  };
}
