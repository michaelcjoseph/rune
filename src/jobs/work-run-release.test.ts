/**
 * Project 13 Phase 1c — the shared work-run RELEASE runtime (test-plan §3).
 *
 * Written TEST-FIRST: `releasePreflight` is a stub returning `not-parked` and
 * `runWorkRunRelease` yields a `failed` "not implemented" terminal, so the
 * clean-release / dirty-confirm / cold-finalize / hold cases are RED until the
 * implementation task lands; the not-parked guard cases pass. Expected failure
 * mode: a clean assertion failure — never a module-resolution / syntax error.
 *
 * Covers test-plan §3:
 *  - Clean release COLD-finalizes through the Project 15 finalizer in
 *    `gated-merge` mode (drives the gated-merge effect, not a hold no-op), and
 *    keeps the supervision `blocked-on-human` hold + the project slot until the
 *    finalizer terminal write.
 *  - Dirty release requires explicit confirmation; a confirmed dirty release is
 *    an explicit DISCARD that never invokes gated merge.
 *  - Already-released / never-parked / stale-worktree ids are clean no-ops.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  releasePreflight,
  runWorkRunRelease,
  workRunReleaseApplier,
  type ReleasePreflightDeps,
  type ReleaseRuntimeDeps,
  type WorkRunReleasePayload,
} from './work-run-release.js';
import type { SupervisedRun } from '../intent/supervision.js';
import type { MutationEvent } from '../transport/mutations.js';

const NOW_ISO = '2026-06-09T00:00:00.000Z';
const WORKTREE = '/tmp/test-worktrees/jarvis/06-webview';

/** A parked (blocked-on-human) supervised run for the release surfaces. */
function parkedRun(overrides: Partial<SupervisedRun> = {}): SupervisedRun {
  return {
    id: 'mut-parked-1',
    product: 'jarvis',
    project: '06-webview',
    status: 'blocked-on-human',
    startedAt: NOW_ISO,
    lastHeartbeatAt: NOW_ISO,
    ...overrides,
  };
}

/** A branch-complete terminal event the cold-finalizer would yield. */
function branchCompleteTerminal(id = 'mut-parked-1'): MutationEvent {
  return {
    mutationId: id,
    ts: NOW_ISO,
    kind: 'completed',
    data: { outcome: 'branch-complete', merged: true, projectSlug: '06-webview', product: 'jarvis' },
  };
}

describe('releasePreflight', () => {
  function makePreflightDeps(over: Partial<ReleasePreflightDeps> = {}): ReleasePreflightDeps {
    return {
      readParkedRun: vi.fn(() => parkedRun()),
      worktreeFor: vi.fn(() => WORKTREE),
      worktreeExists: vi.fn(() => true),
      gitStatusPorcelain: vi.fn(async () => []),
      ...over,
    };
  }

  describe('guards (green pre-impl)', () => {
    it('an unknown / never-parked run → not-parked (no mutation)', async () => {
      const deps = makePreflightDeps({ readParkedRun: vi.fn(() => null) });
      const out = await releasePreflight('mut-unknown', {}, deps);
      expect(out.kind).toBe('not-parked');
    });

    it('a parked record whose worktree is gone (stale) → not-parked clean no-op', async () => {
      // The record survived but the worktree was swept; releasing it must be a
      // clean no-op, never an error that touches an unrelated path. (Green
      // pre-impl because the stub also returns not-parked — the real impl must
      // keep this true via the worktreeExists check, not coincidentally.)
      const out = await releasePreflight(
        'mut-parked-1',
        {},
        makePreflightDeps({ worktreeExists: vi.fn(() => false) }),
      );
      expect(out.kind).toBe('not-parked');
    });
  });

  describe('RED until impl', () => {
    it('a clean parked worktree → release (confirmDirty:false), no mutation gating', async () => {
      const out = await releasePreflight('mut-parked-1', {}, makePreflightDeps());
      expect(out.kind).toBe('release');
      if (out.kind === 'release') expect(out.confirmDirty).toBe(false);
    });

    it('a dirty parked worktree with no confirmation → dirty-confirm + the file list', async () => {
      const files = ['M src/foo.ts', '?? scratch.md'];
      const out = await releasePreflight(
        'mut-parked-1',
        {},
        makePreflightDeps({ gitStatusPorcelain: vi.fn(async () => files) }),
      );
      expect(out.kind).toBe('dirty-confirm');
      if (out.kind === 'dirty-confirm') expect(out.files).toEqual(files);
    });

    it('a dirty parked worktree WITH confirmDirty:true → release (confirmDirty:true)', async () => {
      const out = await releasePreflight(
        'mut-parked-1',
        { confirmDirty: true },
        makePreflightDeps({ gitStatusPorcelain: vi.fn(async () => ['M src/foo.ts']) }),
      );
      expect(out.kind).toBe('release');
      if (out.kind === 'release') expect(out.confirmDirty).toBe(true);
    });
  });
});

