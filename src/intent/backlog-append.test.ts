import { describe, it, expect } from 'vitest';

/*
 * Test suite for the pure backlog append core (09-expand-cockpit, Phase 3, written test-first).
 *
 * `backlog-append.ts` computes the new file content for the drawer's `+` add action — no I/O.
 * Bugs append `- [ ] <text>` at EOF (always leaving a trailing newline). Ideas insert
 * `- <text>` at the END of the User-authored section, just above the `## Loop-filed` sentinel
 * so a new user-authored idea never lands among the machine-filed ones; with the sentinel
 * missing (or no headings at all) it falls back to an EOF append. Empty/whitespace-only and
 * multiline text are rejected with typed errors.
 *
 * "Test suite as deliverable": stays RED until the Phase 3 build lands `backlog-append.ts`.
 */

import { appendBug, appendIdea, type AppendResult } from './backlog-append.js';

/** Assert success and return the new content. */
function ok(result: AppendResult): string {
  if (!result.ok) throw new Error(`expected ok, got error ${result.error}`);
  return result.content;
}

const LF = '## Loop-filed';

describe('backlog-append — appendBug', () => {
  it('appends a checkbox bullet to an empty file with a trailing newline', () => {
    expect(ok(appendBug('', 'New bug'))).toBe('- [ ] New bug\n');
  });

  it('appends after content that already ends with a newline', () => {
    expect(ok(appendBug('- [ ] First\n', 'Second'))).toBe('- [ ] First\n- [ ] Second\n');
  });

  it('inserts a missing newline before appending when the file does not end with one', () => {
    expect(ok(appendBug('- [ ] First', 'Second'))).toBe('- [ ] First\n- [ ] Second\n');
  });

  it('always leaves the result ending in a newline', () => {
    expect(ok(appendBug('- [ ] First\n', 'Second')).endsWith('\n')).toBe(true);
  });

  it('rejects empty / whitespace-only text with empty-text', () => {
    expect(appendBug('- [ ] First\n', '')).toEqual({ ok: false, error: 'empty-text' });
    expect(appendBug('- [ ] First\n', '   ')).toEqual({ ok: false, error: 'empty-text' });
  });

  it('rejects multiline text with multiline-text', () => {
    expect(appendBug('- [ ] First\n', 'line one\nline two')).toEqual({
      ok: false,
      error: 'multiline-text',
    });
  });
});

describe('backlog-append — appendIdea', () => {
  it('inserts a top-level idea at the end of User-authored, above the Loop-filed sentinel', () => {
    const input = ['## User-authored', '- Idea A', '', LF, '<!-- sentinel -->', ''].join('\n');
    // Exact shape pins all three guarantees at once: the bullet lands directly after the LAST
    // user-authored bullet (not mid-section), the blank separator + sentinel + comment are
    // preserved verbatim, and the trailing newline is intact.
    expect(ok(appendIdea(input, 'New idea'))).toBe(
      ['## User-authored', '- Idea A', '- New idea', '', LF, '<!-- sentinel -->', ''].join('\n'),
    );
  });

  it('uses a non-checkbox bullet for ideas (exact bullet form)', () => {
    const out = ok(appendIdea(`## User-authored\n- Idea A\n\n${LF}\n`, 'New idea'));
    expect(out).toBe(`## User-authored\n- Idea A\n- New idea\n\n${LF}\n`);
    expect(out).not.toContain('- [ ] New idea');
  });

  it('falls back to an EOF append when the Loop-filed sentinel is missing', () => {
    const out = ok(appendIdea('## User-authored\n- Idea A\n', 'New idea'));
    expect(out).toBe('## User-authored\n- Idea A\n- New idea\n');
  });

  it('falls back to an EOF append when there are no section headings at all', () => {
    expect(ok(appendIdea('- Idea A\n', 'New idea'))).toBe('- Idea A\n- New idea\n');
  });

  it('appends to an empty file with a trailing newline', () => {
    expect(ok(appendIdea('', 'New idea'))).toBe('- New idea\n');
  });

  it('does not insert among the loop-filed bullets', () => {
    const input = [
      '## User-authored',
      '- Idea A',
      '',
      LF,
      '<!-- sentinel -->',
      '- **Filed** — friction',
      '',
    ].join('\n');
    // The new idea lands at the end of User-authored; the entire loop-filed section (heading,
    // comment, and filed bullet) is preserved verbatim below it.
    expect(ok(appendIdea(input, 'New idea'))).toBe(
      [
        '## User-authored',
        '- Idea A',
        '- New idea',
        '',
        LF,
        '<!-- sentinel -->',
        '- **Filed** — friction',
        '',
      ].join('\n'),
    );
  });

  it('inserts above a Loop-filed sentinel that is the very first line (never among filed bullets)', () => {
    // Degenerate input — no User-authored section. The new idea must still land ABOVE the
    // sentinel (an EOF append would wrongly drop it into the loop-filed section).
    const input = `${LF}\n- **Filed** — friction\n`;
    const out = ok(appendIdea(input, 'New idea'));
    expect(out).toBe(`- New idea\n${LF}\n- **Filed** — friction\n`);
  });

  it('normalizes CRLF input to LF so no mixed line endings are produced', () => {
    const out = ok(appendIdea(`## User-authored\r\n- Idea A\r\n\r\n${LF}\r\n`, 'New idea'));
    expect(out).not.toContain('\r');
    expect(out).toBe(`## User-authored\n- Idea A\n- New idea\n\n${LF}\n`);
  });

  it('rejects empty / whitespace-only text with empty-text', () => {
    expect(appendIdea('- Idea A\n', '  ')).toEqual({ ok: false, error: 'empty-text' });
  });

  it('rejects multiline text with multiline-text', () => {
    expect(appendIdea('- Idea A\n', 'a\nb')).toEqual({ ok: false, error: 'multiline-text' });
  });
});
