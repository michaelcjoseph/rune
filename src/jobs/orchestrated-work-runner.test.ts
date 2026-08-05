import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import { defaultRunGit, type GitRunner } from './sandbox-runtime.js';
import type { ValidationCommandResult } from './work-run-gate-runtime.js';
import type {
  FinalizerEffects,
  FinalizerInput,
  FinalizerResult,
  GateResult,
} from './work-run-finalizer.js';
import type { FinalizerHandoff } from '../intent/finalizer-handoff.js';

const mockAppendMutationLine = vi.hoisted(() => vi.fn());
const mockUpsertRun = vi.hoisted(() => vi.fn());
const mockRecordRunActivity = vi.hoisted(() => vi.fn());
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
const mockRunGate = vi.hoisted(() => vi.fn(async (): Promise<GateResult> => ({
  ok: true,
  validationReceipt: {
    version: 1,
    treeOid: 'a'.repeat(40),
    fullTaskReviewHash: 'b'.repeat(64),
    completedAt: '2026-07-30T12:00:00.000Z',
    commandFingerprint: 'c'.repeat(64),
    configurationFingerprint: 'd'.repeat(64),
    dependencyFingerprint: 'e'.repeat(64),
    outcome: 'passed',
    commands: [{
      command: 'npm test',
      outcome: 'passed',
      coverage: 'unsupported',
    }],
  },
})));
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
const mockRunFullSuiteValidation = vi.hoisted(() =>
  vi.fn(async (
    _opts?: unknown,
    _io?: unknown,
  ): Promise<Record<string, unknown>> => ({ ok: true })),
);
const mockCollectTaskChangedPaths = vi.hoisted(() => vi.fn(async () => [] as string[]));
const mockTaskChangesRequireFullValidation = vi.hoisted(() => vi.fn(async () => false));
const mockRunValidationCommandArgv = vi.hoisted(() =>
  vi.fn(async (
    _argv?: readonly string[],
    _cwd?: string,
    _timeoutMs?: number,
    _diagnosticDir?: string,
    _options?: unknown,
  ): Promise<ValidationCommandResult> => ({
  exitCode: 0,
  timedOut: false,
  outputHead: '',
  outputTail: '',
  diagnosticArtifacts: [],
})));

vi.mock('./mutations-log.js', () => ({
  appendMutationLine: mockAppendMutationLine,
}));

vi.mock('./supervision-store.js', () => ({
  upsertRun: mockUpsertRun,
  recordRunActivity: (...args: unknown[]) => {
    mockRecordRunActivity(...args);
    mockUpsertRun(args[0]);
  },
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
  collectTaskChangedPaths: mockCollectTaskChangedPaths,
  taskChangesRequireFullValidation: mockTaskChangesRequireFullValidation,
  runValidationCommandArgv: mockRunValidationCommandArgv,
  runProfiledVitestSelection: async (args: {
    command: string;
    argv: string[];
    cwd: string;
    timeoutMs: number;
    diagnosticDir?: string;
  }) => {
    for (const profile of ['isolated', 'loopback', 'sandbox-integration'] as const) {
      const result = await mockRunValidationCommandArgv(
        [...args.argv, `--tags-filter=${profile}`],
        args.cwd,
        args.timeoutMs,
        args.diagnosticDir,
        { profile },
      );
      if (result.timedOut || result.cancelled || result.exitCode !== 0) {
        return { ok: false, command: args.command, result };
      }
    }
    return { ok: true };
  },
  runTrustedVitestObserver: mockRunValidationCommandArgv,
  productionFullSuiteProfileIO: () => ({
    probeProfile: vi.fn(),
    startSandboxBroker: vi.fn(),
  }),
  runValidationCommands: mockRunValidationCommands,
  runFullSuiteValidation: mockRunFullSuiteValidation,
}));

