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
export type AppendResult = { ok: true; content: string } | { ok: false; error: AppendError };

const LOOP_FILED_RE = /^##\s+Loop-filed\s*$/i;

/** Reject empty/whitespace-only and multiline text. */
function validateText(text: string): AppendError | null {
  if (text.trim() === '') return 'empty-text';
  if (text.includes('\n')) return 'multiline-text';
  return null;
}

/** Append `line` at EOF, ensuring the file ended in a newline first and the result does too. */
function appendAtEof(content: string, line: string): string {
  const sep = content === '' || content.endsWith('\n') ? '' : '\n';
  return `${content}${sep}${line}\n`;
}

/** Normalize CRLF → LF so an inserted (LF) bullet never creates mixed line endings; a backlog
 *  file synced from Windows is rewritten to LF on append, matching the LF-only vault norm. */
function toLf(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

export function appendBug(content: string, text: string): AppendResult {
  const error = validateText(text);
  if (error) return { ok: false, error };
  return { ok: true, content: appendAtEof(toLf(content), `- [ ] ${text}`) };
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
    return { ok: true, content: appendAtEof(normalized, bullet) };
  }

  // Insert directly after the last non-blank line before the sentinel, so the new idea joins
  // the existing user-authored bullets rather than landing after a blank gap.
  let j = loopFiledIndex - 1;
  while (j >= 0 && (lines[j] ?? '').trim() === '') j--;
  lines.splice(j + 1, 0, bullet);
  return { ok: true, content: lines.join('\n') };
}
