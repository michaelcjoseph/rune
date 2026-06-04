/**
 * Pure mark-done rewriter (09-expand-cockpit, Phase 4).
 *
 * Once a promotion has scaffolded a project, the source backlog bullet is rewritten to record it.
 * `markBacklogItemDone(content, kind, snapshotRaw, slug)` finds the bullet by SNAPSHOT — the
 * original raw line stored on the `Promotion` record — rather than by line number (which shifts as
 * the file is edited), and rewrites it:
 *
 * - bugs: flip the checkbox `[ ]`/`[x]` → `[x]` and append ` → <slug>`
 * - ideas: append ` → <slug>`
 *
 * Idempotency is keyed on the RETRY scenario: `Promotion.snapshotRaw` is the ORIGINAL line, but on
 * a retry the on-disk content already shows the promoted line. The rewriter recognizes a line that
 * is already the promoted form of the snapshot and returns the content byte-equal — re-running is a
 * no-op. It preserves every other byte (sub-bullets, surrounding lines, trailing whitespace),
 * tolerates CRLF content against an LF snapshot, and reports `ambiguous` (snapshot matches >1 line)
 * or `no-match` (snapshot — and its promoted form — absent).
 *
 * Pure — no I/O. The caller reads/writes the file.
 *
 * Contract pinned by `backlog-mark-done.test.ts`.
 */

import type { BacklogKind } from './backlog-id.js';

/** The promotion marker prefix appended to a promoted bullet: ` → <slug>`. */
const ARROW = ' → ';

/** Result of a mark-done rewrite. */
export type MarkDoneResult =
  | { matched: true; newText: string }
  | { matched: false; reason: 'no-match' | 'ambiguous' };

/** Strip a trailing CR/LF (line ending) from a line so an LF snapshot compares equal to a line
 *  read from CRLF content. The `+` is defensive cover — a `split('\n')` part carries at most one
 *  trailing `\r`, but a caller-supplied `snapshotRaw` with a stray trailing newline is also handled. */
function stripEol(line: string): string {
  return line.replace(/[\r\n]+$/, '');
}

/** The promoted form of a snapshot line: what the bullet should read once the slug is recorded.
 *  Assumes `snapshot` is the ORIGINAL unpromoted line (no trailing ` → <slug>`); a doubly-promoted
 *  snapshot can't reach here because the parser marks an already-promoted item `done` and the
 *  cockpit suppresses its Plan button. */
function promotedForm(snapshot: string, kind: BacklogKind, slug: string): string {
  const base = kind === 'bugs' ? snapshot.replace(/^- \[[ xX]\] /, '- [x] ') : snapshot;
  return `${base}${ARROW}${slug}`;
}

/**
 * Rewrite the snapshot bullet to its promoted form, matching by snapshot text (not line number).
 *
 * Counts lines that equal the snapshot (need rewriting) and lines that already equal its promoted
 * form (already done). Zero total → `no-match`; more than one total → `ambiguous`. Exactly one:
 * an already-promoted line yields a byte-equal no-op; a snapshot line is rewritten in place,
 * preserving its original line ending and every other byte of the file.
 */
export function markBacklogItemDone(
  content: string,
  kind: BacklogKind,
  snapshotRaw: string,
  slug: string,
): MarkDoneResult {
  const snapshot = stripEol(snapshotRaw);
  // An empty snapshot would compare equal to every blank line — guard against rewriting (or
  // ambiguously matching) blank lines if a caller ever passes an empty/whitespace-stripped raw.
  if (snapshot.length === 0) return { matched: false, reason: 'no-match' };
  const promoted = promotedForm(snapshot, kind, slug);

  // Split on '\n' so re-joining reproduces the file verbatim; a CRLF line keeps its trailing '\r'
  // on the part, which we strip only for comparison and re-attach on rewrite. Single pass, bailing
  // once a second hit makes the result ambiguous — we only need 0 / 1 / 2+ and, if exactly 1, which
  // kind of line it is.
  const parts = content.split('\n');
  let snapshotLine = -1;
  let promotedLine = -1;
  let total = 0;
  for (let i = 0; i < parts.length && total < 2; i++) {
    const text = stripEol(parts[i]!);
    if (text === promoted) { promotedLine = i; total++; }
    else if (text === snapshot) { snapshotLine = i; total++; }
  }

  if (total === 0) return { matched: false, reason: 'no-match' };
  if (total > 1) return { matched: false, reason: 'ambiguous' };

  // Exactly one target. An already-promoted line means a retry — change nothing (byte-equal).
  if (promotedLine !== -1) return { matched: true, newText: content };

  // One snapshot line to rewrite — preserve its original CR (if any) so the line ending is intact.
  const hadCr = parts[snapshotLine]!.endsWith('\r');
  parts[snapshotLine] = promoted + (hadCr ? '\r' : '');
  return { matched: true, newText: parts.join('\n') };
}
