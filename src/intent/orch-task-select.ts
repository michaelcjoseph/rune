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

/** A selected `tasks.md` task. */
export interface SelectedTask {
  /** Text-stable id (slug of `text`). */
  id: string;
  /** The task text (the `- [ ]` line body). */
  text: string;
  /** The nearest `## ` section heading above the task. */
  section: string;
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
const SECTION_RE = /^##\s+(\S(?:.*\S)?)\s*$/;

/**
 * Select the first unchecked task in document order. Tracks the running `## `
 * section so the selected task carries its section label. Returns `all-complete`
 * when no `- [ ]` line remains.
 */
export function selectNextTask(tasksMd: string): TaskSelectionResult {
  let section = '';
  for (const line of tasksMd.split('\n')) {
    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      continue;
    }
    const taskMatch = UNCHECKED_RE.exec(line);
    if (taskMatch) {
      const text = taskMatch[1]!;
      return { kind: 'task', task: { id: computeTaskId(text), text, section } };
    }
  }
  return { kind: 'all-complete' };
}