describe('runWorkRunRelease (applier core)', () => {
  let deps: ReleaseRuntimeDeps;
  let coldFinalize: ReturnType<typeof vi.fn>;
  let discard: ReturnType<typeof vi.fn>;
  let clearHold: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    coldFinalize = vi.fn(async () => branchCompleteTerminal());
    discard = vi.fn(async () => {});
    clearHold = vi.fn();
    deps = {
      readParkedRun: vi.fn(() => parkedRun()),
      worktreeFor: vi.fn(() => WORKTREE),
      worktreeExists: vi.fn(() => true),
      gitStatusPorcelain: vi.fn(async () => []),
      runGit: vi.fn(async () => ({ stdout: '', stderr: '' })),
      // `as never` on the spy seams mirrors work-runner.test.ts: a bare
      // `vi.fn()` types as the generic `Mock`, which TS won't assign to the
      // specific dep-field signature (the same friction memory-writer.test.ts
      // hits). The spy handles (coldFinalize/discard/clearHold) keep their call
      // assertions; only the assignment is cast.
      coldFinalizeGatedMerge: coldFinalize as never,
      discardDirtyWorktree: discard as never,
      clearParkedHold: clearHold as never,
    };
  });

  async function drain(payload: WorkRunReleasePayload): Promise<MutationEvent[]> {
    const events: MutationEvent[] = [];
    for await (const e of runWorkRunRelease(payload, deps)) events.push(e);
    return events;
  }

  describe('RED until impl', () => {
    it('clean release COLD-finalizes through the gated-merge finalizer', async () => {
      await drain({ runId: 'mut-parked-1', confirmDirty: false });
      // The clean path must drive the gated-merge cold-finalizer (NOT a hold
      // no-op, NOT a direct destroyWorktree).
      expect(coldFinalize).toHaveBeenCalledOnce();
      expect(discard).not.toHaveBeenCalled();
    });

    it('a clean branch-complete release actually merges (yields the finalizer terminal)', async () => {
      const events = await drain({ runId: 'mut-parked-1', confirmDirty: false });
      const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal?.kind).toBe('completed');
      const data = (terminal?.data ?? {}) as Record<string, unknown>;
      expect(data['outcome']).toBe('branch-complete');
      expect(data['merged']).toBe(true);
    });

    it('keeps the parked hold until the finalizer terminal — clearParkedHold fires AFTER cold-finalize resolves', async () => {
      const order: string[] = [];
      coldFinalize.mockImplementation(async () => {
        order.push('cold-finalize');
        return branchCompleteTerminal();
      });
      clearHold.mockImplementation(() => order.push('clear-hold'));
      await drain({ runId: 'mut-parked-1', confirmDirty: false });
      expect(order).toEqual(['cold-finalize', 'clear-hold']);
    });

    it('a confirmed-dirty release DISCARDS (destroys worktree) and never gated-merges', async () => {
      deps.gitStatusPorcelain = vi.fn(async () => ['M src/foo.ts']);
      await drain({ runId: 'mut-parked-1', confirmDirty: true });
      expect(discard).toHaveBeenCalledOnce();
      expect(coldFinalize).not.toHaveBeenCalled();
    });

    it('confirmed-dirty discard clears the parked hold only AFTER destructive cleanup', async () => {
      deps.gitStatusPorcelain = vi.fn(async () => ['M src/foo.ts']);
      const order: string[] = [];
      discard.mockImplementation(async () => { order.push('discard'); });
      clearHold.mockImplementation(() => order.push('clear-hold'));
      await drain({ runId: 'mut-parked-1', confirmDirty: true });
      expect(order).toEqual(['discard', 'clear-hold']);
    });
  });

  describe('misuse guards', () => {
    it('a no-longer-parked run is a clean no-op terminal — never destroys a worktree', async () => {
      deps.readParkedRun = vi.fn(() => null);
      await drain({ runId: 'mut-gone', confirmDirty: false });
      expect(coldFinalize).not.toHaveBeenCalled();
      expect(discard).not.toHaveBeenCalled();
    });
  });
});

describe('workRunReleaseApplier — mutation-kind contract', () => {
  it('is the auto-approved `work-run-release` kind (green pre-impl — static contract)', () => {
    expect(workRunReleaseApplier.kind).toBe('work-run-release');
    expect(workRunReleaseApplier.autoApprove).toBe(true);
  });

  it('validate accepts a well-formed { runId } payload (RED until impl)', () => {
    // The applier's validate must accept a real release payload; the stub
    // rejects everything, so this is RED until the applier lands.
    const result = workRunReleaseApplier.validate({ runId: 'mut-parked-1', confirmDirty: false });
    expect(result.ok).toBe(true);
  });

  it('validate rejects a payload with no runId (green pre-impl — guard)', () => {
    const result = workRunReleaseApplier.validate({ runId: '' });
    expect(result.ok).toBe(false);
  });
});
