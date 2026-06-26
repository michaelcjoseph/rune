/**
 * Test suite for `src/intent/product-routing.ts` — project 16-claude-app-connector,
 * Phase 1, test-plan.md §2 "Product routing function".
 *
 * Written TEST-FIRST: the implementation module does not exist yet.
 *
 * Part A — resolveProductTarget (all 🔴 until implementation lands)
 * Part B — shared attribution schema (tests 8-9 🔴, test-10 🟢)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Part A: resolveProductTarget — dynamic import so an absent module is a
// clean "implementation pending" failure, not an import crash.
// ---------------------------------------------------------------------------

async function loadRoutingModule(): Promise<Record<string, unknown> | null> {
  // The module does not exist yet (implementation pending). Using a computed
  // path defeats tsc's static resolution so the file stays tsc-clean before
  // the module lands; the try/catch handles the runtime ModuleNotFoundError.
  const specifier = './product-routing' + '.js';
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Fixture: mirrors policies/products.json keys. Never reads the real file. */
function knownProducts(): string[] {
  return ['aura', 'assay', 'rune', 'relay'];
}

const IMPL_PENDING = 'src/intent/product-routing.ts not implemented yet — implementation pending';

type ResolveFn = (
  candidate: string | undefined,
  loader: () => string[],
) => { product: string; routed: boolean; reason: string };

/** Load the module and return the typed routing exports, or fail THIS test
 *  with a clean "implementation pending" message. Called per-test so each
 *  red is an isolated, descriptive assertion failure — never an import crash. */
async function requireRoutingFn(): Promise<{ resolveProductTarget: ResolveFn; INBOX_PRODUCT: string }> {
  const mod = await loadRoutingModule();
  if (!mod || typeof mod.resolveProductTarget !== 'function') {
    expect.fail(IMPL_PENDING);
  }
  return {
    resolveProductTarget: mod.resolveProductTarget as ResolveFn,
    INBOX_PRODUCT: mod.INBOX_PRODUCT as string,
  };
}

