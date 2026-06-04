import { describe, it, expect } from 'vitest';

/*
 * Test suite for the pure mark-done rewriter (09-expand-cockpit, Phase 4, written test-first).
 *
 * After a promotion scaffolds a project, the source backlog bullet is rewritten to record it.
 * `markBacklogItemDone(content, kind, snapshotRaw, slug)` finds the bullet by SNAPSHOT (the
 * original raw line, as stored on the Promotion record) — not by line number, which is unstable —
 * and rewrites it: bugs flip `[ ] → [x]` and append ` → <slug>`; ideas append ` → <slug>`.
 *
 * Idempotency is keyed on the RETRY scenario: the Promotion record holds the ORIGINAL snapshot,
 * but on retry the on-disk content already shows the promoted line. The function must recognize a
 * line that is already the promoted form of the snapshot and return the content byte-equal.
 * It preserves every other byte (sub-bullets, trailing whitespace), tolerates CRLF content against
 * an LF snapshot, and reports `ambiguous` (snapshot matches >1 line) / `no-match` (none).
 *
 * "Test suite as deliverable": stays RED until the Phase 4 build lands `backlog-mark-done.ts`.
 */

import { markBacklogItemDone, type MarkDoneResult } from './backlog-mark-done.js';

function matched(r: MarkDoneResult): string {
  if (!r.matched) throw new Error(`expected match, got ${r.reason}`);
  return r.newText;
}

describe('backlog-mark-done — bugs', () => {
  it('flips [ ] → [x] and appends the slug suffix', () => {
    const out = matched(markBacklogItemDone('- [ ] Cockpit bug\n', 'bugs', '- [ ] Cockpit bug', '09-x'));
    expect(out).toBe('- [x] Cockpit bug → 09-x\n');
  });

  it('appends the suffix to an already-[x] (done-but-unpromoted) bug', () => {
    // Distinct from the idempotent case below: this line is done but NOT yet promoted (no suffix),
    // so the suffix must still be appended.
    const out = matched(markBacklogItemDone('- [x] Whoop bug\n', 'bugs', '- [x] Whoop bug', '04-y'));
    expect(out).toBe('- [x] Whoop bug → 04-y\n');
  });

  it('is a byte-equal no-op on retry — original snapshot, content already promoted (idempotent)', () => {
    // The realistic retry: Promotion.snapshotRaw is the ORIGINAL `- [ ] Whoop bug`, but the file
    // on disk already shows the promoted line. The rewrite must detect that and change nothing.
    const content = '- [x] Whoop bug → 04-y\n';
    const out = matched(markBacklogItemDone(content, 'bugs', '- [ ] Whoop bug', '04-y'));
    expect(out).toBe(content);
  });
});

describe('backlog-mark-done — ideas', () => {
  it('appends the slug suffix to an idea bullet', () => {
    const out = matched(markBacklogItemDone('- Some idea\n', 'ideas', '- Some idea', '09-x'));
    expect(out).toBe('- Some idea → 09-x\n');
  });

  it('is a byte-equal no-op on retry — original snapshot, content already promoted', () => {
    const content = '- Some idea → 09-x\n';
    const out = matched(markBacklogItemDone(content, 'ideas', '- Some idea', '09-x'));
    expect(out).toBe(content);
  });

  it('appends the suffix correctly to an idea with a mid-sentence arrow (not a marker)', () => {
    // ` → B` mid-sentence is not a promotion marker (the parser anchors markers at EOL), so the
    // suffix is appended at the end and idempotency keys on the trailing ` → <slug>`, not any
    // interior arrow.
    const out = matched(markBacklogItemDone('- Map A → B correctly\n', 'ideas', '- Map A → B correctly', '09-x'));
    expect(out).toBe('- Map A → B correctly → 09-x\n');
  });
});

describe('backlog-mark-done — match by snapshot, not line; byte preservation', () => {
  it('rewrites the snapshot line wherever it sits, preserving every other byte (bugs)', () => {
    const content = ['- [ ] First bug', '- [ ] Target bug', '- [ ] Third bug', ''].join('\n');
    const out = matched(markBacklogItemDone(content, 'bugs', '- [ ] Target bug', '12-z'));
    expect(out).toBe(['- [ ] First bug', '- [x] Target bug → 12-z', '- [ ] Third bug', ''].join('\n'));
  });

  it('preserves an idea item\'s sub-bullets (and all surrounding bytes) when rewriting it', () => {
    const content = [
      '## User-authored',
      '- Target idea',
      '  - context one',
      '  - context two',
      '- Another idea',
      '',
    ].join('\n');
    const out = matched(markBacklogItemDone(content, 'ideas', '- Target idea', '12-z'));
    expect(out).toBe([
      '## User-authored',
      '- Target idea → 12-z',
      '  - context one',
      '  - context two',
      '- Another idea',
      '',
    ].join('\n'));
  });
});

describe('backlog-mark-done — CRLF tolerance', () => {
  it('matches an LF snapshot against CRLF content (does not silently no-op)', () => {
    const r = markBacklogItemDone('- [ ] Cockpit bug\r\n', 'bugs', '- [ ] Cockpit bug', '09-x');
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.newText).toContain('- [x] Cockpit bug → 09-x');
  });
});

describe('backlog-mark-done — match failures', () => {
  it('reports no-match when neither the snapshot nor its promoted form is present', () => {
    const r = markBacklogItemDone('- [ ] Some bug\n', 'bugs', '- [ ] A different bug', '09-x');
    expect(r.matched).toBe(false);
    if (!r.matched) expect(r.reason).toBe('no-match');
  });

  it('reports ambiguous when the snapshot matches more than one line', () => {
    const content = '- [ ] Dup bug\n- [ ] Dup bug\n';
    const r = markBacklogItemDone(content, 'bugs', '- [ ] Dup bug', '09-x');
    expect(r.matched).toBe(false);
    if (!r.matched) expect(r.reason).toBe('ambiguous');
  });
});
