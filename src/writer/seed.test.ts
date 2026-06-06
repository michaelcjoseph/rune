/**
 * Phase 1 test suite for `src/writer/seed.ts` — the writer-memory seed helper
 * (project 12, test-plan §0).
 *
 * Written TEST-FIRST. The scaffold bodies throw
 * `writer/seed: <fn> not implemented (project 12 Phase 1 pending)`, so every
 * test here is RED until the Phase 1 seed implementation lands.
 *
 * Expected failure mode: a clean assertion failure or the "not implemented"
 * throw — never a module-resolution error, syntax error, or env crash.
 *
 * See: docs/projects/12-writer-memory/test-plan.md §0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractSeedLinks,
  assertSeedSourceCount,
  capSeedBullets,
  stampSeedLesson,
  planSeedMining,
  SeedPrerequisiteError,
  SeedCapError,
  SEED_BULLET_CAP,
  PROVENANCE_RE,
} from './seed.js';

// Repo root derived locally (src/writer/ → ../.. ) — no app env vars needed.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A minimal spec fixture with a Seed sources section bracketed by the real
// surrounding headers, so the parser must scope extraction to that section.
function specWith(links: string[]): string {
  const bullets = links.map((l) => `- ${l}`).join('\n');
  return [
    '## The writer role',
    'Not a link section. https://ignored.example.com/should-not-count',
    '',
    '### Seed sources (Michael to add before agent run)',
    '',
    '#### Best works',
    bullets,
    '',
    '## Eval gate (loop closure, not quality)',
    'Trailing prose. https://also-ignored.example.com/nope',
  ].join('\n');
}

function nLinks(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://example.com/essay-${i + 1}`);
}

// ---------------------------------------------------------------------------
// extractSeedLinks — scope to the Seed sources section
// ---------------------------------------------------------------------------

describe('writer/seed — extractSeedLinks', () => {
  it('extracts only links inside the Seed sources section', () => {
    const links = extractSeedLinks(specWith(nLinks(20)));
    expect(links).toHaveLength(20);
    expect(links).toContain('https://example.com/essay-1');
    expect(links).not.toContain('https://ignored.example.com/should-not-count');
    expect(links).not.toContain('https://also-ignored.example.com/nope');
  });

  // Intentional integration check: doubles as the test-plan §0 assertion that
  // the real seed list satisfies the 20-50 prerequisite (Phase 0 complete at 46
  // links, commit 93d3754). Coupled to the spec file by design — if the seed
  // section is later edited out of range, this should fail loudly.
  it('parses the real project spec.md and finds 20-50 seed links', () => {
    const specPath = join(REPO_ROOT, 'docs', 'projects', '12-writer-memory', 'spec.md');
    const content = readFileSync(specPath, 'utf8');
    const links = extractSeedLinks(content);
    expect(links.length).toBeGreaterThanOrEqual(20);
    expect(links.length).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// assertSeedSourceCount — enforce the 20-50 supplied-link range
// ---------------------------------------------------------------------------

describe('writer/seed — assertSeedSourceCount', () => {
  it('accepts exactly 20 links', () => {
    expect(() => assertSeedSourceCount(nLinks(20))).not.toThrow();
  });

  it('accepts exactly 50 links', () => {
    expect(() => assertSeedSourceCount(nLinks(50))).not.toThrow();
  });

  it('fewer than 20 links throws SeedPrerequisiteError', () => {
    expect(() => assertSeedSourceCount(nLinks(19))).toThrow(SeedPrerequisiteError);
  });

  it('more than 50 links throws SeedCapError', () => {
    expect(() => assertSeedSourceCount(nLinks(51))).toThrow(SeedCapError);
  });
});

// ---------------------------------------------------------------------------
// capSeedBullets — output stays ≤ 20
// ---------------------------------------------------------------------------

describe('writer/seed — capSeedBullets', () => {
  it('caps more than SEED_BULLET_CAP bullets to the cap', () => {
    const bullets = Array.from({ length: 30 }, (_, i) => `- bullet ${i}`);
    expect(capSeedBullets(bullets)).toHaveLength(SEED_BULLET_CAP);
  });

  it('passes through when already under the cap', () => {
    const bullets = ['- a', '- b', '- c'];
    expect(capSeedBullets(bullets)).toEqual(bullets);
  });
});

// ---------------------------------------------------------------------------
// stampSeedLesson — canonical provenance format
// ---------------------------------------------------------------------------

describe('writer/seed — stampSeedLesson', () => {
  it('stamps a lesson in the provenance format', () => {
    const stamped = stampSeedLesson('Open on tension, not context.', 'eugene-status', '2026-06-05');
    expect(stamped).toBe('- [2026-06-05 · source: eugene-status] Open on tension, not context.');
    expect(stamped).toMatch(PROVENANCE_RE);
  });
});

// ---------------------------------------------------------------------------
// planSeedMining — skip unfetchable links with a note
// ---------------------------------------------------------------------------

describe('writer/seed — planSeedMining', () => {
  it('routes fetched links to toMine and unfetchable ones to skipped-with-note', () => {
    const links = ['https://a.example.com', 'https://b.example.com', 'https://c.example.com'];
    const plan = planSeedMining(links, [
      { url: 'https://a.example.com', fetched: true },
      { url: 'https://b.example.com', fetched: false },
      { url: 'https://c.example.com', fetched: true },
    ]);
    expect(plan.toMine).toEqual(['https://a.example.com', 'https://c.example.com']);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.url).toBe('https://b.example.com');
    expect(plan.skipped[0]?.note).toBeTruthy();
  });
});
