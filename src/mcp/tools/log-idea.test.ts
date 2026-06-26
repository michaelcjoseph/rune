/**
 * Test suite for `src/mcp/tools/log-idea.ts` — project 16-claude-app-connector,
 * Phase 1, test-plan.md §3 "log_idea tool".
 *
 * Written TEST-FIRST: the implementation module does not exist yet.
 * Every test in this file is expected to be RED until the implementation lands.
 *
 * Contract:
 *   logIdea(input: LogIdeaInput, deps: LogIdeaDeps): Promise<McpTextResult>
 *
 * Mechanics:
 *   - Dynamic import via computed specifier defeats tsc's static resolution so
 *     the file is tsc-clean before the module exists.
 *   - Every test calls requireLogIdeaFn() which fails with a clean
 *     "implementation pending" message when the module is absent — never an
 *     import crash.
 *   - deps use plain vi.fn() fakes — no real fs, no temp dirs (readFiledIdeas
 *     and appendFiledIdeas are injected).
 */

import { describe, it, expect, vi } from 'vitest';

// deriveIdeaId is live today — imported statically for use in dedupe fixtures.
import { deriveIdeaId } from '../../intent/observation-ideas-io.js';
import type { ProjectIdea } from '../../intent/observation-loop.js';

// ---------------------------------------------------------------------------
// Local structural types — mirror the future module's public surface so the
// test file is tsc-clean today while the implementation module does not exist.
// These are CASTING ONLY; they must stay in sync with the final module types.
// ---------------------------------------------------------------------------

interface LogIdeaInput {
  /** Optional per tech-spec.md (`kind?: 'idea'|'bug'`); omitted defaults to 'idea'. */
  kind?: 'idea' | 'bug';
  title: string;
  /** Field name per tech-spec.md: `{ title, friction, product?, kind? }`. */
  friction: string;
  product?: string;
}

interface LogIdeaDeps {
  ideasPath: string;
  loadKnownProducts: () => string[];
  readFiledIdeas: (ideasPath: string) => ProjectIdea[];
  appendFiledIdeas: (ideasPath: string, markdown: string) => void;
  commitAndPush: (message: string) => Promise<void>;
}

interface McpTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type LogIdeaFn = (input: LogIdeaInput, deps: LogIdeaDeps) => Promise<McpTextResult>;

// ---------------------------------------------------------------------------
// Dynamic import — computed specifier bypasses tsc static resolution.
// ---------------------------------------------------------------------------

const IMPL_PENDING =
  'src/mcp/tools/log-idea.ts not implemented yet — implementation pending';

