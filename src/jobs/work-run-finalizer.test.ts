/**
 * Test suite for `src/jobs/work-run-finalizer.ts` — the shared finalizer state
 * machine (project 15). test-plan.md §4 (hold mode). §6/§7 (gated-merge,
 * failure path) land with their phases.
 *
 * Written TEST-FIRST: the scaffold's `runFinalizer` throws `notImplemented(...)`,
 * so every test here is RED until the P0.4a impl task fills in `hold` mode. The
 * expected failure is the thrown notImplemented (or a clean assertion once the
 * body lands) — never a module-resolution / syntax error.
 *
 * Hold-mode contract pinned here (spec req 11, 17):
 *   classify → flush transcript → write summary/index → resolve worktree
 *   (remove, branch left intact) → terminal supervision write. NEVER merges,
 *   pushes, or deletes the branch; supervision ends terminal, never `running`.
 */

import { describe, it, expect, vi } from 'vitest';

// work-run-finalizer.ts is type-only at the scaffold stage, but the P0.4a impl
// will import config-bearing modules (mutations/classify/store). Mock config so
// the suite keeps loading cleanly once those imports land.
vi.mock('../config.js', () => ({
  default: {
    LOGS_DIR: '/tmp',
    VAULT_DIR: '/test/vault',
    WORKSPACE_DIR: '/test/workspace',
    PROJECT_ROOT: '/test/project',
    SUPERVISED_RUNS_FILE: '/tmp/supervised-runs.json',
    MUTATIONS_LOG_FILE: '/tmp/mutations.jsonl',
    WORK_RUNS_DIR: '/tmp/work-runs',
    WORK_RUNS_INDEX_FILE: '/tmp/work-runs/index.jsonl',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 42,
  },
  PROJECT_ROOT: '/test/project',
}));

import type { MutationEvent } from '../transport/mutations.js';
import {
  runFinalizer,
  type FinalizerEffects,
  type FinalizerInput,
  type FinalizerPhase,
  type GateResult,
} from './work-run-finalizer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Shared so the input's runId and the fixture events' mutationId can't drift. */
const DEFAULT_RUN_ID = 'mut-final-hold';

function holdInput(over: Partial<FinalizerInput> = {}): FinalizerInput {
  return {
    mode: 'hold',
    runId: DEFAULT_RUN_ID,
    project: '15-work-run-finalizer',
    product: 'jarvis',
    branch: 'jarvis-work/15-work-run-finalizer',
    baseBranch: 'main',
    ...over,
  };
}

/** A classified terminal event: clean branch-complete (5 commits, no tasks left). */
function branchCompleteEvent(): MutationEvent {
  return {
    mutationId: DEFAULT_RUN_ID,
    ts: '2026-06-07T00:00:00.000Z',
    kind: 'completed',
    data: {
      outcome: 'branch-complete',
      reason: '5 commit(s), all original tasks checked',
      workProduct: {
        commitCount: 5,
        commitShas: ['a1', 'b2', 'c3', 'd4', 'e5'],
        filesChanged: ['src/foo.ts'],
        diffstat: '1 file changed',
        dirty: false,
        untracked: false,
        transitions: { tasksNewlyChecked: 3, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 },
      },
      exit: { exitCode: 0, signal: null, cancelled: false, durationMs: 5000 },
    },
  };
}

/** A classified terminal event for a failed run. */
function failedEvent(): MutationEvent {
  return {
    mutationId: DEFAULT_RUN_ID,
    ts: '2026-06-07T00:00:00.000Z',
    kind: 'failed',
    data: {
      outcome: 'failed',
      reason: 'exited with code 1',
      exit: { exitCode: 1, signal: null, cancelled: false, durationMs: 3000 },
    },
  };
}

/** Effects bag: every seam a spy, the durable phase store an array. */
function makeEffects(terminalEvent: MutationEvent, over: Partial<FinalizerEffects> = {}) {
  const phases: FinalizerPhase[] = [];
  const effects: FinalizerEffects = {
    classify: vi.fn(async () => terminalEvent),
    flushTranscript: vi.fn(async () => {}),
    writeSummary: vi.fn(),
    appendIndexRow: vi.fn(),
    writeSupervisionTerminal: vi.fn(),
    removeWorktree: vi.fn(async () => {}),
    recordPhase: vi.fn((p: FinalizerPhase) => { phases.push(p); }),
    // Fresh run by default — recovery resume tests (P0.4) override this.
    readLastPhase: vi.fn((): FinalizerPhase | null => null),
    gate: vi.fn(async (): Promise<GateResult> => ({ ok: true })),
    alert: vi.fn(),
    mergeBranch: vi.fn(async () => {}),
    pushBranch: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    ...over,
  };
  return { effects, phases };
}

