/**
 * Test suite for `src/jobs/gen-eval-loop-runner.ts` — the MutationApplier
 * scaffold for the single-model Generator-Evaluator loop (Phase 6 A3).
 *
 * Written test-first (A3.1); the implementation file does not exist yet —
 * every test must fail with a missing-module / missing-export error.
 *
 * Scope: A3.1 ships only the scaffold (validate path + applier registration
 * shape). The per-round loop body (`/work --auto` then `/review` then
 * `recordRound` + `evaluateLoop`) lands in A3.2 — until then the placeholder
 * `apply()` yields a structured 'not implemented' failed event so a caller
 * that triggers the run gets a clear signal instead of silent success.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Mocks (vi.mock is auto-hoisted above const declarations, so the
//     shared objects need vi.hoisted to be initialized in time). ---

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { mockActiveRuns, mockConfig } = vi.hoisted(() => ({
  // activeRuns is shared module state in mutations.ts; the applier consults
  // it for the per-product concurrency cap. Mutated per test.
  mockActiveRuns: new Map<
    string,
    { descriptor: { kind: string; status: string; payload: Record<string, unknown> } }
  >(),
  // config.PRODUCTS_CONFIG_FILE is read by the applier; the beforeEach
  // overwrites this to point at a fresh tmpdir-backed products.json.
  mockConfig: { PRODUCTS_CONFIG_FILE: '/test/products.json' },
}));

vi.mock('../transport/mutations.js', () => ({
  activeRuns: mockActiveRuns,
}));

vi.mock('../config.js', () => ({
  default: mockConfig,
}));

// claude.js transitively imports config — and uses PROJECT_ROOT etc. that
// the mockConfig doesn't carry. The orchestration tests only exercise the
// loop through injected spawners (defaultSpawners are never reached), so we
// can mock the entire claude.js surface with stubs.
vi.mock('../ai/claude.js', () => ({
  CLAUDE_BIN: '/usr/local/bin/claude',
  registerActiveProcess: vi.fn(),
  unregisterActiveProcess: vi.fn(),
}));

// credential-injector also transitively reads config via products.json
// (which the orchestration tests don't need either — buildSandboxEnv is
// only invoked from the production spawners).
vi.mock('./credential-injector.js', () => ({
  buildSandboxEnv: vi.fn(() => ({})),
}));

// --- Imports under test (after mocks) ---

import { genEvalLoopApplier } from './gen-eval-loop-runner.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-gel-runner-test-'));
  const productsPath = join(tmpDir, 'products.json');
  writeFileSync(productsPath, JSON.stringify({
    aura: {
      repoPath: '/fake/workspace/aura',
      baseBranch: 'main',
      credentialsFile: '/fake/aura.env',
      egressAllowlist: ['github.com'],
    },
    assay: {
      repoPath: '/fake/workspace/assay',
      baseBranch: 'main',
      credentialsFile: '/fake/assay.env',
      egressAllowlist: ['github.com'],
    },
  }));
  mockConfig.PRODUCTS_CONFIG_FILE = productsPath;
  mockActiveRuns.clear();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('genEvalLoopApplier — shape', () => {
  it('declares the kind "gen-eval-loop"', () => {
    expect(genEvalLoopApplier.kind).toBe('gen-eval-loop');
  });

  it('does NOT autoApprove — gen-eval-loop runs require explicit approval', () => {
    // The autonomous engine dispatches these via the future planner approval
    // flow, not bare createMutation. Defaulting to false avoids accidentally
    // firing a long run from a misroute.
    expect(genEvalLoopApplier.autoApprove).toBe(false);
  });
});

describe('genEvalLoopApplier — validate', () => {
  function validate(
    payload: Record<string, unknown>,
  ): { ok: true } | { ok: false; reason: string } {
    // The applier reads products.json from config.PRODUCTS_CONFIG_FILE; the
    // beforeEach above repoints that mock to a per-test tmp fixture.
    return genEvalLoopApplier.validate(payload as never);
  }

  it('accepts a valid payload', () => {
    const result = validate({ product: 'aura', project: '01-growth' });
    expect(result).toEqual({ ok: true });
  });

  it('accepts a valid payload with maxEvaluatorRounds override', () => {
    const result = validate({ product: 'aura', project: '01-growth', maxEvaluatorRounds: 5 });
    expect(result).toEqual({ ok: true });
  });

  it('rejects when product is missing', () => {
    const result = validate({ project: '01-growth' });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('product') });
  });

  it('rejects when project is missing', () => {
    const result = validate({ product: 'aura' });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('project') });
  });

  it('rejects when product slug is malformed (path traversal)', () => {
    const result = validate({ product: '../etc', project: '01-growth' });
    expect(result.ok).toBe(false);
  });

  it('rejects when project slug is malformed', () => {
    const result = validate({ product: 'aura', project: 'a/b' });
    expect(result.ok).toBe(false);
  });

  it('rejects when product is not in products.json', () => {
    const result = validate({ product: 'relay', project: '01-core' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('relay');
  });

  it('rejects when maxEvaluatorRounds is zero', () => {
    const result = validate({ product: 'aura', project: '01-growth', maxEvaluatorRounds: 0 });
    expect(result.ok).toBe(false);
  });

  it('rejects when maxEvaluatorRounds is negative', () => {
    const result = validate({ product: 'aura', project: '01-growth', maxEvaluatorRounds: -1 });
    expect(result.ok).toBe(false);
  });

  it('rejects when maxEvaluatorRounds is non-integer', () => {
    const result = validate({ product: 'aura', project: '01-growth', maxEvaluatorRounds: 1.5 });
    expect(result.ok).toBe(false);
  });

  it('rejects a duplicate per-product run (one gen-eval-loop per product at a time)', () => {
    mockActiveRuns.set('m1', {
      descriptor: {
        kind: 'gen-eval-loop',
        status: 'running',
        payload: { product: 'aura', project: '01-growth' },
      },
    });
    const result = validate({ product: 'aura', project: '02-other' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('aura');
  });

  it('allows a second run on a different product even when one is in flight', () => {
    mockActiveRuns.set('m1', {
      descriptor: {
        kind: 'gen-eval-loop',
        status: 'running',
        payload: { product: 'aura', project: '01-growth' },
      },
    });
    const result = validate({ product: 'assay', project: '01-core' });
    expect(result).toEqual({ ok: true });
  });
});

describe('runGenEvalLoop — orchestration', () => {
  // The orchestration core is exported from gen-eval-loop-runner.ts. The
  // applier wraps it with production spawners + worktree lifecycle; tests
  // inject mock spawners and a mock worktree lifecycle so the loop logic
  // can be exercised deterministically.

  type LoopSpawners = {
    runWorkAuto: ReturnType<typeof vi.fn>;
    runReview: ReturnType<typeof vi.fn>;
    createWorktree: ReturnType<typeof vi.fn>;
    destroyWorktree: ReturnType<typeof vi.fn>;
  };

  function fakeSpawners(overrides: Partial<{
    workExits: number[];
    reviewVerdicts: Array<'pass' | 'fail'>;
    createThrows?: Error;
    destroyThrows?: Error;
  }> = {}): LoopSpawners {
    const workExits = overrides.workExits ?? [0];
    const verdicts = overrides.reviewVerdicts ?? ['pass'];
    let workIdx = 0;
    let verdictIdx = 0;
    return {
      createWorktree: vi.fn(async () => {
        if (overrides.createThrows) throw overrides.createThrows;
        return {
          product: 'aura',
          project: '01-growth',
          worktree: '/tmp/jarvis-worktrees/aura/01-growth',
          egressAllowlist: [],
        };
      }),
      destroyWorktree: vi.fn(async () => {
        if (overrides.destroyThrows) throw overrides.destroyThrows;
      }),
      runWorkAuto: vi.fn(async () => workExits[workIdx++ % workExits.length]!),
      runReview: vi.fn(async () => verdicts[verdictIdx++ % verdicts.length]!),
    };
  }

  // Import the loop entrypoint lazily so the file can declare the type above.
  async function runLoop(spawners: LoopSpawners, opts: { maxEvaluatorRounds?: number; cancelAfterRound?: number } = {}) {
    const { runGenEvalLoop } = await import('./gen-eval-loop-runner.js');
    const events: Array<{ kind: string; data?: unknown }> = [];
    let roundCount = 0;
    const cancel = () => opts.cancelAfterRound !== undefined && roundCount >= opts.cancelAfterRound;
    for await (const ev of runGenEvalLoop({
      mutationId: 'mut-1',
      payload: { product: 'aura', project: '01-growth', maxEvaluatorRounds: opts.maxEvaluatorRounds },
      worktreeRoot: '/tmp/jarvis-worktrees',
      productsConfigPath: mockConfig.PRODUCTS_CONFIG_FILE,
      // Orchestration tests inject maxEvaluatorRounds directly; the cap
      // read from the policy is exercised in its own describe block.
      escalationPolicyPath: '/test/no-such-policy.json',
      spawners: spawners as never,
      cancel,
      onRound: () => { roundCount++; },
    })) {
      events.push({ kind: ev.kind, data: ev.data });
    }
    return events;
  }

  it('one round, tests pass + evaluator pass → completed event', async () => {
    const spawners = fakeSpawners({ workExits: [0], reviewVerdicts: ['pass'] });
    const events = await runLoop(spawners);
    expect(events[events.length - 1]!.kind).toBe('completed');
    expect(spawners.runWorkAuto).toHaveBeenCalledOnce();
    expect(spawners.runReview).toHaveBeenCalledOnce();
    expect(spawners.destroyWorktree).toHaveBeenCalledOnce();
  });

  it('tests fail → evaluator is NOT consulted that round', async () => {
    // /work --auto exited non-zero — tests failed. The round records testsPass: false,
    // evaluator verdict 'not-run'. evaluateLoop says in-progress; next round.
    const spawners = fakeSpawners({
      workExits: [1, 0],
      reviewVerdicts: ['pass'], // only consulted in round 2
    });
    const events = await runLoop(spawners);
    expect(events[events.length - 1]!.kind).toBe('completed');
    expect(spawners.runWorkAuto).toHaveBeenCalledTimes(2);
    // Only round 2's tests passed — review was consulted only once.
    expect(spawners.runReview).toHaveBeenCalledTimes(1);
  });

  it('evaluator fails N rounds in a row → escalated → failed event', async () => {
    // cap = 3 → after 3 failed evaluator verdicts, escalate.
    const spawners = fakeSpawners({
      workExits: [0, 0, 0],
      reviewVerdicts: ['fail', 'fail', 'fail'],
    });
    const events = await runLoop(spawners, { maxEvaluatorRounds: 3 });
    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe('failed');
    const data = terminal.data as Record<string, unknown>;
    expect(String(data['reason'])).toMatch(/escalat|evaluator/i);
    expect(spawners.runReview).toHaveBeenCalledTimes(3);
  });

  it('worktree is destroyed even when the loop escalates', async () => {
    const spawners = fakeSpawners({
      workExits: [0, 0, 0],
      reviewVerdicts: ['fail', 'fail', 'fail'],
    });
    await runLoop(spawners, { maxEvaluatorRounds: 3 });
    expect(spawners.destroyWorktree).toHaveBeenCalledOnce();
  });

  it('worktree is destroyed even when the loop body throws', async () => {
    const spawners = fakeSpawners();
    spawners.runWorkAuto = vi.fn(async () => {
      throw new Error('spawn failure');
    });
    const events = await runLoop(spawners);
    expect(events[events.length - 1]!.kind).toBe('failed');
    expect(spawners.destroyWorktree).toHaveBeenCalledOnce();
  });

  it('cancel between rounds short-circuits with a failed (cancelled) event', async () => {
    // Each round passes tests but evaluator fails — so loop wants more rounds.
    // Cancel after the first round → terminate.
    const spawners = fakeSpawners({
      workExits: [0, 0, 0],
      reviewVerdicts: ['fail', 'fail', 'fail'],
    });
    const events = await runLoop(spawners, { maxEvaluatorRounds: 5, cancelAfterRound: 1 });
    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe('failed');
    const data = terminal.data as Record<string, unknown>;
    expect(String(data['reason'])).toMatch(/cancel/i);
    expect(spawners.runWorkAuto).toHaveBeenCalledOnce();
  });

  it('createWorktree failure surfaces as a failed event (no rounds attempted)', async () => {
    const spawners = fakeSpawners({ createThrows: new Error('worktree blew up') });
    const events = await runLoop(spawners);
    expect(events[events.length - 1]!.kind).toBe('failed');
    expect(spawners.runWorkAuto).not.toHaveBeenCalled();
    // destroy is not called when createWorktree failed — there is no worktree to destroy
    expect(spawners.destroyWorktree).not.toHaveBeenCalled();
  });

  it('destroyWorktree failure does not mask a successful run', async () => {
    const spawners = fakeSpawners({
      workExits: [0],
      reviewVerdicts: ['pass'],
      destroyThrows: new Error('rm failed'),
    });
    const events = await runLoop(spawners);
    // The completed event still surfaces — destroy failure is logged but not fatal.
    expect(events[events.length - 1]!.kind).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// readEvaluatorRoundCapFromPolicy (Phase 6 A3.3) — the cap source for the
// loop, defaulting to the policy file's `evaluator-round-cap` rule with a
// fallback when the file is missing or malformed.
// ---------------------------------------------------------------------------

describe('readEvaluatorRoundCapFromPolicy', () => {
  async function readCap(policyPath: string): Promise<number> {
    const { readEvaluatorRoundCapFromPolicy } = await import('./gen-eval-loop-runner.js');
    return readEvaluatorRoundCapFromPolicy(policyPath);
  }

  it('returns maxEvaluatorRounds from the evaluator-round-cap rule', async () => {
    const path = join(tmpDir, 'policy.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      rules: [
        {
          id: 'evaluator-round-cap',
          condition: 'run-exceeded-bounds',
          maxEvaluatorRounds: 7,
        },
      ],
    }));
    expect(await readCap(path)).toBe(7);
  });

  it('returns maxEvaluatorRounds from any run-exceeded-bounds rule when id differs', async () => {
    // The id is informational; the condition is what marks the rule as the cap source.
    const path = join(tmpDir, 'policy.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      rules: [
        { id: 'some-other-id', condition: 'run-exceeded-bounds', maxEvaluatorRounds: 5 },
      ],
    }));
    expect(await readCap(path)).toBe(5);
  });

  it('falls back to 3 when the policy file is missing (logged, not thrown)', async () => {
    const missing = join(tmpDir, 'no-such-policy.json');
    expect(await readCap(missing)).toBe(3);
  });

  it('falls back to 3 when the policy file is malformed JSON', async () => {
    const path = join(tmpDir, 'policy.json');
    writeFileSync(path, '{ not valid json');
    expect(await readCap(path)).toBe(3);
  });

  it('falls back to 3 when no run-exceeded-bounds rule is present', async () => {
    const path = join(tmpDir, 'policy.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      rules: [
        {
          id: 'high-risk',
          condition: 'high-risk-change-class',
          pathPatterns: ['**/auth/**'],
        },
      ],
    }));
    expect(await readCap(path)).toBe(3);
  });
});
