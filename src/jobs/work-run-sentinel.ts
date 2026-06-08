/**
 * Project 13 Phase 1b — the blocked-on-human sentinel contract.
 *
 * A `/work --auto` run that hits a step it cannot take headless (an interactive
 * check, a credential prompt, a human decision) ends its FINAL result line with
 * exactly:
 *
 *   JARVIS_WORK_RUN_SENTINEL { "version": 1, "pendingCheck": "…", "command"?: "…", "reason"?: "…" }
 *
 * `work-runner` parses this from the RAW `assistant`/`result` envelope text
 * (before display scrubbing) and, on a valid sentinel, PARKS the run: it writes
 * a durable supervision `blocked-on-human` record, skips the Project 15
 * finalizer, and leaves the worktree live for a human. A malformed, absent, or
 * unsupported-version sentinel falls through to the ordinary terminal path — no
 * park, no regression.
 *
 * This module is PURE (no I/O): it only extracts + validates the sentinel from a
 * block of agent text. The work-runner integration (stream scan → park branch)
 * and the SKILL.md contract live elsewhere.
 */

/** The exact marker that opens a sentinel line. */
export const WORK_RUN_SENTINEL_MARKER = 'JARVIS_WORK_RUN_SENTINEL';

/** The only schema version accepted in Phase 1. */
export const WORK_RUN_SENTINEL_VERSION = 1;

export interface WorkRunSentinel {
  version: 1;
  /** Non-empty human-facing description of the pending check. */
  pendingCheck: string;
  /** Optional shell command the operator should run. */
  command?: string;
  /** Optional short reason the agent could not proceed. */
  reason?: string;
}

/**
 * Parse a blocked-on-human sentinel from a block of agent text (a `result`
 * envelope's `result` string, or an assistant message's concatenated text).
 *
 * Contract:
 *  - The sentinel is `JARVIS_WORK_RUN_SENTINEL ` followed by a JSON object, on a
 *    single (final) line. The LAST sentinel line in the text wins.
 *  - `version` MUST be `1`, `pendingCheck` MUST be a non-empty string,
 *    `command`/`reason` are optional strings (wrong types reject the sentinel).
 *  - Returns `null` for: no marker, malformed JSON, non-object JSON, an
 *    unsupported `version`, a missing/empty/non-string `pendingCheck`, or a
 *    non-string `command`/`reason`.
 *
 * STUB (Phase 1b "Tests write first"): returns null until the implementation
 * task lands — valid-sentinel tests are RED, malformed→null tests pass as guards.
 */
export function parseWorkRunSentinel(_text: string): WorkRunSentinel | null {
  return null;
}