describe('resolveProductTarget — Part A (product-routing.ts)', () => {
  it('1: explicit candidate matching a known product → explicit-match routed result', async () => {
    const { resolveProductTarget } = await requireRoutingFn();

    const result = resolveProductTarget('aura', knownProducts);
    expect(result).toEqual({ product: 'aura', routed: true, reason: 'explicit-match' });
  });

  it('2: unknown explicit candidate falls back to inbox, never filed under non-existent product', async () => {
    const { resolveProductTarget, INBOX_PRODUCT } = await requireRoutingFn();

    const result = resolveProductTarget('nonexistent-product', knownProducts);
    expect(result).toEqual({ product: INBOX_PRODUCT, routed: false, reason: 'unknown-product' });
  });

  it('3a: undefined candidate → inbox with no-candidate reason', async () => {
    const { resolveProductTarget, INBOX_PRODUCT } = await requireRoutingFn();

    const result = resolveProductTarget(undefined, knownProducts);
    expect(result).toEqual({ product: INBOX_PRODUCT, routed: false, reason: 'no-candidate' });
  });

  it('3b: empty string candidate → inbox with no-candidate reason', async () => {
    const { resolveProductTarget, INBOX_PRODUCT } = await requireRoutingFn();

    const result = resolveProductTarget('', knownProducts);
    expect(result).toEqual({ product: INBOX_PRODUCT, routed: false, reason: 'no-candidate' });
  });

  it('3c: whitespace-only string candidate → inbox with no-candidate reason', async () => {
    const { resolveProductTarget, INBOX_PRODUCT } = await requireRoutingFn();

    const result = resolveProductTarget('   ', knownProducts);
    expect(result).toEqual({ product: INBOX_PRODUCT, routed: false, reason: 'no-candidate' });
  });

  it('4: partial/prefix candidate never fuzzy-matches — falls back to inbox as unknown-product', async () => {
    const { resolveProductTarget, INBOX_PRODUCT } = await requireRoutingFn();

    // 'aur' is a prefix of 'aura' but must NOT resolve to 'aura'
    const result = resolveProductTarget('aur', knownProducts);
    expect(result.product).toBe(INBOX_PRODUCT);
    expect(result.routed).toBe(false);
    expect(result.reason).toBe('unknown-product');
  });

  it('5: whitespace + case normalization — "  Aura " resolves to aura routed:true', async () => {
    const { resolveProductTarget } = await requireRoutingFn();

    const result = resolveProductTarget('  Aura ', knownProducts);
    expect(result).toEqual({ product: 'aura', routed: true, reason: 'explicit-match' });
  });

  it('5b: case-insensitive exact match works for all known products', async () => {
    const { resolveProductTarget } = await requireRoutingFn();

    expect(resolveProductTarget('RUNE', knownProducts)).toMatchObject({ product: 'rune', routed: true });
    expect(resolveProductTarget('RELAY', knownProducts)).toMatchObject({ product: 'relay', routed: true });
  });

  it('6: loader that throws → inbox with config-read-error reason, never throws', async () => {
    const { resolveProductTarget, INBOX_PRODUCT } = await requireRoutingFn();

    const throwingLoader = (): string[] => {
      throw new Error('disk read failed');
    };

    // Must not throw
    let result: ReturnType<typeof resolveProductTarget>;
    expect(() => {
      result = resolveProductTarget('aura', throwingLoader);
    }).not.toThrow();

    expect(result!).toEqual({ product: INBOX_PRODUCT, routed: false, reason: 'config-read-error' });
  });

  it('7: INBOX_PRODUCT constant equals "inbox"', async () => {
    const mod = await loadRoutingModule();
    if (!mod || typeof mod.INBOX_PRODUCT !== 'string') {
      expect.fail(IMPL_PENDING);
    }
    expect(mod.INBOX_PRODUCT).toBe('inbox');
  });

  it('7b: passing INBOX_PRODUCT as candidate is not treated as routed:true (inbox is not in the known list)', async () => {
    const { resolveProductTarget, INBOX_PRODUCT } = await requireRoutingFn();

    // 'inbox' is not in knownProducts() fixture, so it follows the unknown-product path
    const result = resolveProductTarget(INBOX_PRODUCT, knownProducts);
    expect(result.routed).toBe(false);
    expect(result.product).toBe(INBOX_PRODUCT);
    expect(result.reason).toBe('unknown-product');
  });
});

// ---------------------------------------------------------------------------
// Part B — shared attribution schema
// Tests 8-9: 🔴 (red — await implementation of product field)
// Test-10 group: 🟢 (green — regression pins against existing code)
// ---------------------------------------------------------------------------

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Static imports: these modules exist today and we assert contracts on them.
import { formatIdeasMarkdown } from './observation-triage.js';
import {
  readFiledIdeas,
  deriveIdeaId,
} from './observation-ideas-io.js';
import type { LoopOutcome, ProjectIdea } from './observation-loop.js';

// ---------------------------------------------------------------------------
// Part B temp-dir setup (mirrors observation-ideas-io.test.ts style).
// Scoped via registerTempIdeasFile() inside only the describe blocks that
// write files, so the filesystem hooks don't run for the Part A tests.
// ---------------------------------------------------------------------------

let tmpDir: string;
let ideasPath: string;

function registerTempIdeasFile(): void {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rune-product-routing-test-'));
    ideasPath = join(tmpDir, 'ideas.md');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
}

// ---------------------------------------------------------------------------
// Test 8 🔴 — formatIdeasMarkdown carries product suffix when present
// ---------------------------------------------------------------------------

describe('formatIdeasMarkdown — product attribution suffix (test 8)', () => {
  it('8: filed idea WITH product → bullet ends with " → <product>"', () => {
    // Type the fixture as ProjectIdea & { product?: string } so the file is
    // tsc-clean both before AND after the product field lands on ProjectIdea.
    const outcomes: LoopOutcome[] = [
      {
        kind: 'filed',
        idea: { title: 'T', friction: 'f', id: 'f', product: 'aura' } as ProjectIdea & { product?: string },
      },
    ];
    const result = formatIdeasMarkdown(outcomes);
    // Once the field lands, the formatter must produce this exact line.
    expect(result).toBe('- **T** — f → aura\n');
  });
});

