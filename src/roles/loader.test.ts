/**
 * Phase 1 test suite for `src/roles/loader.ts` — the product-team role loader
 * and its authority boundary (project 14, test-plan §1).
 *
 * Written TEST-FIRST. Until the Phase 1 loader implementation lands, the module
 * does not exist and every test here is RED (module-resolution failure flips to
 * clean assertion failures once the scaffold exists).
 *
 * This generalizes the Project 12 writer loader (`src/writer/memory.ts`) to the
 * six product-team roles. Each role lives at `PROJECT_ROOT/agents/<role>/` with:
 *   - `SOUL.md`   — charter, system-prompt authority.
 *   - `memory.md` — accumulating lessons, LOW authority (reference fence only).
 *
 * Real tmpdir + real fs for the loader-behavior tests; real on-disk reads for
 * the charter test (it asserts the actual `agents/<role>/` files exist).
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §1
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeRoleContext,
  loadRoleMemory,
  buildRoleReferenceContext,
  roleDir,
  ROLE_NAMES,
  ROLES_ROOT,
  ROLE_MEMORY_CHAR_BUDGET,
  SOUL_FILENAME,
  MEMORY_FILENAME,
  type RoleName,
} from './loader.js';

// Repo root derived locally (src/roles/ → ../.. ), the same way loader.ts does,
// so this test needs no app env vars to assert the ROLES_ROOT path contract.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Temp role-dir per test (for the loader-behavior cases)
// ---------------------------------------------------------------------------

let dir: string;

const SOUL_BODY = 'ROLE-SOUL-MARKER — charter. Review edges below.';
const MEMORY_BODY = '- [2026-06-08 · source: run-test] ROLE-MEMORY-MARKER one lesson.';
const BASE = 'BASE-ROLE-INSTRUCTIONS — execute the selected task.';

function seed(soul: string | null, memory: string | null): void {
  if (soul !== null) writeFileSync(join(dir, SOUL_FILENAME), soul);
  if (memory !== null) writeFileSync(join(dir, MEMORY_FILENAME), memory);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'role-loader-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Path contract — reads from PROJECT_ROOT/agents/<role>/, not the vault
// ---------------------------------------------------------------------------

describe('roles/loader — path contract', () => {
  it('roots ROLES_ROOT at <repo-root>/agents', () => {
    expect(ROLES_ROOT).toBe(join(REPO_ROOT, 'agents'));
  });

  it('roleDir(role) resolves to <repo-root>/agents/<role>', () => {
    expect(roleDir('pm')).toBe(join(REPO_ROOT, 'agents', 'pm'));
    expect(roleDir('tech-lead')).toBe(join(REPO_ROOT, 'agents', 'tech-lead'));
  });

  it('reads SOUL and memory from the given dir via fs (not readVaultFile)', () => {
    seed(SOUL_BODY, MEMORY_BODY);
    const ctx = composeRoleContext('coder', BASE, { dir });
    expect(ctx.systemInstructions).toContain('ROLE-SOUL-MARKER');
    expect(ctx.referenceContext).toContain('ROLE-MEMORY-MARKER');
  });
});

// ---------------------------------------------------------------------------
// Authority boundary — SOUL in system instructions, memory in reference only
// ---------------------------------------------------------------------------

describe('roles/loader — authority boundary', () => {
  it('puts SOUL + base in systemInstructions and memory ONLY in referenceContext', () => {
    seed(SOUL_BODY, MEMORY_BODY);
    const ctx = composeRoleContext('reviewer', BASE, { dir });

    // SOUL + base instructions carry system-prompt authority.
    expect(ctx.systemInstructions).toContain('ROLE-SOUL-MARKER');
    expect(ctx.systemInstructions).toContain('BASE-ROLE-INSTRUCTIONS');

    // The load-bearing assertion: memory text is ABSENT from the system channel.
    expect(ctx.systemInstructions).not.toContain('ROLE-MEMORY-MARKER');

    // Memory rides the low-authority reference channel (the user turn).
    expect(ctx.referenceContext).toContain('ROLE-MEMORY-MARKER');
  });

  it('names the role in the reference fence so the model knows whose memory it is', () => {
    seed(SOUL_BODY, MEMORY_BODY);
    const ctx = composeRoleContext('pm', BASE, { dir });
    expect(ctx.referenceContext).toContain('pm');
  });
});

// ---------------------------------------------------------------------------
// Cold start — empty / missing memory degrades cleanly (SOUL-only)
// ---------------------------------------------------------------------------

describe('roles/loader — cold start', () => {
  it('empty memory.md → valid SOUL+base prompt, empty referenceContext, no throw', () => {
    seed(SOUL_BODY, '');
    const ctx = composeRoleContext('qa', BASE, { dir });
    expect(ctx.systemInstructions).toContain('ROLE-SOUL-MARKER');
    expect(ctx.referenceContext).toBe('');
  });

  it('missing memory.md → empty referenceContext, no throw', () => {
    seed(SOUL_BODY, null);
    const ctx = composeRoleContext('qa', BASE, { dir });
    expect(ctx.systemInstructions).toContain('ROLE-SOUL-MARKER');
    expect(ctx.referenceContext).toBe('');
  });

  it('missing SOUL.md → systemInstructions still carries the base instructions', () => {
    seed(null, MEMORY_BODY);
    const ctx = composeRoleContext('designer', BASE, { dir });
    expect(ctx.systemInstructions).toContain('BASE-ROLE-INSTRUCTIONS');
  });

  it('loadRoleMemory returns "" when the file is missing', () => {
    expect(loadRoleMemory({ dir })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// SOUL wins — memory contradicting SOUL stays low-authority
// ---------------------------------------------------------------------------

describe('roles/loader — SOUL governs', () => {
  it('keeps memory in the reference channel even when it would contradict SOUL', () => {
    seed('SOUL: always write tests first.', '- memory: skip tests when rushed.');
    const ctx = composeRoleContext('tech-lead', BASE, { dir });
    // SOUL rule is in the authoritative channel; the contradicting memory line
    // is confined to reference — never promoted to system authority.
    expect(ctx.systemInstructions).toContain('always write tests first');
    expect(ctx.systemInstructions).not.toContain('skip tests when rushed');
    expect(ctx.referenceContext).toContain('skip tests when rushed');
  });
});

// ---------------------------------------------------------------------------
// Budget — oversized memory truncates with a visible marker, disk intact
// ---------------------------------------------------------------------------

describe('roles/loader — char budget', () => {
  it('empty memory → buildRoleReferenceContext returns "" (no empty fence)', () => {
    expect(buildRoleReferenceContext('coder', '', ROLE_MEMORY_CHAR_BUDGET)).toBe('');
  });

  it('memory under budget passes through whole (no marker)', () => {
    const small = '- [2026-06-08 · source: run-x] short lesson.';
    const ref = buildRoleReferenceContext('coder', small, ROLE_MEMORY_CHAR_BUDGET);
    expect(ref).toContain('short lesson.');
    expect(ref).not.toContain('truncated');
  });

  it('memory over budget truncates with a visible marker, bounded near budget', () => {
    const big = 'x'.repeat(ROLE_MEMORY_CHAR_BUDGET + 5000);
    const ref = buildRoleReferenceContext('coder', big, ROLE_MEMORY_CHAR_BUDGET);
    expect(ref.toLowerCase()).toContain('truncated');
    const FENCE_OVERHEAD = 400;
    expect(ref.length).toBeLessThan(ROLE_MEMORY_CHAR_BUDGET + FENCE_OVERHEAD);
  });

  it('respects a custom charBudget override through composeRoleContext', () => {
    seed(SOUL_BODY, 'z'.repeat(500));
    const ctx = composeRoleContext('coder', BASE, { dir, charBudget: 50 });
    expect(ctx.referenceContext.toLowerCase()).toContain('truncated');
    expect(ctx.referenceContext.length).toBeLessThan(450);
  });

  it('truncation never mutates the on-disk memory file', () => {
    const big = 'y'.repeat(ROLE_MEMORY_CHAR_BUDGET + 5000);
    seed(SOUL_BODY, big);
    composeRoleContext('coder', BASE, { dir, charBudget: 100 });
    // The disk file is untouched by the load-time truncation.
    expect(readFileSync(join(dir, MEMORY_FILENAME), 'utf8')).toBe(big);
  });
});

// ---------------------------------------------------------------------------
// Charter inventory — all six roles have a charter + memory file on disk
// ---------------------------------------------------------------------------

describe('roles/loader — charter inventory (real disk)', () => {
  it('enumerates exactly the six product-team roles', () => {
    expect([...ROLE_NAMES].sort()).toEqual(
      ['coder', 'designer', 'pm', 'qa', 'reviewer', 'tech-lead'].sort(),
    );
  });

  it.each([...ROLE_NAMES])('role "%s" has a non-empty SOUL.md on disk', (role: RoleName) => {
    const soulPath = join(roleDir(role), SOUL_FILENAME);
    expect(existsSync(soulPath)).toBe(true);
    expect(readFileSync(soulPath, 'utf8').trim().length).toBeGreaterThan(0);
  });

  it.each([...ROLE_NAMES])('role "%s" has a memory.md on disk', (role: RoleName) => {
    expect(existsSync(join(roleDir(role), MEMORY_FILENAME))).toBe(true);
  });

  it.each([...ROLE_NAMES])(
    'role "%s" SOUL states a mandate and review edges',
    (role: RoleName) => {
      const soul = readFileSync(join(roleDir(role), SOUL_FILENAME), 'utf8').toLowerCase();
      // Low-priority test-plan §1 requirement: each charter states what the role
      // owns (mandate) and who reviews it / what it reviews (review edges).
      expect(soul).toContain('mandate');
      expect(soul).toContain('review');
    },
  );
});
