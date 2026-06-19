import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitRunner } from './sandbox-runtime.js';
import type {
  FinalizerEffects,
  FinalizerInput,
  FinalizerResult,
  GateResult,
} from './work-run-finalizer.js';
import type { FinalizerHandoff } from '../intent/finalizer-handoff.js';

const mockAppendMutationLine = vi.hoisted(() => vi.fn());
const mockUpsertRun = vi.hoisted(() => vi.fn());
const mockCreateTranscriptSink = vi.hoisted(() => vi.fn());
const mockRunFinalizer = vi.hoisted(() =>
  vi.fn(async (
    _input: FinalizerInput,
    _effects: FinalizerEffects,
  ): Promise<FinalizerResult> => ({
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
const mockRunGate = vi.hoisted(() => vi.fn(async (): Promise<GateResult> => ({ ok: true })));

vi.mock('./mutations-log.js', () => ({
  appendMutationLine: mockAppendMutationLine,
}));

vi.mock('./supervision-store.js', () => ({
  upsertRun: mockUpsertRun,
}));

vi.mock('./work-run-transcript.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./work-run-transcript.js')>();
  return {
    ...actual,
    createTranscriptSink: mockCreateTranscriptSink,
  };
});

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
  __getRuntimeDepsForTest,
  redispatchRecoveredOrchestratedMutation,
} from './orchestrated-work-runner.js';
import {
  activeRuns,
  createMutation,
  registerApplier,
  setMutationBus,
  type MutationDescriptor,
  type MutationEvent,
} from '../transport/mutations.js';
import type { OrchestrationDeps, OrchestrationResult } from '../intent/project-orchestrator.js';
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
  runGit: GitRunner;
  calls: Array<{ args: string[]; cwd?: string }>;
} {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const runGit: GitRunner = vi.fn(async (gitArgs: string[], opts?: { cwd?: string }) => {
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

async function finalizeAsOrchestrationResult(
  deps: Pick<OrchestrationDeps, 'finalize'>,
): Promise<OrchestrationResult> {
  const handoff: FinalizerHandoff = {
    runId: 'test-run',
    project: 'demo',
    product: 'jarvis',
    branch: 'jarvis-work/demo',
    baseBranch: 'main',
    taskRecords: [],
  };
  const result = await deps.finalize(handoff);
  if (result.kind !== 'finalized') {
    throw new Error(`expected finalizer adapter to finalize, got ${result.kind}`);
  }
  return { kind: 'finalized', outcome: result.outcome };
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

function makeFakeTranscriptSink(path = '/tmp/work-runs/orch/transcript.jsonl') {
  const appended: unknown[] = [];
  const operations: string[] = [];
  const sink = {
    path,
    append: vi.fn(async (event: unknown) => {
      const mutationEvent = event as MutationEvent;
      appended.push(event);
      operations.push(`append:${mutationEvent.kind}:${String((mutationEvent.data as Record<string, unknown> | undefined)?.['line'] ?? '')}`);
    }),
    finish: vi.fn(async () => {
      operations.push('finish:start');
      await Promise.resolve();
      operations.push('finish:end');
    }),
    destroy: vi.fn(() => {
      operations.push('destroy');
    }),
  };
  return { sink, appended, operations };
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
      mockCreateTranscriptSink.mockReset();
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

    it('re-dispatches recovered mutations against the existing worktree instead of creating a new one', async () => {
      const projectSlug = '14-product-team-agents';
      const recovered = makeWorktree(projectSlug, [
        '# Tasks',
        '',
        '## Phase 11B',
        '- [x] Persist records and cursor',
        '- [ ] Resume boot',
      ].join('\n'));
      wtDir = recovered.dir;
      const createWorktree = vi.fn(async () => {
        throw new Error('should not create a new worktree during recovery redispatch');
      });
      const destroyWorktree = vi.fn(async () => {
        destroyed = true;
      });
      let seenDeps: {
        branch: string;
        baseBranch?: string;
        worktreePath?: string;
      } | undefined;

      __setOrchestratedRuntimeForTest({
        createWorktree,
        destroyWorktree,
        runOrchestration: async (deps) => {
          seenDeps = {
            branch: deps.branch,
            baseBranch: deps.baseBranch,
            worktreePath: deps.worktreePath,
          };
          return {
            kind: 'blocked',
            reason: 'stop after recovery assertion',
            task: { id: 'resume-boot', text: 'Resume boot', section: 'Phase 11B' },
          };
        },
      });

      registerApplier(orchestratedWorkApplier);
      const descriptor = makeDescriptor({ projectSlug, product: 'jarvis' }, 'mut-recovered-redispatch');
      const result = redispatchRecoveredOrchestratedMutation(descriptor, {
        branch: 'jarvis-work/recovered-branch',
        baseBranch: 'main',
        worktreePath: recovered.dir,
        reconstruction: {
          completedTaskIds: ['persist-records-and-cursor'],
          nextTask: { id: 'resume-boot', text: 'Resume boot', section: 'Phase 11B' },
          drift: false,
        },
        resumeFromTaskId: 'resume-boot',
        existingBranch: true,
      });

      expect(result).toEqual({ ok: true });
      await waitForCondition(() => !activeRuns.has(descriptor.id));

      expect(createWorktree).not.toHaveBeenCalled();
      expect(seenDeps).toEqual({
        branch: 'jarvis-work/recovered-branch',
        baseBranch: 'main',
        worktreePath: recovered.dir,
      });
      expect(destroyWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          worktree: recovered.dir,
          resumed: true,
        }),
        expect.any(Object),
      );
    });

    it('binds the production transcript sink to createTranscriptSink under WORK_RUNS_DIR/<runId>/transcript.jsonl', () => {
      const baseDir = mkdtempSync(join(tmpdir(), 'orch-transcript-binding-'));
      const fakeSink = {
        path: join(baseDir, 'mut-transcript-binding', 'transcript.jsonl'),
        append: vi.fn(async () => undefined),
        finish: vi.fn(async () => undefined),
        destroy: vi.fn(),
      };
      mockCreateTranscriptSink.mockReturnValueOnce(fakeSink);
      __resetOrchestratedRuntimeForTest();

      try {
        const sink = __getRuntimeDepsForTest().createSink('mut-transcript-binding', baseDir);

        expect(sink).toBe(fakeSink);
        expect(mockCreateTranscriptSink).toHaveBeenCalledWith({
          runId: 'mut-transcript-binding',
          baseDir,
        });
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
        mockCreateTranscriptSink.mockReset();
      }
    });

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

    it('tees each streamed role event to the transcript sink and awaits finish before the terminal event', async () => {
      const runId = 'mut-orch-stream-transcript';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-stream-transcript-'));
      const fake = makeFakeTranscriptSink(join(artifactsDir, runId, 'transcript.jsonl'));
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
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
        createSink: vi.fn(() => fake.sink),
        runOrchestration: async (deps) => {
          deps.emit?.({
            kind: 'activity',
            data: { role: 'qa', line: 'qa wrote tests from the spec' },
          });
          deps.emit?.({
            kind: 'output',
            data: { role: 'coder', line: 'coder implemented against the red test' },
          });
          return { kind: 'finalized', outcome: 'branch-complete' };
        },
      });

      try {
        const events: MutationEvent[] = [];
        for await (const event of orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx)) {
          if (event.kind === 'completed' || event.kind === 'failed') {
            fake.operations.push('terminal');
            expect(fake.sink.finish).toHaveBeenCalledOnce();
            expect(fake.operations.indexOf('finish:end')).toBeLessThan(fake.operations.indexOf('terminal'));
          }
          events.push(event);
        }

        const streamed = events.filter((event) => event.kind === 'activity' || event.kind === 'output');
        expect(streamed).toHaveLength(2);
        expect(fake.sink.append).toHaveBeenCalledTimes(2);
        expect(fake.appended).toEqual(streamed);
        expect(fake.operations).toEqual(expect.arrayContaining([
          'append:activity:qa wrote tests from the spec',
          'append:output:coder implemented against the red test',
          'finish:end',
          'terminal',
          'destroy',
        ]));
        expect(fake.operations.indexOf('append:activity:qa wrote tests from the spec')).toBeLessThan(fake.operations.indexOf('finish:start'));
        expect(fake.operations.indexOf('append:output:coder implemented against the red test')).toBeLessThan(fake.operations.indexOf('finish:start'));
        expect(fake.operations.indexOf('terminal')).toBeLessThan(fake.operations.indexOf('destroy'));
        expect(destroyed).toBe(true);
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('destroys an opened transcript sink when the orchestration loop throws', async () => {
      const runId = 'mut-orch-transcript-failure';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-transcript-failure-'));
      const fake = makeFakeTranscriptSink(join(artifactsDir, runId, 'transcript.jsonl'));
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
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
        createSink: vi.fn(() => fake.sink),
        runOrchestration: async (deps) => {
          deps.emit?.({
            kind: 'activity',
            data: { role: 'reviewer', line: 'reviewer started before the crash' },
          });
          throw new Error('role process crashed');
        },
      });

      try {
        const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));
        const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');

        expect(terminal?.kind).toBe('failed');
        expect(String((terminal?.data as Record<string, unknown> | undefined)?.['reason'] ?? '')).toContain('role process crashed');
        expect(fake.sink.append).toHaveBeenCalledOnce();
        expect(fake.sink.finish).toHaveBeenCalledOnce();
        expect(fake.sink.destroy).toHaveBeenCalledOnce();
        expect(fake.operations[fake.operations.length - 1]).toBe('destroy');
        expect(destroyed).toBe(true);
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('yields queued role activity while orchestration is still running', async () => {
      let emitActivity: ((event: { kind: 'activity' | 'output'; data?: unknown }) => void) | undefined;
      let finishRun: ((result: OrchestrationResult) => void) | undefined;
      const runResult = new Promise<OrchestrationResult>((resolve) => {
        finishRun = resolve;
      });

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
          emitActivity = deps.emit;
          return runResult;
        },
      });

      try {
        const iterator = orchestratedWorkApplier.apply(makeDescriptor(), ctx)[Symbol.asyncIterator]();
        const start = await iterator.next();
        expect(start.value).toMatchObject({
          mutationId: 'mut-1',
          kind: 'log',
        });

        const streamed = iterator.next();
        await waitForCondition(() => emitActivity !== undefined);
        emitActivity?.({
          kind: 'activity',
          data: { role: 'coder', line: 'coder is implementing the task' },
        });

        await expect(streamed).resolves.toMatchObject({
          done: false,
          value: {
            mutationId: 'mut-1',
            kind: 'activity',
            data: { role: 'coder', line: 'coder is implementing the task' },
          },
        });

        finishRun?.({ kind: 'finalized', outcome: 'branch-complete' });
        const terminal = await iterator.next();
        expect(terminal.value.kind).toBe('completed');
        expect(await iterator.next()).toMatchObject({ done: true });
        expect(destroyed).toBe(true);
      } finally {
        finishRun?.({ kind: 'finalized', outcome: 'branch-complete' });
      }
    });

    it('pumps Jarvis-owned orchestration lifecycle events as activity before the terminal event', async () => {
      const gitCalls: string[][] = [];
      const runGit = vi.fn(async (gitArgs: string[]) => {
        gitCalls.push([...gitArgs]);
        if (gitArgs[0] === 'rev-parse') {
          return { stdout: 'closeout-sha\n', stderr: '' };
        }
        if (gitArgs[0] === 'rev-list') {
          return { stdout: 'closeout-sha\n', stderr: '' };
        }
        if (gitArgs[0] === 'diff' && gitArgs.includes('--stat')) {
          return { stdout: ' src/feature.ts | 1 +\n 1 file changed, 1 insertion(+)\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', '- [ ] Build the streak core\n');
          wtDir = dir;
          writeFileSync(join(dir, 'docs', 'projects', 'demo', 'context.md'), [
            '# Project Context',
            '',
            '## Current State',
            'Initial state.',
            '',
            '## Key Decisions',
            'None yet.',
            '',
            '## Interfaces & Contracts',
            'Use the existing orchestration seams.',
            '',
            '## Known Risks',
            'None yet.',
            '',
            '## Next Task Handoff',
            'Start with the first unchecked task.',
            '',
          ].join('\n'), 'utf8');
          return sandbox;
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runGit,
        createTaskWorkflowRunner: () => async (task) => ({
          taskId: task.id,
          outcome: 'ready-for-closeout',
          rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
          findingsLedger: [],
          loopExitReason: 'all-low',
          objectionOpen: false,
          handoffNotes: [`completed ${task.text}`],
          reviewerVerdict: { pass: true, objections: [] },
        }),
      });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminalIndex = events.findIndex((event) => event.kind === 'completed' || event.kind === 'failed');
      expect(terminalIndex).toBeGreaterThan(0);
      const lifecycle = events.slice(0, terminalIndex).filter((event) => {
        const data = (event.data ?? {}) as Record<string, unknown>;
        return event.kind === 'activity' && typeof data['event'] === 'string';
      });

      expect(lifecycle.map((event) => (event.data as Record<string, unknown>)['event'])).toEqual([
        'task-selected',
        'attempt-start',
        'closeout-start',
        'closeout-complete',
      ]);
      expect(lifecycle).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mutationId: 'mut-1',
            kind: 'activity',
            data: expect.objectContaining({
              event: 'task-selected',
              taskId: 'build-the-streak-core',
              taskText: 'Build the streak core',
            }),
          }),
          expect.objectContaining({
            mutationId: 'mut-1',
            kind: 'activity',
            data: expect.objectContaining({
              event: 'attempt-start',
              taskId: 'build-the-streak-core',
              attemptNumber: 1,
              attemptId: 'mut-1-build-the-streak-core-attempt-1',
            }),
          }),
          expect.objectContaining({
            mutationId: 'mut-1',
            kind: 'activity',
            data: expect.objectContaining({
              event: 'closeout-complete',
              taskId: 'build-the-streak-core',
              commitSha: 'closeout-sha',
            }),
          }),
        ]),
      );
      expect(gitCalls).toEqual(expect.arrayContaining([
        ['add', '-A'],
        ['commit', '-m', 'jarvis(jarvis): closeout — Build the streak core'],
        ['rev-parse', 'HEAD'],
      ]));
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

    it('no-stub regression: production finalize wiring cannot return the old unavailable hold terminal', async () => {
      const runId = 'mut-orch-automerge';

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree();
          wtDir = dir;
          return { ...sandbox, baseSha: 'base-no-stub-123' };
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runOrchestration: async (deps) => finalizeAsOrchestrationResult(deps),
      });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));

      const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');
      expect(terminal?.kind).toBe('completed');
      expect(terminal?.data).toMatchObject({
        outcome: 'branch-complete',
        dispatchMode: 'orchestrated',
      });
      const data = (terminal?.data ?? {}) as Record<string, unknown>;
      expect(data['held']).toBeUndefined();
      expect(String(data['reason'] ?? '')).not.toMatch(/finalizer.*not wired|unavailable/i);
    });

    it('production finalize adapter drives the real gated-merge finalizer effects in order', async () => {
      const runId = 'mut-orch-real-gated-merge';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-real-gated-merge-artifacts-'));
      const repoPath = join(artifactsDir, 'product-repo');
      const productsFile = join(artifactsDir, 'products.json');
      const priorProductsFile = process.env['PRODUCTS_CONFIG_FILE'];
      const operations: string[] = [];
      const phases: string[] = [];
      const calls: Array<{ args: string[]; cwd?: string }> = [];
      const runGit = vi.fn(async (gitArgs: string[], opts?: { cwd?: string }) => {
        calls.push({ args: [...gitArgs], cwd: opts?.cwd });
        if (gitArgs[0] === 'rev-list') {
          return { stdout: 'abc1111\n', stderr: '' };
        }
        if (gitArgs[0] === 'diff' && gitArgs.includes('--stat')) {
          return { stdout: ' src/feature.ts | 1 +\n 1 file changed, 1 insertion(+)\n', stderr: '' };
        }
        if (gitArgs[0] === 'status' && gitArgs.includes('--porcelain')) {
          return { stdout: '', stderr: '' };
        }
        if (gitArgs[0] === 'merge') operations.push('merge');
        if (gitArgs[0] === 'push') operations.push('push');
        if (gitArgs[0] === 'branch' && gitArgs[1] === '-d') operations.push('delete-branch');
        return { stdout: '', stderr: '' };
      });

      mkdirSync(repoPath, { recursive: true });
      writeFileSync(
        productsFile,
        JSON.stringify({
          jarvis: {
            repoPath,
            baseBranch: 'trunk',
            credentialsFile: '',
            egressAllowlist: [],
            validationCommands: ['npm test -- --runInBand'],
          },
        }),
        'utf8',
      );
      process.env['PRODUCTS_CONFIG_FILE'] = productsFile;
      mockRunGate.mockResolvedValueOnce({ ok: true });
      mockRunFinalizer.mockImplementationOnce(async (input, effects) => {
        const actual = await vi.importActual<typeof import('./work-run-finalizer.js')>('./work-run-finalizer.js');
        return actual.runFinalizer(input, effects);
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', '- [ ] task one\n');
          wtDir = dir;
          return { ...sandbox, baseSha: 'base-real-gated-merge' };
        },
        destroyWorktree: async () => {
          operations.push('destroy-worktree');
          destroyed = true;
        },
        runGit,
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
        recordWorkRunPhase: (id, phase) => {
          expect(id).toBe(runId);
          phases.push(phase);
        },
        readLastWorkRunPhase: (id) => {
          expect(id).toBe(runId);
          return null;
        },
        runOrchestration: async (deps) => {
          await deps.writeTasksMd('- [x] task one\n');
          return finalizeAsOrchestrationResult(deps);
        },
      });

      try {
        const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));
        const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');

        expect(mockRunFinalizer).toHaveBeenCalledTimes(1);
        expect(mockRunGate).toHaveBeenCalledWith(expect.objectContaining({
          product: 'jarvis',
          repoPath,
          baseBranch: 'trunk',
          branch: 'jarvis-work/demo',
          validationCommands: ['npm test -- --runInBand'],
          tasksRemaining: 0,
          concurrentRun: false,
          integrationWorktree: expect.stringContaining(`gate-jarvis-${runId}`),
        }));
        expect(terminal?.kind).toBe('completed');
        expect(terminal?.data).toMatchObject({
          outcome: 'branch-complete',
          merged: true,
          branchDeleted: true,
          baseBranch: 'trunk',
          dispatchMode: 'orchestrated',
        });
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
        expect(operations).toEqual(['merge', 'push', 'destroy-worktree', 'delete-branch']);
        expect(calls).toEqual(expect.arrayContaining([
          expect.objectContaining({
            args: ['merge', '--no-ff', 'jarvis-work/demo', '-m', 'jarvis(jarvis): merge orchestrated branch jarvis-work/demo'],
            cwd: repoPath,
          }),
          expect.objectContaining({ args: ['push', 'origin', 'trunk'], cwd: repoPath }),
          expect.objectContaining({ args: ['branch', '-d', 'jarvis-work/demo'], cwd: repoPath }),
        ]));
        expect(destroyed).toBe(true);
      } finally {
        if (priorProductsFile === undefined) delete process.env['PRODUCTS_CONFIG_FILE'];
        else process.env['PRODUCTS_CONFIG_FILE'] = priorProductsFile;
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('production finalize adapter preserves the failed-gate hold invariant through the real finalizer', async () => {
      const runId = 'mut-orch-real-gate-held';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-real-gate-held-artifacts-'));
      const operations: string[] = [];
      const phases: string[] = [];
      const runGit = vi.fn(async (gitArgs: string[], opts?: { cwd?: string }) => {
        if (gitArgs[0] === 'rev-list') {
          return { stdout: 'abc1111\n', stderr: '' };
        }
        if (gitArgs[0] === 'diff' && gitArgs.includes('--stat')) {
          return { stdout: ' src/feature.ts | 1 +\n 1 file changed, 1 insertion(+)\n', stderr: '' };
        }
        if (gitArgs[0] === 'status' && gitArgs.includes('--porcelain')) {
          return { stdout: '', stderr: '' };
        }
        if (gitArgs[0] === 'merge') operations.push(`merge:${opts?.cwd ?? ''}`);
        if (gitArgs[0] === 'push') operations.push(`push:${gitArgs.join(' ')}`);
        if (gitArgs[0] === 'branch' && gitArgs[1] === '-d') operations.push(`delete:${gitArgs[2]}`);
        return { stdout: '', stderr: '' };
      });

      mockRunGate.mockResolvedValueOnce({ ok: false, reason: 'tests-red' });
      mockRunFinalizer.mockImplementationOnce(async (input, effects) => {
        const actual = await vi.importActual<typeof import('./work-run-finalizer.js')>('./work-run-finalizer.js');
        return actual.runFinalizer(input, effects);
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', '- [ ] task one\n');
          wtDir = dir;
          return { ...sandbox, baseSha: 'base-real-gate-held' };
        },
        destroyWorktree: async () => {
          operations.push('destroy-worktree');
          destroyed = true;
        },
        runGit,
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
        recordWorkRunPhase: (id, phase) => {
          expect(id).toBe(runId);
          phases.push(phase);
        },
        readLastWorkRunPhase: (id) => {
          expect(id).toBe(runId);
          return null;
        },
        runOrchestration: async (deps) => {
          await deps.writeTasksMd('- [x] task one\n');
          return finalizeAsOrchestrationResult(deps);
        },
      });

      try {
        const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));
        const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');

        expect(mockRunFinalizer).toHaveBeenCalledTimes(1);
        expect(mockRunGate).toHaveBeenCalledOnce();
        expect(terminal?.kind).toBe('completed');
        expect(terminal?.data).toMatchObject({
          outcome: 'branch-complete',
          merged: false,
          branchDeleted: false,
          gateHeldReason: 'tests-red',
          baseBranch: 'main',
          dispatchMode: 'orchestrated',
        });
        expect(phases).toEqual([
          'classified',
          'transcript-flushed',
          'summary-written',
          'index-appended',
          'worktree-resolved',
          'finalized',
        ]);
        expect(operations).toEqual(['destroy-worktree']);
        expect(destroyed).toBe(true);
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
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

    it('finding-driven held terminals preserve the live worktree and do not run the finalizer', async () => {
      const worktreePath = '/tmp/jarvis-worktrees/jarvis/demo-non-reversible';
      inject({
        kind: 'held',
        reason: 'non-reversible high terminal finding remains after severity convergence',
        branch: 'jarvis-work/demo',
        worktreePath,
        preserveBranch: true,
        preserveWorktree: true,
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

      expect(mockRunFinalizer).not.toHaveBeenCalled();
      expect(terminal?.kind).toBe('completed');
      const data = terminal?.data as Record<string, unknown>;
      expect(data['held']).toBe(true);
      expect(String(data['reason'] ?? '')).toMatch(/non-reversible|terminal finding|hold/i);
      expect(data['branch']).toBe('jarvis-work/demo');
      expect(data['operatorWorktreePath']).toBe(worktreePath);
      expect(data['preserveBranch']).toBe(true);
      expect(data['preserveWorktree']).toBe(true);
      expect(destroyed).toBe(false);
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
      // A normal operational block still fails terminally and tears down the
      // sandbox; Phase 14 finding terminals use the held branch path instead.
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

    it('a non-reversible high terminal finding completes as a held terminal with work preserved and never merges', async () => {
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
        createTaskWorkflowRunner: () => async (task) => {
          const terminalFinding = {
            id: 'finding-token-disk-write',
            sourceGate: 'reviewer' as const,
            class: 'security' as const,
            severity: 'high' as const,
            location: 'src/security.ts:42',
            rationale: 'token material can be written to disk without redaction',
            reversible: false,
            raisedRound: 4,
            status: 'open' as const,
          };
          return {
            taskId: task.id,
            outcome: 'blocked',
            rolesInvoked: ['qa', 'coder', 'reviewer'],
            findingsLedger: [terminalFinding],
            loopExitReason: 'hard-budget',
            objectionOpen: false,
            reviewerVerdict: {
              outcome: 'fail',
              findings: [terminalFinding],
              objections: [terminalFinding],
            },
            handoffNotes: ['partial fix is on the branch and the terminal finding is non-reversible'],
            blockedReason: 'non-reversible high terminal finding must hold the branch',
          };
        },
      });

      try {
        const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));
        const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');
        expect(terminal?.kind).toBe('completed');
        expect(terminal?.data).toMatchObject({
          held: true,
          reason: expect.stringMatching(/non-reversible|high|terminal finding|hold/i),
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
          reason: expect.stringMatching(/non-reversible|high|terminal finding|hold/i),
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
          findingsLedger: [],
          loopExitReason: 'hard-budget',
          objectionOpen: true,
          handoffNotes: [],
          blockedReason: 'test cleanup hard block',
        });
        await waitForCondition(() => runId !== undefined && !activeRuns.has(runId));
        // This test is about child-liveness heartbeat, not terminal preservation.
        // A plain cleanup block is no longer a Phase 14 parked-human terminal.
        expect(destroyed).toBe(true);
      } finally {
        finishRole?.({
          taskId: 'placeholder',
          outcome: 'blocked',
          rolesInvoked: ['qa'],
          findingsLedger: [],
          loopExitReason: 'hard-budget',
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
