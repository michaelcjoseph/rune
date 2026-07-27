/**
 * Rune-owned task selection (project 14, Phase 3).
 *
 * The orchestrator — not the executor model — picks the task. `selectNextTask`
 * returns the FIRST unchecked `- [ ]` in `tasks.md` in document order, with a
 * TEXT-STABLE id (a slug of the task text, not the line number) so the same task
 * keeps its identity across edits that shift its line. This is the contract every
 * other substrate module keys off: closeout ticks exactly this task, run records
 * carry this id, reconstruction matches on it.
 *
 * Pure — no I/O.
 */

import type { ValidationPolicy } from './planning-roles.js';

/** A selected `tasks.md` task. */
export interface SelectedTask {
  /** Text-stable id (slug of `text`). */
  id: string;
  /** The task text (the `- [ ]` line body). */
  text: string;
  /** The nearest `## ` section heading above the task. */
  section: string;
  /** Mechanical validation contract. Runtime selection always populates this;
   * the optional type keeps older fixture literals source-compatible. */
  validationPolicy?: ValidationPolicy;
}

export type TaskSelectionResult =
  | { kind: 'task'; task: SelectedTask }
  | { kind: 'all-complete' };

/** Slugify task text into a stable id: lowercase, non-alphanumeric → `-`,
 *  collapsed and trimmed. Two `tasks.md` revisions that move a task to a
 *  different line produce the same id. */
export function computeTaskId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Body capture is `\S(?:.*\S)?` (not `(.*\S)`) so a whitespace-padded line can't
// trigger quadratic backtracking on this regex applied per `tasks.md` line.
const UNCHECKED_RE = /^\s*-\s*\[\s\]\s+(\S(?:.*\S)?)\s*$/;
const CHECKLIST_RE = /^\s*-\s*\[[ xX]\]\s+/;
const SECTION_RE = /^##\s+(\S(?:.*\S)?)\s*$/;
const VALIDATION_POLICY_RE =
  /^\s+-\s+Validation policy:\s+`(required|reviewed-no-validation)`\s*$/;

/**
 * Select the first unchecked task in document order. Tracks the running `## `
 * section so the selected task carries its section label. Returns `all-complete`
 * when no `- [ ]` line remains.
 */
export function selectNextTask(tasksMd: string): TaskSelectionResult {
  let section = '';
  let selected: SelectedTask | undefined;
  for (const line of tasksMd.split('\n')) {
    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      if (selected) return { kind: 'task', task: selected };
      section = sectionMatch[1]!;
      continue;
    }
    if (selected) {
      if (CHECKLIST_RE.test(line)) return { kind: 'task', task: selected };
      const policyMatch = VALIDATION_POLICY_RE.exec(line);
      if (policyMatch) selected.validationPolicy = policyMatch[1] as ValidationPolicy;
      continue;
    }
    const taskMatch = UNCHECKED_RE.exec(line);
    if (taskMatch) {
      const text = taskMatch[1]!;
      selected = {
        id: computeTaskId(text),
        text,
        section,
        validationPolicy: 'required',
      };
    }
  }
  if (selected) return { kind: 'task', task: selected };
  return { kind: 'all-complete' };
}
