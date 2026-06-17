import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockAppendMutationLine = vi.hoisted(() => vi.fn());
const mockUpsertRun = vi.hoisted(() => vi.fn());
const mockRunFinalizer = vi.hoisted(() =>
  vi.fn(async () => ({
    outcome: 'branch-complete',
    terminalEvent: {
      mutationId: 'mut-orch-automerge',
      ts: new Date('2026-06-16T12:00:00.000Z').toISOString(),
      kind: 'completed',
      data: {
        outcome: 'branch-complete',
        merged: true,
        branchDeleted: true,
      },
    },
    supervisionStatus: 'completed',
    worktreeRemoved: true,
    merged: true,
    branchDeleted: true,
    phases: [
      'classified',
      'transcript-flushed',
      'summary-written',
      'index-appended',
      'merged-not-pushed',
      'pushed-not-deleted',
      'worktree-resolved',
      'finalized',
    ],
  })),
);
const mockRunGate = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock('./mutations-log.js', () => ({
  appendMutationLine: mockAppendMutationLine,
}));

vi.mock('./supervision-store.js', () => ({
  upsertRun: mockUpsertRun,
}));

vi.mock('./work-run-finalizer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./work-run-finalizer.js')>();
  return {
    ...actual,
    runFinalizer: mockRunFinalizer,
  };
});

