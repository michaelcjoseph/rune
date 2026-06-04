import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

/*
 * Automated docs check (09-expand-cockpit, Phase 5). This project was itself promoted from a
 * backlog idea, so the Jarvis repo's own `docs/projects/ideas.md` must carry the promoted bullet
 * `Expand cockpit → 09-expand-cockpit` (the ` → NN-slug` marker the backlog parser recognizes as
 * "done/promoted"). If this fails, add/restore that line to ideas.md.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IDEAS_PATH = join(repoRoot, 'docs', 'projects', 'ideas.md');

describe('docs/projects/ideas.md — Expand cockpit is recorded as promoted', () => {
  it('contains a top-level idea bullet promoted to 09-expand-cockpit', () => {
    const content = readFileSync(IDEAS_PATH, 'utf8');
    // A top-level bullet ending in the strict promotion marker for this project's slug.
    const promoted = /^- .*\bExpand cockpit\b.*→ 09-expand-cockpit\s*$/im;
    expect(promoted.test(content)).toBe(true);
  });
});
