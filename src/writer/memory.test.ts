/**
 * Phase 1 test suite for `src/writer/memory.ts` — the writer-role memory loader
 * and its authority boundary (project 12, test-plan §1).
 *
 * Written TEST-FIRST. The scaffold bodies throw
 * `writer/memory: <fn> not implemented (project 12 Phase 1 pending)`, so every
 * test here is RED until the Phase 1 loader implementation lands.
 *
 * Expected failure mode: a clean assertion failure or the "not implemented"
 * throw — never a module-resolution error, syntax error, or env crash.
 *
 * Real tmpdir + real fs: the loader reads SOUL/memory directly from disk
 * (NOT via readVaultFile), so these tests write fixture files into a temp dir
 * and point the loader at it via `{ dir }`.
 *
 * See: docs/projects/12-writer-memory/test-plan.md §1
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeWriterContext,
  loadWriterMemory,
  buildReferenceContext,
  WRITER_DIR,
  WRITER_MEMORY_CHAR_BUDGET,
  SOUL_FILENAME,
  MEMORY_FILENAME,
} from './memory.js';

// Repo root derived locally (src/writer/ → ../.. ), the same way memory.ts does,
// so this test needs no app env vars to assert the WRITER_DIR path contract.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Temp writer-dir per test
// ---------------------------------------------------------------------------

let dir: string;

const SOUL_BODY = 'WRITER-SOUL-MARKER — charter. See writing/voice.md for tone.';
const MEMORY_BODY = '- [2026-06-05 · source: blog-test] WRITER-MEMORY-MARKER hook lesson.';
const BASE = 'BASE-BLOG-INSTRUCTIONS — interview the author.';

function seed(soul: string | null, memory: string | null): void {
  if (soul !== null) writeFileSync(join(dir, SOUL_FILENAME), soul);
  if (memory !== null) writeFileSync(join(dir, MEMORY_FILENAME), memory);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'writer-memory-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Path contract
// ---------------------------------------------------------------------------

describe('writer/memory — path contract', () => {
  it('defaults WRITER_DIR to <repo-root>/agents/writer', () => {
    expect(WRITER_DIR).toBe(join(REPO_ROOT, 'agents', 'writer'));
  });

  it('reads SOUL and memory from the given dir via fs (not readVaultFile)', () => {
    seed(SOUL_BODY, MEMORY_BODY);
    const ctx = composeWriterContext(BASE, { dir });
    expect(ctx.systemInstructions).toContain('WRITER-SOUL-MARKER');
    expect(ctx.referenceContext).toContain('WRITER-MEMORY-MARKER');
  });
});

// ---------------------------------------------------------------------------
// Authority boundary — SOUL in system instructions, memory in reference only
// ---------------------------------------------------------------------------

describe('writer/memory — authority boundary', () => {
  it('puts SOUL + base in systemInstructions and memory ONLY in referenceContext', () => {
    seed(SOUL_BODY, MEMORY_BODY);
    const ctx = composeWriterContext(BASE, { dir });

    // SOUL + base instructions carry system-prompt authority.
    expect(ctx.systemInstructions).toContain('WRITER-SOUL-MARKER');
    expect(ctx.systemInstructions).toContain('BASE-BLOG-INSTRUCTIONS');

    // The load-bearing assertion: memory text is ABSENT from the system channel.
    expect(ctx.systemInstructions).not.toContain('WRITER-MEMORY-MARKER');

    // Memory rides the low-authority reference channel (the user turn).
    expect(ctx.referenceContext).toContain('WRITER-MEMORY-MARKER');
  });
});

// ---------------------------------------------------------------------------
// Cold start — empty / missing memory degrades cleanly
// ---------------------------------------------------------------------------

describe('writer/memory — cold start', () => {
  it('empty memory.md → valid SOUL+base prompt, empty referenceContext, no throw', () => {
    seed(SOUL_BODY, '');
    const ctx = composeWriterContext(BASE, { dir });
    expect(ctx.systemInstructions).toContain('WRITER-SOUL-MARKER');
    expect(ctx.referenceContext).toBe('');
  });

  it('missing memory.md → empty referenceContext, no throw', () => {
    seed(SOUL_BODY, null);
    const ctx = composeWriterContext(BASE, { dir });
    expect(ctx.systemInstructions).toContain('WRITER-SOUL-MARKER');
    expect(ctx.referenceContext).toBe('');
  });

  it('missing SOUL.md → systemInstructions still carries the base instructions', () => {
    seed(null, MEMORY_BODY);
    const ctx = composeWriterContext(BASE, { dir });
    expect(ctx.systemInstructions).toContain('BASE-BLOG-INSTRUCTIONS');
  });

  it('loadWriterMemory returns "" when the file is missing', () => {
    expect(loadWriterMemory({ dir })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Budget — oversized memory truncates with a visible marker
// ---------------------------------------------------------------------------

describe('writer/memory — char budget', () => {
  it('empty memory → buildReferenceContext returns "" (no empty fence)', () => {
    expect(buildReferenceContext('', WRITER_MEMORY_CHAR_BUDGET)).toBe('');
  });

  it('memory under budget passes through whole (no marker)', () => {
    const small = '- [2026-06-05 · source: blog-x] short lesson.';
    const ref = buildReferenceContext(small, WRITER_MEMORY_CHAR_BUDGET);
    expect(ref).toContain('short lesson.');
    expect(ref).not.toContain('truncated');
  });

  it('memory over budget truncates with a visible marker, bounded near budget', () => {
    const big = 'x'.repeat(WRITER_MEMORY_CHAR_BUDGET + 5000);
    const ref = buildReferenceContext(big, WRITER_MEMORY_CHAR_BUDGET);
    expect(ref.toLowerCase()).toContain('truncated');
    // Bounded to the budget plus a small allowance for the fence + marker text —
    // not lazily truncated thousands of chars over budget.
    const FENCE_OVERHEAD = 400;
    expect(ref.length).toBeLessThan(WRITER_MEMORY_CHAR_BUDGET + FENCE_OVERHEAD);
  });

  it('respects a custom charBudget override through composeWriterContext', () => {
    seed(SOUL_BODY, 'z'.repeat(500));
    const ctx = composeWriterContext(BASE, { dir, charBudget: 50 });
    expect(ctx.referenceContext.toLowerCase()).toContain('truncated');
    expect(ctx.referenceContext.length).toBeLessThan(450);
  });

  it('composeWriterContext applies the default budget to referenceContext', () => {
    seed(SOUL_BODY, 'y'.repeat(WRITER_MEMORY_CHAR_BUDGET + 5000));
    const ctx = composeWriterContext(BASE, { dir });
    expect(ctx.referenceContext.toLowerCase()).toContain('truncated');
    // The truncation never mutates the on-disk file — it's load-time only.
  });
});
