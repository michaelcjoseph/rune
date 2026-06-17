/**
 * Pure task closeout — the `tasks.md` checkbox tick (project 14, Phase 3).
 *
 * Closeout marks EXACTLY the selected task complete and nothing else: it finds the
 * first unchecked `- [ ]` line whose body equals the task's TEXT and (when supplied)
 * whose `## ` section equals the task's section, flips it to `- [x]`, and leaves
 * every other line byte-for-byte. A task whose text is no longer in `tasks.md` is
 * refused as stale rather than silently ticking the wrong box.
 *
 * Matching mirrors `selectNextTask` exactly — same section tracking, same
 * first-unchecked-in-document-order rule — so the line closeout ticks is provably
 * the same line selection picked. This is what keeps verbatim-repeated boilerplate
 * (e.g. the per-phase "Confirm red before implementation.") from being ambiguous:
 * the section scope disambiguates across phases, and first-match disambiguates
 * within one. (Before this, closeout keyed on text alone and refused as `ambiguous`
 * when boilerplate repeated — the bug that blocked the 2026-06-16 project-14 run.)
 *
 * This is the pure SEMANTIC half of closeout (test-plan §3 "Define task closeout
 * semantics"). The effectful half — the closeout commit, clean-worktree
 * verification, durable block on failure — is the Phase 5 runtime's job.
 *
 * Pure — no I/O.
 */

/** The minimum a closeout needs to identify its task — matched on `text`. */
export interface CloseoutTaskRef {
  id: string;
  text: string;
  section?: string;
}

export type CloseoutResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'stale-task' };

/** Match an unchecked task line and capture its leading indent + body. Body
 *  capture is `\S(?:.*\S)?` so a whitespace-padded line can't trigger quadratic
 *  backtracking (this regex runs per `tasks.md` line, twice on the matched one). */
const UNCHECKED_RE = /^(\s*-\s*)\[\s\](\s+)(\S(?:.*\S)?)\s*$/;
/** A `## ` section heading — kept in lockstep with `orch-task-select.ts`. */
const SECTION_RE = /^##\s+(\S(?:.*\S)?)\s*$/;

/**
 * Flip the first unchecked task whose body equals `task.text` — and, when
 * `task.section` is supplied, whose running `## ` section equals it — from `[ ]`
 * to `[x]`. The scan tracks sections and stops at the first match exactly as
 * `selectNextTask` does, so closeout always ticks the line selection picked.
 * Refuses (`stale-task`) when no such line exists.
 */
export function markSelectedTaskComplete(tasksMd: string, task: CloseoutTaskRef): CloseoutResult {
  const lines = tasksMd.split('\n');
  let section = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      continue;
    }
    const m = UNCHECKED_RE.exec(line);
    if (m && m[3] === task.text && (task.section === undefined || section === task.section)) {
      lines[i] = line.replace(UNCHECKED_RE, '$1[x]$2$3');
      return { ok: true, content: lines.join('\n') };
    }
  }

  return { ok: false, reason: 'stale-task' };
}
