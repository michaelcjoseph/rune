/**
 * Pure backlog append core (09-expand-cockpit, Phase 3).
 *
 * Computes the new file content for the drawer's `+` add action — no I/O. Bugs append a
 * checkbox bullet at EOF; ideas insert a plain bullet at the END of the User-authored section,
 * directly above the `## Loop-filed` sentinel so a new user-authored idea never lands among the
 * machine-filed ones. With the sentinel missing (or no headings at all) both fall back to an
 * EOF append. Every successful result ends in a newline. Empty/whitespace-only and multiline
 * text are rejected with typed errors.
 *
 * Contract pinned by `backlog-append.test.ts`. The filesystem write (atomicity, mutex, security)
 * is `backlog-write-lock.ts`.
 */

export type AppendError = 'empty-text' | 'multiline-text';
/** On success, `lineNumber` is the 1-based line of the inserted bullet in `content`. The caller
 *  uses it to find the new item after re-parsing — for ideas the bullet is inserted ABOVE the
 *  Loop-filed sentinel, so it is NOT necessarily the last parsed item. */
export type AppendResult =
  | { ok: true; content: string; lineNumber: number }
  | { ok: false; error: AppendError };

const LOOP_FILED_RE = /^##\s+Loop-filed\s*$/i;

/** Reject empty/whitespace-only and multiline text. */
function validateText(text: string): AppendError | null {
  if (text.trim() === '') return 'empty-text';
  if (text.includes('\n')) return 'multiline-text';
  return null;
}

/** Append `line` at EOF, ensuring the file ended in a newline first and the result does too.
 *  Returns the new content and the 1-based line number the appended bullet landed on. */
function appendAtEof(content: string, line: string): { content: string; lineNumber: number } {
  const sep = content === '' || content.endsWith('\n') ? '' : '\n';
  const newContent = `${content}${sep}${line}\n`;
  // newContent ends in '\n', so split yields a trailing '' — the bullet is the line before it.
  return { content: newContent, lineNumber: newContent.split('\n').length - 1 };
}

/** Normalize CRLF → LF so an inserted (LF) bullet never creates mixed line endings; a backlog
 *  file synced from Windows is rewritten to LF on append, matching the LF-only vault norm. */
function toLf(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

export function appendBug(content: string, text: string): AppendResult {
  const error = validateText(text);
  if (error) return { ok: false, error };
  const { content: newContent, lineNumber } = appendAtEof(toLf(content), `- [ ] ${text}`);
  return { ok: true, content: newContent, lineNumber };
}

export function appendIdea(content: string, text: string): AppendResult {
  const error = validateText(text);
  if (error) return { ok: false, error };
  const bullet = `- ${text}`;

  const normalized = toLf(content);
  const lines = normalized.split('\n');
  const loopFiledIndex = lines.findIndex((l) => LOOP_FILED_RE.test(l));
  if (loopFiledIndex === -1) {
    // No Loop-filed sentinel (and the no-heading case) → EOF append within user-authored.
    const { content: newContent, lineNumber } = appendAtEof(normalized, bullet);
    return { ok: true, content: newContent, lineNumber };
  }

  // Insert directly after the last non-blank line before the sentinel, so the new idea joins
  // the existing user-authored bullets rather than landing after a blank gap.
  let j = loopFiledIndex - 1;
  while (j >= 0 && (lines[j] ?? '').trim() === '') j--;
  const insertAt = j + 1;
  lines.splice(insertAt, 0, bullet);
  return { ok: true, content: lines.join('\n'), lineNumber: insertAt + 1 };
}
