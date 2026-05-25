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

// model-policy: mocked so tests never hit the real policy file on disk.
// loadModelPolicy returns a synthetic policy; resolveModel returns controlled
// resolutions so the cross-model resolution tests can assert exact values.
vi.mock('../intent/model-policy.js', () => ({
  loadModelPolicy: vi.fn(),
  resolveModel: vi.fn(),
}));

// --- Imports under test (after mocks) ---

import { genEvalLoopApplier } from './gen-eval-loop-runner.js';

// Import mock handles for model-policy (lazy import so vi.mock hoisting runs first).
const { loadModelPolicy, resolveModel } = await import('../intent/model-policy.js');
const loadModelPolicyMock = loadModelPolicy as unknown as ReturnType<typeof vi.fn>;
const resolveModelMock = resolveModel as unknown as ReturnType<typeof vi.fn>;

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

  // Prime model-policy mocks with a sensible two-model default.
  // The generator (claude/anthropic) is returned for any non-evaluator role;
  // the evaluator (codex/openai) is returned when distinctFromProvider='anthropic'.
  loadModelPolicyMock.mockReturnValue({
    models: [
      {
        alias: 'sonnet',
        provider: 'anthropic',
        format: 'claude',
        capabilities: ['coding'],
        costTier: 'medium',
        status: 'active',
      },
      {
        alias: 'codex',
        provider: 'openai',
        format: 'codex',
        capabilities: ['coding'],
        costTier: 'medium',
        status: 'preferred',
      },
    ],
    globalFallback: 'opus',
    roleDefaults: { evaluator: 'codex' },
    evaluatorDistinctFromGenerator: false,
  });
  resolveModelMock.mockImplementation((req: { role: string; distinctFromProvider?: string }) => {
    if (req.role === 'evaluator' && req.distinctFromProvider === 'anthropic') {
      return { model: 'codex', provider: 'openai', rule: 'role-default' };
    }
    return { model: 'sonnet', provider: 'anthropic', rule: 'role-default' };
  });
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
    mergeBranch: ReturnType<typeof vi.fn>;
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
      // Default: merge succeeds so existing orchestration tests still pass once
      // the runner is wired to call mergeBranch on the merge-ready path.
      mergeBranch: vi.fn(async () => ({ ok: true as const })),
    };
  }

  // Import the loop entrypoint lazily so the file can declare the type above.
  async function runLoop(spawners: LoopSpawners, opts: {
    maxEvaluatorRounds?: number;
    cancelAfterRound?: number;
    modelPolicyPath?: string;
  } = {}) {
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
      // loadModelPolicy is mocked so the actual path doesn't matter;
      // default to a placeholder that signals "test-injected".
      modelPolicyPath: opts.modelPolicyPath ?? '/test/no-such-policy.json',
      spawners: spawners as never,
      cancel,
      onRound: () => { roundCount++; },
    })) {
      events.push({ kind: ev.kind, data: ev.data });
    }
    return events;
  }

  it('emits a structured progress event per round with {round, failedEvaluatorRounds, status}', async () => {
    // Two rounds: round 1 evaluator fails, round 2 evaluator passes.
    // Expect two progress events with the running failedEvaluatorRounds count.
    const spawners = fakeSpawners({
      workExits: [0, 0],
      reviewVerdicts: ['fail', 'pass'],
    });
    const events = await runLoop(spawners, { maxEvaluatorRounds: 3 });
    // Filter to per-round progress events — the A7.1 'resolution' event at
    // loop start is also a progress event but carries `kind: 'resolution'`
    // instead of `round: N`.
    const progress = events.filter(
      (e) => e.kind === 'progress' && typeof (e.data as Record<string, unknown>)?.['round'] === 'number',
    );
    expect(progress).toHaveLength(2);
    expect(progress[0]!.data).toMatchObject({ round: 1, failedEvaluatorRounds: 1, status: 'in-progress' });
    expect(progress[1]!.data).toMatchObject({ round: 2, failedEvaluatorRounds: 1, status: 'on-branch' });
  });

  it('a tests-failed round still emits a progress event with failedEvaluatorRounds unchanged', async () => {
    const spawners = fakeSpawners({
      workExits: [1, 0],
      reviewVerdicts: ['pass'],
    });
    const events = await runLoop(spawners);
    const progress = events.filter(
      (e) => e.kind === 'progress' && typeof (e.data as Record<string, unknown>)?.['round'] === 'number',
    );
    expect(progress).toHaveLength(2);
    // Round 1: tests failed, evaluator never ran, count stays at 0.
    expect(progress[0]!.data).toMatchObject({ round: 1, failedEvaluatorRounds: 0, status: 'in-progress' });
    // Round 2: tests passed, evaluator passed.
    expect(progress[1]!.data).toMatchObject({ round: 2, failedEvaluatorRounds: 0, status: 'on-branch' });
  });

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