// ---------------------------------------------------------------------------
// Test 9 🔴 — readFiledIdeas parses product suffix from bullet
// ---------------------------------------------------------------------------

describe('readFiledIdeas — product attribution suffix (test 9)', () => {
  registerTempIdeasFile();

  it('9: bullet "- **T** — f → aura" parses to idea with product:"aura", friction excludes suffix', () => {
    writeFileSync(
      ideasPath,
      [
        '## Loop-filed',
        '',
        '- **T** — f → aura',
        '',
      ].join('\n'),
    );

    const ideas = readFiledIdeas(ideasPath) as (ProjectIdea & { product?: string })[];
    expect(ideas).toHaveLength(1);
    // product field must be present once the implementation lands
    expect(ideas[0]).toMatchObject({
      title: 'T',
      friction: 'f',
      product: 'aura',
      id: deriveIdeaId('f'),
    });
    // The product suffix must NOT bleed into friction or the id
    expect(ideas[0]!.friction).toBe('f');
    expect(ideas[0]!.id).toBe(deriveIdeaId('f'));
    expect(ideas[0]!.id).not.toContain('aura');
  });
});

// ---------------------------------------------------------------------------
// Test 10 🟢 — regression pins (must pass today)
// ---------------------------------------------------------------------------

describe('formatIdeasMarkdown — legacy bullets without product (test 10, green)', () => {
  it('10a: filed idea WITHOUT product formats to legacy "- **T** — f" bullet', () => {
    const outcomes: LoopOutcome[] = [
      { kind: 'filed', idea: { title: 'T', friction: 'f', id: 'f' } },
    ];
    expect(formatIdeasMarkdown(outcomes)).toBe('- **T** — f\n');
  });

  it('10b: multiple filed outcomes without product produce the expected legacy lines in order', () => {
    const outcomes: LoopOutcome[] = [
      { kind: 'filed', idea: { title: 'Alpha', friction: 'a', id: 'a' } },
      { kind: 'filed', idea: { title: 'Beta', friction: 'b', id: 'b' } },
    ];
    const result = formatIdeasMarkdown(outcomes);
    expect(result).toBe('- **Alpha** — a\n- **Beta** — b\n');
  });
});

describe('readFiledIdeas — legacy bullets without product suffix (test 10, green)', () => {
  registerTempIdeasFile();

  it('10c: legacy bullet "- **T** — f" parses to {title, friction, id} and friction/id are unchanged', () => {
    writeFileSync(
      ideasPath,
      [
        '## Loop-filed',
        '',
        '- **Fix resolver** — resolver mis-routes /weekly',
        '',
      ].join('\n'),
    );

    const ideas = readFiledIdeas(ideasPath);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]!.title).toBe('Fix resolver');
    expect(ideas[0]!.friction).toBe('resolver mis-routes /weekly');
    expect(ideas[0]!.id).toBe(deriveIdeaId('resolver mis-routes /weekly'));
    // No product field should be present (or undefined) for a legacy bullet
    expect((ideas[0] as ProjectIdea & { product?: string }).product).toBeUndefined();
  });
});

describe('deriveIdeaId — determinism pin (test 10, green)', () => {
  it('10d: deriveIdeaId determinism — lowercase, hyphenation, 60-char truncation', () => {
    // Exact value pins the dedupe contract
    expect(deriveIdeaId('Resolver mis-routes /weekly when user asks for /daily')).toBe(
      'resolver-mis-routes-weekly-when-user-asks-for-daily',
    );
  });

  it('10e: 60-character truncation cap', () => {
    expect(deriveIdeaId('a'.repeat(100))).toBe('a'.repeat(60));
  });

  it('10f: stable — same input always produces the same id', () => {
    const friction = 'some friction that needs addressing';
    expect(deriveIdeaId(friction)).toBe(deriveIdeaId(friction));
  });
});
