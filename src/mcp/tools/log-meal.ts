/**
 * log_meal MCP tool — appends a meal note to the nutrition log
 * (health/nutrition.md under the day's heading, matching the
 * daily-content-updater format).
 *
 * PURE MODULE: every effect (nutrition append, clock, git commit) is injected
 * via {@link LogMealDeps}. The production binding lives in ./log-meal-deps.ts
 * — kept separate because it pulls src/config.ts (which requires env vars at
 * import); this module must stay importable config-free so its unit suite
 * runs anywhere. `insertMealLine` (the file-content insertion logic) is
 * exported from HERE for the same reason: it is pure text manipulation and
 * the deps module binds it to the real vault file.
 */

import { errText, ok, err, type McpTextResult } from './types.js';

export interface LogMealDeps {
  /** Append one meal line under the given date's heading; 'duplicate' when
   *  the identical line is already present for that date. */
  appendMealNote(date: string, line: string): Promise<'appended' | 'duplicate'>;
  /** Today's date, YYYY-MM-DD, America/Chicago. */
  getTodayDate(): string;
  /** Current wall-clock time string, e.g. "12:30pm", America/Chicago. */
  nowTimeString(): string;
  /** Vault git commit+push — throws on failure. */
  commitAndPush(message: string): Promise<void>;
  sanitizeError?(msg: string): string;
}

export interface LogMealInput {
  description: string;
  meal?: string;
  time?: string;
  date?: string;
}

/** Trust-boundary caps on LLM-supplied free text. The server's zod schema
 *  enforces the same limits at the transport boundary; the pure handler
 *  re-caps so it is safe standalone. */
export const DESCRIPTION_MAX_CHARS = 500;
export const MEAL_MAX_CHARS = 40;
export const TIME_MAX_CHARS = 20;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Collapse embedded newlines — the meal line and the git commit subject are
 *  single-line surfaces. */
function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Log one meal. Never throws — every failure path resolves to an `isError`
 * result with a clear message (a phantom success is the one unacceptable
 * outcome).
 */
export async function logMeal(
  input: LogMealInput,
  deps: LogMealDeps,
): Promise<McpTextResult> {
  const clean = deps.sanitizeError ?? ((s: string) => s);

  try {
    // ---- normalize + validate (before any write) ----
    const descriptionRaw =
      typeof input.description === 'string' ? singleLine(input.description) : '';
    if (descriptionRaw.length < 3) {
      return err('description must be at least 3 characters — nothing was written.');
    }
    const description = descriptionRaw.slice(0, DESCRIPTION_MAX_CHARS).trimEnd();

    const mealRaw = typeof input.meal === 'string' ? singleLine(input.meal) : '';
    const meal = (mealRaw || 'Meal').slice(0, MEAL_MAX_CHARS).trimEnd();

    const timeRaw = typeof input.time === 'string' ? singleLine(input.time) : '';
    const time = (timeRaw || deps.nowTimeString()).slice(0, TIME_MAX_CHARS).trimEnd();

    const dateRaw = typeof input.date === 'string' ? input.date.trim() : '';
    const date = dateRaw || deps.getTodayDate();
    if (!DATE_RE.test(date)) {
      return err(
        `Invalid date ${JSON.stringify(date)} — must be YYYY-MM-DD. Nothing was written.`,
      );
    }

    // Line format matches the daily-content-updater agent's nutrition format:
    //   **Meal (HH:MMam/pm):** content
    const line = `**${meal} (${time}):** ${description}`;

    // ---- append (dedupe lives in the appender: exact line under the date) ----
    const outcome = await deps.appendMealNote(date, line);
    if (outcome === 'duplicate') {
      return ok(`Already logged under ${date}:\n${line}\nNothing new was written.`);
    }

    // ---- commit (failure must surface — never a phantom durable log) ----
    try {
      await deps.commitAndPush(`log_meal: ${date} ${meal}`);
    } catch (commitErr) {
      return err(
        `Meal note was written to health/nutrition.md and is saved locally, but the git commit/push failed — it is not committed yet: ${clean(errText(commitErr))}`,
      );
    }

    return ok(`Logged to health/nutrition.md under ${date}:\n${line}`);
  } catch (unexpected) {
    return err(`log_meal failed: ${clean(errText(unexpected))}`);
  }
}

