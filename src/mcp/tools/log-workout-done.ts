/**
 * log_workout_done MCP tool — logs the last generated workout as completed in
 * today's journal (mirrors Telegram /done-workout; the nightly pipeline
 * parses the #workout block into health/workouts.json).
 *
 * PURE MODULE: every effect (last-workout read/clear, journal append, git
 * commit+push) is injected via {@link LogWorkoutDoneDeps}; the production
 * binding lives in ./log-workout-done-deps.ts. Never throws — every failure
 * path resolves to an `isError` result.
 *
 * Staleness: the Telegram command uses a 10-minute "run it again to confirm"
 * window; a stateless MCP tool can't, so the equivalent is the explicit
 * `confirm_stale: true` argument.
 */

import type { LastWorkout } from '../../health/last-workout.js';
import { errText, ok, err, type McpTextResult } from './types.js';

/** Same 48h threshold as the Telegram /done-workout command. */
export const STALE_AFTER_MS = 48 * 3_600_000;

/** Trust-boundary cap on completion notes (matches the z.string() max in the
 *  server registration). Truncated, not rejected — notes are annotation, not
 *  an identity-bearing field. */
export const COMPLETION_NOTES_MAX_CHARS = 1_000;

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

/** Collapse embedded newlines — the notes line and the git commit subject
 *  are single-line surfaces. */
function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

/** Short human tag for the entry — mirrors formatBlock's tag derivation. */
function entryTag(entry: LastWorkout): string {
  return [entry.location, entry.focus].filter(Boolean).join(' / ') || 'session';
}

export async function logWorkoutDone(
  input: LogWorkoutDoneInput,
  deps: LogWorkoutDoneDeps,
): Promise<McpTextResult> {
  const clean = deps.sanitizeError ?? ((s: string) => s);

  try {
    // ---- read the artifact ----
    const read = deps.readLastWorkout();
    if (read.status === 'missing') {
      return err('Nothing to log — call generate_workout first.');
    }
    if (read.status === 'corrupt') {
      return err('The last-workout file is corrupt and could not be parsed — generate a fresh workout with generate_workout.');
    }
    const entry = read.entry;

    // ---- staleness gate ----
    const ageMs = deps.nowMs() - Date.parse(entry.generated_at);
    if (ageMs > STALE_AFTER_MS && input.confirm_stale !== true) {
      const ageHours = Math.round(ageMs / 3_600_000);
      return err(
        `Last workout was generated ~${ageHours}h ago — pass confirm_stale: true to log it anyway, or generate a fresh one.`,
      );
    }

    // ---- build the journal block ----
    let block = deps.formatBlock(entry);
    const notes = typeof input.notes === 'string'
      ? singleLine(input.notes).slice(0, COMPLETION_NOTES_MAX_CHARS)
      : '';
    if (notes) {
      block += `\n\n**Completion notes:** ${notes}`;
    }

    // ---- append (failure preserves the last-workout file for a retry) ----
    try {
      await deps.appendToJournal(block);
    } catch (appendErr) {
      return err(
        `Could not append to today's journal — the last-workout file is preserved, try again: ${clean(errText(appendErr))}`,
      );
    }

    // ---- clear the artifact (best-effort; production binding never throws,
    //      but a throwing deps impl must not turn a logged workout into an
    //      error — worst case is a duplicate log on a second call) ----
    let clearWarning = '';
    try {
      deps.clearLastWorkout();
    } catch (clearErr) {
      clearWarning = `\n\nWarning: could not clear the last-workout file (${clean(errText(clearErr))}) — a second log_workout_done call may log this workout twice.`;
    }

    // ---- commit (failure must surface — never a phantom durable log) ----
    const tag = entryTag(entry);
    const dateStr = new Date(entry.generated_at).toISOString().slice(0, 10);
    try {
      await deps.commitAndPush(`log_workout_done: ${tag} (${dateStr})`);
    } catch (commitErr) {
      return err(
        `Workout was logged to the journal and is saved locally, but the git commit/push failed — it is not committed yet: ${clean(errText(commitErr))}`,
      );
    }

    return ok(
      `Logged the ${tag} workout (generated ${dateStr}) to today's journal — the nightly pipeline will parse it into workouts.json.${clearWarning}`,
    );
  } catch (unexpected) {
    return err(`log_workout_done failed: ${clean(errText(unexpected))}`);
  }
}
