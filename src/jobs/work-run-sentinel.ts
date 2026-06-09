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

/** Per-field cap on the LLM-authored strings. The sentinel comes from untrusted
 *  agent output and is delivered to Telegram; a misbehaving model could emit a
 *  multi-kilobyte field. Truncate (never reject) so a long-but-valid park still
 *  parks, with a bounded message — mirrors `SUBJECT_MAX_CHARS` in
 *  work-run-commit-poll.ts. */
export const SENTINEL_FIELD_MAX_CHARS = 500;

/** Truncate an LLM-authored string to the field cap, appending an ellipsis when
 *  cut so the operator can tell the text was clipped. */
function capField(s: string): string {
  return s.length > SENTINEL_FIELD_MAX_CHARS ? `${s.slice(0, SENTINEL_FIELD_MAX_CHARS)}…` : s;
}

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
 * PURE — no I/O. The caller (work-runner) extracts the raw `result`/`assistant`
 * envelope text and hands it here; this only finds + validates the sentinel.
 */
export function parseWorkRunSentinel(text: string): WorkRunSentinel | null {
  if (!text) return null;

  // The sentinel is a single line opening with the marker. The LAST such line
  // wins (a run may print a stale draft before the final stop). Match only when
  // the marker opens the (trimmed) line, so a bare mention in prose
  // ("the JARVIS_WORK_RUN_SENTINEL is…") never trips a false park.
  let candidate: string | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(WORK_RUN_SENTINEL_MARKER)) candidate = trimmed;
  }
  if (candidate === null) return null;

  const jsonPart = candidate.slice(WORK_RUN_SENTINEL_MARKER.length).trim();
  if (!jsonPart) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPart);
  } catch {
    return null; // malformed JSON after the marker
  }
  // Reject arrays and primitives — the sentinel payload must be an object.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  // `version` is a strict equality check (not a truthiness/coerce) so "1"
  // (string) and 2 (unsupported) both reject.
  if (obj['version'] !== WORK_RUN_SENTINEL_VERSION) return null;

  const pendingCheck = obj['pendingCheck'];
  if (typeof pendingCheck !== 'string' || pendingCheck.trim() === '') return null;

  // Optional fields: present-but-wrong-type rejects the whole sentinel rather
  // than silently dropping the bad field (fail-closed on a malformed payload).
  const command = obj['command'];
  if (command !== undefined && typeof command !== 'string') return null;
  const reason = obj['reason'];
  if (reason !== undefined && typeof reason !== 'string') return null;

  const sentinel: WorkRunSentinel = { version: 1, pendingCheck: capField(pendingCheck) };
  if (typeof command === 'string') sentinel.command = capField(command);
  if (typeof reason === 'string') sentinel.reason = capField(reason);
  return sentinel;
}
