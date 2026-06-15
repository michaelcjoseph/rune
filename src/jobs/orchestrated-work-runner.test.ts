import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockAppendMutationLine = vi.hoisted(() => vi.fn());
const mockUpsertRun = vi.hoisted(() => vi.fn());

vi.mock('./mutations-log.js', () => ({
  appendMutationLine: mockAppendMutationLine,
}));

vi.mock('./supervision-store.js', () => ({
  upsertRun: mockUpsertRun,
}));

import {
  orchestratedWorkApplier,
  __setOrchestratedRuntimeForTest,
  __resetOrchestratedRuntimeForTest,
} from './orchestrated-work-runner.js';
import {
  activeRuns,
  createMutation,
  registerApplier,
  type MutationDescriptor,
  type MutationEvent,
} from '../transport/mutations.js';
import type { OrchestrationResult } from '../intent/project-orchestrator.js';
import type { SandboxSpec } from '../intent/sandbox.js';
import { planQuietCancel, planQuietNudges, type SupervisedRun } from '../intent/supervision.js';

// ---------------------------------------------------------------------------
// Phase 5 orchestrated applier (project 14): the mutation applier that runs
// the multi-task orchestration loop in a sandboxed worktree and maps its
// terminal OrchestrationResult onto a single MutationEvent. Effects are
// injected so the apply→event mapping + worktree lifecycle are exercised
// without git, fs, or a live model call.
// ---------------------------------------------------------------------------

/** Build a temp worktree containing docs/projects/demo/{spec,tasks,context}.md
 *  so the applier's real `findProjectDir` + `buildOrchestrationDeps` resolve
 *  against a genuine tree (the orchestration loop itself is injected). */
function makeWorktree(project = 'demo'): { sandbox: SandboxSpec; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orch-wt-'));
  const projDir = join(dir, 'docs', 'projects', project);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, 'spec.md'), '# Spec\n', 'utf8');
  writeFileSync(join(projDir, 'tasks.md'), '- [ ] task one\n', 'utf8');
  writeFileSync(join(projDir, 'context.md'), '# Project Context\n', 'utf8');
  return {
    sandbox: {
      product: 'jarvis',
      project,
      worktree: dir,
      egressAllowlist: [],
      baseSha: 'abc123',
      resumed: false,
    },
    dir,
  };
}

function makeDescriptor(
  payload: { projectSlug: string; product?: string } = { projectSlug: 'demo', product: 'jarvis' },
): MutationDescriptor<{ projectSlug: string; product?: string }> {
  return {
    id: 'mut-1',
    kind: 'orchestrated-work',
    source: 'webview',
    target: { type: 'orchestrated-work', ref: 'demo' },
    preview: { summary: 'orchestrated-work on demo' },
    payload,
    createdAt: new Date().toISOString(),
    status: 'running',
  };
}

async function drain(gen: AsyncIterable<MutationEvent>): Promise<MutationEvent[]> {
  const out: MutationEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const ctx = { bus: { publish: vi.fn() } as any, cancel: () => false };

async function waitForUpserts(n: number): Promise<unknown[][]> {
  for (let i = 0; i < 20 && mockUpsertRun.mock.calls.length < n; i++) {
    await Promise.resolve();
  }
  expect(mockUpsertRun.mock.calls.length).toBeGreaterThanOrEqual(n);
  return mockUpsertRun.mock.calls;
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 20 && !condition(); i++) {
    await Promise.resolve();
  }
  expect(condition()).toBe(true);
}

function latestRun(id: string): SupervisedRun {
  const runs = mockUpsertRun.mock.calls
    .map((call) => call[0] as SupervisedRun)
    .filter((run) => run.id === id);
  expect(runs.length).toBeGreaterThan(0);
  return runs[runs.length - 1]!;
}

