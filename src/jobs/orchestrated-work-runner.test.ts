import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../config.js';
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
type MockValidationCommandListResult =
  | { ok: true }
  | { ok: false; command: string; result: { exitCode: number | null; timedOut: boolean; outputTail: string } };
const mockRunValidationCommands = vi.hoisted(() =>
  vi.fn(async (
    _commands: readonly string[],
    _cwd: string,
    _timeoutMs: number,
  ): Promise<MockValidationCommandListResult> => ({ ok: true })),
);

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
  runValidationCommands: mockRunValidationCommands,
}));

import {
  orchestratedWorkApplier,
  __setOrchestratedRuntimeForTest,
  __resetOrchestratedRuntimeForTest,
  __getRuntimeDepsForTest,
  redispatchRecoveredOrchestratedMutation,
  fileTerminalBugsToBacklog,
} from './orchestrated-work-runner.js';
import type { OrchestrationTerminalBugEntry } from '../intent/project-orchestrator.js';
import {
  activeRuns,
  cancelMutation,
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
      product: 'rune',
      project,
      worktree: dir,
      egressAllowlist: [],
      baseSha: 'abc123',
      resumed: false,
    },
    dir,
  };
}

function writeValidProjectContext(dir: string, project = 'demo'): void {
  writeFileSync(join(dir, 'docs', 'projects', project, 'context.md'), [
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
}

function initGitRepo(dir: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, env, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: dir, env, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, env, stdio: 'ignore' });
}