async function loadLogIdeaModule(): Promise<Record<string, unknown> | null> {
  const specifier = './log-idea' + '.js';
  try {
    return (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Load the module and return the typed logIdea function, or fail THIS test
 *  with a clean "implementation pending" message. Called per-test so each
 *  red is an isolated, descriptive assertion failure — never an import crash. */
async function requireLogIdeaFn(): Promise<LogIdeaFn> {
  const mod = await loadLogIdeaModule();
  if (!mod || typeof mod.logIdea !== 'function') {
    expect.fail(IMPL_PENDING);
  }
  return mod.logIdea as LogIdeaFn;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** The four products that exist in policies/products.json (fixture). */
function knownProducts(): string[] {
  return ['aura', 'assay', 'rune', 'relay'];
}

/** Builds a minimal valid deps bag where no ideas are pre-filed. All fns are
 *  vi.fn() mocks — tests assert on `deps.appendFiledIdeas` etc. directly. */
function makeDeps(overrides?: Partial<LogIdeaDeps>): LogIdeaDeps {
  return {
    ideasPath: '/fake/ideas.md',
    loadKnownProducts: () => knownProducts(),
    readFiledIdeas: vi.fn().mockReturnValue([]),
    appendFiledIdeas: vi.fn(),
    commitAndPush: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §3 Tests
// ---------------------------------------------------------------------------

describe('logIdea — §3 log_idea tool (log-idea.ts)', () => {
  // -------------------------------------------------------------------------
  // Test 1 🔴 — Happy path idea
  // -------------------------------------------------------------------------
  it('1: idea kind + known product → appends correct markdown bullet, commits, returns filed bullet + target', async () => {
    const logIdea = await requireLogIdeaFn();
    const deps = makeDeps();

    const result = await logIdea(
      { kind: 'idea', title: 'T', friction: 'f', product: 'aura' },
      deps,
    );

    expect(deps.appendFiledIdeas).toHaveBeenCalledOnce();
    expect(deps.appendFiledIdeas).toHaveBeenCalledWith(deps.ideasPath, '- **T** — f → aura\n');
    expect(deps.commitAndPush).toHaveBeenCalledOnce();
    expect(result.isError).toBeFalsy();

    // Result text contains the filed bullet and resolved target
    const text = result.content[0]!.text;
    expect(text).toContain('- **T** — f → aura');
    expect(text).toContain('aura');
  });

  // -------------------------------------------------------------------------
  // Test 2 🔴 — Bug kind uses [bug] title prefix
  // -------------------------------------------------------------------------
  it('2: bug kind → bullet uses "[bug] " title prefix, same return contract', async () => {
    const logIdea = await requireLogIdeaFn();
    const deps = makeDeps();

    const result = await logIdea(
      { kind: 'bug', title: 'T', friction: 'f', product: 'aura' },
      deps,
    );

    expect(deps.appendFiledIdeas).toHaveBeenCalledOnce();
    expect(deps.appendFiledIdeas).toHaveBeenCalledWith(deps.ideasPath, '- **[bug] T** — f → aura\n');
    expect(deps.commitAndPush).toHaveBeenCalledOnce();
    expect(result.isError).toBeFalsy();

    const text = result.content[0]!.text;
    expect(text).toContain('- **[bug] T** — f → aura');
    expect(text).toContain('aura');
  });

  // -------------------------------------------------------------------------
  // Test 3 🔴 — Unknown product candidate falls back to inbox
  // -------------------------------------------------------------------------
  it('3: unknown product candidate → routes to inbox, bullet attributes "inbox", never dropped', async () => {
    const logIdea = await requireLogIdeaFn();
    const deps = makeDeps();

    const result = await logIdea(
      { kind: 'idea', title: 'T', friction: 'f', product: 'nonexistent' },
      deps,
    );

    expect(deps.appendFiledIdeas).toHaveBeenCalledOnce();
    expect(deps.appendFiledIdeas).toHaveBeenCalledWith(deps.ideasPath, '- **T** — f → inbox\n');
    expect(deps.commitAndPush).toHaveBeenCalledOnce();
    expect(result.isError).toBeFalsy();

    const text = result.content[0]!.text;
    expect(text).toContain('inbox');
  });

  // -------------------------------------------------------------------------
  // Test 4 🔴 — Omitted product routes to inbox the same way
  // -------------------------------------------------------------------------
  it('4: omitted product → routes to inbox the same as an unknown candidate', async () => {
    const logIdea = await requireLogIdeaFn();
    const deps = makeDeps();

    const result = await logIdea(
      { kind: 'idea', title: 'T', friction: 'f' },
      deps,
    );

    expect(deps.appendFiledIdeas).toHaveBeenCalledOnce();
    expect(deps.appendFiledIdeas).toHaveBeenCalledWith(deps.ideasPath, '- **T** — f → inbox\n');
    expect(deps.commitAndPush).toHaveBeenCalledOnce();
    expect(result.isError).toBeFalsy();

    const text = result.content[0]!.text;
    expect(text).toContain('inbox');
  });

  // -------------------------------------------------------------------------
  // Test 4b 🔴 — Omitted kind defaults to 'idea'
  // -------------------------------------------------------------------------
  it('4b: omitted kind → treated as idea (legacy bullet, no [bug] prefix)', async () => {
    const logIdea = await requireLogIdeaFn();
    const deps = makeDeps();

    const result = await logIdea({ title: 'T', friction: 'f', product: 'aura' }, deps);

    expect(deps.appendFiledIdeas).toHaveBeenCalledOnce();
    expect(deps.appendFiledIdeas).toHaveBeenCalledWith(deps.ideasPath, '- **T** — f → aura\n');
    expect(deps.commitAndPush).toHaveBeenCalledOnce();
    expect(result.isError).toBeFalsy();
  });

  // -------------------------------------------------------------------------
  // Test 5 🔴 — Commit/push failure surfaces as isError
  // -------------------------------------------------------------------------
  it('5: commitAndPush failure → isError true, text mentions git/commit/push, does not claim full success', async () => {
    const logIdea = await requireLogIdeaFn();
    const deps = makeDeps({
      commitAndPush: vi.fn().mockRejectedValue(new Error('push failed')),
    });

    // Tool must RESOLVE (not throw) with an error result
    const result = await logIdea(
      { kind: 'idea', title: 'T', friction: 'f', product: 'aura' },
      deps,
    );

    expect(result.isError).toBe(true);

    // appendFiledIdeas WAS called — the file write happened; the error must
    // distinguish "written but not committed" from a clean success.
    expect(deps.appendFiledIdeas).toHaveBeenCalledOnce();

    const text = result.content[0]!.text;
    expect(text).toMatch(/git|commit|push/i);
  });

  // -------------------------------------------------------------------------
  // Test 6 🟡 — Dedupe: same friction already filed → no write, no commit
  // -------------------------------------------------------------------------
  it('6: duplicate friction (id matches existing idea) → appendFiledIdeas NOT called, commitAndPush NOT called, result indicates duplicate', async () => {
    const logIdea = await requireLogIdeaFn();

    // Build an existing idea whose id matches deriveIdeaId('f')
    const existingIdea: ProjectIdea = {
      title: 'Existing',
      friction: 'f',
      id: deriveIdeaId('f'),
    };
    const deps = makeDeps({
      readFiledIdeas: vi.fn().mockReturnValue([existingIdea]),
    });

    const result = await logIdea(
      { kind: 'idea', title: 'T', friction: 'f', product: 'aura' },
      deps,
    );

    expect(deps.appendFiledIdeas).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();

    const text = result.content[0]!.text;
    expect(text).toMatch(/duplicate|already/i);
  });

  // -------------------------------------------------------------------------
  // Test 7a 🟢 — Malformed kind → isError, no partial write
  // -------------------------------------------------------------------------
  it('7a: malformed kind → isError true with kind mentioned in error, no append, no commit', async () => {
    const logIdea = await requireLogIdeaFn();
    const deps = makeDeps();

    const result = await logIdea(
      { kind: 'task' as never, title: 'T', friction: 'f', product: 'aura' },
      deps,
    );

    expect(result.isError).toBe(true);
    expect(deps.appendFiledIdeas).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();

    const text = result.content[0]!.text;
    expect(text).toMatch(/kind/i);
  });

  // -------------------------------------------------------------------------
  // Test 7b 🟢 — Empty title → isError, no partial write (resolves, never rejects)
  // -------------------------------------------------------------------------
  it('7b: empty title → isError true, no append, no commit', async () => {
    const logIdea = await requireLogIdeaFn();
    const deps = makeDeps();

    await expect(
      logIdea({ kind: 'idea', title: '', friction: 'f', product: 'aura' }, deps),
    ).resolves.toMatchObject({ isError: true });

    expect(deps.appendFiledIdeas).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 7c 🟢 — Empty friction → isError, no partial write (resolves, never rejects)
  // -------------------------------------------------------------------------
  it('7c: empty friction → isError true, no append, no commit', async () => {
    const logIdea = await requireLogIdeaFn();
    const deps = makeDeps();

    await expect(
      logIdea({ kind: 'idea', title: 'T', friction: '', product: 'aura' }, deps),
    ).resolves.toMatchObject({ isError: true });

    expect(deps.appendFiledIdeas).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });
});
