/**
 * Pure task closeout — the `tasks.md` checkbox tick (project 14, Phase 3).
 *
 * Closeout marks EXACTLY the selected task complete and nothing else: it matches
 * the `- [ ]` line by the task's TEXT (stable across edits), flips it to `- [x]`,
 * and leaves every other line byte-for-byte. A task whose text is no longer in
 * `tasks.md` is refused as stale rather than silently ticking the wrong box.
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
  | { ok: false; reason: 'stale-task' | 'ambiguous' };

/** Match an unchecked task line and capture its leading indent + body. Body
 *  capture is `\S(?:.*\S)?` so a whitespace-padded line can't trigger quadratic
 *  backtracking (this regex runs per `tasks.md` line, twice on the matched one). */
const UNCHECKED_RE = /^(\s*-\s*)\[\s\](\s+)(\S(?:.*\S)?)\s*$/;

/**
 * Flip exactly the line whose unchecked-task body equals `task.text` from `[ ]`
 * to `[x]`. Refuses (`stale-task`) when no such line exists, and (`ambiguous`)
 * when more than one unchecked line shares the text — closeout must tick one
 * deterministic box.
 */
export function markSelectedTaskComplete(tasksMd: string, task: CloseoutTaskRef): CloseoutResult {
  const lines = tasksMd.split('\n');
  const matches: number[] = [];

  lines.forEach((line, i) => {
    const m = UNCHECKED_RE.exec(line);
    if (m && m[3] === task.text) matches.push(i);
  });

  if (matches.length === 0) return { ok: false, reason: 'stale-task' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };

  const idx = matches[0]!;
  lines[idx] = lines[idx]!.replace(UNCHECKED_RE, '$1[x]$2$3');
  return { ok: true, content: lines.join('\n') };
}