// ---------------------------------------------------------------------------
// runGenEvalLoop — cross-model resolution (Phase 7 A7.1)
//
// The runner must resolve the review mode (always 'cross-model' for autonomous
// runs) plus a Generator and an Evaluator via the model-selection policy, then
// emit that resolved pair as a 'progress' event with kind='resolution' BEFORE
// the first round starts.  These tests lock in that contract; the runner
// implementation for A7.1 makes them green.
// ---------------------------------------------------------------------------

describe('runGenEvalLoop — cross-model resolution', () => {
  // Reuse the same fakeSpawners + runLoop helpers defined in the orchestration
  // describe block above.  Because those are closed over in the outer scope we
  // duplicate a minimal version here to keep the helper self-contained.

  type LoopSpawners = {
    runWorkAuto: ReturnType<typeof vi.fn>;
    runReview: ReturnType<typeof vi.fn>;
    createWorktree: ReturnType<typeof vi.fn>;
    destroyWorktree: ReturnType<typeof vi.fn>;
    mergeBranch: ReturnType<typeof vi.fn>;
  };

  function fakeSpawners(): LoopSpawners {
    return {
      createWorktree: vi.fn(async () => ({
        product: 'aura',
        project: '01-growth',
        worktree: '/tmp/jarvis-worktrees/aura/01-growth',
        egressAllowlist: [],
      })),
      destroyWorktree: vi.fn(async () => {}),
      runWorkAuto: vi.fn(async () => 0),
      runReview: vi.fn(async () => 'pass' as const),
      mergeBranch: vi.fn(async () => ({ ok: true as const })),
    };
  }

  async function runLoop(
    spawners: LoopSpawners,
    opts: { modelPolicyPath?: string } = {},
  ) {
    const { runGenEvalLoop } = await import('./gen-eval-loop-runner.js');
    const events: Array<{ kind: string; data?: unknown }> = [];
    for await (const ev of runGenEvalLoop({
      mutationId: 'mut-res-1',
      payload: { product: 'aura', project: '01-growth' },
      worktreeRoot: '/tmp/jarvis-worktrees',
      productsConfigPath: mockConfig.PRODUCTS_CONFIG_FILE,
      escalationPolicyPath: '/test/no-such-policy.json',
      modelPolicyPath: opts.modelPolicyPath ?? '/test/no-such-policy.json',
      spawners: spawners as never,
      cancel: () => false,
    })) {
      events.push({ kind: ev.kind, data: ev.data });
    }
    return events;
  }

  it('emits a resolution progress event at the start of the loop', async () => {
    // The first 'progress' event must carry kind='resolution' with the
    // resolved generator and evaluator pair.
    const events = await runLoop(fakeSpawners());
    const resolutionEvents = events.filter(
      (e) => e.kind === 'progress' && (e.data as Record<string, unknown>)?.['kind'] === 'resolution',
    );
    expect(resolutionEvents).toHaveLength(1);
    expect(resolutionEvents[0]!.data).toMatchObject({
      kind: 'resolution',
      mode: 'cross-model',
      generator: { model: 'sonnet', provider: 'anthropic' },
      evaluator: { model: 'codex', provider: 'openai' },
    });
  });

  it('calls resolveModel for the evaluator with distinctFromProvider="anthropic"', async () => {
    resolveModelMock.mockClear();
    await runLoop(fakeSpawners());
    expect(resolveModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'evaluator', distinctFromProvider: 'anthropic' }),
      expect.anything(), // policy object — exact value is the mock's concern
    );
  });

  it('autonomous mode is always cross-model (mode field is "cross-model")', async () => {
    // resolveReviewMode(autonomous:true) → 'cross-model' regardless of flags.
    // The runner must pass autonomous:true — it never uses a --cross-model flag.
    const events = await runLoop(fakeSpawners());
    const resolutionEvent = events.find(
      (e) => e.kind === 'progress' && (e.data as Record<string, unknown>)?.['kind'] === 'resolution',
    );
    expect(resolutionEvent).toBeDefined();
    expect((resolutionEvent!.data as Record<string, unknown>)['mode']).toBe('cross-model');
  });

  it('resolution event comes before the first round output event', async () => {
    // Order matters: cockpit reads the resolution event to display the resolved
    // model line BEFORE the run starts printing work-auto output.
    const events = await runLoop(fakeSpawners());
    const resolutionIdx = events.findIndex(
      (e) => e.kind === 'progress' && (e.data as Record<string, unknown>)?.['kind'] === 'resolution',
    );
    const firstRoundOutputIdx = events.findIndex(
      (e) => e.kind === 'output' && String((e.data as Record<string, unknown>)?.['line'] ?? '').includes('/work --auto'),
    );
    expect(resolutionIdx).toBeGreaterThanOrEqual(0);
    expect(firstRoundOutputIdx).toBeGreaterThanOrEqual(0);
    expect(resolutionIdx).toBeLessThan(firstRoundOutputIdx);
  });

  it('when loadModelPolicy returns null, the runner emits resolution with evaluator null and holds the merge', async () => {
    // The policy file is missing (or loadModelPolicy returns null). The
    // runner must not crash — it falls back to a default generator
    // (claude/sonnet) and emits the resolution event with `evaluator: null`.
    // Per A7.2's merge contract a null Adjudication holds the merge, so the
    // terminal event is `failed` with the contract reason (NOT `completed`).
    loadModelPolicyMock.mockReturnValue(null);

    const events = await runLoop(fakeSpawners());

    const resolutionEvent = events.find(
      (e) => e.kind === 'progress' && (e.data as Record<string, unknown>)?.['kind'] === 'resolution',
    );
    expect(resolutionEvent).toBeDefined();
    expect((resolutionEvent!.data as Record<string, unknown>)['evaluator']).toBeNull();

    // Terminal event is failed (merge contract held), not completed.
    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe('failed');
    expect(String((terminal.data as Record<string, unknown>)?.['reason'] ?? '')).toMatch(
      /merge contract|cross-model review unavailable/i,
    );
  });
});