function makeDescriptor(
  payload: { projectSlug: string; product?: string } = { projectSlug: 'demo', product: 'rune' },
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
    product: 'rune',
    branch: 'rune-work/demo',
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
    let refreshRegistrySpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      created = false;
      destroyed = false;
      wtDir = null;
      refreshRegistrySpy = vi.fn();
      mockRunFinalizer.mockClear();
      mockRunGate.mockReset();
      mockRunGate.mockResolvedValue({ ok: true });
      mockRunValidationCommands.mockReset();
      mockRunValidationCommands.mockResolvedValue({ ok: true });
      mockAppendMutationLine.mockClear();
      mockUpsertRun.mockClear();
      mockCreateTranscriptSink.mockReset();
      activeRuns.clear();
      __setOrchestratedRuntimeForTest({
        refreshRegistry: refreshRegistrySpy as () => void,
      });
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
      const descriptor = makeDescriptor({ projectSlug, product: 'rune' }, 'mut-recovered-redispatch');
      const result = redispatchRecoveredOrchestratedMutation(descriptor, {
        branch: 'rune-work/recovered-branch',
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
        branch: 'rune-work/recovered-branch',
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

    it.each([
      {
        label: 'finalized',
        runId: 'mut-orch-atomic-finalized',
        expectedStatus: 'completed' as const,
        runOrchestration: async (): Promise<OrchestrationResult> => ({ kind: 'finalized', outcome: 'branch-complete' }),
      },
      {
        label: 'held',
        runId: 'mut-orch-atomic-held',
        expectedStatus: 'completed' as const,
        runOrchestration: async (): Promise<OrchestrationResult> => ({
          kind: 'held',
          reason: 'branch complete; held for terminal verification',
          handoff: {
            runId: 'mut-orch-atomic-held',
            project: 'demo',
            product: 'rune',
            branch: 'rune-work/demo',
            taskRecords: [],
          },
        }),
      },
      {
        label: 'blocked',
        runId: 'mut-orch-atomic-blocked',
        expectedStatus: 'failed' as const,
        runOrchestration: async (): Promise<OrchestrationResult> => ({
          kind: 'blocked',
          reason: 'closeout checks failed',
          task: { id: 't1', text: 'task one', section: 'Phase 1' },
        }),
      },
      {
        label: 'failed',
        runId: 'mut-orch-atomic-failed',
        expectedStatus: 'failed' as const,
        runOrchestration: async (): Promise<OrchestrationResult> => {
          throw new Error('orchestration loop failed after work product');
        },
      },
    ])(
      'persists terminal mutation + supervision in the applier terminal step for $label, independent of startApply consuming the event',
      async ({ runId, expectedStatus, runOrchestration }) => {
        const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-atomic-terminal-'));
        const { runGit } = makeWorkProductGitStub({
          commitShas: [],
          diffstat: '',
        });
        __setOrchestratedRuntimeForTest({
          createWorktree: async () => {
            created = true;
            const { sandbox, dir } = makeWorktree();
            wtDir = dir;
            return { ...sandbox, baseSha: 'base-atomic-terminal' };
          },
          destroyWorktree: async () => {
            destroyed = true;
          },
          runGit,
          workRunsDir: artifactsDir,
          workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
          runOrchestration,
        });

        try {
          const descriptor = makeDescriptor(undefined, runId);
          const iterator = orchestratedWorkApplier.apply(descriptor, ctx)[Symbol.asyncIterator]();
          const start = await iterator.next();
          expect(start.value).toMatchObject({ kind: 'log', mutationId: runId });

          mockAppendMutationLine.mockClear();
          mockUpsertRun.mockClear();

          const terminalStep = await iterator.next();
          const terminal = terminalStep.value as MutationEvent;
          expect(terminalStep.done).toBe(false);
          expect(terminal.kind).toBe(expectedStatus === 'completed' ? 'completed' : 'failed');
          expect(existsSync(join(artifactsDir, runId, 'summary.json'))).toBe(true);

          const terminalMutationWrites = mockAppendMutationLine.mock.calls
            .map(([entry]) => entry as MutationDescriptor)
            .filter((entry) => entry.id === runId);
          expect(
            terminalMutationWrites.at(-1),
            'the applier must persist the terminal mutation status before yielding a terminal event to startApply',
          ).toMatchObject({
            id: runId,
            kind: 'orchestrated-work',
            status: expectedStatus,
          });

          const terminalSupervisionWrites = mockUpsertRun.mock.calls
            .map(([run]) => run as SupervisedRun)
            .filter((run) => run.id === runId);
          expect(
            terminalSupervisionWrites.at(-1),
            'the applier must persist supervised-runs terminal status in the same terminal step as work-product artifacts',
          ).toMatchObject({
            id: runId,
            kind: 'orchestrated-work',
            status: expectedStatus,
          });
        } finally {
          rmSync(artifactsDir, { recursive: true, force: true });
        }
      },
    );

    it('does not strand a run when the consumer abandons after work-product artifacts are written but before the terminal event is consumed', async () => {
      const runId = 'mut-orch-lost-yield-no-strand';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-lost-yield-'));
      const { runGit } = makeWorkProductGitStub({
        commitShas: ['abc1111'],
        diffstat: ' src/feature.ts | 1 +\n 1 file changed, 1 insertion(+)\n',
      });
      let releaseFinalizer!: () => void;
      const allowFinalizerReturn = new Promise<void>((resolve) => {
        releaseFinalizer = resolve;
      });
      let summaryWritten!: () => void;
      const summaryWrittenPromise = new Promise<void>((resolve) => {
        summaryWritten = resolve;
      });

      mockRunFinalizer.mockImplementationOnce(async (_input, effects) => {
        const terminalEvent = await effects.classify();
        await effects.flushTranscript();
        effects.writeSummary(terminalEvent);
        effects.appendIndexRow(terminalEvent);
        effects.writeSupervisionTerminal('completed', terminalEvent);
        summaryWritten();
        await allowFinalizerReturn;
        return {
          outcome: 'branch-complete',
          terminalEvent,
          supervisionStatus: 'completed',
          worktreeRemoved: false,
          merged: false,
          branchDeleted: false,
          phases: ['classified', 'transcript-flushed', 'summary-written', 'index-appended'],
        };
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', '- [x] task one\n');
          wtDir = dir;
          return { ...sandbox, baseSha: 'base-lost-yield' };
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runGit,
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
        runOrchestration: async (deps) => finalizeAsOrchestrationResult(deps),
      });

      const iterator = orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx)[Symbol.asyncIterator]();
      let terminalConsumed = false;
      let abandon: Promise<IteratorResult<MutationEvent>> | undefined;
      const terminalStep = iterator.next().then((step) => {
        terminalConsumed = step.done !== true && (step.value.kind === 'completed' || step.value.kind === 'failed');
        return step;
      });

      try {
        const start = await terminalStep;
        expect(start.value).toMatchObject({ kind: 'log', mutationId: runId });

        mockAppendMutationLine.mockClear();
        mockUpsertRun.mockClear();
        terminalConsumed = false;
        const droppedTerminal = iterator.next().then((step) => {
          terminalConsumed = step.done !== true && (step.value.kind === 'completed' || step.value.kind === 'failed');
          return step;
        });

        await summaryWrittenPromise;
        expect(existsSync(join(artifactsDir, runId, 'summary.json'))).toBe(true);

        abandon = iterator.return?.(undefined as never);
        await Promise.resolve();
        expect(terminalConsumed, 'the terminal event must not be consumed in this lost-yield scenario').toBe(false);

        const terminalMutationWrites = mockAppendMutationLine.mock.calls
          .map(([entry]) => entry as MutationDescriptor)
          .filter((entry) => entry.id === runId);
        expect(
          terminalMutationWrites.at(-1),
          'once work-product artifacts are written, abandoning the iterator must not leave the mutation running',
        ).toMatchObject({
          id: runId,
          kind: 'orchestrated-work',
          status: 'completed',
        });

        const terminalSupervisionWrites = mockUpsertRun.mock.calls
          .map(([run]) => run as SupervisedRun)
          .filter((run) => run.id === runId);
        expect(
          terminalSupervisionWrites.at(-1),
          'once work-product artifacts are written, abandoning the iterator must not leave supervision running',
        ).toMatchObject({
          id: runId,
          kind: 'orchestrated-work',
          status: 'completed',
        });

        releaseFinalizer();
        await Promise.allSettled([droppedTerminal, abandon ?? Promise.resolve({ done: true, value: undefined as never })]);
      } finally {
        releaseFinalizer?.();
        await abandon?.catch(() => undefined);
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('treats the yielded terminal event as notification-only after the applier writes lifecycle state', async () => {
      const projectSlug = '14-product-team-agents';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-notification-only-terminal-'));
      const ordering: string[] = [];
      const { runGit } = makeWorkProductGitStub({
        commitShas: ['abc1111'],
        diffstat: ' src/feature.ts | 1 +\n 1 file changed, 1 insertion(+)\n',
      });
      const previousAppendMutationLineImpl = mockAppendMutationLine.getMockImplementation();
      const previousUpsertRunImpl = mockUpsertRun.getMockImplementation();

      mockAppendMutationLine.mockImplementation((entry: MutationDescriptor) => {
        ordering.push(`mutation:${entry.status}`);
      });
      mockUpsertRun.mockImplementation((run: SupervisedRun) => {
        ordering.push(`supervision:${run.status}`);
      });

      const bus = {
        publish: vi.fn((event: { subKind?: string }) => {
          if (event.subKind === 'completed' || event.subKind === 'failed') {
            ordering.push(`bus:${event.subKind}`);
          }
        }),
      };
      setMutationBus(bus as never);

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree(projectSlug, '- [x] task one\n');
          wtDir = dir;
          return { ...sandbox, baseSha: 'base-notification-only-terminal' };
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runGit,
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
        runOrchestration: async (): Promise<OrchestrationResult> => ({
          kind: 'finalized',
          outcome: 'branch-complete',
        }),
      });

      try {
        registerApplier(orchestratedWorkApplier);
        const createdMutation = await createMutation(
          'orchestrated-work',
          { projectSlug, product: 'rune' },
          'webview',
        );
        if (!createdMutation.ok) throw new Error(createdMutation.reason);
        const runId = createdMutation.descriptor.id;

        await waitForCondition(() => !activeRuns.has(runId));

        const terminalMutationWrites = mockAppendMutationLine.mock.calls
          .map(([entry]) => entry as MutationDescriptor)
          .filter((entry) => entry.id === runId && entry.status === 'completed');
        expect(
          terminalMutationWrites,
          'the applier is the single lifecycle-terminal writer; startApply must not append a second terminal line after notification publish',
        ).toHaveLength(1);

        const terminalSupervisionWrites = mockUpsertRun.mock.calls
          .map(([run]) => run as SupervisedRun)
          .filter((run) => run.id === runId && run.status === 'completed');
        expect(
          terminalSupervisionWrites,
          'the applier is the single terminal supervision writer; consuming the yielded event must not duplicate it',
        ).toHaveLength(1);

        const terminalMutationIndex = ordering.indexOf('mutation:completed');
        const terminalSupervisionIndex = ordering.indexOf('supervision:completed');
        const terminalBusIndex = ordering.indexOf('bus:completed');
        expect(terminalMutationIndex).toBeGreaterThanOrEqual(0);
        expect(terminalSupervisionIndex).toBeGreaterThanOrEqual(0);
        expect(terminalBusIndex).toBeGreaterThanOrEqual(0);
        expect(terminalMutationIndex).toBeLessThan(terminalBusIndex);
        expect(terminalSupervisionIndex).toBeLessThan(terminalBusIndex);
      } finally {
        setMutationBus(null);
        mockAppendMutationLine.mockImplementation(previousAppendMutationLineImpl ?? (() => undefined));
        mockUpsertRun.mockImplementation(previousUpsertRunImpl ?? (() => undefined));
        mockAppendMutationLine.mockClear();
        mockUpsertRun.mockClear();
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it.each([
      {
        outcome: 'branch-complete',
        runId: 'mut-orch-agree-branch-complete',
        expectedStatus: 'completed' as const,
        git: {
          commitShas: ['bc1111'],
          diffstat: ' src/complete.ts | 1 +\n 1 file changed, 1 insertion(+)\n',
        },
        tasks: '- [x] task one\n',
        runOrchestration: async (): Promise<OrchestrationResult> => {
          throw new Error('late loop failure after a branch-complete work product');
        },
      },
      {
        outcome: 'partial',
        runId: 'mut-orch-agree-partial',
        expectedStatus: 'completed' as const,
        git: {
          commitShas: ['pa1111'],
          diffstat: ' src/partial.ts | 1 +\n 1 file changed, 1 insertion(+)\n',
        },
        tasks: '- [ ] task one\n',
        runOrchestration: async (): Promise<OrchestrationResult> => ({ kind: 'finalized', outcome: 'partial' }),
      },
      {
        outcome: 'noop',
        runId: 'mut-orch-agree-noop',
        expectedStatus: 'completed' as const,
        git: {
          commitShas: [],
          diffstat: '',
        },
        tasks: '- [ ] task one\n',
        runOrchestration: async (): Promise<OrchestrationResult> => ({ kind: 'finalized', outcome: 'noop' }),
      },
      {
        outcome: 'dirty-uncommitted',
        runId: 'mut-orch-agree-dirty',
        expectedStatus: 'completed' as const,
        git: {
          commitShas: [],
          diffstat: '',
          status: ' M src/dirty.ts\n',
        },
        tasks: '- [ ] task one\n',
        runOrchestration: async (): Promise<OrchestrationResult> => ({ kind: 'finalized', outcome: 'dirty-uncommitted' }),
      },
      {
        outcome: 'failed',
        runId: 'mut-orch-agree-failed',
        expectedStatus: 'failed' as const,
        git: {
          commitShas: [],
          diffstat: '',
        },
        tasks: '- [ ] task one\n',
        runOrchestration: async (): Promise<OrchestrationResult> => {
          throw new Error('orchestration loop failed with no terminal work product');
        },
      },
    ])(
      'keeps durable work-product and lifecycle layers in agreement for $outcome',
      async ({ outcome, runId, expectedStatus, git, tasks, runOrchestration }) => {
        const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-lifecycle-agreement-'));
        const { runGit } = makeWorkProductGitStub(git);
        __setOrchestratedRuntimeForTest({
          createWorktree: async () => {
            created = true;
            const { sandbox, dir } = makeWorktree('demo', '- [ ] task one\n');
            wtDir = dir;
            writeFileSync(join(dir, 'docs', 'projects', 'demo', 'tasks.md'), tasks, 'utf8');
            return { ...sandbox, baseSha: 'base-lifecycle-agreement' };
          },
          destroyWorktree: async () => {
            destroyed = true;
          },
          runGit,
          workRunsDir: artifactsDir,
          workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
          runOrchestration,
        });

        try {
          const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));
          const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');
          expect(terminal, 'the applier must yield exactly one terminal event').toBeDefined();

          const summary = JSON.parse(readFileSync(join(artifactsDir, runId, 'summary.json'), 'utf8')) as {
            outcome: string;
          };
          expect(summary.outcome).toBe(outcome);

          const terminalMutationWrites = mockAppendMutationLine.mock.calls
            .map(([entry]) => entry as MutationDescriptor)
            .filter((entry) => entry.id === runId);
          const mutation = terminalMutationWrites.at(-1);
          expect(mutation).toMatchObject({
            id: runId,
            kind: 'orchestrated-work',
            status: expectedStatus,
            outcome,
          });

          const terminalSupervisionWrites = mockUpsertRun.mock.calls
            .map(([run]) => run as SupervisedRun)
            .filter((run) => run.id === runId);
          expect(terminalSupervisionWrites.at(-1)).toMatchObject({
            id: runId,
            kind: 'orchestrated-work',
            status: expectedStatus,
          });

          if (summary.outcome === 'branch-complete') {
            expect(mutation?.status, 'a branch-complete work product must not be lifecycle-failed').toBe('completed');
          }
          expect(mutation?.status, 'a terminal work-product summary must not be paired with a running mutation').not.toBe('running');
          expect(terminalSupervisionWrites.at(-1)?.status, 'a terminal work-product summary must not be paired with running supervision').not.toBe('running');
        } finally {
          rmSync(artifactsDir, { recursive: true, force: true });
        }
      },
    );

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

    it('pumps Rune-owned orchestration lifecycle events as activity before the terminal event', async () => {
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
        ['commit', '-m', 'rune(rune): closeout — Build the streak core'],
        ['rev-parse', 'HEAD'],
      ]));
      expect(destroyed).toBe(true);
    });

    it('repairs a failed closeout validation by re-running the task workflow and proceeding', async () => {
      const runId = 'mut-closeout-validation-repairs';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-closeout-validation-repairs-'));
      const productsFile = join(artifactsDir, 'products.json');
      const repoPath = join(artifactsDir, 'canonical-repo');
      const priorProductsFile = process.env['PRODUCTS_CONFIG_FILE'];
      const gitCalls: string[][] = [];
      let capturedRunnerArgs: Record<string, unknown> | undefined;

      mkdirSync(repoPath, { recursive: true });
      writeFileSync(
        productsFile,
        JSON.stringify({
          rune: {
            repoPath,
            baseBranch: 'main',
            credentialsFile: '',
            egressAllowlist: [],
            validationCommands: ['npm test'],
          },
        }),
        'utf8',
      );
      process.env['PRODUCTS_CONFIG_FILE'] = productsFile;
      // ONE red validation; the beforeEach default restores {ok:true} for the
      // repair attempt's confirming re-run.
      mockRunValidationCommands.mockResolvedValueOnce({
        ok: false,
        command: 'npm test',
        result: {
          exitCode: 1,
          timedOut: false,
          outputTail:
            'FAIL src/streak.test.ts > renders the card\n' +
            'AssertionError: expected 3 to be 2\n' +
            ` at ${PROJECT_ROOT}/src/streak.test.ts:42`,
        },
      });

      const runGit = vi.fn(async (gitArgs: string[]) => {
        gitCalls.push([...gitArgs]);
        if (gitArgs[0] === 'status') return { stdout: '', stderr: '' };
        if (gitArgs[0] === 'rev-list') return { stdout: '', stderr: '' };
        if (gitArgs[0] === 'diff') return { stdout: '', stderr: '' };
        if (gitArgs[0] === 'rev-parse') return { stdout: 'closeout-sha\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', [
            '- [ ] Build the streak core',
            '- [ ] Render the streak card',
            '',
          ].join('\n'));
          writeValidProjectContext(dir);
          wtDir = dir;
          return sandbox;
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
        runGit,
        createTaskWorkflowRunner: (runnerArgs) => {
          capturedRunnerArgs = runnerArgs as unknown as Record<string, unknown>;
          return async (task) => ({
            taskId: task.id,
            outcome: 'ready-for-closeout',
            rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
            findingsLedger: [],
            loopExitReason: 'all-low',
            objectionOpen: false,
            handoffNotes: [`completed ${task.text}`],
            reviewerVerdict: { pass: true, objections: [] },
          });
        },
      });

      try {
        const events = await drain(orchestratedWorkApplier.apply(
          makeDescriptor(undefined, runId),
          ctx,
        ));
        const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');

        // The product's validationCommands reach the task-workflow runner (the
        // coder's full-suite self-gate), not only the closeout gate.
        expect(capturedRunnerArgs?.['validationCommands']).toEqual(['npm test']);

        // The single red validation is repaired, not terminal: the run completes.
        expect(terminal?.kind).toBe('completed');
        // The repair re-run surfaces as attempt-start #2 on the first task.
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'activity',
            data: expect.objectContaining({ event: 'attempt-start', attemptNumber: 2 }),
          }),
        ]));
        // Both tasks land normal closeout commits.
        expect(gitCalls).toEqual(expect.arrayContaining([
          ['commit', '-m', 'rune(rune): closeout — Build the streak core'],
          ['commit', '-m', 'rune(rune): closeout — Render the streak card'],
        ]));

        // The failure artifact records exactly ONE entry, and the activity event fired.
        const artifactPath = join(artifactsDir, runId, 'closeout-validation-failure.txt');
        expect(existsSync(artifactPath)).toBe(true);
        const artifact = readFileSync(artifactPath, 'utf8');
        expect(artifact.match(/=== closeout validation failure @/g)?.length).toBe(1);
        expect(artifact).toContain('FAIL src/streak.test.ts > renders the card');
        expect(artifact).not.toContain(PROJECT_ROOT);
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'activity',
            data: expect.objectContaining({
              event: 'closeout-validation-failed',
              taskId: 'build-the-streak-core',
              line: expect.stringContaining('closeout-validation-failure.txt'),
            }),
          }),
        ]));
      } finally {
        if (priorProductsFile === undefined) delete process.env['PRODUCTS_CONFIG_FILE'];
        else process.env['PRODUCTS_CONFIG_FILE'] = priorProductsFile;
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('exhausts closeout repair, WIP-commits the worktree, and parks blocked-on-human with the worktree preserved', async () => {
      const runId = 'mut-closeout-validation-exhausts';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-closeout-validation-exhausts-'));
      const productsFile = join(artifactsDir, 'products.json');
      const repoPath = join(artifactsDir, 'canonical-repo');
      const priorProductsFile = process.env['PRODUCTS_CONFIG_FILE'];
      const gitCalls: string[][] = [];

      mkdirSync(repoPath, { recursive: true });
      writeFileSync(
        productsFile,
        JSON.stringify({
          rune: {
            repoPath,
            baseBranch: 'main',
            credentialsFile: '',
            egressAllowlist: [],
            validationCommands: ['npm test'],
          },
        }),
        'utf8',
      );
      process.env['PRODUCTS_CONFIG_FILE'] = productsFile;
      // Persistently red: every attempt (initial + repairs) fails validation.
      mockRunValidationCommands.mockResolvedValue({
        ok: false,
        command: 'npm test',
        result: {
          exitCode: 1,
          timedOut: false,
          outputTail: 'FAIL src/streak.test.ts > renders the card',
        },
      });

      const runGit = vi.fn(async (gitArgs: string[]) => {
        gitCalls.push([...gitArgs]);
        // Dirty tree so the WIP commit has something to preserve.
        if (gitArgs[0] === 'status') return { stdout: ' M src/streak.ts\n', stderr: '' };
        if (gitArgs[0] === 'rev-list') return { stdout: '', stderr: '' };
        if (gitArgs[0] === 'diff') return { stdout: '', stderr: '' };
        if (gitArgs[0] === 'rev-parse') return { stdout: 'wipsha1234567\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', [
            '- [ ] Build the streak core',
            '- [ ] Render the streak card',
            '',
          ].join('\n'));
          writeValidProjectContext(dir);
          wtDir = dir;
          return sandbox;
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
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

      try {
        const events = await drain(orchestratedWorkApplier.apply(
          makeDescriptor(undefined, runId),
          ctx,
        ));
        const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');
        const terminalData = (terminal?.data ?? {}) as Record<string, unknown>;

        // Exhaustion is a PARKED (blocked-on-human) terminal, not a destructive
        // failure and not a held one: parked keeps the run releasable via the
        // standard blocked-on-human release path, which is what clears the
        // preserved worktree so a later Start can re-dispatch.
        expect(terminal?.kind).toBe('completed');
        expect(terminalData['parked']).toBe(true);
        expect(terminalData['held']).toBeUndefined();
        expect(String(terminalData['reason'])).toMatch(
          /orchestration parked on "Build the streak core": closeout checks failed after 3 attempts/,
        );
        expect(String(terminalData['reason'])).toContain('WIP preserved as wipsha1');
        expect(terminalData['preserveWorktree']).toBe(true);
        expect(destroyed).toBe(false);
        // The supervision row is blocked-on-human — visible to release/approvals.
        expect(mockUpsertRun).toHaveBeenCalledWith(
          expect.objectContaining({ id: runId, status: 'blocked-on-human' }),
          expect.anything(),
        );

        // Repair attempts surfaced (1..3), then the WIP preservation commit —
        // and never a closeout commit.
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'activity',
            data: expect.objectContaining({ event: 'attempt-start', attemptNumber: 3 }),
          }),
          expect.objectContaining({
            kind: 'activity',
            data: expect.objectContaining({
              event: 'closeout-wip-commit',
              taskId: 'build-the-streak-core',
            }),
          }),
        ]));
        const commitMessages = gitCalls
          .filter((args) => args[0] === 'commit')
          .map((args) => args[2] ?? '');
        expect(commitMessages).toEqual([
          expect.stringContaining('WIP — closeout blocked — Build the streak core'),
        ]);

        // One artifact entry per failed attempt.
        const artifact = readFileSync(
          join(artifactsDir, runId, 'closeout-validation-failure.txt'),
          'utf8',
        );
        expect(artifact.match(/=== closeout validation failure @/g)?.length).toBe(3);

        // The preserved worktree still shows the task unchecked.
        if (wtDir === null) throw new Error('worktree was never created');
        const tasksMd = readFileSync(join(wtDir, 'docs', 'projects', 'demo', 'tasks.md'), 'utf8');
        expect(tasksMd).toContain('- [ ] Build the streak core');
      } finally {
        if (priorProductsFile === undefined) delete process.env['PRODUCTS_CONFIG_FILE'];
        else process.env['PRODUCTS_CONFIG_FILE'] = priorProductsFile;
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('runs passing closeout validation before staging, committing, and emitting closeout progress', async () => {
      const runId = 'mut-closeout-validation-passes';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-closeout-validation-passes-'));
      const productsFile = join(artifactsDir, 'products.json');
      const repoPath = join(artifactsDir, 'canonical-repo');
      const priorProductsFile = process.env['PRODUCTS_CONFIG_FILE'];
      const operations: string[] = [];

      mkdirSync(repoPath, { recursive: true });
      writeFileSync(
        productsFile,
        JSON.stringify({
          rune: {
            repoPath,
            baseBranch: 'main',
            credentialsFile: '',
            egressAllowlist: [],
            validationCommands: ['npm test'],
          },
        }),
        'utf8',
      );
      process.env['PRODUCTS_CONFIG_FILE'] = productsFile;
      mockRunValidationCommands.mockImplementationOnce(async () => {
        operations.push('validation');
        return { ok: true as const };
      });

      const runGit = vi.fn(async (gitArgs: string[]) => {
        if (gitArgs[0] === 'add') operations.push('git:add');
        if (gitArgs[0] === 'commit') operations.push('git:commit');
        if (gitArgs[0] === 'rev-parse') return { stdout: 'closeout-pass-sha\n', stderr: '' };
        if (gitArgs[0] === 'rev-list') return { stdout: 'closeout-pass-sha\n', stderr: '' };
        if (gitArgs[0] === 'diff') return { stdout: ' src/feature.ts | 1 +\n', stderr: '' };
        if (gitArgs[0] === 'status') return { stdout: '', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', [
            '- [ ] Build the streak core',
            '- [ ] Render the streak card',
            '',
          ].join('\n'));
          writeValidProjectContext(dir);
          wtDir = dir;
          return sandbox;
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
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

      try {
        const events = await drain(orchestratedWorkApplier.apply(
          makeDescriptor(undefined, runId),
          ctx,
        ));
        const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');
        const progress = events.filter((event) => {
          const data = (event.data ?? {}) as Record<string, unknown>;
          return event.kind === 'progress' && data['event'] === 'closeout-commit';
        });

        expect(terminal?.kind).toBe('completed');
        expect(operations).toEqual(expect.arrayContaining(['validation', 'git:add', 'git:commit']));
        expect(operations.indexOf('validation')).toBeLessThan(operations.indexOf('git:add'));
        expect(operations.indexOf('validation')).toBeLessThan(operations.indexOf('git:commit'));
        expect(progress).toEqual(expect.arrayContaining([
          expect.objectContaining({
            mutationId: runId,
            kind: 'progress',
            data: expect.objectContaining({
              event: 'closeout-commit',
              taskId: 'build-the-streak-core',
              commitSha: 'closeout-pass-sha',
            }),
          }),
        ]));
        expect(readFileSync(join(wtDir!, 'docs', 'projects', 'demo', 'tasks.md'), 'utf8')).toContain('- [x] Build the streak core');
        expect(destroyed).toBe(true);
      } finally {
        if (priorProductsFile === undefined) delete process.env['PRODUCTS_CONFIG_FILE'];
        else process.env['PRODUCTS_CONFIG_FILE'] = priorProductsFile;
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('runs closeout validation in the task sandbox worktree, not the product repo or gate worktree', async () => {
      const runId = 'mut-closeout-validation-cwd';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-closeout-validation-cwd-'));
      const productsFile = join(artifactsDir, 'products.json');
      const repoPath = join(artifactsDir, 'canonical-repo');
      const integrationWorktree = join(artifactsDir, 'gate-worktree');
      const priorProductsFile = process.env['PRODUCTS_CONFIG_FILE'];
      let validationCwd = '';

      mkdirSync(repoPath, { recursive: true });
      writeFileSync(
        productsFile,
        JSON.stringify({
          rune: {
            repoPath,
            baseBranch: 'main',
            credentialsFile: '',
            egressAllowlist: [],
            validationCommands: ['npm test'],
          },
        }),
        'utf8',
      );
      process.env['PRODUCTS_CONFIG_FILE'] = productsFile;
      mockRunValidationCommands.mockImplementationOnce(async (_commands, cwd) => {
        validationCwd = String(cwd);
        return { ok: true as const };
      });

      const runGit = vi.fn(async (gitArgs: string[]) => {
        if (gitArgs[0] === 'rev-parse') return { stdout: 'closeout-cwd-sha\n', stderr: '' };
        if (gitArgs[0] === 'rev-list') return { stdout: 'closeout-cwd-sha\n', stderr: '' };
        if (gitArgs[0] === 'diff') return { stdout: ' src/feature.ts | 1 +\n', stderr: '' };
        if (gitArgs[0] === 'status') return { stdout: '', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', '- [ ] Build the streak core\n');
          writeValidProjectContext(dir);
          wtDir = dir;
          return sandbox;
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        integrationWorktree: () => integrationWorktree,
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
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

      try {
        const events = await drain(orchestratedWorkApplier.apply(
          makeDescriptor(undefined, runId),
          ctx,
        ));
        expect(events.find((event) => event.kind === 'completed' || event.kind === 'failed')?.kind).toBe('completed');
        expect(validationCwd).toBe(wtDir);
        expect(validationCwd).not.toBe(repoPath);
        expect(validationCwd).not.toBe(integrationWorktree);
      } finally {
        if (priorProductsFile === undefined) delete process.env['PRODUCTS_CONFIG_FILE'];
        else process.env['PRODUCTS_CONFIG_FILE'] = priorProductsFile;
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('passes branch-wide tree-state evidence into each task workflow context', async () => {
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-tree-state-context-'));
      let capturedContext = '';
      const runGit = vi.fn(async (gitArgs: string[]) => {
        if (gitArgs[0] === 'diff' && gitArgs[1] === '--name-only') {
          return { stdout: 'src/transport/notification-bus.ts\n', stderr: '' };
        }
        if (gitArgs[0] === 'diff' && gitArgs[1] === '--stat') {
          return { stdout: ' src/transport/notification-bus.ts | 3 +++\n', stderr: '' };
        }
        if (gitArgs[0] === 'diff' && gitArgs[1] === '--unified=3') {
          return {
            stdout: [
              'diff --git a/src/transport/notification-bus.ts b/src/transport/notification-bus.ts',
              '+export interface BusRunEvent {',
              '+  runId: string;',
              '+}',
              '',
            ].join('\n'),
            stderr: '',
          };
        }
        if (gitArgs[0] === 'rev-parse') return { stdout: 'closeout-tree-state-sha\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', '- [ ] Run event bus contract\n');
          wtDir = dir;
          return { ...sandbox, baseSha: 'base-tree-state' };
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runGit,
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
        createTaskWorkflowRunner: () => async (task, taskCtx) => {
          capturedContext = taskCtx.contextMd;
          return {
            taskId: task.id,
            outcome: 'ready-for-closeout',
            rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
            findingsLedger: [],
            loopExitReason: 'all-low',
            objectionOpen: false,
            handoffNotes: [`completed ${task.text}`],
            reviewerVerdict: { pass: true, objections: [] },
          };
        },
      });

      const events = await drain(orchestratedWorkApplier.apply(
        makeDescriptor(undefined, 'mut-tree-state-context'),
        ctx,
      ));

      expect(events.find((event) => event.kind === 'completed' || event.kind === 'failed')?.kind).toBe('completed');
      expect(capturedContext).toContain('## Branch Tree-State Evidence');
      expect(capturedContext).toContain('Base ref: main...HEAD');
      expect(capturedContext).toContain('src/transport/notification-bus.ts');
      expect(capturedContext).toContain('export interface BusRunEvent');
    });

    it('keeps best-effort tree-state evidence when one git probe fails and caps oversized sections', async () => {
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-tree-state-capped-'));
      const longChangedFiles = Array.from(
        { length: 700 },
        (_, i) => `src/generated/${String(i).padStart(3, '0')}.ts`,
      ).join('\n');
      let capturedContext = '';
      const runGit = vi.fn(async (gitArgs: string[]) => {
        if (gitArgs[0] === 'diff' && gitArgs[1] === '--name-only') {
          return { stdout: `${longChangedFiles}\n`, stderr: '' };
        }
        if (gitArgs[0] === 'diff' && gitArgs[1] === '--stat') {
          throw new Error('stat unavailable');
        }
        if (gitArgs[0] === 'diff' && gitArgs[1] === '--unified=3') {
          return {
            stdout: 'diff --git a/src/x.ts b/src/x.ts\n+export const BusRunEvent = true;\n',
            stderr: '',
          };
        }
        if (gitArgs[0] === 'rev-parse') return { stdout: 'closeout-capped-sha\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', '- [ ] Run event bus contract\n');
          wtDir = dir;
          return { ...sandbox, baseSha: 'base-tree-state-capped' };
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runGit,
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
        createTaskWorkflowRunner: () => async (task, taskCtx) => {
          capturedContext = taskCtx.contextMd;
          return {
            taskId: task.id,
            outcome: 'ready-for-closeout',
            rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
            findingsLedger: [],
            loopExitReason: 'all-low',
            objectionOpen: false,
            handoffNotes: [`completed ${task.text}`],
            reviewerVerdict: { pass: true, objections: [] },
          };
        },
      });

      const events = await drain(orchestratedWorkApplier.apply(
        makeDescriptor(undefined, 'mut-tree-state-capped'),
        ctx,
      ));

      expect(events.find((event) => event.kind === 'completed' || event.kind === 'failed')?.kind).toBe('completed');
      expect(capturedContext).toContain('## Branch Tree-State Evidence');
      expect(capturedContext).toContain('src/generated/000.ts');
      expect(capturedContext).toContain('[truncated branch tree-state evidence]');
      expect(capturedContext).toContain('Diffstat already present on this branch:\n(none reported)');
      expect(capturedContext).toContain('export const BusRunEvent = true');
    });

    it('emits one closeout progress event for each successful commitCloseout with live remaining counts', async () => {
      const commitShas = ['1111111aaaaaaa', '2222222bbbbbbb'];
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-closeout-progress-'));
      let revParseCalls = 0;
      const runGit = vi.fn(async (gitArgs: string[]) => {
        if (gitArgs[0] === 'rev-parse') {
          const sha = commitShas[revParseCalls] ?? commitShas[commitShas.length - 1]!;
          revParseCalls += 1;
          return { stdout: `${sha}\n`, stderr: '' };
        }
        if (gitArgs[0] === 'rev-list') {
          return { stdout: `${commitShas.join('\n')}\n`, stderr: '' };
        }
        if (gitArgs[0] === 'diff' && gitArgs.includes('--stat')) {
          return { stdout: ' src/feature.ts | 2 ++\n 1 file changed, 2 insertions(+)\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', [
            '## Phase 1',
            '- [ ] Build the streak core',
            '- [ ] Render the streak card',
            '',
          ].join('\n'));
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
        workRunsDir: artifactsDir,
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

      try {
        const events = await drain(orchestratedWorkApplier.apply(
          makeDescriptor(undefined, 'mut-closeout-progress-events'),
          ctx,
        ));
        const terminalIndex = events.findIndex((event) => event.kind === 'completed' || event.kind === 'failed');
        const progress = events.slice(0, terminalIndex).filter((event) => {
          const data = (event.data ?? {}) as Record<string, unknown>;
          return event.kind === 'progress' && data['event'] === 'closeout-commit';
        });

        expect(progress).toHaveLength(2);
        expect(progress[0]).toMatchObject({
          mutationId: 'mut-closeout-progress-events',
          kind: 'progress',
          data: {
            event: 'closeout-commit',
            projectSlug: 'demo',
            product: 'rune',
            taskId: 'build-the-streak-core',
            taskText: 'Build the streak core',
            commitSha: '1111111aaaaaaa',
            shortSha: '1111111',
            commitSubject: 'rune(rune): closeout — Build the streak core',
            tasksDone: 1,
            tasksTotal: 2,
            tasksRemaining: 1,
            line: expect.stringMatching(/Build the streak core.*1\/2 done.*1 remaining/i),
          },
        });
        expect(progress[1]).toMatchObject({
          mutationId: 'mut-closeout-progress-events',
          kind: 'progress',
          data: {
            event: 'closeout-commit',
            projectSlug: 'demo',
            product: 'rune',
            taskId: 'render-the-streak-card',
            taskText: 'Render the streak card',
            commitSha: '2222222bbbbbbb',
            shortSha: '2222222',
            commitSubject: 'rune(rune): closeout — Render the streak card',
            tasksDone: 2,
            tasksTotal: 2,
            tasksRemaining: 0,
            line: expect.stringMatching(/Render the streak card.*2\/2 done.*0 remaining/i),
          },
        });
        expect(destroyed).toBe(true);
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('dedupes closeout progress alerts across replay by commit sha while still alerting for a new closeout commit', async () => {
      const runId = 'mut-progress-replay-dedupe';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-progress-dedupe-'));
      const createdDirs: string[] = [];
      const closeoutShas = [
        '1111111aaaaaaa',
        '1111111aaaaaaa',
        '2222222bbbbbbb',
      ];
      let revParseCalls = 0;
      let applierRun = 0;

      const runGit = vi.fn(async (gitArgs: string[]) => {
        if (gitArgs[0] === 'rev-parse') {
          const sha = closeoutShas[revParseCalls] ?? closeoutShas[closeoutShas.length - 1]!;
          revParseCalls += 1;
          return { stdout: `${sha}\n`, stderr: '' };
        }
        if (gitArgs[0] === 'rev-list') {
          return { stdout: `${closeoutShas.slice(0, revParseCalls).join('\n')}\n`, stderr: '' };
        }
        if (gitArgs[0] === 'diff' && gitArgs.includes('--stat')) {
          return { stdout: ' src/feature.ts | 2 ++\n 1 file changed, 2 insertions(+)\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const validContext = [
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
      ].join('\n');

      const progressCommitShas = (events: MutationEvent[]): string[] =>
        events
          .filter((event) => {
            const data = (event.data ?? {}) as Record<string, unknown>;
            return event.kind === 'progress' && data['event'] === 'closeout-commit';
          })
          .map((event) => String(((event.data ?? {}) as Record<string, unknown>)['commitSha']));

      const installRuntime = () => {
        __setOrchestratedRuntimeForTest({
          workRunsDir: artifactsDir,
          workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
          createWorktree: async () => {
            applierRun += 1;
            created = true;
            const { sandbox, dir } = makeWorktree('demo', [
              '## Phase 1',
              '- [ ] Build the streak core',
              '- [ ] Render the streak card',
              '',
            ].join('\n'));
            createdDirs.push(dir);
            wtDir = dir;
            writeFileSync(join(dir, 'docs', 'projects', 'demo', 'context.md'), validContext, 'utf8');
            return sandbox;
          },
          destroyWorktree: async () => {
            destroyed = true;
          },
          runGit,
          createTaskWorkflowRunner: () => async (task): Promise<TaskEvidence> => {
            if (applierRun === 1 && task.id === 'render-the-streak-card') {
              return {
                taskId: task.id,
                outcome: 'blocked',
                rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
                findingsLedger: [],
                loopExitReason: 'hard-budget',
                objectionOpen: true,
                handoffNotes: ['blocked after first closeout commit'],
                blockedReason: 'simulated stop before the next closeout commit',
              };
            }

            return {
              taskId: task.id,
              outcome: 'ready-for-closeout',
              rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
              findingsLedger: [],
              loopExitReason: 'all-low',
              objectionOpen: false,
              handoffNotes: [`completed ${task.text}`],
              reviewerVerdict: { pass: true, objections: [] },
            };
          },
        });
      };

      installRuntime();

      try {
        const firstPass = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));
        // Simulate a daemon restart: process memory is gone, but the run artifact
        // directory is still present and must carry the delivery-state dedupe.
        __resetOrchestratedRuntimeForTest();
        installRuntime();
        const replayPass = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));

        expect(progressCommitShas(firstPass)).toEqual(['1111111aaaaaaa']);
        expect(progressCommitShas(replayPass)).toEqual(['2222222bbbbbbb']);
        expect([...progressCommitShas(firstPass), ...progressCommitShas(replayPass)]).toEqual([
          '1111111aaaaaaa',
          '2222222bbbbbbb',
        ]);
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
        for (const dir of createdDirs) {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    it('emits no closeout progress alert when a task blocks before any closeout commit exists', async () => {
      const { runGit, calls: gitCalls } = makeWorkProductGitStub({
        commitShas: [],
        diffstat: '',
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', [
            '## Phase 1',
            '- [ ] Build the streak core',
            '- [ ] Render the streak card',
            '',
          ].join('\n'));
          wtDir = dir;
          return sandbox;
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runGit,
        createTaskWorkflowRunner: () => async (task) => ({
          taskId: task.id,
          outcome: 'blocked',
          rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
          findingsLedger: [],
          loopExitReason: 'hard-budget',
          objectionOpen: true,
          handoffNotes: ['blocked before closeout'],
          blockedReason: 'reviewer objection remains open',
        }),
      });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const progress = events.filter((event) => {
        const data = (event.data ?? {}) as Record<string, unknown>;
        return event.kind === 'progress' && data['event'] === 'closeout-commit';
      });
      const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');

      expect(progress).toEqual([]);
      expect(terminal?.kind).toBe('failed');
      expect(gitCalls.map((call) => call.args[0])).not.toContain('commit');
      expect(gitCalls.map((call) => call.args[0])).not.toContain('rev-parse');
      expect(destroyed).toBe(true);
    });

    it('writes a durable transcript.jsonl and summary.json for a completed orchestrated run', async () => {
      const runId = 'mut-orch-substrate';
      // Isolate the run dir in a temp workRunsDir (like every sibling test) so a
      // concurrent full-suite run or the live Rune work-run GC can't race the real
      // logs/work-runs/<runId> and make transcriptExistedAtTerminal flaky.
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-durable-transcript-'));
      const runDir = join(artifactsDir, runId);
      __setOrchestratedRuntimeForTest({
        workRunsDir: artifactsDir,
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
        product: 'rune',
        outcome: 'branch-complete',
      });
      expect(summary['transcriptPath']).toBe(join(runDir, 'transcript.jsonl'));
      expect(typeof summary['startedAt']).toBe('string');
      expect(typeof summary['endedAt']).toBe('string');
      expect(destroyed).toBe(true);

      rmSync(artifactsDir, { recursive: true, force: true });
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
        product: 'rune',
        branch: 'rune-work/demo',
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

    it('wires onLanded to one merge-success progress event naming the project and base branch', async () => {
      const runId = 'mut-orch-merge-success-notify';
      const { runGit } = makeWorkProductGitStub({
        commitShas: ['abc1111'],
        diffstat: ' src/feature.ts | 1 +\n 1 file changed, 1 insertion(+)\n',
      });
      mockRunFinalizer.mockImplementationOnce(async (_input, effects) => {
        const terminalEvent = await effects.classify();
        await effects.flushTranscript();
        effects.writeSummary(terminalEvent);
        effects.appendIndexRow(terminalEvent);
        if (effects.onLanded) effects.onLanded();
        effects.writeSupervisionTerminal('completed', terminalEvent);
        return {
          outcome: 'branch-complete',
          terminalEvent,
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
        };
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', '- [x] task one\n');
          wtDir = dir;
          return { ...sandbox, baseSha: 'base-notify-123' };
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runGit,
        runOrchestration: async (deps) => finalizeAsOrchestrationResult(deps),
      });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));
      const finalizerEffects = mockRunFinalizer.mock.calls[0]![1];
      const notifications = events.filter((event) => {
        const data = (event.data ?? {}) as Record<string, unknown>;
        return event.kind === 'progress' && data['event'] === 'merge-success';
      });
      const terminalIndex = events.findIndex((event) => event.kind === 'completed' || event.kind === 'failed');
      const notificationIndex = events.findIndex((event) => {
        const data = (event.data ?? {}) as Record<string, unknown>;
        return event.kind === 'progress' && data['event'] === 'merge-success';
      });

      expect(typeof finalizerEffects.onLanded).toBe('function');
      expect(refreshRegistrySpy).toHaveBeenCalledOnce();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        mutationId: runId,
        kind: 'progress',
        data: {
          event: 'merge-success',
          projectSlug: 'demo',
          product: 'rune',
          branch: 'rune-work/demo',
          baseBranch: 'main',
        },
      });
      expect(notificationIndex).toBeGreaterThanOrEqual(0);
      expect(terminalIndex).toBeGreaterThan(notificationIndex);
      expect(destroyed).toBe(true);
    });

    it('does not let a registry refresh failure block an orchestrated landed terminal', async () => {
      const runId = 'mut-orch-refresh-registry-fails';
      const { runGit } = makeWorkProductGitStub({
        commitShas: ['abc1111'],
        diffstat: ' src/feature.ts | 1 +\n 1 file changed, 1 insertion(+)\n',
      });
      refreshRegistrySpy.mockImplementationOnce(() => {
        throw new Error('registry scan failed');
      });
      mockRunFinalizer.mockImplementationOnce(async (_input, effects) => {
        const terminalEvent = await effects.classify();
        await effects.flushTranscript();
        effects.writeSummary(terminalEvent);
        effects.appendIndexRow(terminalEvent);
        effects.onLanded?.();
        effects.writeSupervisionTerminal('completed', terminalEvent);
        return {
          outcome: 'branch-complete',
          terminalEvent,
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
        };
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', '- [x] task one\n');
          wtDir = dir;
          return { ...sandbox, baseSha: 'base-refresh-fails-123' };
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        runGit,
        runOrchestration: async (deps) => finalizeAsOrchestrationResult(deps),
      });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));
      const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');

      expect(terminal?.kind).toBe('completed');
      expect((terminal?.data as Record<string, unknown>)['outcome']).toBe('branch-complete');
      expect(refreshRegistrySpy).toHaveBeenCalledOnce();
      expect(destroyed).toBe(true);
    });

    it('wires abortMerge to git merge --abort so apply-time index conflicts can clean the base checkout', async () => {
      const runId = 'mut-orch-abort-merge';
      const baseSha = 'base-abort-merge-123';
      const { runGit, calls } = makeWorkProductGitStub({
        commitShas: ['abc1111'],
        diffstat: ' docs/projects/index.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n',
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

      await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));

      expect(mockRunFinalizer).toHaveBeenCalledTimes(1);
      const [, effects] = mockRunFinalizer.mock.calls[0]!;
      expect(typeof effects.abortMerge).toBe('function');

      await effects.abortMerge!();

      expect(calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ args: ['merge', '--abort'] }),
      ]));
      expect(created).toBe(true);
    });

    it('wires the project-index Done writer as a finalizer effect, not as an orchestrator terminal side effect', async () => {
      const runId = 'mut-orch-index-writer-finalizer-effect';
      const baseSha = 'base-index-writer-123';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-index-writer-artifacts-'));
      const phases: string[] = [];
      const { runGit } = makeWorkProductGitStub({
        commitShas: ['abc1111'],
        diffstat: ' src/feature.ts | 1 +\n 1 file changed, 1 insertion(+)\n',
      });

      mockRunFinalizer.mockImplementationOnce(async (input, effects) => {
        expect(input).toMatchObject({
          mode: 'gated-merge',
          runId,
          project: 'demo',
          product: 'rune',
          branch: 'rune-work/demo',
          baseBranch: 'main',
        });
        expect(effects.markProjectDone).toEqual(expect.any(Function));
        const actual = await vi.importActual<typeof import('./work-run-finalizer.js')>('./work-run-finalizer.js');
        return actual.runFinalizer(input, effects);
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', '- [x] task one\n');
          mkdirSync(join(dir, 'docs', 'projects'), { recursive: true });
          writeFileSync(join(dir, 'docs/projects/index.md'), [
            '# Projects',
            '',
            '| Project | Status | Summary |',
            '| --- | --- | --- |',
            '| [Demo](demo/) | Active | Demo project |',
            '',
            '## demo — Active',
            '',
            'Keep this body unchanged.',
            '',
          ].join('\n'), 'utf8');
          initGitRepo(dir);
          wtDir = dir;
          return { ...sandbox, baseSha };
        },
        destroyWorktree: async () => {
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
      });

      try {
        const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));

        expect(mockRunFinalizer).toHaveBeenCalledTimes(1);
        const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');
        const terminalData = (terminal?.data ?? {}) as Record<string, unknown>;
        const workProduct = terminalData['workProduct'] as { commitShas?: string[] } | undefined;

        expect(terminal?.kind).toBe('completed');
        expect(terminalData).toMatchObject({
          outcome: 'branch-complete',
          merged: true,
          branchDeleted: true,
        });
        expect(readFileSync(join(wtDir!, 'docs/projects/index.md'), 'utf8')).toEqual([
          '# Projects',
          '',
          '| Project | Status | Summary |',
          '| --- | --- | --- |',
          '| [Demo](demo/) | Done | Demo project |',
          '',
          '## demo — Done',
          '',
          'Keep this body unchanged.',
          '',
        ].join('\n'));
        const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: wtDir!,
          encoding: 'utf8',
        }).trim();
        const headMessage = execFileSync('git', ['log', '-1', '--pretty=%s'], {
          cwd: wtDir!,
          encoding: 'utf8',
        }).trim();
        expect(headMessage).toBe('Mark demo Done in project index');
        expect(workProduct?.commitShas).toContain(headCommit);
        expect(phases).toContain('project-marked-done');
        expect(destroyed).toBe(true);
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
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
          rune: {
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
          product: 'rune',
          repoPath,
          baseBranch: 'trunk',
          branch: 'rune-work/demo',
          validationCommands: ['npm test -- --runInBand'],
          tasksRemaining: 0,
          concurrentRun: false,
          integrationWorktree: expect.stringContaining(`gate-rune-${runId}`),
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
          'merged-not-pushed',
          'project-marked-done',
          'summary-written',
          'index-appended',
          'pushed-not-deleted',
          'worktree-resolved',
          'finalized',
        ]);
        expect(operations).toEqual(['merge', 'push', 'destroy-worktree', 'delete-branch']);
        expect(calls).toEqual(expect.arrayContaining([
          expect.objectContaining({
            args: ['merge', '--no-ff', 'rune-work/demo', '-m', 'rune(rune): merge orchestrated branch rune-work/demo'],
            cwd: repoPath,
          }),
          expect.objectContaining({ args: ['push', 'origin', 'trunk'], cwd: repoPath }),
          expect.objectContaining({ args: ['branch', '-d', 'rune-work/demo'], cwd: repoPath }),
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
            (command === 'merge' && args.includes('rune-work/demo')) ||
            (command === 'push' && args[1] === 'origin' && args[2] === 'main') ||
            (command === 'branch' && args[1] === '-d' && args[2] === 'rune-work/demo')
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
      {
        label: 'zero commits with all original tasks checked',
        runId: 'mut-orch-classify-checkbox-only-noop',
        declaredOutcome: 'branch-complete' as const,
        initialTasks: '- [ ] write classifier tests\n- [ ] wire classifier\n',
        finalTasks: '- [x] write classifier tests\n- [x] wire classifier\n',
        commitShas: [],
        diffstat: '',
        expectedOutcome: 'noop',
        expectedTransitions: { tasksNewlyChecked: 2, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 },
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

          const expectedRange = `${baseSha}..rune-work/demo`;
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
          product: 'rune',
          branch: 'rune-work/demo',
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

    it('stamps outcome + workProduct on a non-finalized terminal so the notification renders an outcome (not "no outcome recorded")', async () => {
      // Regression: only the `finalized` branch of mapResultToTerminal carried an
      // outcome, so held/partial/blocked terminals reached Telegram without one
      // and rendered the generic "… finished" / "completed (no outcome recorded)"
      // fallback. The terminal event must carry the same outcome + workProduct
      // the summary records.
      inject({
        kind: 'held',
        handoff: {
          runId: 'mut-1',
          project: 'demo',
          product: 'rune',
          branch: 'rune-work/demo',
          taskRecords: [],
        },
      });
      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
      const data = terminal?.data as Record<string, unknown>;
      expect(typeof data['outcome']).toBe('string');
      expect(data['outcome']).toBeTruthy();
      expect(data['workProduct']).toBeDefined();
    });

    it('finding-driven held terminals preserve the live worktree and do not run the finalizer', async () => {
      const worktreePath = '/tmp/rune-worktrees/rune/demo-non-reversible';
      inject({
        kind: 'held',
        reason: 'non-reversible high terminal finding remains after severity convergence',
        branch: 'rune-work/demo',
        worktreePath,
        preserveBranch: true,
        preserveWorktree: true,
        handoff: {
          runId: 'mut-1',
          project: 'demo',
          product: 'rune',
          branch: 'rune-work/demo',
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
      expect(data['branch']).toBe('rune-work/demo');
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
          branch: 'rune-work/demo',
          baseBranch: 'main',
          preserveBranch: true,
          preserveWorktree: true,
          dispatchMode: 'orchestrated',
        });

        const summary = JSON.parse(readFileSync(join(artifactsDir, runId, 'summary.json'), 'utf8')) as Record<string, unknown>;
        expect(summary).toMatchObject({
          id: runId,
          branch: 'rune-work/demo',
          reason: expect.stringMatching(/non-reversible|high|terminal finding|hold/i),
          baseSha: 'base-objection-123',
        });

        const baseMutations = calls.filter(({ args }) => {
          const command = args[0];
          return (
            (command === 'merge' && args.includes('rune-work/demo')) ||
            (command === 'push' && args[1] === 'origin' && args[2] === 'main') ||
            (command === 'branch' && args[1] === '-d' && args[2] === 'rune-work/demo')
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

    it('maps user cancellation to failed terminal artifacts and removes the worktree', async () => {
      const runId = 'mut-user-cancel';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-user-cancel-artifacts-'));
      const { runGit } = makeWorkProductGitStub({
        commitShas: [],
        diffstat: '',
        status: '',
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
        runGit,
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
        runOrchestration: async (): Promise<OrchestrationResult> => ({
          kind: 'cancelled',
          reason: 'user',
        }),
      });

      try {
        const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));
        const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');
        const summary = JSON.parse(readFileSync(join(artifactsDir, runId, 'summary.json'), 'utf8')) as Record<string, any>;
        const index = readFileSync(join(artifactsDir, 'index.jsonl'), 'utf8');

        expect(terminal).toMatchObject({
          kind: 'failed',
          data: { reason: 'cancelled', cancelReason: 'user', outcome: 'failed' },
        });
        expect(summary.exit).toMatchObject({ cancelled: true, exitFact: 'user-cancel' });
        expect(summary.outcome).toBe('failed');
        expect(index).toContain(runId);
        expect(latestRun(runId).status).toBe('failed');
        expect(destroyed).toBe(true);
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('maps system cancellation to work-product-classified completed artifacts', async () => {
      const runId = 'mut-system-cancel';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-system-cancel-artifacts-'));
      const { runGit } = makeWorkProductGitStub({
        commitShas: ['closeout-sha'],
        diffstat: ' docs/projects/demo/tasks.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n',
        status: '',
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
        runGit,
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
        runOrchestration: async (deps): Promise<OrchestrationResult> => {
          await deps.writeTasksMd('- [x] task one\n');
          return { kind: 'cancelled', reason: 'system' };
        },
      });

      try {
        const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));
        const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');
        const summary = JSON.parse(readFileSync(join(artifactsDir, runId, 'summary.json'), 'utf8')) as Record<string, any>;
        const index = readFileSync(join(artifactsDir, 'index.jsonl'), 'utf8');

        expect(terminal).toMatchObject({
          kind: 'completed',
          data: {
            cancelReason: 'system',
            outcome: 'branch-complete',
            reason: expect.stringContaining('system-cancelled'),
          },
        });
        expect(summary.exit).toMatchObject({ cancelled: false, exitFact: 'system-cancel' });
        expect(summary.outcome).toBe('branch-complete');
        expect(summary.workProduct.commitShas).toEqual(['closeout-sha']);
        expect(index).toContain(runId);
        expect(latestRun(runId).status).toBe('completed');
        expect(mockRunFinalizer).not.toHaveBeenCalled();
        expect(destroyed).toBe(true);
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('wakes the orchestration stream loop when cancelMutation fires', async () => {
      const projectSlug = '14-product-team-agents';
      const fake = makeFakeTranscriptSink();
      let orchestrationStarted = false;
      let finishRun: ((result: OrchestrationResult) => void) | undefined;
      const runResult = new Promise<OrchestrationResult>((resolve) => {
        finishRun = resolve;
      });
      mockCreateTranscriptSink.mockReturnValue(fake.sink);
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
        runOrchestration: async () => {
          orchestrationStarted = true;
          return runResult;
        },
      });

      try {
        registerApplier(orchestratedWorkApplier);
        const createdMutation = await createMutation(
          'orchestrated-work',
          { projectSlug, product: 'rune' },
          'webview',
        );
        if (!createdMutation.ok) throw new Error(createdMutation.reason);
        const runId = createdMutation.descriptor.id;
        await waitForCondition(() => created && orchestrationStarted && activeRuns.has(runId));

        expect(cancelMutation(runId, 'system')).toEqual({ ok: true });
        await waitForCondition(() =>
          fake.appended.some((event) =>
            String(((event as MutationEvent).data as Record<string, unknown> | undefined)?.['line'] ?? '')
              .includes('cancellation requested; stopping at next orchestration boundary'),
          ),
        );
        expect(activeRuns.has(runId)).toBe(true);

        finishRun?.({ kind: 'cancelled', reason: 'system' });
        await waitForCondition(() => !activeRuns.has(runId));
        expect(destroyed).toBe(true);
      } finally {
        finishRun?.({ kind: 'cancelled', reason: 'system' });
      }
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
          { projectSlug, product: 'rune' },
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
        await waitForCondition(() => destroyed);
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
          { projectSlug, product: 'rune' },
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
          { projectSlug, product: 'rune' },
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

describe('fileTerminalBugsToBacklog', () => {
  let repoPath: string;
  let mutationsLog: string;
  const bugsRel = join('docs', 'projects', 'bugs.md');
  const noopGit: GitRunner = async () => ({ stdout: 'rune-work/x', stderr: '' });

  function bug(over: Partial<OrchestrationTerminalBugEntry> = {}): OrchestrationTerminalBugEntry {
    return {
      runId: 'run-1',
      taskId: 'wire-the-index-writer',
      findingId: 'finding-abc',
      sourceGate: 'reviewer',
      class: 'data-integrity',
      severity: 'critical',
      location: 'src/finalizer.ts:285',
      rationale: 'project index never marked Done',
      reversible: true,
      ...over,
    };
  }

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'rune-bugs-'));
    mkdirSync(join(repoPath, 'docs', 'projects'), { recursive: true });
    writeFileSync(join(repoPath, bugsRel), '# Bugs\n', 'utf8');
    mutationsLog = join(repoPath, 'mutations.jsonl');
  });
  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('writes a Loop-filed bullet to the canonical bugs.md and audits it', async () => {
    const res = await fileTerminalBugsToBacklog({
      repoPath,
      product: 'rune',
      entries: [bug()],
      runGit: noopGit,
      mutationsLogFile: mutationsLog,
    });
    expect(res.appended).toBe(1);
    const content = readFileSync(join(repoPath, bugsRel), 'utf8');
    expect(content).toContain('## Loop-filed');
    expect(content).toContain('src/finalizer.ts:285');
    expect(existsSync(mutationsLog)).toBe(true);
  });

  it('does not re-file a defect already present (dedup through disk)', async () => {
    await fileTerminalBugsToBacklog({
      repoPath,
      product: 'rune',
      entries: [bug()],
      runGit: noopGit,
      mutationsLogFile: mutationsLog,
    });
    const first = readFileSync(join(repoPath, bugsRel), 'utf8');
    const res = await fileTerminalBugsToBacklog({
      repoPath,
      product: 'rune',
      entries: [bug({ findingId: 'finding-new-id' })],
      runGit: noopGit,
      mutationsLogFile: mutationsLog,
    });
    expect(res.appended).toBe(0);
    expect(readFileSync(join(repoPath, bugsRel), 'utf8')).toBe(first);
  });

  it('is a no-op for an empty entry list', async () => {
    const res = await fileTerminalBugsToBacklog({
      repoPath,
      product: 'rune',
      entries: [],
      runGit: noopGit,
      mutationsLogFile: mutationsLog,
    });
    expect(res.appended).toBe(0);
  });
});
