/**
 * Phase 6 test suite for `src/roles/memory-writer.ts` — provenance-stamped
 * lesson writer for the product-team role learning loop (project 14,
 * test-plan §6.4, §6.7).
 *
 * TEST-FIRST / RED-BY-DESIGN. The module under test (`./memory-writer.ts`)
 * does NOT exist yet. Every test in this file is expected to fail RED on
 * module-not-found until the Phase 6 implementation lands.
 *
 * Expected failure mode: import resolution error on `./memory-writer.js`.
 * The compounding test (§6.7) also imports the EXISTING `../roles/loader.js`
 * and writes to a real tmp dir, but the file still fails overall because
 * `memory-writer.js` is missing.
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §6
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeRoleLesson } from './memory-writer.js';
import { composeRoleContext } from './loader.js';
import { PROVENANCE_RE } from '../writer/seed.js';
import type { CommitRoleMemoryResult } from './commit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AppendLineMock = ReturnType<typeof vi.fn<(line: string) => void>>;
type CommitMock = ReturnType<typeof vi.fn<(message: string) => Promise<CommitRoleMemoryResult>>>;

function makeInjectedDeps(existingMemory = ''): {
  readMemory: () => string;
  appendLine: AppendLineMock;
  commit: CommitMock;
} {
  return {
    readMemory: () => existingMemory,
    appendLine: vi.fn<(line: string) => void>(),
    commit: vi.fn<(message: string) => Promise<CommitRoleMemoryResult>>().mockResolvedValue({ committed: true, sha: 'abc1234' }),
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('memory-writer — writeRoleLesson (happy path)', () => {
  it('stamps a clean abstract lesson with provenance and commits once', async () => {
    const { readMemory, appendLine, commit } = makeInjectedDeps();

    const result = await writeRoleLesson({
      role: 'coder',
      lesson: 'Always verify index bounds before slicing an array.',
      sourceSlug: 'project-14-2026-06-08',
      date: '2026-06-08',
      privateNames: [],
      readMemory,
      appendLine,
      commit,
    });

    expect(result.skipReason).toBeUndefined();
    expect(result.committed).toBe(true);
    expect(result.captured).toBeDefined();
    expect(result.captured).toMatch(PROVENANCE_RE);

    // appendLine called exactly once (atomic write)
    expect(appendLine).toHaveBeenCalledTimes(1);
    // commit called exactly once — one commit per lesson write, never batched silently
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('the stamped line contains the source slug as the provenance token', async () => {
    const { readMemory, appendLine, commit } = makeInjectedDeps();

    const result = await writeRoleLesson({
      role: 'reviewer',
      lesson: 'Check that tests cover the unhappy path before passing.',
      sourceSlug: 'run-42-review',
      date: '2026-06-08',
      privateNames: [],
      readMemory,
      appendLine,
      commit,
    });

    expect(result.captured).toBeDefined();
    // The provenance stamp must contain the slug
    expect(result.captured).toContain('run-42-review');
    expect(result.captured).toMatch(PROVENANCE_RE);
  });
});

// ---------------------------------------------------------------------------
// Privacy filter
// ---------------------------------------------------------------------------

describe('memory-writer — writeRoleLesson (privacy filter)', () => {
  it('skips a lesson naming a configured private name', async () => {
    const { readMemory, appendLine, commit } = makeInjectedDeps();

    const result = await writeRoleLesson({
      role: 'qa',
      lesson: 'Alice noticed the missing edge case in the integration test.',
      sourceSlug: 'project-14-run-1',
      date: '2026-06-08',
      privateNames: ['Alice'],
      readMemory,
      appendLine,
      commit,
    });

    expect(result.skipReason).toBe('filtered');
    expect(result.captured).toBeUndefined();
    expect(appendLine).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('skips a lesson containing a markdown link', async () => {
    const { readMemory, appendLine, commit } = makeInjectedDeps();

    const result = await writeRoleLesson({
      role: 'coder',
      lesson: 'Pattern from [this PR](https://github.com/example/repo/pull/42) applies here.',
      sourceSlug: 'project-14-run-1',
      date: '2026-06-08',
      privateNames: [],
      readMemory,
      appendLine,
      commit,
    });

    expect(result.skipReason).toBe('filtered');
    expect(appendLine).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('skips a lesson containing a wikilink', async () => {
    const { readMemory, appendLine, commit } = makeInjectedDeps();

    const result = await writeRoleLesson({
      role: 'tech-lead',
      lesson: 'See [[project-notes/private-design]] for the full context.',
      sourceSlug: 'project-14-run-1',
      date: '2026-06-08',
      privateNames: [],
      readMemory,
      appendLine,
      commit,
    });

    expect(result.skipReason).toBe('filtered');
    expect(appendLine).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('skips a lesson containing a bare URL', async () => {
    const { readMemory, appendLine, commit } = makeInjectedDeps();

    const result = await writeRoleLesson({
      role: 'pm',
      lesson: 'Borrow this structure from https://example.com/private-spec.md.',
      sourceSlug: 'project-14-run-1',
      date: '2026-06-08',
      privateNames: [],
      readMemory,
      appendLine,
      commit,
    });

    expect(result.skipReason).toBe('filtered');
    expect(appendLine).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Empty lesson
// ---------------------------------------------------------------------------

describe('memory-writer — writeRoleLesson (empty lesson)', () => {
  it('skips a whitespace-only lesson', async () => {
    const { readMemory, appendLine, commit } = makeInjectedDeps();

    const result = await writeRoleLesson({
      role: 'designer',
      lesson: '   \n  ',
      sourceSlug: 'project-14-run-1',
      date: '2026-06-08',
      privateNames: [],
      readMemory,
      appendLine,
      commit,
    });

    expect(result.skipReason).toBe('empty');
    expect(appendLine).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('memory-writer — writeRoleLesson (dedup)', () => {
  it('skips a lesson whose body already exists in memory (provenance-stamped)', async () => {
    const existingLesson = 'Always verify index bounds before slicing an array.';
    const existingLine = `- [2026-01-01 · source: old-run-1] ${existingLesson}`;

    const { appendLine, commit } = makeInjectedDeps(existingLine);

    const result = await writeRoleLesson({
      role: 'coder',
      lesson: existingLesson,
      sourceSlug: 'project-14-run-2',
      date: '2026-06-08',
      privateNames: [],
      readMemory: () => existingLine,
      appendLine,
      commit,
    });

    expect(result.skipReason).toBe('duplicate');
    expect(appendLine).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-role serialization — concurrent same-role writes don't interleave
// ---------------------------------------------------------------------------

describe('memory-writer — writeRoleLesson (concurrency)', () => {
  it('serializes concurrent same-role writes so the second dedups against the first', async () => {
    // Shared in-memory memory.md — readMemory must observe appendLine's writes.
    let buf = '';
    const readMemory = () => buf;
    const appendLine = (line: string) => {
      buf += line + '\n';
    };
    const commit = vi.fn<(message: string) => Promise<CommitRoleMemoryResult>>().mockResolvedValue({ committed: true, sha: 'abc1234' });

    const lesson = 'Serialize the read-modify-commit so it never races.';
    const fire = () =>
      writeRoleLesson({
        role: 'coder',
        lesson,
        sourceSlug: 'project-14-concurrency',
        date: '2026-06-08',
        privateNames: [],
        readMemory,
        appendLine,
        commit,
      });

    const [r1, r2] = await Promise.all([fire(), fire()]);

    // Serialized: exactly one write lands; the second reads the updated buffer and
    // dedups. Un-serialized, both would read an empty buffer and both append.
    const writes = [r1, r2].filter((r) => r.captured).length;
    const dupes = [r1, r2].filter((r) => r.skipReason === 'duplicate').length;
    expect(writes).toBe(1);
    expect(dupes).toBe(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Provenance slug fallback
// ---------------------------------------------------------------------------

describe('memory-writer — writeRoleLesson (slug fallback)', () => {
  it('invalid sourceSlug still produces a valid PROVENANCE_RE-matching stamp via fallback', async () => {
    const { readMemory, appendLine, commit } = makeInjectedDeps();

    const result = await writeRoleLesson({
      role: 'coder',
      lesson: 'Always run tests in isolation before submitting for review.',
      sourceSlug: 'Not A Valid Slug!',   // invalid slug shape — must derive a fallback
      fallbackTopic: 'test isolation',
      date: '2026-06-08',
      privateNames: [],
      readMemory,
      appendLine,
      commit,
    });

    expect(result.skipReason).toBeUndefined();
    expect(result.captured).toMatch(PROVENANCE_RE);
    // The slug used in the stamp must NOT contain spaces or uppercase
    const slugMatch = result.captured?.match(/source: ([^\]]+)/);
    expect(slugMatch).not.toBeNull();
    const slug = slugMatch?.[1] ?? '';
    expect(slug).not.toContain(' ');
    expect(slug).toBe(slug.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// Compounding test (§6.7)
// Write a lesson into a temp role dir, then assert it loads into the next
// run's reference context via composeRoleContext.
// ---------------------------------------------------------------------------

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    tmpDir = null;
  }
});

describe('memory-writer — compounding (§6.7): written lesson loads into next context', () => {
  it('a lesson written via writeRoleLesson appears in referenceContext but not systemInstructions', async () => {
    // Create a real tmp dir that acts as the role dir
    tmpDir = mkdtempSync(join(tmpdir(), 'rune-test-role-'));

    // Write a minimal SOUL.md so composeRoleContext has a charter
    writeFileSync(join(tmpDir, 'SOUL.md'), '# Coder SOUL\nWrite correct, tested code.');

    // Collect appended lines in an in-memory accumulator and write to tmp memory.md
    const memoryPath = join(tmpDir, 'memory.md');
    writeFileSync(memoryPath, ''); // start empty

    const { appendLine, commit } = makeInjectedDeps();

    // Wire appendLine to actually write bytes into the tmp memory.md
    const lines: string[] = [];
    appendLine.mockImplementation((line: string) => {
      lines.push(line);
      // Append to the file so composeRoleContext can read it
      appendFileSync(memoryPath, line + '\n', 'utf8');
    });

    const lesson = 'Ensure all edge cases are covered in the test matrix.';

    const result = await writeRoleLesson({
      role: 'coder',
      lesson,
      sourceSlug: 'project-14-compounding',
      date: '2026-06-08',
      privateNames: [],
      readMemory: () => '',   // empty at write time
      appendLine,
      commit,
    });

    // Lesson captured
    expect(result.skipReason).toBeUndefined();
    expect(result.captured).toMatch(PROVENANCE_RE);

    // Now simulate loading the next run's context with the same role dir
    const roleContext = composeRoleContext('coder', 'Implement the feature.', { dir: tmpDir });

    // The lesson body must appear in referenceContext (low-authority reference channel)
    expect(roleContext.referenceContext).toContain(lesson);

    // The lesson must NOT appear in systemInstructions (the system-prompt authority channel)
    expect(roleContext.systemInstructions).not.toContain(lesson);
  });
});