// ---------------------------------------------------------------------------
// runGenEvalLoop — merge contract (Phase 7 A7.2)
//
// When `evaluateLoop` returns `'on-branch'`, the runner must build an
// `Adjudication` from the resolved (generator, evaluator) pair (from A7.1)
// plus the round's verdict, and feed it into `evaluateMergeContract`.
//
// - merge: true  → emit progress {kind:'merge-ready', adjudication} THEN
//                  emit completed (actual git merge is A7.3).
// - merge: false → emit failed {reason: 'merge contract held: ...', adjudication}.
//                  No completed event.
// - evaluator null → adjudication null → merge contract returns false with
//                  'cross-model review unavailable — second provider was down'.
// ---------------------------------------------------------------------------

describe('runGenEvalLoop — merge contract (A7.2)', () => {
  type LoopSpawners = {
    runWorkAuto: ReturnType<typeof vi.fn>;
    runReview: ReturnType<typeof vi.fn>;
    createWorktree: ReturnType<typeof vi.fn>;
    destroyWorktree: ReturnType<typeof vi.fn>;
    mergeBranch: ReturnType<typeof vi.fn>;
  };

  function fakeSpawners(overrides: Partial<{
    workExits: number[];
    reviewVerdicts: Array<'pass' | 'fail'>;
  }> = {}): LoopSpawners {
    const workExits = overrides.workExits ?? [0];
    const verdicts = overrides.reviewVerdicts ?? ['pass'];
    let workIdx = 0;
    let verdictIdx = 0;
    return {
      createWorktree: vi.fn(async () => ({
        product: 'aura',
        project: '01-growth',
        worktree: '/tmp/jarvis-worktrees/aura/01-growth',
        egressAllowlist: [],
      })),
      destroyWorktree: vi.fn(async () => {}),
      runWorkAuto: vi.fn(async () => workExits[workIdx++ % workExits.length]!),
      runReview: vi.fn(async () => verdicts[verdictIdx++ % verdicts.length]!),
      // Default: merge succeeds so A7.2 tests that expect `completed` are
      // unaffected once A7.3 wires the runner to call mergeBranch.
      mergeBranch: vi.fn(async () => ({ ok: true as const })),
    };
  }

  async function runLoop(
    spawners: LoopSpawners,
    opts: { maxEvaluatorRounds?: number } = {},
  ) {
    const { runGenEvalLoop } = await import('./gen-eval-loop-runner.js');
    const events: Array<{ kind: string; data?: unknown }> = [];
    for await (const ev of runGenEvalLoop({
      mutationId: 'mut-merge-1',
      payload: { product: 'aura', project: '01-growth', maxEvaluatorRounds: opts.maxEvaluatorRounds },
      worktreeRoot: '/tmp/jarvis-worktrees',
      productsConfigPath: mockConfig.PRODUCTS_CONFIG_FILE,
      escalationPolicyPath: '/test/no-such-policy.json',
      modelPolicyPath: '/test/no-such-policy.json',
      spawners: spawners as never,
      cancel: () => false,
    })) {
      events.push({ kind: ev.kind, data: ev.data });
    }
    return events;
  }

  it('on-branch + evaluator resolved → emits a merge-ready progress event before completed', async () => {
    // Single round: tests pass + evaluator pass. Expect a progress event with
    // kind='merge-ready' and a full Adjudication before the completed event.
    const events = await runLoop(fakeSpawners({ workExits: [0], reviewVerdicts: ['pass'] }));

    const mergeReadyIdx = events.findIndex(
      (e) => e.kind === 'progress' && (e.data as Record<string, unknown>)?.['kind'] === 'merge-ready',
    );
    expect(mergeReadyIdx).toBeGreaterThanOrEqual(0);

    const mergeReadyEvent = events[mergeReadyIdx]!;
    const data = mergeReadyEvent.data as Record<string, unknown>;
    expect(data['kind']).toBe('merge-ready');

    const adjudication = data['adjudication'] as Record<string, unknown>;
    expect(adjudication).toMatchObject({
      generatorProvider: 'anthropic',
      generatorModel: 'sonnet',
      evaluatorProvider: 'openai',
      evaluatorModel: 'codex',
      verdict: 'pass',
    });

    // completed must fire after merge-ready
    const completedIdx = events.findIndex((e) => e.kind === 'completed');
    expect(completedIdx).toBeGreaterThan(mergeReadyIdx);
  });

  it('on-branch + evaluator NOT resolved → emits failed with merge contract reason', async () => {
    // loadModelPolicy returns null → resolution.evaluator is null →
    // adjudication is null → evaluateMergeContract returns merge:false with
    // 'cross-model review unavailable — second provider was down'.
    loadModelPolicyMock.mockReturnValue(null);

    const events = await runLoop(fakeSpawners({ workExits: [0], reviewVerdicts: ['pass'] }));

    const terminalEvent = events[events.length - 1]!;
    expect(terminalEvent.kind).toBe('failed');

    const reason = String((terminalEvent.data as Record<string, unknown>)['reason']);
    expect(reason).toMatch(/cross-model review unavailable|second provider/i);

    // No completed event must appear
    const completedEvent = events.find((e) => e.kind === 'completed');
    expect(completedEvent).toBeUndefined();
  });

  it('escalated path is unaffected by the merge contract', async () => {
    // N=3 failed evaluator rounds → evaluateLoop returns 'escalated'.
    // The failed event must carry the existing escalation reason, NOT the
    // merge-contract reason (the escalated path never reaches evaluateMergeContract).
    const events = await runLoop(
      fakeSpawners({ workExits: [0, 0, 0], reviewVerdicts: ['fail', 'fail', 'fail'] }),
      { maxEvaluatorRounds: 3 },
    );

    const terminalEvent = events[events.length - 1]!;
    expect(terminalEvent.kind).toBe('failed');

    const reason = String((terminalEvent.data as Record<string, unknown>)['reason']);
    expect(reason).toMatch(/escalat/i);
    expect(reason).not.toMatch(/merge contract/i);
    expect(reason).not.toMatch(/cross-model review unavailable/i);

    // No merge-ready event should appear on the escalated path
    const mergeReadyEvent = events.find(
      (e) => e.kind === 'progress' && (e.data as Record<string, unknown>)?.['kind'] === 'merge-ready',
    );
    expect(mergeReadyEvent).toBeUndefined();
  });

  it('adjudication carries the round verdict "pass"', async () => {
    // Happy path: single round, tests pass + evaluator pass.
    // Assert the adjudication object's verdict field specifically.
    const events = await runLoop(fakeSpawners({ workExits: [0], reviewVerdicts: ['pass'] }));

    const mergeReadyEvent = events.find(
      (e) => e.kind === 'progress' && (e.data as Record<string, unknown>)?.['kind'] === 'merge-ready',
    );
    expect(mergeReadyEvent).toBeDefined();

    const adjudication = (mergeReadyEvent!.data as Record<string, unknown>)['adjudication'] as Record<string, unknown>;
    expect(adjudication['verdict']).toBe('pass');
  });

  it('merge-ready event includes the full Adjudication shape — no extra fields', async () => {
    // Assert that the adjudication object has exactly the 5 fields defined in
    // the Adjudication interface and nothing else.
    const events = await runLoop(fakeSpawners({ workExits: [0], reviewVerdicts: ['pass'] }));

    const mergeReadyEvent = events.find(
      (e) => e.kind === 'progress' && (e.data as Record<string, unknown>)?.['kind'] === 'merge-ready',
    );
    expect(mergeReadyEvent).toBeDefined();

    const adjudication = (mergeReadyEvent!.data as Record<string, unknown>)['adjudication'] as Record<string, unknown>;
    const keys = Object.keys(adjudication).sort();
    expect(keys).toEqual(
      ['generatorModel', 'generatorProvider', 'evaluatorModel', 'evaluatorProvider', 'verdict'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// runGenEvalLoop — merge step (A7.3)
//
// After the A7.2 merge-ready gate clears, the runner must:
//   1. Call `spawners.createWorktree` with a deterministic feature-branch arg
//      derived from the mutationId (`'jarvis-gen-eval/' + mutationId.slice(0,8)`).
//   2. On the merge-ready path, call `spawners.mergeBranch(sandbox, branch, opts)`.
//   3. `mergeBranch` ok:true  → emit `completed`.
//   4. `mergeBranch` ok:false → emit `failed` (reason carries 'merge failed: ...');
//      no `completed` event.
//   5. `mergeBranch` is NOT called on the `escalated` path.
//   6. `mergeBranch` is NOT called when the merge contract holds (null evaluator).
// ---------------------------------------------------------------------------

describe('runGenEvalLoop — merge step (A7.3)', () => {
  type LoopSpawners = {
    runWorkAuto: ReturnType<typeof vi.fn>;
    runReview: ReturnType<typeof vi.fn>;
    createWorktree: ReturnType<typeof vi.fn>;
    destroyWorktree: ReturnType<typeof vi.fn>;
    mergeBranch: ReturnType<typeof vi.fn>;
  };

  function fakeSpawners(overrides: Partial<{
    workExits: number[];
    reviewVerdicts: Array<'pass' | 'fail'>;
    mergeBranchResult?: { ok: true } | { ok: false; error: string };
  }> = {}): LoopSpawners {
    const workExits = overrides.workExits ?? [0];
    const verdicts = overrides.reviewVerdicts ?? ['pass'];
    let workIdx = 0;
    let verdictIdx = 0;
    const mergeBranchResult = overrides.mergeBranchResult ?? { ok: true as const };
    return {
      createWorktree: vi.fn(async () => ({
        product: 'aura',
        project: '01-growth',
        worktree: '/tmp/jarvis-worktrees/aura/01-growth',
        egressAllowlist: [],
      })),
      destroyWorktree: vi.fn(async () => {}),
      runWorkAuto: vi.fn(async () => workExits[workIdx++ % workExits.length]!),
      runReview: vi.fn(async () => verdicts[verdictIdx++ % verdicts.length]!),
      mergeBranch: vi.fn(async () => mergeBranchResult),
    };
  }

  async function runLoop(
    spawners: LoopSpawners,
    opts: { maxEvaluatorRounds?: number } = {},
  ) {
    const { runGenEvalLoop } = await import('./gen-eval-loop-runner.js');
    const events: Array<{ kind: string; data?: unknown }> = [];
    for await (const ev of runGenEvalLoop({
      mutationId: 'mut-1',
      payload: { product: 'aura', project: '01-growth', maxEvaluatorRounds: opts.maxEvaluatorRounds },
      worktreeRoot: '/tmp/jarvis-worktrees',
      productsConfigPath: mockConfig.PRODUCTS_CONFIG_FILE,
      escalationPolicyPath: '/test/no-such-policy.json',
      modelPolicyPath: '/test/no-such-policy.json',
      spawners: spawners as never,
      cancel: () => false,
    })) {
      events.push({ kind: ev.kind, data: ev.data });
    }
    return events;
  }

  it('createWorktree is called with a deterministic feature branch arg', async () => {
    // The runner must call createWorktree with a `branch` field derived from
    // the mutationId: 'jarvis-gen-eval/' + mutationId.slice(0, 8).
    // mutationId is 'mut-1' here, so the branch is 'jarvis-gen-eval/mut-1'.
    const spawners = fakeSpawners({ workExits: [0], reviewVerdicts: ['pass'] });
    await runLoop(spawners);

    expect(spawners.createWorktree).toHaveBeenCalledOnce();
    const firstCall = spawners.createWorktree.mock.calls[0]![0] as Record<string, unknown>;
    expect(firstCall).toMatchObject({
      branch: expect.stringMatching(/^jarvis-gen-eval\//),
    });
    // The suffix is derived from mutationId 'mut-1'.slice(0, 8) = 'mut-1'.
    expect(firstCall['branch']).toBe('jarvis-gen-eval/mut-1');
  });

  it('merge-ready + mergeBranch success → emits completed', async () => {
    // Happy path: tests pass, evaluator passes, merge contract clears, and
    // mergeBranch resolves ok:true — the run is now actually merged.
    const spawners = fakeSpawners({
      workExits: [0],
      reviewVerdicts: ['pass'],
      mergeBranchResult: { ok: true },
    });
    const events = await runLoop(spawners);

    // merge-ready progress event must fire
    const mergeReadyEvent = events.find(
      (e) => e.kind === 'progress' && (e.data as Record<string, unknown>)?.['kind'] === 'merge-ready',
    );
    expect(mergeReadyEvent).toBeDefined();

    // mergeBranch must have been called with the sandbox + branch
    expect(spawners.mergeBranch).toHaveBeenCalledOnce();
    const [callSandbox, callBranch] = spawners.mergeBranch.mock.calls[0] as [unknown, string, unknown];
    expect(callSandbox).toBeDefined();
    expect(typeof callBranch).toBe('string');
    expect(callBranch).toMatch(/^jarvis-gen-eval\//);

    // completed event must fire — the run is merged
    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe('completed');
  });

  it('merge-ready + mergeBranch failure → emits failed with merge error', async () => {
    // mergeBranch fails — the terminal event must be `failed` (not `completed`),
    // and the reason must mention the merge failure.
    const spawners = fakeSpawners({
      workExits: [0],
      reviewVerdicts: ['pass'],
      mergeBranchResult: { ok: false, error: 'fatal: refusing to merge unrelated histories' },
    });
    const events = await runLoop(spawners);

    // merge-ready progress event must still fire (it precedes the mergeBranch call)
    const mergeReadyEvent = events.find(
      (e) => e.kind === 'progress' && (e.data as Record<string, unknown>)?.['kind'] === 'merge-ready',
    );
    expect(mergeReadyEvent).toBeDefined();

    // mergeBranch must have been called
    expect(spawners.mergeBranch).toHaveBeenCalledOnce();

    // Terminal event is `failed` — no `completed` event
    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe('failed');

    const data = terminal.data as Record<string, unknown>;
    expect(String(data['reason'])).toMatch(/merge failed.*refusing to merge/i);
    // adjudication must be present on the failed event
    expect(data['adjudication']).toBeDefined();

    const completedEvent = events.find((e) => e.kind === 'completed');
    expect(completedEvent).toBeUndefined();
  });

  it('mergeBranch is NOT called when merge contract holds (evaluator null)', async () => {
    // loadModelPolicy returns null → evaluator is null → adjudication is null →
    // evaluateMergeContract returns merge:false (cross-model review unavailable).
    // The merge contract gate is not cleared, so mergeBranch must never be called.
    loadModelPolicyMock.mockReturnValue(null);

    const spawners = fakeSpawners({ workExits: [0], reviewVerdicts: ['pass'] });
    const events = await runLoop(spawners);

    expect(spawners.mergeBranch).not.toHaveBeenCalled();

    // Terminal is failed with the merge-contract reason
    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe('failed');
    expect(String((terminal.data as Record<string, unknown>)['reason'])).toMatch(
      /merge contract|cross-model review unavailable/i,
    );
  });

  it('mergeBranch is NOT called when escalated', async () => {
    // N=3 failed evaluator rounds → evaluateLoop returns 'escalated'.
    // The escalated path exits before reaching the merge-ready gate,
    // so mergeBranch must never be invoked.
    const spawners = fakeSpawners({
      workExits: [0, 0, 0],
      reviewVerdicts: ['fail', 'fail', 'fail'],
    });
    const events = await runLoop(spawners, { maxEvaluatorRounds: 3 });

    expect(spawners.mergeBranch).not.toHaveBeenCalled();

    // Terminal is failed with escalation reason
    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe('failed');
    expect(String((terminal.data as Record<string, unknown>)['reason'])).toMatch(/escalat/i);
  });

  it('mergeBranch throwing synchronously is caught and surfaces as a failed event', async () => {
    // A real-world case: getProductConfig throws when products.json was
    // edited between mutation creation and the merge step, or git binary
    // is missing. The throw must not escape the generator.
    const spawners = {
      ...fakeSpawners({ workExits: [0], reviewVerdicts: ['pass'] }),
      mergeBranch: vi.fn(async () => {
        throw new Error('product config missing');
      }),
    };
    const events = await runLoop(spawners as never);

    expect(spawners.mergeBranch).toHaveBeenCalledOnce();
    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe('failed');
    expect(String((terminal.data as Record<string, unknown>)['reason'])).toMatch(
      /mergeBranch threw.*product config missing/i,
    );
  });
});
