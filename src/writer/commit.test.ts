/**
 * Phase 2 test suite for `src/writer/commit.ts` — the memory-scoped commit helper
 * (project 12, test-plan §2: atomic commit stages only memory.md).
 *
 * Written TEST-FIRST. The scaffold body throws
 * `writer/commit: commitWriterMemory not implemented (...)`, so these tests are
 * RED until the Phase 2 implementation lands.
 *
 * Real temp git repo + real fs: the contract is "stage ONLY
 * agents/writer/memory.md, one commit, no unrelated files, no push", which can
 * only be proven against an actual repo.
 *
 * See: docs/projects/12-writer-memory/test-plan.md §2
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commitWriterMemory, MEMORY_REPO_PATH } from './commit.js';

let repo: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'writer-commit-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  // Seed the memory file and an initial commit so HEAD exists.
  mkdirSync(join(repo, 'agents', 'writer'), { recursive: true });
  writeFileSync(join(repo, MEMORY_REPO_PATH), '# Writer Memory\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('writer/commit — commitWriterMemory', () => {
  it('stages ONLY memory.md, commits once, and leaves unrelated dirty files untouched', async () => {
    const headBefore = git(['rev-parse', 'HEAD']);

    // Modify memory.md AND leave an unrelated dirty file in the tree.
    writeFileSync(join(repo, MEMORY_REPO_PATH), '# Writer Memory\n- [2026-06-05 · source: x] A lesson.\n');
    writeFileSync(join(repo, 'UNRELATED.txt'), 'should not be committed');

    const result = await commitWriterMemory({ cwd: repo, message: 'capture: writer memory lesson' });

    // Exactly one new commit.
    const headAfter = git(['rev-parse', 'HEAD']);
    expect(headAfter).not.toBe(headBefore);
    expect(result.committed).toBe(true);

    // The commit touched ONLY memory.md.
    const changed = git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean);
    expect(changed).toEqual([MEMORY_REPO_PATH]);

    // The unrelated file is still untracked — never swept in by `git add -A`.
    const status = git(['status', '--porcelain']);
    expect(status).toContain('UNRELATED.txt');
    expect(status).toMatch(/\?\?\s+UNRELATED\.txt/);
  });

  it('reports nothing-to-commit when memory.md is unchanged (no empty commit, no throw)', async () => {
    const headBefore = git(['rev-parse', 'HEAD']);
    const result = await commitWriterMemory({ cwd: repo, message: 'capture: no-op' });
    expect(result.committed).toBe(false);
    expect(git(['rev-parse', 'HEAD'])).toBe(headBefore);
  });
});
