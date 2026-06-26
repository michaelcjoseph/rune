import { describe, it, expect } from 'vitest';

/*
 * Test suite for the backlog deterministic id helper (09-expand-cockpit, Phase 1,
 * written test-first).
 *
 * `backlog-id.ts` owns the single source of truth for a backlog item's id:
 *
 *   sha1(`${kind}:${repoRelativeFile}:${topLevelStartLine}:${normalizedRaw}`).slice(0, 12)
 *
 * The id is intentionally UNSTABLE across line edits — a content edit changes the id, which
 * is how a stale Plan URL surfaces as `409 stale-item` and forces the cockpit to re-fetch.
 * It is also intentionally PRODUCT-LOCAL: the formula carries no product, so two product
 * repos can hold byte-identical bullets at the same path+line and collide on id string —
 * disambiguation is the API route's `:product` segment, not the id (see test-plan §2).
 *
 * `normalizeBacklogRaw` is the normalization the formula applies to the raw line before
 * hashing: trailing whitespace and a trailing CR are stripped so invisible trailing-whitespace
 * differences don't spuriously change the id, while any visible content change does.
 *
 * This is the "test suite as deliverable" task: it stays RED (the module does not exist yet)
 * until the Phase 1 build task lands.
 */

import {
  computeBacklogId,
  normalizeBacklogRaw,
  type BacklogIdInput,
} from './backlog-id.js';

// Field-name note: the spec formula calls the position term `topLevelStartLine`; the
// `BacklogIdInput` field is `lineNumber`, matching `BacklogItem.source.lineNumber`. The
// name does not affect the hash — the formula interpolates the line number's value.
const BUG: BacklogIdInput = {
  kind: 'bugs',
  file: 'docs/projects/bugs.md',
  lineNumber: 1,
  raw: '- [ ] Cockpit shows wrong status',
};

describe('backlog-id — computeBacklogId formula', () => {
  it('matches the exact sha1-slice contract for a bug line', () => {
    // sha1("bugs:docs/projects/bugs.md:1:- [ ] Cockpit shows wrong status").slice(0,12)
    expect(computeBacklogId(BUG)).toBe('868debebf8c2');
  });

  it('matches the exact sha1-slice contract for an idea line', () => {
    // sha1("ideas:docs/projects/ideas.md:7:- Some idea").slice(0,12)
    expect(
      computeBacklogId({
        kind: 'ideas',
        file: 'docs/projects/ideas.md',
        lineNumber: 7,
        raw: '- Some idea',
      }),
    ).toBe('a7e87a93d1c8');
  });

  it('produces a 12-character lowercase hex id', () => {
    expect(computeBacklogId(BUG)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('backlog-id — determinism and input sensitivity', () => {
  it('is stable for identical (kind, file, line, raw)', () => {
    expect(computeBacklogId(BUG)).toBe(computeBacklogId({ ...BUG }));
  });

  it('changes when the kind changes', () => {
    expect(computeBacklogId({ ...BUG, kind: 'ideas' })).not.toBe(computeBacklogId(BUG));
  });

  it('changes when the file changes', () => {
    expect(computeBacklogId({ ...BUG, file: 'docs/projects/ideas.md' })).not.toBe(
      computeBacklogId(BUG),
    );
  });

  it('changes when the line number changes (same text at a different position)', () => {
    const moved = computeBacklogId({ ...BUG, lineNumber: 2 });
    expect(moved).not.toBe(computeBacklogId(BUG));
    // pin the moved value too, so the position term of the formula can't silently drift
    expect(moved).toBe('dd084365f1ee');
  });

  it('changes when the raw text changes (a line edit invalidates the id)', () => {
    expect(computeBacklogId({ ...BUG, raw: '- [ ] Cockpit shows the wrong status' })).not.toBe(
      computeBacklogId(BUG),
    );
  });
});

describe('backlog-id — normalization', () => {
  it('strips trailing whitespace before hashing (invisible edits do not change the id)', () => {
    expect(computeBacklogId({ ...BUG, raw: BUG.raw + '   ' })).toBe(computeBacklogId(BUG));
  });

  it('strips a trailing carriage return before hashing (CRLF parity)', () => {
    expect(computeBacklogId({ ...BUG, raw: BUG.raw + '\r' })).toBe(computeBacklogId(BUG));
  });

  it('normalizeBacklogRaw trims trailing whitespace and CR', () => {
    expect(normalizeBacklogRaw('- [ ] foo  ')).toBe('- [ ] foo');
    expect(normalizeBacklogRaw('- [ ] foo\r')).toBe('- [ ] foo');
    expect(normalizeBacklogRaw('- [ ] foo\t')).toBe('- [ ] foo');
  });

  it('normalizeBacklogRaw preserves leading whitespace and interior content', () => {
    // Leading indentation is meaningful (it distinguishes sub-bullets) and interior spacing
    // is content — only the trailing edge is normalized.
    expect(normalizeBacklogRaw('  - real sub')).toBe('  - real sub');
    expect(normalizeBacklogRaw('- [ ] a   b')).toBe('- [ ] a   b');
  });
});

describe('backlog-id — product-locality', () => {
  it('collides across products that share a repo-relative path: the differing absolute repoPath is not in the formula', () => {
    // The formula's file term is the REPO-RELATIVE path. Two distinct product repos — say
    // rune at /Users/x/workspace/rune and aura at /Users/x/workspace/aura — both hold a
    // byte-identical bullet at `docs/projects/bugs.md:1`. Because the absolute repoPath is
    // deliberately absent from the formula, both yield the same id string. Global uniqueness
    // comes from the API route's `:product` segment, not the id. See test-plan §2.
    const runeItem = computeBacklogId({
      kind: 'bugs',
      file: 'docs/projects/bugs.md',
      lineNumber: 1,
      raw: '- [ ] Shared bullet text',
    });
    const auraItem = computeBacklogId({
      kind: 'bugs',
      file: 'docs/projects/bugs.md',
      lineNumber: 1,
      raw: '- [ ] Shared bullet text',
    });
    expect(runeItem).toBe(auraItem);
  });
});
