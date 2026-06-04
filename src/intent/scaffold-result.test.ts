import { describe, it, expect } from 'vitest';

/*
 * Test suite for the scaffold-result parser + repo-diff cross-check (09-expand-cockpit, Phase 4,
 * written test-first).
 *
 * The `project-setup-writer` agent's final message must carry a fenced ```scaffold-result JSON
 * block `{ slug, filesCreated[] }`. `parseScaffoldResult` extracts it (absent/malformed →
 * undefined). `crossCheckScaffold` reconciles the (primary) parsed block against the (fallback)
 * directory diff of `docs/projects/` — both must agree on the slug. All `filesCreated` paths must
 * be repo-relative; absolute or escaping paths fail. Distinct error reasons per failure mode.
 *
 * "Test suite as deliverable": stays RED until the Phase 4 build lands `scaffold-result.ts`.
 */

import {
  parseScaffoldResult,
  crossCheckScaffold,
  type ScaffoldResult,
  type ScaffoldCheck,
} from './scaffold-result.js';

/** Build an agent message embedding a scaffold-result block with the given raw JSON body. */
function withBlock(jsonBody: string): string {
  return ['Done scaffolding.', '', '```scaffold-result', jsonBody, '```', '', 'Files written.'].join('\n');
}

function okCheck(check: ScaffoldCheck): string {
  if (!check.ok) throw new Error(`expected ok, got error ${check.error}`);
  return check.slug;
}

const VALID: ScaffoldResult = {
  slug: '09-expand-cockpit',
  filesCreated: [
    'docs/projects/09-expand-cockpit/spec.md',
    'docs/projects/09-expand-cockpit/tasks.md',
    'docs/projects/09-expand-cockpit/test-plan.md',
  ],
};

describe('scaffold-result — parseScaffoldResult', () => {
  it('extracts slug + filesCreated from a valid fenced block', () => {
    const msg = withBlock(JSON.stringify(VALID));
    expect(parseScaffoldResult(msg)).toEqual(VALID);
  });

  it('returns undefined when no scaffold-result block is present', () => {
    expect(parseScaffoldResult('I created the project. spec.md, tasks.md, test-plan.md.')).toBeUndefined();
  });

  it('returns undefined when the block JSON is malformed', () => {
    expect(parseScaffoldResult(withBlock('{ slug: not json }'))).toBeUndefined();
  });

  it('returns undefined when slug is missing', () => {
    expect(parseScaffoldResult(withBlock('{ "filesCreated": ["docs/projects/x/spec.md"] }'))).toBeUndefined();
  });

  it('returns undefined when filesCreated is missing', () => {
    expect(parseScaffoldResult(withBlock('{ "slug": "09-expand-cockpit" }'))).toBeUndefined();
  });

  it('returns undefined when filesCreated is not an array of strings', () => {
    expect(parseScaffoldResult(withBlock('{ "slug": "09-x", "filesCreated": "spec.md" }'))).toBeUndefined();
    expect(parseScaffoldResult(withBlock('{ "slug": "09-x", "filesCreated": [1, 2] }'))).toBeUndefined();
    // Mixed array — a later non-string element must reject (forces validating EVERY element).
    expect(parseScaffoldResult(withBlock('{ "slug": "09-x", "filesCreated": ["ok.md", 42] }'))).toBeUndefined();
  });
});

describe('scaffold-result — crossCheckScaffold (primary block agrees with diff)', () => {
  it('captures the slug when the parsed block and the diff agree', () => {
    expect(okCheck(crossCheckScaffold(VALID, ['09-expand-cockpit']))).toBe('09-expand-cockpit');
  });

  it('flags slug-mismatch when the parsed slug disagrees with the diff', () => {
    const check = crossCheckScaffold(VALID, ['08-other-thing']);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toBe('slug-mismatch');
  });

  it('flags slug-mismatch when the diff shows no new project dir despite a parsed block', () => {
    // A block was parsed, so the diff must CONFIRM it. An empty diff means the claimed dir isn't
    // on disk — the block is unconfirmed, which counts as disagreement (spec: "both must agree").
    // Deliberately `slug-mismatch` (block path), not `no-new-project-dir` (which is the no-block
    // fallback's empty-diff code).
    const check = crossCheckScaffold(VALID, []);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toBe('slug-mismatch');
  });
});

describe('scaffold-result — crossCheckScaffold (fallback to diff when no block)', () => {
  it('captures the slug from the diff when exactly one new project dir exists and no block was parsed', () => {
    expect(okCheck(crossCheckScaffold(undefined, ['09-expand-cockpit']))).toBe('09-expand-cockpit');
  });

  it('flags no-new-project-dir when the diff is empty and no block was parsed', () => {
    const check = crossCheckScaffold(undefined, []);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toBe('no-new-project-dir');
  });

  it('flags ambiguous-project-dirs when the diff shows more than one new dir and no block', () => {
    const check = crossCheckScaffold(undefined, ['09-expand-cockpit', '10-something-else']);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toBe('ambiguous-project-dirs');
  });
});

describe('scaffold-result — crossCheckScaffold (repo-relative filesCreated guard)', () => {
  it('rejects an absolute path in filesCreated', () => {
    const bad: ScaffoldResult = { slug: '09-x', filesCreated: ['/etc/passwd'] };
    const check = crossCheckScaffold(bad, ['09-x']);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toBe('non-relative-path');
  });

  it('rejects a path that escapes the repo with ..', () => {
    const bad: ScaffoldResult = { slug: '09-x', filesCreated: ['../../etc/passwd'] };
    const check = crossCheckScaffold(bad, ['09-x']);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toBe('non-relative-path');
  });

  it('rejects a mid-path .. that normalizes out of the repo (forces normalize, not a prefix check)', () => {
    const bad: ScaffoldResult = { slug: '09-x', filesCreated: ['docs/projects/09-x/../../../../outside.txt'] };
    const check = crossCheckScaffold(bad, ['09-x']);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toBe('non-relative-path');
  });

  it('accepts repo-relative paths under docs/projects/<slug>/', () => {
    expect(okCheck(crossCheckScaffold(VALID, ['09-expand-cockpit']))).toBe('09-expand-cockpit');
  });
});