import {
  orchestratedWorkApplier,
  __setOrchestratedRuntimeForTest,
  __resetOrchestratedRuntimeForTest,
  __getRuntimeDepsForTest,
  redispatchRecoveredOrchestratedMutation,
  fileTerminalBugsToBacklog,
  parkInFlightOrchestratedRuns,
  defaultShutdownParkDeps,
  selectReusableFullSuiteEvidence,
  fullSuiteFailureAllowsCloseoutFallback,
  commitReviewedCloseoutTree,
} from './orchestrated-work-runner.js';
import type { OrchestrationTerminalBugEntry } from '../intent/project-orchestrator.js';
import {
  activeRuns,
  cancelMutation,
  createMutation,
  registerApplier,
  preserveMutationForRecoveryHandoff,
  releaseMutationRecoveryHandoff,
  setMutationBus,
  setMutationShutdownInProgress,
  type MutationDescriptor,
  type MutationEvent,
} from '../transport/mutations.js';
import type { OrchestrationDeps, OrchestrationResult } from '../intent/project-orchestrator.js';
import type { SandboxSpec } from '../intent/sandbox.js';
import { isStalled, planQuietCancel, planQuietNudges, type SupervisedRun } from '../intent/supervision.js';
import type { TaskEvidence } from '../intent/team-task-workflow.js';
import { canonicalReviewDiffHash } from './canonical-git.js';
import { writeOrchestratedRunCursor } from './orchestrated-run-store.js';

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

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
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
  // Microtask-only polling (NOT setTimeout — several tests in this file run
  // under fake timers, where a real-timer wait would hang to the test
  // timeout). The budget is generous because stub-async paths like the
  // restart-salvage git sequence add multiple promise hops per iteration.
  for (let i = 0; i < 500 && !condition(); i++) {
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
    flush: vi.fn(async () => {
      operations.push('flush');
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

describe('commitReviewedCloseoutTree — real Git isolation', () => {
  function makeReviewedRepo(): {
    dir: string;
    reviewedTree: string;
    contextPath: string;
    tasksPath: string;
  } {
    const { dir } = makeWorktree('demo', '- [ ] task one\n');
    writeValidProjectContext(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'feature.ts'), 'export const reviewed = true;\n');
    initGitRepo(dir);
    git(dir, 'config', 'user.name', 'test');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'checkout', '-b', 'rune-work/demo');
    writeFileSync(join(dir, 'src', 'feature.ts'), 'export const reviewed = "complete";\n');
    git(dir, 'add', '-A');
    const reviewedTree = git(dir, 'write-tree');
    return {
      dir,
      reviewedTree,
      contextPath: 'docs/projects/demo/context.md',
      tasksPath: 'docs/projects/demo/tasks.md',
    };
  }

  it('commits the reviewed tree plus only prepared managed files and leaves late work dirty', async () => {
    const fixture = makeReviewedRepo();
    try {
      const nextContext = '# Project Context\n\n## Current State\nClosed out.\n';
      const nextTasks = '- [x] task one\n';
      writeFileSync(join(fixture.dir, fixture.contextPath), nextContext);
      writeFileSync(join(fixture.dir, fixture.tasksPath), nextTasks);
      writeFileSync(join(fixture.dir, 'late-unreviewed.txt'), 'must not land\n');

      const sha = await commitReviewedCloseoutTree({
        cwd: fixture.dir,
        branch: 'rune-work/demo',
        reviewedTreeOid: fixture.reviewedTree,
        contextPath: fixture.contextPath,
        contextContent: nextContext,
        tasksPath: fixture.tasksPath,
        tasksContent: nextTasks,
        message: 'closeout',
        runGit: defaultRunGit,
      });

      expect(git(fixture.dir, 'show', `${sha}:src/feature.ts`))
        .toBe('export const reviewed = "complete";');
      expect(git(fixture.dir, 'show', `${sha}:${fixture.contextPath}`)).toBe(nextContext.trim());
      expect(git(fixture.dir, 'show', `${sha}:${fixture.tasksPath}`)).toBe(nextTasks.trim());
      expect(git(fixture.dir, 'ls-tree', '-r', '--name-only', sha))
        .not.toContain('late-unreviewed.txt');
      expect(git(fixture.dir, 'status', '--porcelain'))
        .toContain('?? late-unreviewed.txt');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('fails the update-ref CAS when HEAD advances concurrently', async () => {
    const fixture = makeReviewedRepo();
    try {
      const parent = git(fixture.dir, 'rev-parse', 'HEAD');
      let advanced = false;
      const racingGit: GitRunner = async (args, options) => {
        const result = await defaultRunGit(args, options);
        if (args[0] === 'commit-tree' && !advanced) {
          advanced = true;
          const competing = git(
            fixture.dir,
            'commit-tree',
            fixture.reviewedTree,
            '-p',
            parent,
            '-m',
            'concurrent',
          );
          git(
            fixture.dir,
            'update-ref',
            'refs/heads/rune-work/demo',
            competing,
            parent,
          );
        }
        return result;
      };

      await expect(commitReviewedCloseoutTree({
        cwd: fixture.dir,
        branch: 'rune-work/demo',
        reviewedTreeOid: fixture.reviewedTree,
        contextPath: fixture.contextPath,
        contextContent: '# Project Context\n\nconcurrent-safe\n',
        tasksPath: fixture.tasksPath,
        tasksContent: '- [x] task one\n',
        message: 'closeout',
        runGit: racingGit,
      })).rejects.toThrow();
      expect(git(fixture.dir, 'rev-parse', 'HEAD')).not.toBe(parent);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe('selectReusableFullSuiteEvidence', () => {
  const attestation = { coverage: { status: 'complete' } };
  const receipt = { coverage: 'complete' };

  it('requires the launcher aggregate verdict even when one adapter produced evidence', () => {
    expect(selectReusableFullSuiteEvidence({
      ok: true,
      attestations: [attestation],
      receipts: [receipt],
      coverageComplete: false,
      validationReceipt: { outcome: 'passed', commands: [] },
    } as never)).toBeUndefined();
  });

  it('requires both a complete attestation and compact receipt', () => {
    expect(selectReusableFullSuiteEvidence({
      ok: true,
      attestations: [attestation],
      receipts: [receipt],
      coverageComplete: true,
      validationReceipt: { outcome: 'passed', commands: [] },
    } as never)).toEqual({ attestation, receipt });
    expect(selectReusableFullSuiteEvidence({
      ok: true,
      attestations: [attestation],
      receipts: [],
      coverageComplete: true,
      validationReceipt: { outcome: 'passed', commands: [] },
    } as never)).toBeUndefined();
  });

  it('allows closeout fallback only for green execution with invalid structured coverage', () => {
    const coverageOnlyFailure = {
      ok: false,
      command: 'npm test',
      result: {
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        outputTail: 'trusted evidence missing',
      },
      attestations: [],
      receipts: [],
      coverageComplete: false,
      validationReceipt: {
        outcome: 'failed',
        commands: [{ command: 'npm test', outcome: 'passed', coverage: 'invalid' }],
      },
    };
    expect(fullSuiteFailureAllowsCloseoutFallback(coverageOnlyFailure as never)).toBe(true);
    expect(fullSuiteFailureAllowsCloseoutFallback({
      ...coverageOnlyFailure,
      result: { ...coverageOnlyFailure.result, exitCode: 1 },
    } as never)).toBe(false);
    expect(fullSuiteFailureAllowsCloseoutFallback({
      ...coverageOnlyFailure,
      validationReceipt: { outcome: 'drifted', commands: [] },
    } as never)).toBe(false);
  });
});

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

    it('resolves an external product outside PROJECT_ROOT and scopes its concurrency cap by product', () => {
      const root = mkdtempSync(join(tmpdir(), 'orch-validate-external-'));
      const repo = join(root, 'brand-repo');
      const projectDir = join(repo, 'docs', 'projects', '01-brand');
      const productsFile = join(root, 'products.json');
      const priorProductsFile = process.env['PRODUCTS_CONFIG_FILE'];
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'spec.md'), '# Spec\n', 'utf8');
      execFileSync('git', ['init', '-q', repo]);
      writeFileSync(productsFile, JSON.stringify({
        brand: { repoPath: repo, baseBranch: 'main' },
      }), 'utf8');
      process.env['PRODUCTS_CONFIG_FILE'] = productsFile;
      activeRuns.clear();
      activeRuns.set('aura-same-slug', {
        descriptor: {
          id: 'aura-same-slug',
          kind: 'work-run',
          payload: { projectSlug: '01-brand', product: 'aura' },
          status: 'running',
        },
      } as never);

      try {
        expect(orchestratedWorkApplier.validate({
          projectSlug: '01-brand',
          product: 'brand',
        })).toEqual({ ok: true });

        activeRuns.set('brand-same-slug', {
          descriptor: {
            id: 'brand-same-slug',
            kind: 'work-run',
            payload: { projectSlug: '01-brand', product: 'brand' },
            status: 'running',
          },
        } as never);
        expect(orchestratedWorkApplier.validate({
          projectSlug: '01-brand',
          product: 'brand',
        })).toEqual({ ok: false, reason: 'already running for 01-brand' });
      } finally {
        activeRuns.clear();
        if (priorProductsFile === undefined) delete process.env['PRODUCTS_CONFIG_FILE'];
        else process.env['PRODUCTS_CONFIG_FILE'] = priorProductsFile;
        rmSync(root, { recursive: true, force: true });
      }
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
      mockRunGate.mockResolvedValue({
        ok: true,
        validationReceipt: {
          version: 1,
          treeOid: 'a'.repeat(40),
          fullTaskReviewHash: 'b'.repeat(64),
          completedAt: '2026-07-30T12:00:00.000Z',
          commandFingerprint: 'c'.repeat(64),
          configurationFingerprint: 'd'.repeat(64),
          dependencyFingerprint: 'e'.repeat(64),
          outcome: 'passed',
          commands: [{
            command: 'npm test',
            outcome: 'passed',
            coverage: 'unsupported',
          }],
        },
      });
      mockRunValidationCommands.mockReset();
      mockRunValidationCommands.mockResolvedValue({ ok: true });
      mockRunFullSuiteValidation.mockReset();
      mockRunFullSuiteValidation.mockResolvedValue({ ok: true });
      mockCollectTaskChangedPaths.mockReset();
      mockCollectTaskChangedPaths.mockResolvedValue([]);
      mockRunValidationCommandArgv.mockReset();
      mockRunValidationCommandArgv.mockResolvedValue({
        exitCode: 0,
        timedOut: false,
        outputHead: '',
        outputTail: '',
        diagnosticArtifacts: [],
      });
      mockTaskChangesRequireFullValidation.mockReset();
      mockTaskChangesRequireFullValidation.mockResolvedValue(false);
      mockAppendMutationLine.mockClear();
      mockUpsertRun.mockClear();
      mockCreateTranscriptSink.mockReset();
      activeRuns.clear();
      __setOrchestratedRuntimeForTest({
        refreshRegistry: refreshRegistrySpy as () => void,
        inspectWorktreeStatus: async () => '',
        captureTaskBaseTree: async () =>
          '1111111111111111111111111111111111111111',
        invalidateRunCursor: () => {},
        verifyWorktree: async (opts) => ({
          ok: true,
          projectDir: join(opts.worktree, 'docs', 'projects', opts.project ?? 'demo'),
          specContent: readFileSync(join(opts.worktree, 'docs', 'projects', opts.project ?? 'demo', 'spec.md'), 'utf8'),
          tasksContent: readFileSync(join(opts.worktree, 'docs', 'projects', opts.project ?? 'demo', 'tasks.md'), 'utf8'),
        }),
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

    it('shutdown suppression: skips terminal persistence and preserves the worktree', async () => {
      // shutdown() arms setMutationShutdownInProgress before killing children;
      // the dying child surfaces in the loop as a terminal the run never
      // earned. The applier must neither persist it (the shutdown parker /
      // next-boot recovery own the on-disk state) nor destroy the worktree
      // (it may hold the in-flight task's uncommitted diff).
      inject({
        kind: 'blocked',
        reason: 'child SIGTERM surfaced as block',
        task: { id: 'task-one', text: 'task one', section: 'Phase 1' },
      });
      const descriptor = makeDescriptor();
      setMutationShutdownInProgress(true);
      try {
        const events = await drain(orchestratedWorkApplier.apply(descriptor, ctx));
        const terminal = events[events.length - 1]!;
        // The terminal is still yielded (startApply suppresses its own write).
        expect(terminal.kind).toBe('failed');
        // Worktree left in place for the parker / boot recovery.
        expect(destroyed).toBe(false);
        // persistTerminalMutationState skipped: no mutation line, no supervision write.
        expect(mockAppendMutationLine).not.toHaveBeenCalled();
        expect(mockUpsertRun).not.toHaveBeenCalled();
        expect(descriptor.status).toBe('running');
      } finally {
        setMutationShutdownInProgress(false);
      }
    });

    it('a superseded recovery invocation cannot remove the handed-off worktree while it unwinds', async () => {
      inject({ kind: 'blocked', reason: 'superseded', task: { id: 'task-one', text: 'task one', section: 'Phase 1' } });
      const descriptor = makeDescriptor();
      preserveMutationForRecoveryHandoff(descriptor.id);
      try {
        await drain(orchestratedWorkApplier.apply(descriptor, ctx));
        expect(destroyed).toBe(false);
        expect(mockAppendMutationLine).not.toHaveBeenCalled();
      } finally {
        releaseMutationRecoveryHandoff(descriptor.id);
      }
    });

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
        // Hermetic: the recovery path now probes the worktree for restart
        // salvage; a clean-status stub keeps real git out of this test.
        runGit: vi.fn(async () => ({ stdout: '', stderr: '' })),
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

    it('salvages uncommitted work from a recovered dirty worktree before the orchestration re-runs', async () => {
      // bugs.md (restart safety 2/2): the interrupted task's uncommitted dirt
      // must land as a labeled salvage commit BEFORE the re-run — otherwise
      // closeout's `git add -A` silently absorbs it into the next task's commit.
      const projectSlug = '14-product-team-agents';
      const recovered = makeWorktree(projectSlug, '- [ ] Resume boot\n');
      wtDir = recovered.dir;
      const gitCalls: Array<{ args: string[]; cwd?: string }> = [];
      let salvageCommittedBeforeOrchestration = false;
      const runGit: GitRunner = vi.fn(async (gitArgs: string[], opts?: { cwd?: string }) => {
        gitCalls.push({ args: [...gitArgs], cwd: opts?.cwd });
        if (gitArgs[0] === 'status') return { stdout: ' M src/half-done.ts\n?? src/new.ts\n', stderr: '' };
        if (gitArgs[0] === 'rev-parse') return { stdout: 'salvage1234567\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: vi.fn(async () => {
          throw new Error('should not create a new worktree during recovery redispatch');
        }),
        destroyWorktree: async () => {
          destroyed = true;
        },
        runGit,
        runOrchestration: async () => {
          salvageCommittedBeforeOrchestration = gitCalls.some(
            (c) => c.args[0] === 'commit' && String(c.args[2]).includes('restart salvage'),
          );
          return {
            kind: 'blocked',
            reason: 'stop after salvage assertion',
            task: { id: 'resume-boot', text: 'Resume boot', section: 'Phase 11B' },
          };
        },
      });

      registerApplier(orchestratedWorkApplier);
      const descriptor = makeDescriptor({ projectSlug, product: 'rune' }, 'mut-recovered-salvage');
      const result = redispatchRecoveredOrchestratedMutation(descriptor, {
        branch: 'rune-work/recovered-branch',
        baseBranch: 'main',
        worktreePath: recovered.dir,
        reconstruction: { completedTaskIds: [], nextTask: { id: 'resume-boot', text: 'Resume boot', section: 'Phase 11B' }, drift: false },
        resumeFromTaskId: 'resume-boot',
        existingBranch: true,
      });

      expect(result).toEqual({ ok: true });
      await waitForCondition(() => !activeRuns.has(descriptor.id));

      expect(salvageCommittedBeforeOrchestration).toBe(true);
      const salvageSeq = gitCalls
        .filter((c) => c.cwd === recovered.dir)
        .slice(0, 4)
        .map((c) => c.args.join(' '));
      expect(salvageSeq).toEqual([
        'status --porcelain',
        'add -A',
        `commit -m rune(rune): WIP — restart salvage — ${projectSlug}`,
        'rev-parse HEAD',
      ]);
    });

    it('does not salvage-commit on a recovered clean worktree', async () => {
      const projectSlug = '14-product-team-agents';
      const recovered = makeWorktree(projectSlug, '- [ ] Resume boot\n');
      wtDir = recovered.dir;
      const gitCalls: string[] = [];
      const runGit: GitRunner = vi.fn(async (gitArgs: string[]) => {
        gitCalls.push(gitArgs.join(' '));
        return { stdout: '', stderr: '' };
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: vi.fn(async () => {
          throw new Error('should not create a new worktree during recovery redispatch');
        }),
        destroyWorktree: async () => {
          destroyed = true;
        },
        runGit,
        runOrchestration: async () => ({
          kind: 'blocked',
          reason: 'stop after clean-tree assertion',
          task: { id: 'resume-boot', text: 'Resume boot', section: 'Phase 11B' },
        }),
      });

      registerApplier(orchestratedWorkApplier);
      const descriptor = makeDescriptor({ projectSlug, product: 'rune' }, 'mut-recovered-clean');
      redispatchRecoveredOrchestratedMutation(descriptor, {
        branch: 'rune-work/recovered-branch',
        baseBranch: 'main',
        worktreePath: recovered.dir,
        reconstruction: { completedTaskIds: [], nextTask: { id: 'resume-boot', text: 'Resume boot', section: 'Phase 11B' }, drift: false },
        resumeFromTaskId: 'resume-boot',
        existingBranch: true,
      });
      await waitForCondition(() => !activeRuns.has(descriptor.id));

      expect(gitCalls).toContain('status --porcelain');
      expect(gitCalls.some((c) => c.startsWith('add '))).toBe(false);
      expect(gitCalls.some((c) => c.startsWith('commit '))).toBe(false);
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

    it('persists a context-closeout failure as failed terminal truth with preserved WIP disposition', async () => {
      const contextFailure = {
        reason: 'managed-heading-collision' as const,
        file: 'docs/projects/resolved-assay/context.md',
        canonicalHeading: '## Interfaces & Contracts',
        conflictingHeadings: ['## Interfaces & Contracts', '## Canonical Interfaces'],
        proposedRepair: 'Merge the bodies and remove the legacy heading.',
        checkpoint: {
          kind: 'committed' as const,
          sha: 'abcdef1234567',
        },
      };
      inject({
        kind: 'held',
        reason:
          'context update rejected in docs/projects/resolved-assay/context.md: ' +
          'managed-heading-collision at ## Interfaces & Contracts',
        handoff: {
          runId: 'mut-1',
          project: 'demo',
          product: 'rune',
          branch: 'rune-work/demo',
          taskRecords: [],
        },
        branch: 'rune-work/demo',
        preserveBranch: true,
        preserveWorktree: true,
        contextFailure,
      });
      let persistedSummary: Record<string, unknown> | undefined;
      __setOrchestratedRuntimeForTest({
        runGit: makeWorkProductGitStub({
          commitShas: ['abcdef1234567'],
          diffstat: ' src/task.ts | 1 +\n',
        }).runGit,
        writeSummary: (_dir, summary) => {
          persistedSummary = summary as unknown as Record<string, unknown>;
        },
        appendIndexRow: () => {},
      });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');

      expect(terminal).toMatchObject({
        kind: 'failed',
        data: {
          held: true,
          contextFailure,
          trigger: { kind: 'failure' },
          disposition: {
            kind: 'preserved',
            wipSha: 'abcdef1234567',
          },
        },
      });
      expect(persistedSummary).toMatchObject({
        outcome: 'failed',
        exit: { exitCode: 1, exitFact: 'execution-failure' },
        trigger: { kind: 'failure' },
        disposition: { kind: 'preserved', wipSha: 'abcdef1234567' },
        contextFailure,
      });
      expect(JSON.stringify(terminal)).not.toContain('/Users/');
      expect(destroyed).toBe(false);
    });

    it('derives contextFile from the resolved project directory, not the requested slug', async () => {
      let seenContextFile: string | undefined;
      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('resolved-assay');
          wtDir = dir;
          return { ...sandbox, project: 'requested-assay' };
        },
        verifyWorktree: async (opts) => ({
          ok: true,
          projectDir: join(opts.worktree, 'docs', 'projects', 'resolved-assay'),
          specContent: '# Spec\n',
          tasksContent: '- [ ] task one\n',
        }),
        runOrchestration: async (deps) => {
          seenContextFile = deps.contextFile;
          return {
            kind: 'blocked',
            reason: 'stop after context path assertion',
            task: { id: 'task-one', text: 'task one', section: 'Tasks' },
          };
        },
      });

      await drain(orchestratedWorkApplier.apply(
        makeDescriptor({ projectSlug: 'requested-assay', product: 'rune' }),
        ctx,
      ));

      expect(seenContextFile).toBe('docs/projects/resolved-assay/context.md');
      expect(seenContextFile).not.toContain('requested-assay');
    });

    it('dirty terminal with a verified resumable cursor WIP-commits, parks, and preserves the worktree', async () => {
      inject({ kind: 'blocked', reason: 'cancelled', task: { id: 'task-one', text: 'task one', section: 'Phase 1' } });
      const parked = vi.fn();
      const git = vi.fn(async (args: string[]) => {
        if (args[0] === 'rev-parse') return { stdout: 'deadbeefcafebabe\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });
      __setOrchestratedRuntimeForTest({
        inspectWorktreeStatus: async () => ' M src/index.ts\n',
        preflightRecovery: async () => ({
          kind: 'recoverable',
          cursor: {
            runId: 'mut-1', product: 'rune', project: 'demo', branch: 'rune-work/demo',
            baseBranch: 'main', worktreePath: wtDir ?? '', resumeMarker: 'resumable',
            cursor: { completedTaskIds: [], currentTaskId: 'task-one', nextTaskId: 'task-one' },
          },
          reconstruction: { completedTaskIds: [], nextTask: null, drift: false },
        }),
        runGit: git,
        writeRecoveredTerminal: parked,
      });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));

      expect(git.mock.calls.map(([args]) => (args as string[])[0])).toEqual(
        expect.arrayContaining(['add', 'commit', 'rev-parse']),
      );
      expect(events.at(-1)).toEqual(expect.objectContaining({
        kind: 'failed',
        data: expect.objectContaining({
          parked: true,
          preserveWorktree: true,
          preserveBranch: true,
          trigger: expect.objectContaining({ kind: 'failure' }),
          disposition: expect.objectContaining({ kind: 'parked', wipSha: 'deadbeefcafebabe' }),
        }),
      }));
      expect(parked).not.toHaveBeenCalled();
      expect(destroyed).toBe(false);
    });

    it('preserves an executor-failure trigger while parking its dirty WIP', async () => {
      const executionFailure = {
        taskId: 'task-one', role: 'coder', provider: 'openai' as const, format: 'codex' as const,
        model: 'gpt-test', workflowStage: 'coder-implementation',
        checkpointedAt: '2026-07-22T00:00:00.000Z', failureStage: 'provider' as const,
        diagnostic: 'temporary transport failure', retryable: true, attempts: [{
          attempt: 1,
          startedAt: '2026-07-22T00:00:00.000Z',
          endedAt: '2026-07-22T00:00:01.000Z',
          failureStage: 'provider' as const,
          diagnostic: 'temporary transport failure',
          retryable: true,
        }],
        retryDisposition: 'worktree-changed' as const,
      };
      inject({
        kind: 'held',
        reason: 'coder implementation failed at provider: temporary transport failure',
        handoff: { runId: 'mut-1', project: 'demo', product: 'rune', branch: 'rune-work/demo', taskRecords: [] },
        branch: 'rune-work/demo',
        worktreePath: wtDir ?? '',
        executionFailure,
      });
      __setOrchestratedRuntimeForTest({
        inspectWorktreeStatus: async () => ' M src/partial.ts\n',
        preflightRecovery: async () => ({
          kind: 'recoverable',
          cursor: {
            runId: 'mut-1', product: 'rune', project: 'demo', branch: 'rune-work/demo',
            baseBranch: 'main', worktreePath: wtDir ?? '', resumeMarker: 'resumable',
            cursor: { completedTaskIds: [], currentTaskId: 'task-one', nextTaskId: 'task-one' },
          },
          reconstruction: { completedTaskIds: [], nextTask: null, drift: false },
        }),
        runGit: async (args) => args[0] === 'rev-parse'
          ? { stdout: 'cafebabedeadbeef\n', stderr: '' }
          : { stdout: '', stderr: '' },
      });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      expect(events.at(-1)).toMatchObject({
        kind: 'failed',
        data: {
          outcome: 'failed',
          reason: expect.stringContaining('temporary transport failure'),
          trigger: { kind: 'failure', executionFailure },
          disposition: { kind: 'parked', wipSha: 'cafebabedeadbeef' },
          parked: true,
        },
      });
      expect(destroyed).toBe(false);
    });

    it('removes a clean executor-failure worktree without leaving stale parked fields', async () => {
      const executionFailure = {
        taskId: 'task-one', role: 'coder', provider: 'openai' as const, format: 'codex' as const,
        model: 'gpt-test', workflowStage: 'coder-implementation',
        checkpointedAt: '2026-07-22T00:00:00.000Z', failureStage: 'executor-exit' as const,
        diagnostic: 'executor exited with code 1', retryable: true, attempts: [{
          attempt: 1,
          startedAt: '2026-07-22T00:00:00.000Z',
          endedAt: '2026-07-22T00:00:01.000Z',
          failureStage: 'executor-exit' as const,
          diagnostic: 'executor exited with code 1',
          retryable: true,
        }],
        retryDisposition: 'exhausted' as const,
      };
      inject({
        kind: 'held',
        reason: 'executor exited with code 1',
        handoff: {
          runId: 'mut-1',
          project: 'demo',
          product: 'rune',
          branch: 'rune-work/demo',
          taskRecords: [],
        },
        branch: 'rune-work/demo',
        worktreePath: '/tmp/stale-path',
        executionFailure,
      });
      __setOrchestratedRuntimeForTest({ inspectWorktreeStatus: async () => '' });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminal = events.at(-1)!;
      expect(terminal).toMatchObject({
        kind: 'failed',
        data: {
          trigger: { kind: 'failure', executionFailure },
          disposition: { kind: 'removed' },
        },
      });
      expect(terminal.data).not.toHaveProperty('parked');
      expect(terminal.data).not.toHaveProperty('operatorWorktreePath');
      expect(terminal.data).not.toHaveProperty('preserveWorktree');
      expect(latestRun('mut-1').status).toBe('failed');
      expect(destroyed).toBe(true);
    });

    it('dirty terminal parks and preserves when recovery eligibility is unavailable', async () => {
      inject({ kind: 'blocked', reason: 'cancelled', task: { id: 'task-one', text: 'task one', section: 'Phase 1' } });
      const parked = vi.fn();
      __setOrchestratedRuntimeForTest({
        inspectWorktreeStatus: async () => ' M src/index.ts\n',
        preflightRecovery: async () => ({
          kind: 'not-resumable',
          reason: 'Git worktree registration could not be verified',
        }),
        writeRecoveredTerminal: parked,
      });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));

      expect(events.at(-1)).toEqual(expect.objectContaining({
        kind: 'failed',
        data: expect.objectContaining({ parked: true, preserveWorktree: true, preserveBranch: true,
          trigger: expect.objectContaining({ kind: 'failure' }),
          disposition: expect.objectContaining({ kind: 'parked' }),
        }),
      }));
      expect(parked).not.toHaveBeenCalled();
      expect(destroyed).toBe(false);
    });

    it('terminal cleanup fails closed when status inspection fails', async () => {
      inject({ kind: 'blocked', reason: 'cancelled', task: { id: 'task-one', text: 'task one', section: 'Phase 1' } });
      const parked = vi.fn();
      __setOrchestratedRuntimeForTest({
        inspectWorktreeStatus: async () => { throw new Error('status failed'); },
        writeRecoveredTerminal: parked,
      });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));

      expect(events.at(-1)).toEqual(expect.objectContaining({
        kind: 'failed',
        data: expect.objectContaining({ parked: true, preserveWorktree: true,
          trigger: expect.objectContaining({ kind: 'failure' }),
          disposition: expect.objectContaining({ kind: 'parked' }),
        }),
      }));
      expect(parked).not.toHaveBeenCalled();
      expect(destroyed).toBe(false);
    });

    it('terminal cleanup fails closed when a resumable dirty worktree cannot be WIP-committed', async () => {
      inject({ kind: 'blocked', reason: 'cancelled', task: { id: 'task-one', text: 'task one', section: 'Phase 1' } });
      const parked = vi.fn();
      __setOrchestratedRuntimeForTest({
        inspectWorktreeStatus: async () => ' M src/index.ts\n',
        preflightRecovery: async () => ({
          kind: 'recoverable',
          cursor: {
            runId: 'mut-1', product: 'rune', project: 'demo', branch: 'rune-work/demo',
            baseBranch: 'main', worktreePath: '/tmp/worktree', resumeMarker: 'resumable',
            cursor: { completedTaskIds: [], currentTaskId: 'task-one', nextTaskId: 'task-one' },
          },
          reconstruction: { completedTaskIds: [], nextTask: null, drift: false },
        }),
        runGit: async (args) => {
          if (args[0] === 'commit') throw new Error('index.lock exists');
          return { stdout: '', stderr: '' };
        },
        writeRecoveredTerminal: parked,
      });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));

      expect(events.at(-1)).toEqual(expect.objectContaining({
        kind: 'failed',
        data: expect.objectContaining({ parked: true, preserveWorktree: true,
          trigger: expect.objectContaining({ kind: 'failure' }),
          disposition: expect.objectContaining({ kind: 'parked' }),
        }),
      }));
      expect(parked).not.toHaveBeenCalled();
      expect(destroyed).toBe(false);
    });

    it('clean terminal invalidates its cursor before removing the worktree', async () => {
      inject({ kind: 'blocked', reason: 'done', task: { id: 'task-one', text: 'task one', section: 'Phase 1' } });
      const order: string[] = [];
      __setOrchestratedRuntimeForTest({
        inspectWorktreeStatus: async () => '',
        invalidateRunCursor: () => { order.push('invalidate'); },
        destroyWorktree: async () => { order.push('remove'); destroyed = true; },
      });

      await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));

      expect(order).toEqual(['invalidate', 'remove']);
    });

    it('clean terminal parks and preserves when cursor invalidation fails', async () => {
      inject({ kind: 'blocked', reason: 'done', task: { id: 'task-one', text: 'task one', section: 'Phase 1' } });
      const parked = vi.fn();
      __setOrchestratedRuntimeForTest({
        inspectWorktreeStatus: async () => '',
        invalidateRunCursor: () => { throw new Error('cursor write failed'); },
        writeRecoveredTerminal: parked,
      });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));

      expect(events.at(-1)).toEqual(expect.objectContaining({
        kind: 'failed',
        data: expect.objectContaining({ parked: true, preserveWorktree: true,
          trigger: expect.objectContaining({ kind: 'failure' }),
          disposition: expect.objectContaining({ kind: 'parked' }),
        }),
      }));
      expect(parked).not.toHaveBeenCalled();
      expect(destroyed).toBe(false);
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
          captureTaskBaseTree: async () =>
            '1111111111111111111111111111111111111111',
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

    it('defers terminal persistence until finalizer teardown and disposition resolution complete', async () => {
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
        await effects.removeWorktree();
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

        const prematureMutationWrites = mockAppendMutationLine.mock.calls
          .map(([entry]) => entry as MutationDescriptor)
          .filter((entry) => entry.id === runId);
        expect(prematureMutationWrites).toEqual([]);
        expect(mockUpsertRun.mock.calls
          .map(([run]) => run as SupervisedRun)
          .filter((run) => run.id === runId)).toEqual([]);

        releaseFinalizer();
        await Promise.allSettled([droppedTerminal, abandon ?? Promise.resolve({ done: true, value: undefined as never })]);

        expect(mockAppendMutationLine.mock.calls
          .map(([entry]) => entry as MutationDescriptor)
          .filter((entry) => entry.id === runId).at(-1)).toMatchObject({
          id: runId,
          kind: 'orchestrated-work',
          status: 'completed',
        });
        expect(mockUpsertRun.mock.calls
          .map(([run]) => run as SupervisedRun)
          .filter((run) => run.id === runId).at(-1)).toMatchObject({
          id: runId,
          kind: 'orchestrated-work',
          status: 'completed',
        });
      } finally {
        releaseFinalizer?.();
        await abandon?.catch(() => undefined);
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('persists an early finalizer hold only after outer cleanup enriches it as parked', async () => {
      const runId = 'mut-finalizer-hold-parks';
      inject({ kind: 'finalized', outcome: 'unused' });
      mockRunFinalizer.mockImplementationOnce(async (_input, effects) => {
        const terminalEvent = {
          mutationId: runId,
          ts: new Date().toISOString(),
          kind: 'completed' as const,
          data: { outcome: 'branch-complete', reason: 'merge conflict hold' },
        };
        effects.writeSupervisionTerminal('completed', terminalEvent);
        return {
          outcome: 'branch-complete',
          terminalEvent,
          supervisionStatus: 'completed',
          worktreeRemoved: false,
          merged: false,
          branchDeleted: false,
          phases: ['classified'],
        };
      });
      __setOrchestratedRuntimeForTest({
        runOrchestration: async (deps) => finalizeAsOrchestrationResult(deps),
        inspectWorktreeStatus: async () => ' M src/conflict.ts\n',
        preflightRecovery: async () => ({
          kind: 'not-resumable',
          reason: 'merge conflict requires operator review',
        }),
      });

      const events = await drain(
        orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx),
      );
      expect(events.at(-1)).toMatchObject({
        kind: 'completed',
        data: {
          trigger: { kind: 'success', reason: 'merge conflict hold' },
          disposition: { kind: 'parked' },
          parked: true,
        },
      });
      expect(mockUpsertRun.mock.calls
        .map(([run]) => run as SupervisedRun)
        .filter((run) => run.id === runId)).toHaveLength(1);
      expect(latestRun(runId)).toMatchObject({
        status: 'blocked-on-human',
        operatorWorktreePath: expect.any(String),
      });
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
        outcome: 'failed',
        runId: 'mut-orch-agree-branch-complete',
        expectedStatus: 'failed' as const,
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
        expect(fake.sink.append).toHaveBeenCalledTimes(3);
        expect(fake.appended.slice(0, 2)).toEqual(streamed);
        expect((fake.appended[2] as MutationEvent | undefined)?.data).toMatchObject({ event: 'terminal-facts' });
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
        expect(fake.sink.append).toHaveBeenCalledTimes(2);
        expect((fake.appended[1] as MutationEvent | undefined)?.data).toMatchObject({ event: 'terminal-facts' });
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
        'task-base-captured',
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
        [
          'add',
          '--',
          'docs/projects/demo/context.md',
          'docs/projects/demo/tasks.md',
        ],
        ['commit', '-m', 'rune(rune): closeout — Build the streak core'],
        ['rev-parse', 'HEAD'],
      ]));
      expect(destroyed).toBe(true);
    });

    it('threads a structured related-test assertion into coder repair feedback and durable failure evidence', async () => {
      const runId = 'mut-closeout-validation-repairs';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-closeout-validation-repairs-'));
      const productsFile = join(artifactsDir, 'products.json');
      const repoPath = join(artifactsDir, 'canonical-repo');
      const priorProductsFile = process.env['PRODUCTS_CONFIG_FILE'];
      const gitCalls: string[][] = [];
      let capturedRunnerArgs: Record<string, unknown> | undefined;
      const repairFeedback: unknown[] = [];

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
            validationCommandProfiles: [{ command: 'npm test', profile: 'isolated' }],
            closeoutValidationStrategy: 'vitest-related',
          },
        }),
        'utf8',
      );
      process.env['PRODUCTS_CONFIG_FILE'] = productsFile;
      mockCollectTaskChangedPaths.mockResolvedValue(['src/streak.ts']);
      // ONE red related selection; the beforeEach default restores exit 0 for
      // the repair attempt's confirming re-run.
      mockRunValidationCommandArgv.mockResolvedValueOnce({
        exitCode: 1,
        timedOut: false,
        outputHead: '',
        outputTail: 'JSON report written to a private validation artifact',
        diagnosticArtifacts: [],
        structuredErrorsTotal: 1,
        structuredErrorsComplete: true,
        structuredErrors: [{
          source: 'vitest-json',
          scope: 'assertion',
          file: 'src/streak.test.ts',
          testName: 'renders the card',
          message:
            'AssertionError: expected 3 to be 2\n' +
            ` at ${PROJECT_ROOT}/src/streak.test.ts:42`,
        }],
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
          return async (task, workflowContext) => {
            if (workflowContext.rejectionFeedback !== undefined) {
              repairFeedback.push(workflowContext.rejectionFeedback);
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
          };
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
        expect(artifact).toContain('AssertionError: expected 3 to be 2');
        expect(artifact).not.toContain(PROJECT_ROOT);
        expect(JSON.stringify(repairFeedback)).toContain('AssertionError: expected 3 to be 2');
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
            validationCommandProfiles: [{ command: 'npm test', profile: 'isolated' }],
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

    it('reuses an exact Rune-owned full-suite attestation at closeout without spawning vitest related', async () => {
      const runId = 'mut-closeout-full-suite-reused';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-closeout-full-suite-reused-'));
      const productsFile = join(artifactsDir, 'products.json');
      const repoPath = join(artifactsDir, 'canonical-repo');
      const priorProductsFile = process.env['PRODUCTS_CONFIG_FILE'];
      const canonicalDiff = 'diff --git a/src/feature.ts b/src/feature.ts\n+attested\n';
      const reviewHash = canonicalReviewDiffHash(canonicalDiff);
      const reviewTree = '2'.repeat(40);
      const attestation = {
        version: 1,
        treeOid: reviewTree,
        fullTaskReviewHash: reviewHash,
        validationCwd: '.',
        configuredArgv: [['npm', 'run', 'build'], ['npm', 'test']],
        adapter: { runner: 'vitest', version: 1 },
        commandFingerprint: 'c'.repeat(64),
        configurationFingerprint: 'd'.repeat(64),
        dependencyFingerprint: 'e'.repeat(64),
        startedAt: '2026-07-30T12:00:00.000Z',
        completedAt: '2026-07-30T12:00:05.000Z',
        durationMs: 5_000,
        execution: { outcome: 'passed', exitCode: 0, timedOut: false, cancelled: false },
        coverage: {
          status: 'complete',
          manifest: {
            version: 1,
            runner: 'vitest',
            completedNormally: true,
            collectionErrors: 0,
            discovered: { suites: 3, tests: 7 },
            completed: {
              suites: 3, tests: 7, passed: 4, failed: 0, skipped: 1, todo: 2, cancelled: 0,
            },
          },
        },
      };

      mkdirSync(repoPath, { recursive: true });
      writeFileSync(productsFile, JSON.stringify({
        rune: {
          repoPath,
          baseBranch: 'main',
          credentialsFile: '',
          egressAllowlist: [],
          validationCommands: ['npm run build', 'npm test'],
          validationCommandProfiles: [
            { command: 'npm run build', profile: 'isolated' },
            { command: 'npm test', profile: 'isolated' },
          ],
          validationAdapters: [{ command: 'npm test', runner: 'vitest' }],
          closeoutValidationStrategy: 'vitest-related',
        },
      }));
      process.env['PRODUCTS_CONFIG_FILE'] = productsFile;
      mockRunFullSuiteValidation.mockResolvedValueOnce({
        ok: true,
        attestations: [attestation],
        receipts: [{
          version: 1,
          command: 'npm test',
          treeOid: reviewTree,
          fullTaskReviewHash: reviewHash,
          outcome: 'passed',
          coverage: 'complete',
          completedAt: '2026-07-30T12:00:05.000Z',
          discovered: { suites: 3, tests: 7 },
          completed: {
            suites: 3, tests: 7, passed: 4, failed: 0, skipped: 1, todo: 2, cancelled: 0,
          },
        }],
        coverageComplete: true,
        validationReceipt: {
          outcome: 'passed',
          commands: [{
            command: 'npm test',
            outcome: 'passed',
            coverage: 'complete',
            discovered: { suites: 3, tests: 7 },
            completed: {
              suites: 3, tests: 7, passed: 4, failed: 0, skipped: 1, todo: 2, cancelled: 0,
            },
          }],
        },
      });
      const runGit = vi.fn(async (gitArgs: string[]) => {
        if (gitArgs[0] === 'status') return { stdout: '', stderr: '' };
        if (gitArgs[0] === 'rev-list') return { stdout: 'closeout-sha\n', stderr: '' };
        if (gitArgs[0] === 'rev-parse') return { stdout: 'closeout-sha\n', stderr: '' };
        if (gitArgs[0] === 'hash-object') return { stdout: `${'4'.repeat(40)}\n`, stderr: '' };
        if (gitArgs[0] === 'write-tree') return { stdout: `${'3'.repeat(40)}\n`, stderr: '' };
        if (gitArgs[0] === 'commit-tree') return { stdout: 'closeout-sha\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });
      const runCanonicalGit = vi.fn(async (gitArgs: string[]) => {
        if (gitArgs[0] === 'write-tree') return { stdout: `${reviewTree}\n`, stderr: '' };
        if (gitArgs.includes('diff')) return { stdout: canonicalDiff, stderr: '' };
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
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
        runGit,
        runCanonicalGit,
        createTaskWorkflowRunner: () => async (task) => ({
          taskId: task.id,
          outcome: 'ready-for-closeout',
          rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
          findingsLedger: [],
          loopExitReason: 'all-low',
          objectionOpen: false,
          handoffNotes: [`completed ${task.text}`],
          reviewerVerdict: { pass: true, objections: [] },
          reviewSurfaceHash: reviewHash,
          taskBaseTree: '1'.repeat(40),
          currentReviewTree: reviewTree,
          fullTaskReviewHash: reviewHash,
        }),
      });

      try {
        const events = await drain(orchestratedWorkApplier.apply(
          makeDescriptor(undefined, runId),
          ctx,
        ));
        const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');

        expect(terminal?.kind).toBe('completed');
        expect(mockRunFullSuiteValidation).toHaveBeenCalledTimes(1);
        expect(mockRunFullSuiteValidation.mock.calls[0]?.[1]).toMatchObject({
          probeProfile: expect.any(Function),
          startSandboxBroker: expect.any(Function),
        });
        expect(mockRunValidationCommandArgv).not.toHaveBeenCalled();
        expect(mockRunValidationCommands).not.toHaveBeenCalled();
        expect(mockCollectTaskChangedPaths).not.toHaveBeenCalled();
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'activity',
            data: expect.objectContaining({
              event: 'closeout-validation',
              taskId: 'build-the-streak-core',
              provenance: 'full-suite-reused',
              treeOid: reviewTree,
              validationReceipt: expect.objectContaining({
                provenance: 'full-suite-reused',
                command: 'npm test',
                coverage: 'complete',
              }),
            }),
          }),
        ]));
        const taskRecords = readFileSync(
          join(artifactsDir, runId, 'task-records.jsonl'),
          'utf8',
        );
        expect(taskRecords).toContain('"fullSuiteAttestation"');
        expect(taskRecords).toContain('"provenance":"full-suite-reused"');
        expect(taskRecords).not.toContain('/Users/');
        expect(taskRecords).not.toContain('outputTail');
        const transcript = readFileSync(
          join(artifactsDir, runId, 'transcript.jsonl'),
          'utf8',
        );
        expect(transcript).toContain('"validationReceipt"');
        expect(transcript).toContain('"provenance":"full-suite-reused"');
        expect(destroyed).toBe(true);
      } finally {
        if (priorProductsFile === undefined) delete process.env['PRODUCTS_CONFIG_FILE'];
        else process.env['PRODUCTS_CONFIG_FILE'] = priorProductsFile;
        rmSync(artifactsDir, { recursive: true, force: true });
      }
    });

    it('confirms a structured loopback host conflict with the exact related selection before hash verification and closeout', async () => {
      const runId = 'mut-closeout-validation-passes';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-closeout-validation-passes-'));
      const productsFile = join(artifactsDir, 'products.json');
      const repoPath = join(artifactsDir, 'canonical-repo');
      const priorProductsFile = process.env['PRODUCTS_CONFIG_FILE'];
      const operations: string[] = [];
      const canonicalDiff = 'diff --git a/src/feature.ts b/src/feature.ts\n+compatible fallback passed\n';

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
            validationCommandProfiles: [{ command: 'npm test', profile: 'isolated' }],
            validationCwd: 'harness',
            closeoutValidationStrategy: 'vitest-related',
          },
        }),
        'utf8',
      );
      process.env['PRODUCTS_CONFIG_FILE'] = productsFile;
      // Sourced from the canonical full-task capture below, not
      // `collectTaskChangedPaths` — any task carrying a `taskBaseTree` (every
      // fresh run) takes that path. The odd-name and leading-dash entries keep
      // the argv-sanitization guard covered on it.
      const canonicalChangedPathsOutput = [
        'harness/src/feature.ts',
        'harness/src/odd name.test.ts',
        'harness/--config=malicious.ts',
      ].join('\n') + '\n';
      mockRunValidationCommandArgv
        .mockImplementationOnce(async () => {
          operations.push('validation:initial-conflict');
          return {
            exitCode: 1,
            timedOut: false,
            outputHead: '',
            outputTail: 'Vitest worker could not listen on loopback',
            diagnosticArtifacts: [],
            structuredErrorsTotal: 1,
            structuredErrorsComplete: true,
            structuredErrors: [{
              source: 'vitest-json',
              scope: 'suite',
              file: 'src/server.test.ts',
              message: 'listen EPERM: operation not permitted 127.0.0.1',
            }],
          };
        })
        .mockImplementationOnce(async () => {
          operations.push('validation:compatible-fallback');
          return {
            exitCode: 0,
            timedOut: false,
            outputHead: '',
            outputTail: '',
            diagnosticArtifacts: [],
            structuredErrorsTotal: 0,
            structuredErrorsComplete: true,
            structuredErrors: [],
          };
        });

      const runGit = vi.fn(async (gitArgs: string[]) => {
        if (gitArgs[0] === 'update-index') operations.push('git:add');
        if (gitArgs[0] === 'commit-tree') operations.push('git:commit-tree');
        if (gitArgs[0] === 'rev-parse') return { stdout: 'closeout-pass-sha\n', stderr: '' };
        if (gitArgs[0] === 'rev-list') return { stdout: 'closeout-pass-sha\n', stderr: '' };
        if (gitArgs[0] === 'diff') return { stdout: ' src/feature.ts | 1 +\n', stderr: '' };
        if (gitArgs[0] === 'hash-object') {
          return { stdout: `${'4'.repeat(40)}\n`, stderr: '' };
        }
        if (gitArgs[0] === 'write-tree') {
          return { stdout: `${'3'.repeat(40)}\n`, stderr: '' };
        }
        if (gitArgs[0] === 'commit-tree') {
          return { stdout: 'closeout-pass-sha\n', stderr: '' };
        }
        if (gitArgs[0] === 'status') return { stdout: '', stderr: '' };
        return { stdout: '', stderr: '' };
      });
      const runCanonicalGit = vi.fn(async (gitArgs: string[]) => {
        if (gitArgs[0] === 'add') {
          operations.push('review-surface:stage');
          return { stdout: '', stderr: '' };
        }
        if (gitArgs[0] === 'write-tree') {
          return {
            stdout: '2222222222222222222222222222222222222222\n',
            stderr: '',
          };
        }
        if (gitArgs.includes('--name-only')) {
          return { stdout: canonicalChangedPathsOutput, stderr: '' };
        }
        operations.push('review-surface:hash');
        return {
          stdout: canonicalDiff,
          stderr: '',
        };
      });

      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree('demo', '- [ ] Build the streak core\n');
          writeValidProjectContext(dir);
          mkdirSync(join(dir, 'harness'));
          wtDir = dir;
          return sandbox;
        },
        destroyWorktree: async () => {
          destroyed = true;
        },
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
        runGit,
        runCanonicalGit,
        createTaskWorkflowRunner: () => async (task) => ({
          taskId: task.id,
          outcome: 'ready-for-closeout',
          rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
          findingsLedger: [],
          loopExitReason: 'all-low',
          objectionOpen: false,
          handoffNotes: [`completed ${task.text}`],
          reviewerVerdict: { pass: true, objections: [] },
          reviewSurfaceHash: canonicalReviewDiffHash(canonicalDiff),
          taskBaseTree: '1111111111111111111111111111111111111111',
          currentReviewTree: '2222222222222222222222222222222222222222',
          fullTaskReviewHash: canonicalReviewDiffHash(canonicalDiff),
        }),
      });

      try {
        const events = await drain(orchestratedWorkApplier.apply(
          makeDescriptor(undefined, runId),
          ctx,
        ));
        const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');

        expect(terminal?.kind).toBe('completed');
        expect(terminal?.data).toMatchObject({
          relatedTestDiagnostic: { state: 'related-fallback-passed' },
          relatedTestDiagnostics: [{
            taskId: 'build-the-streak-core',
            diagnostic: { state: 'related-fallback-passed' },
          }],
        });
        expect(operations).toEqual(expect.arrayContaining([
          'validation:initial-conflict',
          'validation:compatible-fallback',
          'review-surface:hash',
          'git:add',
          'git:commit-tree',
        ]));
        expect(operations.indexOf('validation:initial-conflict'))
          .toBeLessThan(operations.indexOf('validation:compatible-fallback'));
        expect(operations.indexOf('validation:compatible-fallback'))
          .toBeLessThan(operations.indexOf('review-surface:hash'));
        expect(operations.indexOf('review-surface:hash'))
          .toBeLessThan(operations.indexOf('git:commit-tree'));
        expect(mockRunValidationCommands).not.toHaveBeenCalled();
        expect(mockCollectTaskChangedPaths).not.toHaveBeenCalled();
        expect(runCanonicalGit).toHaveBeenCalledWith(
          expect.arrayContaining(['--name-only']),
          { cwd: wtDir },
        );
        // Paths are rebased from worktree-relative to the validation cwd
        // (`<worktree>/harness`), and a rebased path that would read as a flag
        // is prefixed `./` — `vitest related` has no `--` terminator.
        const exactArgv = [
          'npx',
          'vitest',
          'related',
          '--run',
          '--passWithNoTests',
          'src/feature.ts',
          'src/odd name.test.ts',
          './--config=malicious.ts',
        ];
        expect(mockRunValidationCommandArgv.mock.calls).toEqual([
          [
            exactArgv,
            join(wtDir!, 'harness'),
            120_000,
            join(artifactsDir, runId, 'validation-diagnostics'),
          ],
          [
            exactArgv,
            join(wtDir!, 'harness'),
            120_000,
            join(artifactsDir, runId, 'validation-diagnostics'),
            { compatibleFallback: true },
          ],
        ]);
        const relatedDiagnostics = readFileSync(
          join(artifactsDir, runId, 'related-test-diagnostics.jsonl'),
          'utf8',
        ).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(relatedDiagnostics).toEqual([
          expect.objectContaining({
            taskId: 'build-the-streak-core',
            state: 'related-validation-host-conflict',
            initial: expect.objectContaining({
              selectedPaths: exactArgv.slice(5),
              argv: exactArgv,
              validationCwd: 'harness',
            }),
            conflictEvidence: expect.arrayContaining([
              expect.objectContaining({
                kind: 'loopback-listen-denied',
                syscall: 'listen',
                code: 'EPERM',
              }),
            ]),
          }),
          expect.objectContaining({
            taskId: 'build-the-streak-core',
            state: 'related-fallback-passed',
            fallback: expect.objectContaining({
              selectedPaths: exactArgv.slice(5),
              argv: exactArgv,
              validationCwd: 'harness',
            }),
          }),
        ]);
        expect(JSON.stringify(relatedDiagnostics)).not.toContain(repoPath);
        const summary = JSON.parse(
          readFileSync(join(artifactsDir, runId, 'summary.json'), 'utf8'),
        ) as Record<string, unknown>;
        expect(summary).toMatchObject({
          relatedTestDiagnostic: { state: 'related-fallback-passed' },
          relatedTestDiagnostics: [{
            taskId: 'build-the-streak-core',
            diagnostic: { state: 'related-fallback-passed' },
          }],
        });
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({
            mutationId: runId,
            kind: 'activity',
            data: expect.objectContaining({
              event: 'related-fallback-passed',
              taskId: 'build-the-streak-core',
              line: expect.stringMatching(/compatible confirmation passed/i),
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
            validationCommandProfiles: [{ command: 'npm test', profile: 'isolated' }],
            closeoutValidationStrategy: 'vitest-related',
          },
        }),
        'utf8',
      );
      process.env['PRODUCTS_CONFIG_FILE'] = productsFile;
      mockCollectTaskChangedPaths.mockResolvedValueOnce(['src/feature.ts']);
      mockTaskChangesRequireFullValidation.mockResolvedValueOnce(true);
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
        const terminal = events.find(
          (event) => event.kind === 'completed' || event.kind === 'failed',
        );
        expect(terminal?.kind).toBe('completed');
        expect(validationCwd).toBe(wtDir);
        expect(validationCwd).not.toBe(repoPath);
        expect(validationCwd).not.toBe(integrationWorktree);
        expect(mockTaskChangesRequireFullValidation).toHaveBeenCalledWith(
          wtDir,
          ['src/feature.ts'],
          runGit,
        );
        expect(mockRunValidationCommands).toHaveBeenCalledWith(
          ['npm test'],
          wtDir,
          120_000,
          undefined,
          join(artifactsDir, runId, 'validation-diagnostics'),
          {
            commandProfiles: [{ command: 'npm test', profile: 'isolated' }],
            adapters: [],
          },
        );
        expect(mockRunValidationCommandArgv).not.toHaveBeenCalled();
        expect(terminal?.data).not.toHaveProperty('relatedTestDiagnostic');
        expect(terminal?.data).not.toHaveProperty('relatedTestDiagnostics');
        expect(existsSync(
          join(artifactsDir, runId, 'related-test-diagnostics.jsonl'),
        )).toBe(false);
        const summary = JSON.parse(
          readFileSync(join(artifactsDir, runId, 'summary.json'), 'utf8'),
        ) as Record<string, unknown>;
        expect(summary).not.toHaveProperty('relatedTestDiagnostic');
        expect(summary).not.toHaveProperty('relatedTestDiagnostics');
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
              applierRun === 1
                ? '- [ ] Build the streak core'
                : '- [x] Build the streak core',
              '- [ ] Render the streak card',
              '',
            ].join('\n'));
            createdDirs.push(dir);
            wtDir = dir;
            writeFileSync(join(dir, 'docs', 'projects', 'demo', 'context.md'), validContext, 'utf8');
            return sandbox;
          },
          captureTaskBaseTree: async () =>
            '1111111111111111111111111111111111111111',
          destroyWorktree: async () => {
            destroyed = true;
          },
          runGit,
          verifyWorktree: async (opts) => ({
            ok: true,
            projectDir: join(opts.worktree, 'docs', 'projects', opts.project ?? 'demo'),
            specContent: readFileSync(join(opts.worktree, 'docs', 'projects', opts.project ?? 'demo', 'spec.md'), 'utf8'),
            tasksContent: readFileSync(join(opts.worktree, 'docs', 'projects', opts.project ?? 'demo', 'tasks.md'), 'utf8'),
          }),
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
        branch: 'rune-work/rune/demo',
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

    it('finalizer-owned teardown cannot remove a worktree claimed for recovery handoff', async () => {
      const runId = 'mut-orch-finalizer-handoff';
      const { runGit } = makeWorkProductGitStub({
        commitShas: ['abc1111'],
        diffstat: ' src/feature.ts | 1 +\n 1 file changed, 1 insertion(+)',
      });
      mockRunFinalizer.mockImplementationOnce(async (_input, effects) => {
        const terminalEvent = await effects.classify();
        await expect(effects.removeWorktree()).rejects.toThrow(/preservation/);
        return {
          outcome: 'branch-complete',
          terminalEvent,
          supervisionStatus: 'completed',
          worktreeRemoved: false,
          merged: true,
          branchDeleted: true,
          phases: ['classified', 'worktree-resolved', 'finalized'],
        };
      });
      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          const { sandbox, dir } = makeWorktree('demo', '- [x] task one\n');
          wtDir = dir;
          return { ...sandbox, baseSha: 'base-handoff-123' };
        },
        destroyWorktree: async () => { destroyed = true; },
        runGit,
        runOrchestration: async (deps) => finalizeAsOrchestrationResult(deps),
      });

      preserveMutationForRecoveryHandoff(runId);
      try {
        await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));
        expect(destroyed).toBe(false);
      } finally {
        releaseMutationRecoveryHandoff(runId);
      }
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
          branch: 'rune-work/rune/demo',
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
          branch: 'rune-work/rune/demo',
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
            validationCommandProfiles: [{
              command: 'npm test -- --runInBand',
              profile: 'isolated',
            }],
          },
        }),
        'utf8',
      );
      process.env['PRODUCTS_CONFIG_FILE'] = productsFile;
      mockRunGate.mockResolvedValueOnce({
        ok: true,
        validationReceipt: {
          version: 1,
          treeOid: 'a'.repeat(40),
          fullTaskReviewHash: 'b'.repeat(64),
          completedAt: '2026-07-30T12:00:00.000Z',
          commandFingerprint: 'c'.repeat(64),
          configurationFingerprint: 'd'.repeat(64),
          dependencyFingerprint: 'e'.repeat(64),
          outcome: 'passed',
          commands: [{
            command: 'npm test -- --runInBand',
            outcome: 'passed',
            coverage: 'unsupported',
          }],
        },
      });
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
          branch: 'rune-work/rune/demo',
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
            args: ['merge', '--no-ff', 'rune-work/rune/demo', '-m', 'rune(rune): merge orchestrated branch rune-work/rune/demo'],
            cwd: repoPath,
          }),
          expect.objectContaining({ args: ['push', 'origin', 'trunk'], cwd: repoPath }),
          expect.objectContaining({ args: ['branch', '-d', 'rune-work/rune/demo'], cwd: repoPath }),
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
      const gateValidationReceipt = {
        version: 1 as const,
        treeOid: 'a'.repeat(40),
        fullTaskReviewHash: 'b'.repeat(64),
        completedAt: '2026-07-30T12:00:00.000Z',
        commandFingerprint: 'c'.repeat(64),
        configurationFingerprint: 'd'.repeat(64),
        dependencyFingerprint: 'e'.repeat(64),
        outcome: 'failed' as const,
        commands: [
          { command: 'npm run build', outcome: 'passed' as const, coverage: 'unsupported' as const },
          {
            command: 'npm test',
            outcome: 'failed' as const,
            coverage: 'complete' as const,
            discovered: { suites: 3, tests: 7 },
            completed: {
              suites: 3, tests: 7, passed: 6, failed: 1,
              skipped: 0, todo: 0, cancelled: 0,
            },
          },
        ],
      };
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

      mockRunGate.mockResolvedValueOnce({
        ok: false,
        reason: 'tests-red',
        validationReceipt: gateValidationReceipt,
      });
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
          gateValidationReceipt,
        });
        const summary = JSON.parse(
          readFileSync(join(artifactsDir, runId, 'summary.json'), 'utf8'),
        );
        expect(summary).toMatchObject({ gateValidationReceipt });
        const transcript = readFileSync(
          join(artifactsDir, runId, 'transcript.jsonl'),
          'utf8',
        );
        expect(transcript).toContain('"gateValidationReceipt"');
        expect(transcript).toContain('"event":"terminal-facts"');
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
      const cleanupOrder: string[] = [];
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
          cleanupOrder.push('remove');
          destroyed = true;
        },
        invalidateRunCursor: () => { cleanupOrder.push('invalidate'); },
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
            (command === 'merge' && args.includes('rune-work/rune/demo')) ||
            (command === 'push' && args[1] === 'origin' && args[2] === 'main') ||
            (command === 'branch' && args[1] === '-d' && args[2] === 'rune-work/rune/demo')
          );
        });
        expect(baseMutations).toEqual([]);
        expect(cleanupOrder).toEqual(['invalidate', 'remove']);
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

          const expectedRange = `${baseSha}..rune-work/rune/demo`;
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
          branch: 'rune-work/rune/demo',
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
          branch: 'rune-work/rune/demo',
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
          branch: 'rune-work/rune/demo',
          baseBranch: 'main',
          preserveBranch: true,
          preserveWorktree: true,
          dispatchMode: 'orchestrated',
        });

        const summary = JSON.parse(readFileSync(join(artifactsDir, runId, 'summary.json'), 'utf8')) as Record<string, unknown>;
        expect(summary).toMatchObject({
          id: runId,
          branch: 'rune-work/rune/demo',
          reason: expect.stringMatching(/non-reversible|high|terminal finding|hold/i),
          baseSha: 'base-objection-123',
        });

        const baseMutations = calls.filter(({ args }) => {
          const command = args[0];
          return (
            (command === 'merge' && args.includes('rune-work/rune/demo')) ||
            (command === 'push' && args[1] === 'origin' && args[2] === 'main') ||
            (command === 'branch' && args[1] === '-d' && args[2] === 'rune-work/rune/demo')
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

    it('records pre-start cancellation source and a removed no-worktree disposition', async () => {
      const createWorktree = vi.fn();
      __setOrchestratedRuntimeForTest({ createWorktree });
      const cancelledCtx = {
        ...ctx,
        cancel: () => true,
        cancelReason: () => 'system' as const,
        cancelSource: () => 'shutdown' as const,
      };

      const events = await drain(
        orchestratedWorkApplier.apply(makeDescriptor(undefined, 'mut-prestart-cancel'), cancelledCtx),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'completed',
        data: {
          trigger: {
            kind: 'cancellation',
            reason: 'cancelled before start',
            cancellationSource: 'shutdown',
          },
          disposition: { kind: 'removed', reason: 'no worktree was created' },
        },
      });
      expect(createWorktree).not.toHaveBeenCalled();
    });

    it('fails with a scrubbed provisioning stage before any orchestration role is spawned', async () => {
      const runOrchestration = vi.fn(async () => ({ kind: 'finalized', outcome: 'x' } as OrchestrationResult));
      inject({ kind: 'finalized', outcome: 'unused' });
      __setOrchestratedRuntimeForTest({
        runOrchestration,
        verifyWorktree: async () => ({
          ok: false,
          stage: 'tasks-readable',
          cause: new Error('ENOENT /Users/private/operator/worktree/tasks.md'),
        }),
      });

      const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(), ctx));
      const terminal = events.find((event) => event.kind === 'failed');
      expect(terminal?.data).toMatchObject({ reason: 'worktree provisioning failed: tasks-readable' });
      expect(JSON.stringify(terminal)).not.toContain('/Users/private');
      expect(runOrchestration).not.toHaveBeenCalled();
    });

    it('rejects a managed-file symlink swap after workflow execution without writing its target', async () => {
      const runId = 'mut-closeout-symlink-swap';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-closeout-symlink-artifacts-'));
      const externalTasks = join(artifactsDir, 'operator-tasks.md');
      const { runGit } = makeWorkProductGitStub({ commitShas: [], diffstat: '', status: '' });
      writeFileSync(externalTasks, 'operator-owned content\n', 'utf8');
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
        runOrchestration: async (deps) => {
          const tasksPath = join(wtDir!, 'docs', 'projects', 'demo', 'tasks.md');
          rmSync(tasksPath);
          symlinkSync(externalTasks, tasksPath);
          await deps.writeContextMd('# closeout must not land\n');
          return { kind: 'finalized', outcome: 'unused' };
        },
      });

      try {
        const events = await drain(
          orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx),
        );
        const terminal = events.find((event) =>
          event.kind === 'completed' || event.kind === 'failed');

        expect(terminal?.kind).toBe('failed');
        expect(readFileSync(externalTasks, 'utf8')).toBe('operator-owned content\n');
        expect(readFileSync(
          join(wtDir!, 'docs', 'projects', 'demo', 'context.md'),
          'utf8',
        )).toBe('# Project Context\n');
        expect(JSON.stringify(terminal)).not.toContain(artifactsDir);
        expect(destroyed).toBe(true);
      } finally {
        rmSync(artifactsDir, { recursive: true, force: true });
      }
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

    it('persists a nested role cancellation with a direct terminal reason and correlation record', async () => {
      const runId = 'mut-nested-role-cancel';
      const artifactsDir = mkdtempSync(join(tmpdir(), 'orch-nested-cancel-artifacts-'));
      const cancellation = {
        role: 'tech-lead' as const,
        operationId: 'abc12345-1234-1234-1234-123456789abc',
        source: 'cockpit' as const,
        requestedAt: '2026-07-13T12:34:56.000Z',
      };
      const judgmentOutcomes = [
        { role: 'reviewer' as const, status: 'cancelled' as const },
        { role: 'tech-lead' as const, status: 'cancelled' as const },
      ];
      const { runGit } = makeWorkProductGitStub({ commitShas: [], diffstat: '', status: '' });
      __setOrchestratedRuntimeForTest({
        createWorktree: async () => {
          created = true;
          const { sandbox, dir } = makeWorktree();
          wtDir = dir;
          return sandbox;
        },
        destroyWorktree: async () => { destroyed = true; },
        runGit,
        workRunsDir: artifactsDir,
        workRunsIndexFile: join(artifactsDir, 'index.jsonl'),
        runOrchestration: async (): Promise<OrchestrationResult> => ({
          kind: 'cancelled',
          reason: 'user',
          task: { id: 'task-one', text: 'Task one', section: 'Phase 1' },
          cancellation,
          judgmentOutcomes,
        }),
      });

      try {
        const events = await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, runId), ctx));
        const terminal = events.find((event) => event.kind === 'completed' || event.kind === 'failed');
        const summary = JSON.parse(
          readFileSync(join(artifactsDir, runId, 'summary.json'), 'utf8'),
        ) as Record<string, any>;

        expect(terminal).toMatchObject({
          kind: 'failed',
          data: {
            cancelReason: 'user',
            reason: 'tech-lead cancelled from cockpit (operation abc12345)',
            cancellation,
            judgmentOutcomes,
          },
        });
        expect(String((terminal!.data as Record<string, unknown>)['reason']))
          .not.toMatch(/orchestration blocked|model call failed/i);
        expect(summary).toMatchObject({
          reason: 'tech-lead cancelled from cockpit (operation abc12345)',
          cancellation,
          judgmentOutcomes,
          exit: { cancelled: true, exitFact: 'user-cancel' },
        });
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

    it('threads cancellation supersession through the runner and publishes it to transcript and live feed', async () => {
      const projectSlug = '14-product-team-agents';
      const fake = makeFakeTranscriptSink();
      const published: Array<Record<string, unknown>> = [];
      let orchestrationStarted = false;
      let inspectCancellation!: () => void;
      const cancellationRequested = new Promise<void>((resolve) => {
        inspectCancellation = resolve;
      });
      mockCreateTranscriptSink.mockReturnValue(fake.sink);
      setMutationBus({
        publish: vi.fn((event: Record<string, unknown>) => {
          published.push(event);
        }),
      } as never);
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
          orchestrationStarted = true;
          await cancellationRequested;
          expect(deps.cancel?.()).toBe(true);
          expect(deps.cancelReason?.()).toBe('system');
          expect(deps.cancelSource?.()).toBe('quiet-run');
          expect(deps.supersedeSystemCancellation?.()).toBe('quiet-run');
          deps.emit?.({
            kind: 'output',
            data: {
              event: 'system-cancel-superseded',
              cancellationSource: 'quiet-run',
              line: 'verified task progress superseded quiet-run cancellation for task one',
            },
          });
          return { kind: 'finalized', outcome: 'branch-complete' };
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

        expect(cancelMutation(runId, 'system', 'quiet-run')).toEqual({ ok: true });
        inspectCancellation();
        await waitForCondition(() => !activeRuns.has(runId));

        const supersessionTranscriptEvents = fake.appended.filter((event) =>
          ((event as MutationEvent).data as Record<string, unknown> | undefined)?.['event'] ===
          'system-cancel-superseded',
        );
        expect(supersessionTranscriptEvents).toHaveLength(1);
        expect(published).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'mutation-event',
            mutationId: runId,
            subKind: 'output',
            data: expect.objectContaining({ event: 'system-cancel-superseded' }),
          }),
          expect.objectContaining({
            kind: 'run-event',
            runId,
            subKind: 'log',
            lines: ['verified task progress superseded quiet-run cancellation for task one'],
          }),
        ]));
        expect(mockRecordRunActivity).toHaveBeenCalled();
      } finally {
        inspectCancellation();
        setMutationBus(null);
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

// ---------------------------------------------------------------------------
// The production `buildOrchestrationDeps` closures. Every other suite in this
// file injects `runOrchestration` wholesale, so `captureTaskBase` and the
// review-surface half of `runCloseoutChecks` were constructed on each dispatch
// but never actually called. Here `runOrchestration` is injected as a probe: it
// receives the REAL deps the applier built and invokes one closure directly, so
// these tests exercise production code rather than a re-description of it.
// ---------------------------------------------------------------------------
describe('buildOrchestrationDeps — production closures', () => {
  let wtDir: string | undefined;
  let artifactsDir: string | undefined;

  beforeEach(() => {
    activeRuns.clear();
    mockAppendMutationLine.mockClear();
    mockUpsertRun.mockClear();
    mockRunValidationCommands.mockReset();
    mockRunValidationCommands.mockResolvedValue({ ok: true });
    __setOrchestratedRuntimeForTest({
      refreshRegistry: (() => {}) as () => void,
      inspectWorktreeStatus: async () => '',
      invalidateRunCursor: () => {},
      verifyWorktree: async (opts) => ({
        ok: true,
        projectDir: join(opts.worktree, 'docs', 'projects', opts.project ?? 'demo'),
        specContent: readFileSync(join(opts.worktree, 'docs', 'projects', opts.project ?? 'demo', 'spec.md'), 'utf8'),
        tasksContent: readFileSync(join(opts.worktree, 'docs', 'projects', opts.project ?? 'demo', 'tasks.md'), 'utf8'),
      }),
    });
  });

  afterEach(() => {
    __resetOrchestratedRuntimeForTest();
    activeRuns.clear();
    if (wtDir) rmSync(wtDir, { recursive: true, force: true });
    if (artifactsDir) rmSync(artifactsDir, { recursive: true, force: true });
    wtDir = undefined;
    artifactsDir = undefined;
  });

  const TASK = {
    id: 'task-one',
    text: 'task one',
    section: 'Phase 1',
    validationPolicy: 'reviewed-no-validation' as const,
  };

  /** Dispatch the applier, but replace the orchestration loop with `probe`, so
   *  the probe runs against the real `OrchestrationDeps` the applier built. */
  async function withRealDeps(args: {
    runId: string;
    resumed: boolean;
    runCanonicalGit: GitRunner;
    captureTaskBaseTree?: (runGit: GitRunner, cwd: string) => Promise<string>;
    seedCursor?: (dir: string, runId: string, worktree: string) => void;
    probe: (deps: OrchestrationDeps) => Promise<void>;
  }): Promise<void> {
    const runsDir = mkdtempSync(join(tmpdir(), 'orch-real-deps-'));
    artifactsDir = runsDir;
    const { sandbox, dir } = makeWorktree();
    wtDir = dir;
    args.seedCursor?.(runsDir, args.runId, dir);
    // Probe failures are captured, not propagated: letting one reject
    // `runOrchestration` would route it into the applier's terminal/cleanup
    // machinery and surface as a hang instead of a readable assertion.
    let probeError: unknown;
    __setOrchestratedRuntimeForTest({
      workRunsDir: runsDir,
      workRunsIndexFile: join(runsDir, 'index.jsonl'),
      runGit: vi.fn(async () => ({ stdout: '', stderr: '' })),
      runCanonicalGit: args.runCanonicalGit,
      captureTaskBaseTree: args.captureTaskBaseTree ??
        (async () => { throw new Error('fresh capture must not run for this case'); }),
      createWorktree: async () => ({ ...sandbox, resumed: args.resumed }),
      destroyWorktree: async () => {},
      runOrchestration: async (deps) => {
        try {
          await args.probe(deps);
        } catch (err) {
          probeError = err;
        }
        return { kind: 'blocked', reason: 'probe complete', task: TASK };
      },
    });
    await drain(orchestratedWorkApplier.apply(makeDescriptor(undefined, args.runId), ctx));
    if (probeError !== undefined) throw probeError;
  }

  describe('captureTaskBase', () => {
    it('reuses and verifies a resumed run\'s durable task base instead of re-capturing', async () => {
      const durableTree = '1111111111111111111111111111111111111111';
      const revParseArgs: string[][] = [];
      let captured: { taskId: string; treeOid: string } | undefined;
      let freshCaptureCalls = 0;

      await withRealDeps({
        runId: 'mut-capture-durable',
        resumed: true,
        runCanonicalGit: vi.fn(async (gitArgs: string[]) => {
          if (gitArgs[0] === 'rev-parse') {
            revParseArgs.push([...gitArgs]);
            return { stdout: `${durableTree}\n`, stderr: '' };
          }
          throw new Error(`unexpected canonical git call: ${gitArgs.join(' ')}`);
        }),
        captureTaskBaseTree: async () => {
          freshCaptureCalls += 1;
          return '9999999999999999999999999999999999999999';
        },
        seedCursor: (dir, runId, worktree) => {
          writeOrchestratedRunCursor(dir, runId, {
            runId,
            product: 'rune',
            project: 'demo',
            branch: 'rune-work/demo',
            baseBranch: 'main',
            worktreePath: worktree,
            resumeMarker: 'resumable',
            cursor: { completedTaskIds: [], currentTaskId: TASK.id, nextTaskId: TASK.id },
            taskBase: { taskId: TASK.id, treeOid: durableTree },
          });
        },
        probe: async (deps) => {
          captured = await deps.captureTaskBase(TASK);
        },
      });

      // The durable base is verified, never re-derived: re-capturing on resume
      // would rebase the task onto work the interrupted attempt already did,
      // which is exactly the incremental-diff misjudgment the base prevents.
      expect(captured).toEqual({ taskId: TASK.id, treeOid: durableTree });
      expect(freshCaptureCalls).toBe(0);
      expect(revParseArgs).toEqual([['rev-parse', '--verify', `${durableTree}^{tree}`]]);
    });

    it('throws rather than reusing a durable task base recorded for a different task', async () => {
      let thrown: Error | undefined;

      await withRealDeps({
        runId: 'mut-capture-mismatch',
        resumed: true,
        runCanonicalGit: vi.fn(async () => {
          throw new Error('canonical git must not run for a mismatched base');
        }),
        seedCursor: (dir, runId, worktree) => {
          writeOrchestratedRunCursor(dir, runId, {
            runId,
            product: 'rune',
            project: 'demo',
            branch: 'rune-work/demo',
            baseBranch: 'main',
            worktreePath: worktree,
            resumeMarker: 'resumable',
            cursor: {
              completedTaskIds: [],
              currentTaskId: 'a-different-task',
              nextTaskId: 'a-different-task',
            },
            taskBase: { taskId: 'a-different-task', treeOid: '1111111111111111111111111111111111111111' },
          });
        },
        probe: async (deps) => {
          await deps.captureTaskBase(TASK).catch((err: Error) => { thrown = err; });
        },
      });

      expect(thrown?.message).toBe('durable task base belongs to a different task');
    });

    it('captures a fresh base for a non-resumed run even when a cursor task base exists on disk', async () => {
      const freshTree = '3333333333333333333333333333333333333333';
      let captured: { taskId: string; treeOid: string } | undefined;

      await withRealDeps({
        runId: 'mut-capture-fresh',
        resumed: false,
        runCanonicalGit: vi.fn(async () => {
          throw new Error('verification must not run when capturing fresh');
        }),
        captureTaskBaseTree: async () => freshTree,
        seedCursor: (dir, runId, worktree) => {
          writeOrchestratedRunCursor(dir, runId, {
            runId,
            product: 'rune',
            project: 'demo',
            branch: 'rune-work/demo',
            baseBranch: 'main',
            worktreePath: worktree,
            resumeMarker: 'resumable',
            cursor: { completedTaskIds: [], currentTaskId: TASK.id, nextTaskId: TASK.id },
            taskBase: { taskId: TASK.id, treeOid: '1111111111111111111111111111111111111111' },
          });
        },
        probe: async (deps) => {
          captured = await deps.captureTaskBase(TASK);
        },
      });

      // `resumed` is the only signal that a prior attempt owns the baseline. A
      // stale cursor from an earlier run of the same id must not silently
      // become a fresh dispatch's base.
      expect(captured).toEqual({ taskId: TASK.id, treeOid: freshTree });
    });

    it('captures a fresh base when a resumed run has no durable task base', async () => {
      const freshTree = '4444444444444444444444444444444444444444';
      let captured: { taskId: string; treeOid: string } | undefined;

      await withRealDeps({
        runId: 'mut-capture-resumed-no-base',
        resumed: true,
        runCanonicalGit: vi.fn(async () => {
          throw new Error('verification must not run without a durable base');
        }),
        captureTaskBaseTree: async () => freshTree,
        seedCursor: (dir, runId, worktree) => {
          writeOrchestratedRunCursor(dir, runId, {
            runId,
            product: 'rune',
            project: 'demo',
            branch: 'rune-work/demo',
            baseBranch: 'main',
            worktreePath: worktree,
            resumeMarker: 'resumable',
            cursor: { completedTaskIds: [], currentTaskId: null, nextTaskId: TASK.id },
          });
        },
        probe: async (deps) => {
          captured = await deps.captureTaskBase(TASK);
        },
      });

      expect(captured).toEqual({ taskId: TASK.id, treeOid: freshTree });
    });
  });

  describe('runCloseoutChecks — full-task review-surface verification', () => {
    const canonicalDiff = 'diff --git a/src/feature.ts b/src/feature.ts\n+shipped\n';
    const currentTree = '2222222222222222222222222222222222222222';

    function canonicalGitStub(): GitRunner {
      return vi.fn(async (gitArgs: string[]) => {
        if (gitArgs[0] === 'add') return { stdout: '', stderr: '' };
        if (gitArgs[0] === 'write-tree') return { stdout: `${currentTree}\n`, stderr: '' };
        if (gitArgs.includes('--name-only')) return { stdout: 'src/feature.ts\n', stderr: '' };
        return { stdout: canonicalDiff, stderr: '' };
      });
    }

    function evidence(overrides: Partial<TaskEvidence>): TaskEvidence {
      return {
        taskId: TASK.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: ['qa', 'coder', 'reviewer'],
        findingsLedger: [],
        loopExitReason: 'all-low',
        objectionOpen: false,
        handoffNotes: [],
        reviewerVerdict: { pass: true, objections: [] },
        ...overrides,
      } as TaskEvidence;
    }

    it('fails closed when an approved surface carries no canonical tree identities', async () => {
      let checks: Awaited<ReturnType<OrchestrationDeps['runCloseoutChecks']>> | undefined;

      await withRealDeps({
        runId: 'mut-closeout-missing-identities',
        resumed: false,
        runCanonicalGit: vi.fn(async () => {
          throw new Error('canonical capture must not run before the identity guard');
        }),
        probe: async (deps) => {
          checks = await deps.runCloseoutChecks(
            TASK,
            // An approval hash with no trees: unverifiable, so closeout must
            // refuse rather than fall through to the ok-path above it.
            evidence({ reviewSurfaceHash: canonicalReviewDiffHash(canonicalDiff) }),
          );
        },
      });

      expect(checks).toMatchObject({
        ok: false,
        failure: {
          command: 'full-task review-surface verification',
          outputTail: 'canonical review tree identities are missing',
          reviewSurfaceFailure: { kind: 'candidate-mismatch', canonicalHash: 'missing' },
        },
      });
    });

    it('fails closed when the hash still matches but the current tree drifted', async () => {
      let checks: Awaited<ReturnType<OrchestrationDeps['runCloseoutChecks']>> | undefined;
      let runsDirSeen: string | undefined;
      const approvedHash = canonicalReviewDiffHash(canonicalDiff);

      await withRealDeps({
        runId: 'mut-closeout-tree-drift',
        resumed: false,
        runCanonicalGit: canonicalGitStub(),
        probe: async (deps) => {
          runsDirSeen = artifactsDir;
          checks = await deps.runCloseoutChecks(
            TASK,
            evidence({
              reviewSurfaceHash: approvedHash,
              fullTaskReviewHash: approvedHash,
              taskBaseTree: '1111111111111111111111111111111111111111',
              // Both hashes agree, but the tree the roles judged is not the
              // tree on disk — the third leg of the equality check is the only
              // thing that catches this.
              currentReviewTree: '5555555555555555555555555555555555555555',
            }),
          );
        },
      });

      expect(checks).toMatchObject({
        ok: false,
        failure: {
          command: 'full-task review-surface verification',
          reviewSurfaceFailure: {
            kind: 'candidate-mismatch',
            canonicalHash: approvedHash,
            candidateHash: approvedHash,
            canonicalTree: currentTree,
            candidateTree: '5555555555555555555555555555555555555555',
          },
        },
      });

      // Durable evidence records identities only — never raw diff content.
      const durable = readFileSync(
        join(runsDirSeen!, 'mut-closeout-tree-drift', 'review-surface-failures.jsonl'),
        'utf8',
      );
      expect(durable).toContain('"candidateTree":"5555555555555555555555555555555555555555"');
      expect(durable).not.toContain('+shipped');
    });

    it('passes closeout when hash and current tree both match the approved surface', async () => {
      let checks: Awaited<ReturnType<OrchestrationDeps['runCloseoutChecks']>> | undefined;
      const approvedHash = canonicalReviewDiffHash(canonicalDiff);

      await withRealDeps({
        runId: 'mut-closeout-match',
        resumed: false,
        runCanonicalGit: canonicalGitStub(),
        probe: async (deps) => {
          checks = await deps.runCloseoutChecks(
            TASK,
            evidence({
              reviewSurfaceHash: approvedHash,
              fullTaskReviewHash: approvedHash,
              taskBaseTree: '1111111111111111111111111111111111111111',
              currentReviewTree: currentTree,
            }),
          );
        },
      });

      expect(checks).toEqual({ ok: true });
    });

    it('falls back to related validation when execution is green but canonical coverage evidence is missing', async () => {
      let checks: Awaited<ReturnType<OrchestrationDeps['runCloseoutChecks']>> | undefined;
      const approvedHash = canonicalReviewDiffHash(canonicalDiff);
      const requiredTask = { ...TASK, validationPolicy: 'required' as const };
      mockRunFullSuiteValidation.mockReset();
      mockRunFullSuiteValidation.mockResolvedValueOnce({
        ok: false,
        command: 'npm test',
        result: {
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          outputTail: 'trusted Vitest lifecycle evidence was missing or incomplete',
        },
        attestations: [],
        receipts: [],
        coverageComplete: false,
        validationReceipt: {
          outcome: 'failed',
          commands: [{ command: 'npm test', outcome: 'passed', coverage: 'invalid' }],
        },
      });
      mockRunValidationCommandArgv.mockClear();
      mockRunValidationCommandArgv.mockResolvedValue({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        outputHead: '',
        outputTail: '',
        diagnosticArtifacts: [],
      });

      await withRealDeps({
        runId: 'mut-closeout-coverage-fallback',
        resumed: false,
        runCanonicalGit: canonicalGitStub(),
        probe: async (deps) => {
          checks = await deps.runCloseoutChecks(
            requiredTask,
            evidence({
              reviewSurfaceHash: approvedHash,
              fullTaskReviewHash: approvedHash,
              taskBaseTree: '1111111111111111111111111111111111111111',
              currentReviewTree: currentTree,
            }),
          );
        },
      });

      expect(mockRunFullSuiteValidation).toHaveBeenCalledOnce();
      expect(mockRunValidationCommandArgv).toHaveBeenCalledTimes(3);
      expect(mockRunValidationCommandArgv.mock.calls.map((call) => call[4])).toEqual([
        { profile: 'isolated' },
        { profile: 'loopback' },
        { profile: 'sandbox-integration' },
      ]);
      expect(mockRunValidationCommandArgv.mock.calls.every((call) =>
        call[0]?.includes('related'),
      )).toBe(true);
      expect(checks).toMatchObject({
        ok: true,
        validationReceipt: {
          provenance: 'related-ran',
          outcome: 'passed',
          coverage: 'unsupported',
        },
      });
    });
  });
});

describe('shutdown park composition (suppression + parker, codex 2026-07-08 BLOCK)', () => {
  // The production race: shutdown() arms suppression, kills children, waits,
  // THEN parks. The killed applier's startApply unwind completes during that
  // wait — if the unwind removed the handle from activeRuns, the parker's
  // default snapshot would see nothing and the no-cursor run would be left
  // `running` (orphaned at next boot). This test drives the REAL startApply
  // (createMutation) and the parker's REAL default listActiveRuns +
  // writeTerminal (mutations-log and supervision-store are module-mocked).
  it('a suppressed applier that unwinds before the parker runs is still discoverable and parked', async () => {
    setMutationShutdownInProgress(true);
    try {
      let unwound = false;
      const fixture = {
        kind: 'orchestrated-work',
        autoApprove: true,
        validate: () => ({ ok: true as const }),
        apply: (descriptor: MutationDescriptor) =>
          (async function* () {
            try {
              // The SIGTERM'd child surfacing as a terminal the run never earned.
              yield {
                mutationId: descriptor.id,
                ts: new Date().toISOString(),
                kind: 'failed' as const,
                data: { reason: 'child SIGTERM surfaced as failure' },
              };
            } finally {
              unwound = true;
            }
          })(),
      };
      registerApplier(fixture as never);

      const created = await createMutation('orchestrated-work', { projectSlug: 'demo', product: 'rune' }, 'webview');
      expect((created as { ok: boolean }).ok).toBe(true);
      const descriptor = (created as unknown as { descriptor: MutationDescriptor }).descriptor;

      await waitForCondition(() => unwound);
      // Real-timer settle so startApply's own finally has definitely run —
      // asserting retention before it ran would pass spuriously even without
      // the retention guard. (No fake timers in this describe.)
      await new Promise((resolve) => setTimeout(resolve, 25));
      // Fully unwound under suppression: still running on disk, and the
      // handle is STILL in activeRuns for the parker to find.
      expect(descriptor.status).toBe('running');
      expect(activeRuns.has(descriptor.id)).toBe(true);

      const parkDeps = {
        ...defaultShutdownParkDeps(),
        readRunCursor: async () => null,
        runGit: vi.fn(async () => ({ stdout: '', stderr: '' })),
        worktreeExists: () => true,
        resolveBaseBranch: () => 'main',
        resolveWorktreePath: () => '/tmp/orch-park-compose-wt',
        resolveWorkBranch: async () => 'rune-work/rune/demo',
      };
      const parked = await parkInFlightOrchestratedRuns(parkDeps);

      expect(parked).toEqual({ parked: [descriptor.id], resumable: [], skipped: [] });
      // The default writeTerminal (writeRecoveredTerminalMutation) really ran:
      // descriptor terminalized completed+parked, supervision blocked-on-human.
      expect(descriptor.status).toBe('completed');
      const supervisionRows = (mockUpsertRun.mock.calls as unknown[][])
        .map((c) => c[0] as { id: string; status: string })
        .filter((row) => row.id === descriptor.id);
      expect(supervisionRows[supervisionRows.length - 1]!.status).toBe('blocked-on-human');
      const snapshots = (mockAppendMutationLine.mock.calls as unknown[][])
        .map((c) => c[0] as { id: string; status: string })
        .filter((line) => line.id === descriptor.id);
      expect(snapshots[snapshots.length - 1]!.status).toBe('completed');
    } finally {
      setMutationShutdownInProgress(false);
      activeRuns.clear();
    }
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
