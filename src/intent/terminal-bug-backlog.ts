/**
 * Pure terminal-bug → bugs.md backlog append (project 14, Phase 15).
 *
 * Turns the orchestration's open-at-terminal findings into `## Loop-filed`
 * checkbox bullets in a product's `docs/projects/bugs.md`. Pure: no I/O, no
 * clock. The filesystem write (mutex, atomicity, security guard) is
 * `backlog-write-lock.ts`; the caller (the orchestrated-work runner deps) reads
 * the canonical bugs.md, calls `appendTerminalBugsToBacklog`, and atomically
 * writes the result back — NEVER the throwaway worktree, which is GC'd before a
 * non-merge run's bug would survive.
 *
 * Dedup: a finding is filed at most once. The dedup key is the defect SIGNATURE
 * (class/severity @ location — rationale), not the findingId, so a re-raise of
 * the same defect on a later run — even with a fresh id — is recognized and
 * skipped. Both the on-disk content and earlier entries in the same batch are
 * checked.
 *
 * Contract pinned by `terminal-bug-backlog.test.ts`.
 */

import type { OrchestrationTerminalBugEntry } from './project-orchestrator.js';

const LOOP_FILED_RE = /^##\s+Loop-filed\s*$/i;
const HEADING_RE = /^##\s+/;

/** Collapse all whitespace (incl. newlines) to single spaces — appendBug-style
 *  single-line discipline, so a multi-line rationale can never break the bullet. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The defect identity used for dedup — stable across runs and findingIds. The
 *  formatted bullet embeds this verbatim, so a substring scan of bugs.md finds a
 *  prior filing of the same defect. */
export function terminalBugSignature(entry: OrchestrationTerminalBugEntry): string {
  return `${entry.class}/${entry.severity} @ ${entry.location} — ${oneLine(entry.rationale)}`;
}

/** The bug text (the part after `- [ ]`). Begins with the dedup signature so the
 *  signature scan matches, then carries provenance for a human triaging it. */
export function formatTerminalBugLine(entry: OrchestrationTerminalBugEntry): string {
  return `[team-loop] ${terminalBugSignature(entry)} (finding ${entry.findingId} · task ${entry.taskId})`;
}

/** Insert `bullet` as the LAST entry under a `## Loop-filed` section, creating
 *  the section at EOF if absent. Operates on a line array; returns a new array. */
function insertUnderLoopFiled(lines: string[], bullet: string): string[] {
  const out = [...lines];
  const headingIdx = out.findIndex((l) => LOOP_FILED_RE.test(l));

  if (headingIdx === -1) {
    // No section yet — drop trailing blank lines, then open the section at EOF.
    while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') out.pop();
    if (out.length > 0) out.push('');
    out.push('## Loop-filed', '', bullet);
    return out;
  }

  // End of the Loop-filed section = the next `## ` heading, else EOF.
  let end = out.length;
  for (let i = headingIdx + 1; i < out.length; i++) {
    if (HEADING_RE.test(out[i] ?? '')) {
      end = i;
      break;
    }
  }
  // Insert right after the last non-blank line inside the section, so the new
  // bullet joins existing loop-filed bullets rather than landing after a gap.
  let j = end - 1;
  while (j > headingIdx && (out[j] ?? '').trim() === '') j--;
  out.splice(j + 1, 0, bullet);
  return out;
}

export interface AppendTerminalBugsResult {
  /** New file content. Ends in a single trailing newline when anything changed.
   *  Returned UNCHANGED (===) when every entry was a duplicate. */
  content: string;
  /** How many bullets were actually added (post-dedup). */
  appended: number;
}

/** Append each not-already-present terminal-bug entry as a Loop-filed bullet.
 *  Pure. Dedups by signature against the existing content AND against entries
 *  added earlier in this same call. */
export function appendTerminalBugsToBacklog(
  content: string,
  entries: readonly OrchestrationTerminalBugEntry[],
): AppendTerminalBugsResult {
  const normalized = content.replace(/\r\n/g, '\n');
  let lines = normalized.split('\n');
  let appended = 0;

  for (const entry of entries) {
    const signature = terminalBugSignature(entry);
    // Already filed (on disk, or earlier in this batch — the bullet embeds the
    // signature, so a prior insertion is found by the same scan).
    if (lines.some((l) => l.includes(signature))) continue;
    lines = insertUnderLoopFiled(lines, `- [ ] ${formatTerminalBugLine(entry)}`);
    appended += 1;
  }

  if (appended === 0) return { content, appended: 0 };
  const joined = lines.join('\n');
  return { content: joined.endsWith('\n') ? joined : `${joined}\n`, appended };
}