// ---------------------------------------------------------------------------
// Insertion logic (pure) — exported for the deps binding and its unit tests.
// ---------------------------------------------------------------------------

export const MEAL_NOTES_HEADING = '## Meal Notes';

const MEAL_NOTES_HEADING_RE = /^## Meal Notes\s*$/;
/** A section boundary: any h1/h2 heading (h3 date headings stay inside). */
const SECTION_BOUNDARY_RE = /^##? /;
const DATE_HEADING_RE = /^### (\d{4}-\d{2}-\d{2})\s*$/;

/**
 * Insert `line` under `### {date}` inside the `## Meal Notes` section of the
 * nutrition file, matching the daily-content-updater conventions:
 *
 *   - missing file (`current === null`) → scaffold a minimal doc with the
 *     `## Meal Notes` heading (and a file without the section gets it
 *     appended, mirroring log-idea's ensureLoopFiledSection);
 *   - date headings are NEWEST-FIRST: a new date's heading is inserted at the
 *     TOP of the dated list;
 *   - an existing `### {date}` heading gets the line appended at the end of
 *     that date's entries;
 *   - the exact same line already under that date → `'duplicate'` (content
 *     returned unchanged).
 */
export function insertMealLine(
  current: string | null,
  date: string,
  line: string,
): { content: string; outcome: 'appended' | 'duplicate' } {
  const text = current ?? `# Nutrition\n\n${MEAL_NOTES_HEADING}\n`;
  const lines = text.split('\n');

  let headingIdx = lines.findIndex((l) => MEAL_NOTES_HEADING_RE.test(l));
  if (headingIdx === -1) {
    // Existing file without the section — append it rather than error.
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    lines.push('', MEAL_NOTES_HEADING);
    headingIdx = lines.length - 1;
  }

  // The Meal Notes section runs until the next h1/h2 heading (or EOF).
  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (SECTION_BOUNDARY_RE.test(lines[i]!)) {
      sectionEnd = i;
      break;
    }
  }

  const dateHeadings: Array<{ idx: number; date: string }> = [];
  for (let i = headingIdx + 1; i < sectionEnd; i++) {
    const m = DATE_HEADING_RE.exec(lines[i]!);
    if (m) dateHeadings.push({ idx: i, date: m[1]! });
  }

  const existing = dateHeadings.find((h) => h.date === date);
  if (existing) {
    const next = dateHeadings.find((h) => h.idx > existing.idx);
    const subEnd = next ? next.idx : sectionEnd;
    for (let i = existing.idx + 1; i < subEnd; i++) {
      if (lines[i]!.trim() === line) {
        return { content: text, outcome: 'duplicate' };
      }
    }
    // Append after the last non-blank entry of this date's block (keeps the
    // blank separator before the next heading intact).
    let insertAt = existing.idx + 1;
    for (let i = existing.idx + 1; i < subEnd; i++) {
      if (lines[i]!.trim() !== '') insertAt = i + 1;
    }
    lines.splice(insertAt, 0, line);
  } else if (dateHeadings.length > 0) {
    // Newest-first: the new date's block goes at the TOP of the dated list.
    lines.splice(dateHeadings[0]!.idx, 0, `### ${date}`, line, '');
  } else {
    // No dated entries yet — start the list after the section heading (and
    // any intro text), before the trailing blank run / next section.
    let anchor = headingIdx;
    for (let i = headingIdx + 1; i < sectionEnd; i++) {
      if (lines[i]!.trim() !== '') anchor = i;
    }
    lines.splice(anchor + 1, 0, '', `### ${date}`, line);
  }

  let content = lines.join('\n');
  if (!content.endsWith('\n')) content += '\n';
  return { content, outcome: 'appended' };
}