describe('orchestratedWorkApplier', () => {
  it('is a non-auto-approve? — registered as autoApprove work applier kind', () => {
    expect(orchestratedWorkApplier.kind).toBe('orchestrated-work');
    expect(orchestratedWorkApplier.autoApprove).toBe(true);
  });

  describe('validate', () => {
    it('rejects a missing projectSlug', () => {
      const r = orchestratedWorkApplier.validate({} as never);
      expect(r.ok).toBe(false);
    });

    it('rejects an invalid slug (path traversal)', () => {
      const r = orchestratedWorkApplier.validate({ projectSlug: '../etc' } as never);
      expect(r.ok).toBe(false);
    });

    it('rejects an invalid product slug', () => {
      const r = orchestratedWorkApplier.validate({ projectSlug: 'demo', product: '../x' } as never);
      expect(r.ok).toBe(false);
    });
  });

  describe('apply — maps OrchestrationResult to a terminal event', () => {
    let created: boolean;
    let destroyed: boolean;
    let wtDir: string | null;

    beforeEach(() => {
      created = false;
      destroyed = false;
      wtDir = null;
      mockAppendMutationLine.mockClear();
      mockUpsertRun.mockClear();
      activeRuns.clear();
    });

    afterEach(() => {
      __resetOrchestratedRuntimeForTest();
      activeRuns.clear();
      if (wtDir) rmSync(wtDir, { recursive: true, force: true });
    });

    function inject(result: OrchestrationResult): void {
      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree();
          wtDir = dir;
          return sandbox;
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runOrchestration: async () => result,
      });
    }

    it('finalized → completed terminal event tagged orchestrated', async () => {
      inject({ kind: 'finalized', outcome: 'branch-complete' });
      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal?.kind).toBe('completed');
      const data = terminal?.data as Record<string, unknown>;
      expect(data['dispatchMode']).toBe('orchestrated');
      expect(data['projectSlug']).toBe('demo');
      expect(created).toBe(true);
      expect(destroyed).toBe(true);
    });

    it('pumps reported role activity between the starting log and terminal event', async () => {
      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree();
          wtDir = dir;
          return sandbox;
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runOrchestration: async (deps) => {
          const emit = (deps as unknown as {
            emit?: (event: { kind: 'activity' | 'output'; data?: unknown }) => void;
          }).emit;
          emit?.({
            kind: 'output',
            data: { line: 'qa wrote tests from the spec', role: 'qa' },
          });
          return { kind: 'finalized', outcome: 'branch-complete' };
        },
      });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const startIndex = events.findIndex(
        (e) => e.kind === 'log' && String((e.data as Record<string, unknown> | undefined)?.['line']).includes('orchestrated run starting'),
      );
      const terminalIndex = events.findIndex((e) => e.kind === 'completed' || e.kind === 'failed');
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(terminalIndex).toBeGreaterThan(startIndex);

      const streamed = events
        .slice(startIndex + 1, terminalIndex)
        .filter((e) => e.kind === 'activity' || e.kind === 'output');
      expect(streamed.length, 'expected apply() to pump at least one reported activity/output event before terminal').toBeGreaterThanOrEqual(1);
      expect(streamed[0]).toMatchObject({
        mutationId: 'mut-1',
        kind: 'output',
        data: { line: 'qa wrote tests from the spec', role: 'qa' },
      });
      expect(destroyed).toBe(true);
    });

    it('held (finalizer unavailable) → completed terminal event flagged held, never self-merge', async () => {
      inject({
        kind: 'held',
        handoff: {
          runId: 'mut-1',
          project: 'demo',
          product: 'jarvis',
          branch: 'jarvis-work/demo',
          taskRecords: [],
        },
      });
      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
      // A held run is a legitimate durable terminal (branch-complete, awaiting
      // the Project 15 finalizer) — not a failure.
      expect(terminal?.kind).toBe('completed');
      const data = terminal?.data as Record<string, unknown>;
      expect(data['held']).toBe(true);
      expect(destroyed).toBe(true);
    });

    it('blocked → failed terminal event carrying the block reason', async () => {
      inject({
        kind: 'blocked',
        reason: 'closeout checks failed',
        task: { id: 't1', text: 'task one', section: 'Phase 1' },
      });
      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal?.kind).toBe('failed');
      const data = terminal?.data as Record<string, unknown>;
      expect(String(data['reason'])).toContain('closeout checks failed');
      expect(destroyed).toBe(true);
    });

    it('ordinary blocked orchestrated runs are FAILED + worktree destroyed, never parked', async () => {
      // Only explicit parked orchestration results preserve the worktree. A
      // normal block still fails terminally and tears down the sandbox.
      inject({
        kind: 'blocked',
        reason: 'a task needs a human decision',
        task: { id: 't1', text: 'task one', section: 'Phase 1' },
      });
      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal?.kind).toBe('failed');
      const data = (terminal?.data ?? {}) as Record<string, unknown>;
      // NOT parked: no parked metadata, no operator path, no sentinel payload.
      expect(data['parked']).toBeUndefined();
      expect(data['pendingCheck']).toBeUndefined();
      expect(data['operatorWorktreePath']).toBeUndefined();
      // The worktree is unconditionally torn down (never left live for a human).
      expect(destroyed).toBe(true);
    });

    it('parked blocked-on-human orchestrated runs complete with parked metadata and preserve the worktree', async () => {
      const parkedPath = '/tmp/jarvis-worktrees/jarvis/demo';
      inject({
        kind: 'blocked',
        reason: 'feedback retry cap exhausted',
        task: { id: 't1', text: 'task one', section: 'Phase 1' },
        parked: {
          status: 'blocked-on-human',
          branch: 'jarvis-work/demo',
          worktreePath: parkedPath,
          preserveBranch: true,
          preserveWorktree: true,
        },
      });
      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal?.kind).toBe('completed');
      const data = (terminal?.data ?? {}) as Record<string, unknown>;
      expect(data['parked']).toBe(true);
      expect(data['operatorWorktreePath']).toBe(parkedPath);
      expect(data['branch']).toBe('jarvis-work/demo');
      expect(data['preserveBranch']).toBe(true);
      expect(data['preserveWorktree']).toBe(true);
      expect(destroyed).toBe(false);
    });

    it('worktree-create failure → failed terminal event, no destroy of a non-existent tree', async () => {
      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          throw new Error('worktree add failed');
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runOrchestration: async () => ({ kind: 'finalized', outcome: 'x' }),
      });
      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal?.kind).toBe('failed');
      expect(destroyed).toBe(false);
    });

    it('active-harm probe: a silent in-flight orchestration stays quiet and is eligible for the quiet nudge', async () => {
      let finishRun: ((result: OrchestrationResult) => void) | undefined;
      try {
        const projectSlug = '14-product-team-agents';
        const runResult = new Promise<OrchestrationResult>((resolve) => {
          finishRun = resolve;
        });
        __setOrchestratedRuntimeForTest({
          createWorktree: async () => {
            created = true;
            const { sandbox, dir } = makeWorktree(projectSlug);
            wtDir = dir;
            return sandbox;
          },
          destroyWorktree: async () => {
            destroyed = true;
          },
          runOrchestration: async () => runResult,
        });

        registerApplier(orchestratedWorkApplier);
        const createdMutation = await createMutation(
          'orchestrated-work',
          { projectSlug, product: 'jarvis' },
          'webview',
        );
        if (!createdMutation.ok) throw new Error(createdMutation.reason);
        const runId = createdMutation.descriptor.id;

        // createMutation seeds the supervised run, then startApply flips it to
        // running. That real mutation/applier linkage is the load-bearing
        // state this probe must inspect.
        await waitForUpserts(2);
        await waitForCondition(() => created);
        expect(activeRuns.has(runId)).toBe(true);

        const stillRunning = latestRun(runId);
        expect(stillRunning.status).toBe('running');
        expect(stillRunning.project).toBe(projectSlug);
        expect(stillRunning.lastOutputAt).toBeUndefined();
        expect(mockUpsertRun.mock.calls).toHaveLength(2);

        const quietAt = Date.parse(stillRunning.startedAt) + (5 * 60 * 1000) + 1;
        const quietPlan = planQuietNudges([stillRunning], 5 * 60 * 1000, quietAt);
        expect(quietPlan.toNudge.map((r) => r.id)).toEqual([runId]);

        const nudgedRun = quietPlan.updated[0]!;
        const cancelAt = quietAt + (20 * 60 * 1000) + 1;
        expect(planQuietCancel([nudgedRun], 20 * 60 * 1000, cancelAt).toCancel.map((r) => r.id))
          .toEqual([runId]);

        finishRun?.({ kind: 'finalized', outcome: 'branch-complete' });
        await waitForUpserts(3);
        expect(latestRun(runId).status).toBe('completed');
        expect(destroyed).toBe(true);
      } finally {
        finishRun?.({ kind: 'finalized', outcome: 'branch-complete' });
      }
    });
  });
});
