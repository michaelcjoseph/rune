/**
 * update_workout_plan MCP tool — replaces the weekly workout plan document
 * (health/plan.md). Full-content replace; vault git is the undo path.
 *
 * PURE MODULE: every effect (plan read/write, git commit) is injected via
 * {@link UpdateWorkoutPlanDeps}. The production binding lives in
 * ./update-workout-plan-deps.ts — kept separate because it pulls
 * src/config.ts (which requires env vars at import); this module must stay
 * importable config-free so its unit suite runs anywhere.
 */

import { errText, ok, err, type McpTextResult } from './types.js';

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

/** Guard bounds — mirror the server's zod schema; the pure handler re-checks
 *  so it is safe standalone. */
export const CONTENT_MIN_CHARS = 50;
export const CONTENT_MAX_CHARS = 64000;
export const REASON_MIN_CHARS = 3;
export const REASON_MAX_CHARS = 200;

/** Any markdown heading — a "complete plan document" must have at least one. */
const HEADING_RE = /^#{1,6} /m;

/** The provenance footer this tool appends on every update. Trailing lines
 *  matching this are stripped from round-tripped submissions so footers
 *  never accumulate. */
const FOOTER_RE = /^> Updated \d{4}-\d{2}-\d{2} via MCP:/;

/** Collapse embedded newlines — the footer and the git commit subject are
 *  single-line surfaces. */
function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

/** Drop trailing `> Updated … via MCP: …` footer lines (and the blank
 *  separators before them) from a round-tripped document. */
function stripTrailingFooters(text: string): string {
  let body = text.trimEnd();
  for (;;) {
    const lines = body.split('\n');
    const last = lines[lines.length - 1]!;
    if (!FOOTER_RE.test(last)) break;
    lines.pop();
    body = lines.join('\n').trimEnd();
  }
  return body;
}

/**
 * Replace the weekly plan. Never throws — every failure path resolves to an
 * `isError` result with a clear message.
 */
export async function updateWorkoutPlan(
  input: UpdateWorkoutPlanInput,
  deps: UpdateWorkoutPlanDeps,
): Promise<McpTextResult> {
  const clean = deps.sanitizeError ?? ((s: string) => s);

  try {
    // ---- guards (before any read or write) ----
    const raw = typeof input.content === 'string' ? input.content : '';
    const trimmedLen = raw.trim().length;
    if (trimmedLen < CONTENT_MIN_CHARS || trimmedLen > CONTENT_MAX_CHARS) {
      return err(
        `content must be ${CONTENT_MIN_CHARS}–${CONTENT_MAX_CHARS} characters after trimming (got ${trimmedLen}) — nothing was written.`,
      );
    }
    if (!HEADING_RE.test(raw)) {
      return err('content must be a complete markdown plan document (no heading found)');
    }
    const reason = typeof input.reason === 'string' ? singleLine(input.reason) : '';
    if (reason.length < REASON_MIN_CHARS || reason.length > REASON_MAX_CHARS) {
      return err(
        `reason must be ${REASON_MIN_CHARS}–${REASON_MAX_CHARS} characters — nothing was written.`,
      );
    }

    const current = await deps.readPlan();

    // No substantive change (compared BEFORE footer handling): don't churn a
    // fresh footer + commit out of an identical round-trip.
    if (current !== null && current.trimEnd() === raw.trimEnd()) {
      return ok('No change — plan.md already matches.');
    }

    // Strip round-tripped footers, then stamp exactly one fresh footer.
    const body = stripTrailingFooters(raw);
    const finalContent = `${body}\n\n> Updated ${deps.getTodayDate()} via MCP: ${reason}\n`;

    await deps.writePlan(finalContent);

    // ---- commit (failure must surface — never a phantom durable update) ----
    try {
      await deps.commitAndPush(`update_workout_plan: ${reason}`);
    } catch (commitErr) {
      return err(
        `Plan was written to health/plan.md and is saved locally, but the git commit/push failed — it is not committed yet: ${clean(errText(commitErr))}`,
      );
    }

    const wasLines = current === null ? 0 : current.split('\n').length;
    const nowLines = finalContent.split('\n').length;
    return ok(
      `Plan updated (was ${wasLines} lines, now ${nowLines}). Previous version recoverable via vault git.`,
    );
  } catch (unexpected) {
    return err(`update_workout_plan failed: ${clean(errText(unexpected))}`);
  }
}