vi.mock('./work-run-gate-runtime.js', () => ({
  runGate: mockRunGate,
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
import { isStalled, planQuietCancel, planQuietNudges, type SupervisedRun } from '../intent/supervision.js';
import type { TaskEvidence } from '../intent/team-task-workflow.js';

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
function makeWorktree(project = 'demo', tasks = '- [ ] task one\n'): { sandbox: SandboxSpec; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orch-wt-'));
  const projDir = join(dir, 'docs', 'projects', project);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, 'spec.md'), '# Spec\n', 'utf8');
  writeFileSync(join(projDir, 'tasks.md'), tasks, 'utf8');
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
  id = 'mut-1',
): MutationDescriptor<{ projectSlug: string; product?: string }> {
  return {
    id,
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

function makeWorkProductGitStub(args: {
  commitShas: string[];
  diffstat: string;
  status?: string;
}): {
  runGit: ReturnType<typeof vi.fn>;
  calls: Array<{ args: string[]; cwd?: string }>;
} {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const runGit = vi.fn(async (gitArgs: string[], opts?: { cwd?: string }) => {
    calls.push({ args: [...gitArgs], cwd: opts?.cwd });
    if (gitArgs[0] === 'rev-list') {
      return { stdout: args.commitShas.length > 0 ? `${args.commitShas.join('\n')}\n` : '', stderr: '' };
    }
    if (gitArgs[0] === 'diff' && gitArgs.includes('--stat')) {
      return { stdout: args.diffstat, stderr: '' };
    }
    if (gitArgs[0] === 'status' && gitArgs.includes('--porcelain')) {
      return { stdout: args.status ?? '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });
  return { runGit, calls };
}

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
      mockRunFinalizer.mockClear();
      mockRunGate.mockReset();
      mockRunGate.mockResolvedValue({ ok: true });
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

    it('writes a durable transcript.jsonl and summary.json for a completed orchestrated run', async () => {
      const runId = 'mut-orch-substrate';
      const runDir = join(process.cwd(), 'logs', 'work-runs', runId);
      rmSync(runDir, { recursive: true, force: true });
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
          deps.emit?.({
            kind: 'activity',
            data: { role: 'qa', line: 'qa wrote tests from the spec' },
          });
          return { kind: 'finalized', outcome: 'branch-complete' };
        },
      });

      let transcriptExistedAtTerminal: boolean | undefined;
      let summaryExistedAtTerminal: boolean | undefined;
      const events: MutationEvent[] = [];
      for await (const event of orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx)) {
        if (event.kind === 'completed' || event.kind === 'failed') {
          transcriptExistedAtTerminal = existsSync(join(runDir, 'transcript.jsonl'));
          summaryExistedAtTerminal = existsSync(join(runDir, 'summary.json'));
        }
        events.push(event);
      }

      expect(events.find((event) => event.kind === 'completed' || event.kind === 'failed')?.kind).toBe('completed');
      expect(transcriptExistedAtTerminal).toBe(true);
      expect(summaryExistedAtTerminal).toBe(true);

      const transcriptLines = readFileSync(join(runDir, 'transcript.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(transcriptLines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'activity',
            data: { role: 'qa', line: 'qa wrote tests from the spec' },
          }),
        ]),
      );

      const summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8')) as Record<string, unknown>;
      expect(summary).toMatchObject({
        id: runId,
        project: 'demo',
        product: 'jarvis',
        outcome: 'branch-complete',
      });
      expect(summary['transcriptPath']).toBe(join(runDir, 'transcript.jsonl'));
      expect(typeof summary['startedAt']).toBe('string');
      expect(typeof summary['endedAt']).toBe('string');
      expect(destroyed).toBe(true);

      rmSync(runDir, { recursive: true, force: true });
    });

    it('a clean branch-complete orchestrated run invokes runFinalizer in gated-merge mode', async () => {
      const runId = 'mut-orch-automerge';
      const baseSha = 'base-clean-123';
      const { runGit } = makeWorkProductGitStub({
        commitShas: ['abc1111'],
        diffstat: ' src/feature.ts | 1 +\n 1 file changed, 1 insertion(+)\n',
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', '- [x] task one\n');
          wtDir = dir;
          return { ...sandbox, baseSha };
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runGit,
      });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));

      expect(mockRunFinalizer).toHaveBeenCalledTimes(1);
      const [input, effects] = mockRunFinalizer.mock.calls[0]!;
      expect(input).toMatchObject({
        mode: 'gated-merge',
        runId,
        project: 'demo',
        product: 'jarvis',
        branch: 'jarvis-work/demo',
        baseBranch: 'main',
      });
      expect(typeof effects.classify).toBe('function');
      expect(typeof effects.gate).toBe('function');
      expect(typeof effects.mergeBranch).toBe('function');
      expect(typeof effects.pushBranch).toBe('function');
      expect(typeof effects.deleteBranch).toBe('function');

      const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');
      expect(terminal?.kind).toBe('completed');
      expect((terminal?.data as Record<string, unknown>)['outcome']).toBe('branch-complete');
      expect((terminal?.data as Record<string, unknown>)['held']).toBeUndefined();
      expect(created).toBe(true);
    });

    it('a gate-failing branch-complete orchestrated run holds with the gate reason recorded and does not touch the base branch', async () => {
      const runId = 'mut-orch-gate-held';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-gate-held-artifacts-'));
      const { runGit, calls } = makeWorkProductGitStub({
        commitShas: ['abc1111'],
        diffstat: ' src/feature.ts | 1 +\n 1 file changed, 1 insertion(+)\n',
      });
      mockRunGate.mockResolvedValueOnce({ ok: false, reason: 'tests-red' });
      mockRunFinalizer.mockImplementationOnce(async (input, effects) => {
        expect(input).toMatchObject({ mode: 'gated-merge', runId, baseBranch: 'main' });
        const terminalEvent = await effects.classify();
        await effects.flushTranscript();
        effects.writeSummary(terminalEvent);
        effects.appendIndexRow(terminalEvent);
        const verdict = await effects.gate!();
        expect(verdict).toEqual({ ok: false, reason: 'tests-red' });
        effects.alert!('tests-red');
        await effects.removeWorktree();
        effects.writeSupervisionTerminal('completed', terminalEvent);
        return {
          outcome: 'branch-complete',
          terminalEvent,
          supervisionStatus: 'completed',
          worktreeRemoved: true,
          merged: false,
          branchDeleted: false,
          phases: [
            'classified',
            'transcript-flushed',
            'summary-written',
            'index-appended',
            'worktree-resolved',
            'finalized',
          ],
        };
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', '- [x] task one\n');
          wtDir = dir;
          return { ...sandbox, baseSha: 'base-held-123' };
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runGit,
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
      });

      try {
        const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));
        const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');
        expect(terminal?.kind).toBe('completed');
        expect(terminal?.data).toMatchObject({
          outcome: 'branch-complete',
          merged: false,
          branchDeleted: false,
          gateHeldReason: 'tests-red',
          baseBranch: 'main',
          dispatchMode: 'orchestrated',
        });

        const summary = JSON.parse(readFileSync(join(artifactsDir, runId, 'summary.json'), 'utf8')) as Record<string, unknown>;
        expect(summary).toMatchObject({
          id: runId,
          outcome: 'branch-complete',
          merged: false,
          branchDeleted: false,
          gateHeldReason: 'tests-red',
          baseBranch: 'main',
        });

        const baseMutations = calls.filter(({ args }) => {
          const command = args[0];
          return (
            (command === 'merge' && args.includes('jarvis-work/demo')) ||
            (command === 'push' && args[1] === 'origin' && args[2] === 'main') ||
            (command === 'branch' && args[1] === '-d' && args[2] === 'jarvis-work/demo')
          );
        });
        expect(baseMutations).toEqual([]);
        expect(destroyed).toBe(true);
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it.each([
      {
        label: 'commits with all original tasks checked',
        runId: 'mut-orch-classify-complete',
        declaredOutcome: 'noop' as const,
        initialTasks: '- [ ] write classifier tests\n- [ ] wire classifier\n',
        finalTasks: '- [x] write classifier tests\n- [x] wire classifier\n',
        commitShas: ['1111111', '2222222'],
        diffstat: ' src/jobs/orchestrated-work-runner.ts | 12 ++++++++++++\n 1 file changed, 12 insertions(+)\n',
        expectedOutcome: 'branch-complete',
        expectedTransitions: { tasksNewlyChecked: 2, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 },
        expectedFilesChanged: ['src/jobs/orchestrated-work-runner.ts'],
      },
      {
        label: 'commits with an original task still unchecked',
        runId: 'mut-orch-classify-partial',
        declaredOutcome: 'branch-complete' as const,
        initialTasks: '- [ ] write classifier tests\n- [ ] wire classifier\n',
        finalTasks: '- [x] write classifier tests\n- [ ] wire classifier\n',
        commitShas: ['3333333'],
        diffstat: ' src/jobs/orchestrated-work-runner.ts | 8 ++++++++\n 1 file changed, 8 insertions(+)\n',
        expectedOutcome: 'partial',
        expectedTransitions: { tasksNewlyChecked: 1, tasksRemaining: 1, tasksAdded: 0, tasksRemoved: 0 },
        expectedFilesChanged: ['src/jobs/orchestrated-work-runner.ts'],
      },
      {
        label: 'zero commits and clean worktree',
        runId: 'mut-orch-classify-noop',
        declaredOutcome: 'branch-complete' as const,
        initialTasks: '- [ ] write classifier tests\n',
        finalTasks: '- [ ] write classifier tests\n',
        commitShas: [],
        diffstat: '',
        expectedOutcome: 'noop',
        expectedTransitions: { tasksNewlyChecked: 0, tasksRemaining: 1, tasksAdded: 0, tasksRemoved: 0 },
        expectedFilesChanged: [],
      },
    ])(
      'writes summary.json from computed orchestrated branch work product: $label',
      async ({
        runId,
        declaredOutcome,
        initialTasks,
        finalTasks,
        commitShas,
        diffstat,
        expectedOutcome,
        expectedTransitions,
        expectedFilesChanged,
      }) => {
        const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-classify-artifacts-'));
        const baseSha = 'base-orch-123';
        const { runGit, calls } = makeWorkProductGitStub({ commitShas, diffstat });
        __setOrchestratedRuntimeForTest({
          createWorktree: async () => {
            created = true;
            const { sandbox, dir } = makeWorktree('demo', initialTasks);
            wtDir = dir;
            return { ...sandbox, baseSha };
          },
          destroyWorktree: async () => {
            destroyed = true;
          },
          runGit,
          workRunsDir: artifactsDir,
          runOrchestration: async (deps) => {
            await deps.writeTasksMd(finalTasks);
            return { kind: 'finalized', outcome: declaredOutcome };
          },
        });

        try {
          const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));
          expect(events.find((event) => event.kind === 'completed' || event.kind === 'failed')?.kind).toBe('completed');

          const summary = JSON.parse(readFileSync(join(artifactsDir, runId, 'summary.json'), 'utf8')) as Record<string, any>;
          expect(summary['outcome']).toBe(expectedOutcome);
          expect(summary['workProduct']).toMatchObject({
            commitCount: commitShas.length,
            commitShas,
            filesChanged: expectedFilesChanged,
            diffstat: diffstat.trim(),
            dirty: false,
            untracked: false,
            transitions: expectedTransitions,
          });
          expect(summary['baseSha']).toBe(baseSha);

          const expectedRange = `${baseSha}..jarvis-work/demo`;
          expect(calls).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ args: ['rev-list', expectedRange] }),
              expect.objectContaining({ args: ['diff', '--stat', expectedRange] }),
              expect.objectContaining({ args: ['status', '--porcelain'] }),
            ]),
          );
          expect(destroyed).toBe(true);
        } finally {
          rmSync(artifactsDir, { recursive: true, force: true });
        }
      },
    );

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

    it('an open high/critical objection holds the branch with handoff payload recorded and never merges', async () => {
      const runId = 'mut-orch-objection-held';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-objection-held-artifacts-'));
      const { runGit, calls } = makeWorkProductGitStub({
        commitShas: ['abc1111'],
        diffstat: ' src/security.ts | 1 +\n 1 file changed, 1 insertion(+)\n',
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', '- [ ] close the objection\n');
          wtDir = dir;
          return { ...sandbox, baseSha: 'base-objection-123' };
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runGit,
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
        createTaskWorkflowRunner: () => async (task) => ({
          taskId: task.id,
          outcome: 'blocked',
          rolesInvoked: ['qa', 'coder', 'reviewer'],
          objectionOpen: true,
          reviewerVerdict: {
            pass: false,
            objections: [
              {
                class: 'security',
                severity: 'high',
                location: 'src/security.ts:42',
                rationale: 'token material can be written to disk without redaction',
              },
            ],
          },
          handoffNotes: ['partial fix is on the branch and needs human objection handling'],
          blockedReason: 'open objection-class finding',
        }),
      });

      try {
        const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));
        const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');
        expect(terminal?.kind).toBe('completed');
        expect(terminal?.data).toMatchObject({
          parked: true,
          reason: expect.stringContaining('open objection-class finding'),
          operatorWorktreePath: wtDir,
          branch: 'jarvis-work/demo',
          baseBranch: 'main',
          preserveBranch: true,
          preserveWorktree: true,
          dispatchMode: 'orchestrated',
        });

        const summary = JSON.parse(readFileSync(join(artifactsDir, runId, 'summary.json'), 'utf8')) as Record<string, unknown>;
        expect(summary).toMatchObject({
          id: runId,
          branch: 'jarvis-work/demo',
          reason: expect.stringContaining('open objection-class finding'),
          baseSha: 'base-objection-123',
        });

        const baseMutations = calls.filter(({ args }) => {
          const command = args[0];
          return (
            (command === 'merge' && args.includes('jarvis-work/demo')) ||
            (command === 'push' && args[1] === 'origin' && args[2] === 'main') ||
            (command === 'branch' && args[1] === '-d' && args[2] === 'jarvis-work/demo')
          );
        });
        expect(baseMutations).toEqual([]);
        expect(mockRunFinalizer).not.toHaveBeenCalled();
        expect(destroyed).toBe(false);
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
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

    it('advances child-liveness heartbeat during a long-running injected role session without faking output', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
      const projectSlug = '14-product-team-agents';
      let runId: string | undefined;
      let finishRole: ((evidence: TaskEvidence) => void) | undefined;

      try {
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
          createTaskWorkflowRunner: () => async (task) =>
            new Promise<TaskEvidence>((resolve) => {
              finishRole = resolve;
            }).then((evidence) => ({ ...evidence, taskId: task.id })),
        });

        registerApplier(orchestratedWorkApplier);
        const createdMutation = await createMutation(
          'orchestrated-work',
          { projectSlug, product: 'jarvis' },
          'webview',
        );
        if (!createdMutation.ok) throw new Error(createdMutation.reason);
        runId = createdMutation.descriptor.id;

        await waitForUpserts(2);
        await waitForCondition(() => created);
        const runningBeforeHeartbeat = latestRun(runId);
        expect(runningBeforeHeartbeat.status).toBe('running');
        expect(runningBeforeHeartbeat.lastOutputAt).toBeUndefined();

        await vi.advanceTimersByTimeAsync(31_000);
        for (let i = 0; i < 20 && latestRun(runId).lastChildAliveAt === undefined; i++) {
          await Promise.resolve();
        }

        const runningAfterHeartbeat = latestRun(runId);
        expect(runningAfterHeartbeat.status).toBe('running');
        expect(runningAfterHeartbeat.lastHeartbeatAt).toBe(runningBeforeHeartbeat.lastHeartbeatAt);
        expect(
          runningAfterHeartbeat.lastChildAliveAt,
          'expected a keep-alive upsert carrying lastChildAliveAt while the injected role session is still running',
        ).toBeDefined();
        expect(Date.parse(runningAfterHeartbeat.lastChildAliveAt!)).toBeGreaterThan(
          Date.parse(runningBeforeHeartbeat.lastHeartbeatAt),
        );
        expect(runningAfterHeartbeat.lastOutputAt).toBeUndefined();

        const quietAt = Date.parse(runningBeforeHeartbeat.startedAt) + (5 * 60 * 1000) + 1;
        expect(isStalled(runningAfterHeartbeat, 5 * 60 * 1000, quietAt)).toBe(false);

        const quietPlan = planQuietNudges([runningAfterHeartbeat], 5 * 60 * 1000, quietAt);
        expect(quietPlan.toNudge.map((r) => r.id)).toEqual([runId]);

        const nudgedRun = quietPlan.updated[0]!;
        const cancelAt = quietAt + (20 * 60 * 1000) + 1;
        expect(planQuietCancel([nudgedRun], 20 * 60 * 1000, cancelAt).toCancel.map((r) => r.id))
          .toEqual([runId]);

        finishRole?.({
          taskId: 'placeholder',
          outcome: 'blocked',
          rolesInvoked: ['qa'],
          objectionOpen: true,
          handoffNotes: [],
          blockedReason: 'test cleanup hard block',
        });
        await waitForCondition(() => runId !== undefined && !activeRuns.has(runId));
        expect(destroyed).toBe(true);
      } finally {
        finishRole?.({
          taskId: 'placeholder',
          outcome: 'blocked',
          rolesInvoked: ['qa'],
          objectionOpen: true,
          handoffNotes: [],
          blockedReason: 'test cleanup hard block',
        });
        if (runId !== undefined) {
          for (let i = 0; i < 20 && activeRuns.has(runId); i++) {
            await Promise.resolve();
          }
        }
        vi.useRealTimers();
      }
    });

    it('quiet-backstop safe: a genuinely streaming orchestrated run advances lastOutputAt and is not quiet-cancel eligible', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
      const projectSlug = '14-product-team-agents';
      let runId: string | undefined;
      let emitActivity: ((line: string) => void) | undefined;
      let finishRun: ((result: OrchestrationResult) => void) | undefined;

      try {
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
          runOrchestration: async (deps) => {
            emitActivity = (line: string) => {
              deps.emit?.({
                kind: 'activity',
                data: { role: 'coder', line },
              });
            };
            return runResult;
          },
        });

        registerApplier(orchestratedWorkApplier);
        const createdMutation = await createMutation(
          'orchestrated-work',
          { projectSlug, product: 'jarvis' },
          'webview',
        );
        if (!createdMutation.ok) throw new Error(createdMutation.reason);
        runId = createdMutation.descriptor.id;

        await waitForUpserts(2);
        await waitForCondition(() => created && emitActivity !== undefined);
        const runningBeforeStream = latestRun(runId);
        expect(runningBeforeStream.status).toBe('running');
        expect(runningBeforeStream.lastOutputAt).toBeUndefined();

        await vi.advanceTimersByTimeAsync(31_000);
        emitActivity?.('reviewer is reading the diff');
        await waitForCondition(() => latestRun(runId!).lastOutputAt !== undefined);

        const runningAfterStream = latestRun(runId);
        expect(runningAfterStream.status).toBe('running');
        expect(runningAfterStream.lastOutputAt).toBeDefined();
        expect(Date.parse(runningAfterStream.lastOutputAt!)).toBeGreaterThan(
          Date.parse(runningBeforeStream.startedAt),
        );

        const fiveMinutesAfterStart = Date.parse(runningBeforeStream.startedAt) + (5 * 60 * 1000) + 1;
        const quietPlan = planQuietNudges([runningAfterStream], 5 * 60 * 1000, fiveMinutesAfterStart);
        expect(
          quietPlan.toNudge.map((r) => r.id),
          'streamed role activity should reset the quiet baseline away from startedAt',
        ).toEqual([]);

        const wouldHaveBeenNudgedFromStart = {
          ...runningAfterStream,
          lastOutputAt: undefined,
          quietNudgedAt: new Date(fiveMinutesAfterStart).toISOString(),
        };
        const cancelAt = fiveMinutesAfterStart + (20 * 60 * 1000) + 1;
        expect(
          planQuietCancel([wouldHaveBeenNudgedFromStart], 20 * 60 * 1000, cancelAt).toCancel.map((r) => r.id),
          'control check: without a streamed lastOutputAt, this run shape would enter the quiet-cancel path',
        ).toEqual([runId]);
        expect(planQuietCancel([runningAfterStream], 20 * 60 * 1000, cancelAt).toCancel.map((r) => r.id))
          .toEqual([]);

        finishRun?.({ kind: 'finalized', outcome: 'branch-complete' });
        const completedRunId = runId;
        await waitForCondition(() => completedRunId !== undefined && !activeRuns.has(completedRunId));
        expect(completedRunId).toBeDefined();
        expect(latestRun(completedRunId!).status).toBe('completed');
        expect(destroyed).toBe(true);
      } finally {
        finishRun?.({ kind: 'finalized', outcome: 'branch-complete' });
        if (runId !== undefined) {
          for (let i = 0; i < 20 && activeRuns.has(runId); i++) {
            await Promise.resolve();
          }
        }
        vi.useRealTimers();
      }
    });
  });
});