function gatedMergeInput(over: Partial<FinalizerInput> = {}): FinalizerInput {
  return holdInput({ mode: 'gated-merge', ...over });
}

// ---------------------------------------------------------------------------
// §4 — Finalizer hold mode
// ---------------------------------------------------------------------------

describe('runFinalizer — hold mode (P0.4a)', () => {
  it('writes summary + index + terminal supervision for a branch-complete run, and NEVER merges/pushes/deletes', async () => {
    const ev = branchCompleteEvent();
    const { effects } = makeEffects(ev);

    const result = await runFinalizer(holdInput(), effects);

    expect(effects.writeSummary).toHaveBeenCalledWith(ev);
    expect(effects.appendIndexRow).toHaveBeenCalledWith(ev);
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('completed', ev);
    // The whole point of hold mode: never touches `main`.
    expect(effects.mergeBranch).not.toHaveBeenCalled();
    expect(effects.pushBranch).not.toHaveBeenCalled();
    expect(effects.deleteBranch).not.toHaveBeenCalled();
    expect(result.outcome).toBe('branch-complete');
    expect(result.merged).toBe(false);
    expect(result.branchDeleted).toBe(false);
  });

  it('removes the worktree, records the decision, and never leaves supervision running', async () => {
    const ev = branchCompleteEvent();
    const { effects } = makeEffects(ev);

    const result = await runFinalizer(holdInput(), effects);

    expect(effects.removeWorktree).toHaveBeenCalledOnce();
    expect(result.worktreeRemoved).toBe(true);
    // Terminal supervision — never a quiet-pinging `running`.
    expect(result.supervisionStatus).toBe('completed');
  });

  it('flushes the transcript before writing summary/index (terminal-write ordering)', async () => {
    const ev = branchCompleteEvent();
    const { effects } = makeEffects(ev);

    await runFinalizer(holdInput(), effects);

    const flushOrder = vi.mocked(effects.flushTranscript).mock.invocationCallOrder[0]!;
    const summaryOrder = vi.mocked(effects.writeSummary).mock.invocationCallOrder[0]!;
    const indexOrder = vi.mocked(effects.appendIndexRow).mock.invocationCallOrder[0]!;
    expect(flushOrder).toBeLessThan(summaryOrder);
    expect(flushOrder).toBeLessThan(indexOrder);
  });

  it('records the exact ordered hold-mode phase sequence (durable resume checkpoints), with no gated-merge phases', async () => {
    const ev = branchCompleteEvent();
    const { effects, phases } = makeEffects(ev);

    const result = await runFinalizer(holdInput(), effects);

    // A phase is recorded after EACH mutating step so a crash-resume (P0.4) can
    // skip exactly the steps already committed — the gated-merge-only
    // checkpoints (`merged-not-pushed`/`pushed-not-deleted`) never appear.
    expect(phases).toEqual([
      'classified',
      'transcript-flushed',
      'summary-written',
      'index-appended',
      'worktree-resolved',
      'finalized',
    ]);
    expect(result.phases).toEqual(phases);
  });

  it('a worktree-removal failure does NOT block the terminal supervision write (never left running)', async () => {
    // req 17: a cleanup failure must never strand the run as a quiet-pinging
    // `running`. Worktree removal is best-effort inside hold mode.
    const ev = branchCompleteEvent();
    const { effects } = makeEffects(ev, {
      removeWorktree: vi.fn(async () => { throw new Error('worktree busy'); }),
    });

    const result = await runFinalizer(holdInput(), effects);

    // The run still reaches a real terminal supervision status.
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('completed', ev);
    expect(result.supervisionStatus).toBe('completed');
    // The decision is recorded truthfully: the worktree was NOT removed.
    expect(result.worktreeRemoved).toBe(false);
  });

  it('on a failed run writes failed supervision, never merges, and still resolves the worktree', async () => {
    const ev = failedEvent();
    const { effects } = makeEffects(ev);

    const result = await runFinalizer(holdInput(), effects);

    expect(result.outcome).toBe('failed');
    expect(result.supervisionStatus).toBe('failed');
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('failed', ev);
    expect(effects.mergeBranch).not.toHaveBeenCalled();
    expect(result.merged).toBe(false);
    // Failure path still reaps/tears down — never left quiet-pinging running.
    expect(effects.removeWorktree).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// §6 — Gated-merge mode state machine (P1.5). WRITE-FIRST: gated-merge throws
// notImplemented, so these are RED until the P1.5 impl. The per-gate-condition
// matrix + lock + resume are separate Phase 3 test tasks.
// ---------------------------------------------------------------------------

describe('runFinalizer — gated-merge mode (P1.5)', () => {
  it('happy path: classify branch-complete → gate green → merge → push → branch delete → terminal merged', async () => {
    const ev = branchCompleteEvent();
    const { effects } = makeEffects(ev);

    const result = await runFinalizer(gatedMergeInput(), effects);

    // Gate consulted; all merge steps fired; no operator alert.
    expect(effects.gate).toHaveBeenCalledOnce();
    expect(effects.mergeBranch).toHaveBeenCalledOnce();
    expect(effects.pushBranch).toHaveBeenCalledOnce();
    expect(effects.deleteBranch).toHaveBeenCalledOnce();
    expect(effects.removeWorktree).toHaveBeenCalledOnce();
    expect(effects.alert).not.toHaveBeenCalled();
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('completed', ev);
    // Result reflects the landed merge. `outcome` stays the work-product
    // classification (branch-complete); the merge DISPOSITION is signalled by
    // `result.merged` (no `merged` value is added to the WorkOutcome enum — that
    // would ripple across the cockpit/projection/formatters).
    expect(result.outcome).toBe('branch-complete');
    expect(result.merged).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.supervisionStatus).toBe('completed');
  });

  it('records the exact ordered gated-merge phase sequence (push-before-delete durable checkpoints)', async () => {
    const { effects, phases } = makeEffects(branchCompleteEvent());
    await runFinalizer(gatedMergeInput(), effects);
    expect(phases).toEqual([
      'classified',
      'transcript-flushed',
      'summary-written',
      'index-appended',
      'merged-not-pushed',
      'pushed-not-deleted',
      'worktree-resolved',
      'finalized',
    ]);
  });

  it('pushes BEFORE deleting the branch (origin is the durable backup)', async () => {
    const { effects } = makeEffects(branchCompleteEvent());
    await runFinalizer(gatedMergeInput(), effects);
    // Legible failure if a step never fired (vs a confusing NaN comparison).
    expect(effects.mergeBranch).toHaveBeenCalledOnce();
    expect(effects.pushBranch).toHaveBeenCalledOnce();
    expect(effects.deleteBranch).toHaveBeenCalledOnce();
    const mergeOrder = vi.mocked(effects.mergeBranch!).mock.invocationCallOrder[0]!;
    const pushOrder = vi.mocked(effects.pushBranch!).mock.invocationCallOrder[0]!;
    const deleteOrder = vi.mocked(effects.deleteBranch!).mock.invocationCallOrder[0]!;
    expect(mergeOrder).toBeLessThan(pushOrder);
    expect(pushOrder).toBeLessThan(deleteOrder);
  });

  it('gated-merge requires the gate/merge/push/delete effects — rejects if a caller omits them', async () => {
    // The optional-on-the-interface effects MUST be present in gated-merge mode;
    // the impl guards so a missing `gate` can never silently skip verification.
    const ev = branchCompleteEvent();
    const { effects } = makeEffects(ev);
    const withoutGate: FinalizerEffects = { ...effects, gate: undefined };
    await expect(runFinalizer(gatedMergeInput(), withoutGate)).rejects.toThrow(/gated-merge.*require|require.*gate/i);
  });

  it('a failed gate STOPS at branch-complete: alert, no merge/push/delete, main untouched', async () => {
    const ev = branchCompleteEvent();
    const { effects } = makeEffects(ev, {
      gate: vi.fn(async (): Promise<GateResult> => ({ ok: false, reason: 'tests-red' })),
    });

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(effects.alert).toHaveBeenCalledWith('tests-red');
    expect(effects.mergeBranch).not.toHaveBeenCalled();
    expect(effects.pushBranch).not.toHaveBeenCalled();
    expect(effects.deleteBranch).not.toHaveBeenCalled();
    expect(result.merged).toBe(false);
    expect(result.branchDeleted).toBe(false);
    // Still reaches a terminal supervision status (branch-complete held on a branch).
    expect(result.outcome).toBe('branch-complete');
    expect(effects.writeSupervisionTerminal).toHaveBeenCalledWith('completed', ev);
    // The worktree is removed (the branch ref persists for inspection/retry),
    // matching the hold-mode non-merge policy — never left orphaned.
    expect(effects.removeWorktree).toHaveBeenCalledOnce();
    expect(result.worktreeRemoved).toBe(true);
  });

  it('never merges a non-branch-complete run (partial/failed): the gate is not even consulted', async () => {
    const ev = failedEvent();
    const { effects } = makeEffects(ev);

    const result = await runFinalizer(gatedMergeInput(), effects);

    expect(effects.gate).not.toHaveBeenCalled();
    expect(effects.mergeBranch).not.toHaveBeenCalled();
    expect(result.merged).toBe(false);
    expect(result.supervisionStatus).toBe('failed');
    expect(effects.removeWorktree).toHaveBeenCalledOnce();
  });
});
