/**
 * Phase 5 test suite for `src/intent/project-orchestrator.ts` — the multi-task
 * orchestrator loop (project 14, test-plan §5).
 *
 * Written TEST-FIRST — RED until `project-orchestrator.ts` lands in a later
 * `/work` run.
 *
 * The loop ties the Phase 3/4 substrate together: select the first unchecked
 * task → assemble bounded context → run the team-task workflow → on
 * ready-for-closeout, perform Rune-owned closeout (context update + tick
 * exactly the selected task + closeout checks + commit + clean-worktree verify) →
 * advance. A blocked/failed/objection task stops durably (never skipped). When no
 * tasks remain, it hands branch/run facts to the injected finalizer rather than
 * self-merging; an unavailable finalizer holds.
 *
 * Every effect is injected, so the whole loop runs on an in-memory fixture with
 * no git, no disk, and no live model call.
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §5
 */

import { describe, it, expect, vi } from 'vitest';

import {
  CLOSEOUT_REPAIR_CAP,
  runProjectOrchestration,
  type CloseoutCommit,
  type OrchestrationActivityEvent,
  type OrchestrationDeps,
  type OrchestrationResult,
} from './project-orchestrator.js';
import type {
  FindingSourceGate,
  FindingsLedgerEntry,
  GateRejectionFeedback,
  ObjectionFinding,
  ObjectionSeverity,
  TaskEvidence,
} from './team-task-workflow.js';
import type { SelectedTask } from './orch-task-select.js';
import type { FinalizerAdapter } from './finalizer-handoff.js';
import type { TaskRunRecord } from './orch-run-record.js';
import type { RelatedTestDiagnostic } from './related-test-diagnostic.js';
import { reconstructRun } from './orch-reconstruct.js';
import { seedProjectContext } from './project-context.js';
import { buildInvariantChecklistEvidence } from './invariant-review.js';

// ---------------------------------------------------------------------------
// In-memory fixture harness
// ---------------------------------------------------------------------------

interface Harness {
  deps: OrchestrationDeps;
  state: {
    tasksMd: string;
    contextMd: string;
    commits: string[];
    contextHandoffs: string[]; // the context each task saw at workflow time
    finalizeCalled: boolean;
    events: OrchestrationActivityEvent[];
  };
}

const TWO_TASKS = [
  '# Tasks',
  '',
  '## Phase 1',
  '- [ ] Build the streak core',
  '- [ ] Render the streak card',
].join('\n');

function readyEvidence(task: SelectedTask): TaskEvidence {
  return {
    taskId: task.id,
    outcome: 'ready-for-closeout',
    rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
    findingsLedger: [],
    loopExitReason: 'all-low',
    objectionOpen: false,
    handoffNotes: [`did ${task.text}`],
  };
}

function redCloseout(
  outputTail = 'FAIL src/streak.test.ts > renders the card\nAssertionError: expected 3 to be 2',
) {
  return {
    ok: false,
    failure: { command: 'npm test', exitCode: 1, timedOut: false, outputTail },
  } as const;
}

function fixtureTaskBase(task: SelectedTask) {
  return {
    taskId: task.id,
    treeOid: task.id === 'build-the-streak-core'
      ? '1111111111111111111111111111111111111111'
      : '2222222222222222222222222222222222222222',
  };
}

function makeHarness(over: Partial<OrchestrationDeps> = {}, tasksMd = TWO_TASKS): Harness {
  const state = {
    tasksMd,
    contextMd: seedProjectContext({ product: 'aura', projectTitle: 'Streaks' }),
    commits: [] as string[],
    contextHandoffs: [] as string[],
    finalizeCalled: false,
    events: [] as OrchestrationActivityEvent[],
  };

  const finalize: FinalizerAdapter = async () => {
    state.finalizeCalled = true;
    return { kind: 'finalized', outcome: 'branch-complete' };
  };

  const deps: OrchestrationDeps = {
    runId: 'run-1',
    project: '14-x',
    product: 'aura',
    branch: 'rune-work/14-x',
    baseBranch: 'main',
    readTasksMd: async () => state.tasksMd,
    readContextMd: async () => state.contextMd,
    readSpec: async () => 'spec body',
    captureTaskBase: async (task) => fixtureTaskBase(task),
    writeRunCursor: async () => {},
    runTaskWorkflow: async (task, ctx) => {
      state.contextHandoffs.push(ctx.contextMd);
      return readyEvidence(task);
    },
    curateContext: () => ({
      kind: 'neutral',
      sections: { 'Current State': 'task complete' },
    }),
    writeContextMd: async (content) => {
      state.contextMd = content;
    },
    writeTasksMd: async (content) => {
      state.tasksMd = content;
    },
    runPreCloseoutValidation: async () => ({
      ok: true,
      candidate: {
        evidence: {
          version: 1,
          durationMs: 0,
          outcome: 'skipped',
          reuseDecision: 'pending',
        },
      },
    }),
    runCloseoutChecks: async () => ({ ok: true } as const),
    commitCloseout: async (task) => {
      const sha = `sha-${task.id}`;
      state.commits.push(sha);
      return { sha, subject: `actual closeout subject for ${task.id}` };
    },
    verifyCleanWorktree: async () => true,
    finalize,
    emit: (event) => {
      state.events.push(event);
    },
    ...over,
  };

  return { deps, state };
}

function eventsByName(
  events: OrchestrationActivityEvent[],
  name: string,
): OrchestrationActivityEvent[] {
  return events.filter((event) => eventData(event)?.['event'] === name);
}

function eventNames(
  events: OrchestrationActivityEvent[],
): string[] {
  return events
    .map((event) => eventData(event)?.['event'])
    .filter((name): name is string => typeof name === 'string');
}

function closeoutProgressEvents(
  events: OrchestrationActivityEvent[],
): OrchestrationActivityEvent[] {
  return events.filter(
    (event) => event.kind === 'progress' && eventData(event)?.['event'] === 'closeout-commit',
  );
}

function eventData(event: OrchestrationActivityEvent): Record<string, unknown> | undefined {
  return event.data && typeof event.data === 'object'
    ? (event.data as Record<string, unknown>)
    : undefined;
}

function expectOperationalHold(
  res: OrchestrationResult,
  opts: { reason: RegExp; worktreePath: string },
): void {
  const raw = res as unknown as Record<string, unknown>;
  const handoff =
    raw['handoff'] && typeof raw['handoff'] === 'object'
      ? (raw['handoff'] as Record<string, unknown>)
      : {};

  expect(raw['kind']).toBe('held');
  expect(String(raw['reason'] ?? '')).toMatch(opts.reason);
  expect(raw).not.toHaveProperty('parked');
  expect(JSON.stringify(raw)).not.toMatch(/blocked-on-human/i);
  expect(raw['branch'] ?? handoff['branch']).toBe('rune-work/14-x');
  expect(raw['worktreePath'] ?? handoff['worktreePath']).toBe(opts.worktreePath);
  expect(raw['preserveBranch'] ?? handoff['preserveBranch']).toBe(true);
  expect(raw['preserveWorktree'] ?? handoff['preserveWorktree']).toBe(true);
}

function expectFindingHold(
  res: OrchestrationResult,
  opts: { reason: RegExp; worktreePath: string },
): void {
  const raw = res as unknown as Record<string, unknown>;
  const handoff =
    raw['handoff'] && typeof raw['handoff'] === 'object'
      ? (raw['handoff'] as Record<string, unknown>)
      : {};

  expect(raw['kind']).toBe('held');
  expect(String(raw['reason'] ?? '')).toMatch(opts.reason);
  expect(raw).not.toHaveProperty('parked');
  expect(JSON.stringify(raw)).not.toMatch(/blocked-on-human|PM|wrap-up/i);
  expect(raw['branch'] ?? handoff['branch']).toBe('rune-work/14-x');
  expect(raw['worktreePath'] ?? handoff['worktreePath']).toBe(opts.worktreePath);
  expect(raw['preserveBranch'] ?? handoff['preserveBranch']).toBe(true);
  expect(raw['preserveWorktree'] ?? handoff['preserveWorktree']).toBe(true);
}

interface PersistedRunCursor {
  runId: string;
  product: string;
  project: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  resumeMarker: 'resumable';
  cursor: {
    completedTaskIds: string[];
    currentTaskId: string | null;
    nextTaskId: string | null;
  };
}

interface TerminalBugEntry {
  runId: string;
  taskId: string;
  findingId: string;
  sourceGate: FindingSourceGate;
  class: ObjectionFinding['class'];
  severity: Exclude<ObjectionSeverity, 'low'>;
  location: string;
  rationale: string;
  reversible: boolean;
}

type TerminalBugRecordingDeps = OrchestrationDeps & {
  appendTerminalBugEntries: (entries: TerminalBugEntry[]) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Cooperative cancellation
// ---------------------------------------------------------------------------

describe('project-orchestrator — cancellation boundaries', () => {
  it.each([
    ['tech-lead', 'telegram', 'user'],
    ['qa', 'cockpit', 'user'],
    ['coder', 'internal', 'system'],
    ['reviewer', 'cockpit', 'user'],
  ] as const)(
    'maps nested %s cancellation from %s to the %s cancellation terminal',
    async (role, source, reason) => {
      const cancellation = {
        role,
        operationId: '12345678-1234-1234-1234-123456789abc',
        source,
        requestedAt: '2026-07-13T12:34:56.000Z',
      } as const;
      const h = makeHarness({
        runTaskWorkflow: async (task) => ({
          taskId: task.id,
          outcome: 'cancelled',
          rolesInvoked: [role],
          findingsLedger: [],
          loopExitReason: 'operational',
          objectionOpen: false,
          handoffNotes: [],
          cancellation,
          judgmentOutcomes: [
            { role: 'reviewer', status: 'cancelled', summary: 'cancelled by user' },
            { role: 'tech-lead', status: 'cancelled', summary: 'cancelled by sibling' },
          ],
        }),
      });

      const result = await runProjectOrchestration(h.deps);

      expect(result).toMatchObject({
        kind: 'cancelled',
        reason,
        cancellation,
        judgmentOutcomes: [
          { role: 'reviewer', status: 'cancelled', summary: 'cancelled by user' },
          { role: 'tech-lead', status: 'cancelled', summary: 'cancelled by sibling' },
        ],
        task: { text: 'Build the streak core' },
      });
      expect(h.state.tasksMd).toBe(TWO_TASKS);
      expect(h.state.commits).toEqual([]);
      expect(h.state.finalizeCalled).toBe(false);
    },
  );

  it('cancels before first task selection without workflow, closeout, or finalizer', async () => {
    const h = makeHarness({
      cancel: () => true,
      cancelReason: () => 'user',
    });

    const res = await runProjectOrchestration(h.deps);

    expect(res).toEqual({ kind: 'cancelled', reason: 'user' });
    expect(h.state.commits).toEqual([]);
    expect(h.state.finalizeCalled).toBe(false);
    expect(eventNames(h.state.events)).toEqual([]);
    expect(h.state.tasksMd).toBe(TWO_TASKS);
  });

  it('cancels after a ready workflow returns before closeout', async () => {
    let cancelled = false;
    const workflow = vi.fn(async (task: SelectedTask) => {
      cancelled = true;
      return readyEvidence(task);
    });
    const h = makeHarness({
      cancel: () => cancelled,
      cancelReason: () => 'user',
      runTaskWorkflow: workflow,
    });

    const res = await runProjectOrchestration(h.deps);

    expect(res).toMatchObject({
      kind: 'cancelled',
      reason: 'user',
      task: { text: 'Build the streak core' },
    });
    expect(workflow).toHaveBeenCalledOnce();
    expect(h.state.commits).toEqual([]);
    expect(h.state.finalizeCalled).toBe(false);
    expect(h.state.tasksMd).toBe(TWO_TASKS);
  });

  it('cancels after one successful closeout before selecting the next task', async () => {
    let cancelled = false;
    const h = makeHarness({
      cancel: () => cancelled,
      cancelReason: () => 'user',
      commitCloseout: async (task) => {
        const sha = `sha-${task.id}`;
        h.state.commits.push(sha);
        cancelled = true;
        return { sha, subject: `actual closeout subject for ${task.id}` };
      },
    });

    const res = await runProjectOrchestration(h.deps);

    expect(res).toMatchObject({
      kind: 'cancelled',
      reason: 'user',
      task: { text: 'Build the streak core' },
    });
    expect(h.state.commits).toEqual(['sha-build-the-streak-core']);
    expect(h.state.tasksMd).toContain('- [x] Build the streak core');
    expect(h.state.tasksMd).toContain('- [ ] Render the streak card');
    expect(eventsByName(h.state.events, 'task-selected').map((event) => eventData(event)?.['taskText']))
      .toEqual(['Build the streak core']);
    expect(h.state.finalizeCalled).toBe(false);
  });

  it('cancels when all tasks are complete before finalizer handoff', async () => {
    const h = makeHarness({
      cancel: () => true,
      cancelReason: () => 'user',
    }, [
      '# Tasks',
      '',
      '## Phase 1',
      '- [x] Build the streak core',
    ].join('\n'));

    const res = await runProjectOrchestration(h.deps);

    expect(res).toEqual({ kind: 'cancelled', reason: 'user' });
    expect(h.state.finalizeCalled).toBe(false);
  });

  it('preserves an unspecified non-revocable system cancel at orchestration boundaries', async () => {
    let cancelled = false;
    const h = makeHarness({
      cancel: () => cancelled,
      cancelReason: () => 'system',
      runTaskWorkflow: async (task) => {
        cancelled = true;
        return readyEvidence(task);
      },
    });

    const res = await runProjectOrchestration(h.deps);

    expect(res).toMatchObject({
      kind: 'cancelled',
      reason: 'system',
      task: { text: 'Build the streak core' },
    });
    expect(h.state.commits).toEqual([]);
    expect(h.state.finalizeCalled).toBe(false);
  });

  it('supersedes quiet cancellation after verified workflow progress, closes out, checkpoints, and advances', async () => {
    let cancelled = false;
    let source: 'quiet-run' | null = null;
    let workflowCalls = 0;
    const supersede = vi.fn(() => {
      if (!cancelled || source !== 'quiet-run') return null;
      cancelled = false;
      source = null;
      return 'quiet-run' as const;
    });
    const records: TaskRunRecord[] = [];
    const h = makeHarness({
      cancel: () => cancelled,
      cancelReason: () => cancelled ? 'system' : null,
      cancelSource: () => source,
      supersedeSystemCancellation: supersede,
      runTaskWorkflow: async (task) => {
        workflowCalls += 1;
        if (workflowCalls === 1) {
          cancelled = true;
          source = 'quiet-run';
        }
        return readyEvidence(task);
      },
      appendTaskRunRecord: async (record) => {
        records.push(record);
      },
    });

    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('finalized');
    expect(h.state.commits).toEqual([
      'sha-build-the-streak-core',
      'sha-render-the-streak-card',
    ]);
    expect(h.state.tasksMd).toContain('- [x] Build the streak core');
    expect(h.state.tasksMd).toContain('- [x] Render the streak card');
    expect(records.map((record) => record.taskId)).toEqual([
      'build-the-streak-core',
      'render-the-streak-card',
    ]);
    expect(supersede).toHaveBeenCalledOnce();
    expect(eventsByName(h.state.events, 'system-cancel-superseded')).toEqual([
      expect.objectContaining({
        kind: 'output',
        data: expect.objectContaining({
          cancellationSource: 'quiet-run',
          taskId: 'build-the-streak-core',
        }),
      }),
    ]);
    expect(eventsByName(h.state.events, 'task-selected').map((event) => eventData(event)?.['taskText']))
      .toEqual(['Build the streak core', 'Render the streak card']);
  });

  it.each(['blocked', 'failed', 'cancelled'] as const)(
    'honors revocable system cancellation when workflow evidence is %s',
    async (outcome) => {
      let cancelled = false;
      const supersede = vi.fn(() => 'quiet-run' as const);
      const h = makeHarness({
        cancel: () => cancelled,
        cancelReason: () => cancelled ? 'system' : null,
        cancelSource: () => cancelled ? 'quiet-run' : null,
        supersedeSystemCancellation: supersede,
        runTaskWorkflow: async (task) => {
          cancelled = true;
          return {
            taskId: task.id,
            outcome,
            rolesInvoked: ['qa'],
            findingsLedger: [],
            loopExitReason: 'operational',
            objectionOpen: false,
            handoffNotes: [],
            ...(outcome === 'blocked' ? { blockedReason: 'blocked' } : {}),
            ...(outcome === 'failed' ? { failureReason: 'failed' } : {}),
          } as TaskEvidence;
        },
      });

      const res = await runProjectOrchestration(h.deps);

      expect(res).toMatchObject({
        kind: 'cancelled',
        reason: 'system',
        task: { id: 'build-the-streak-core' },
      });
      expect(supersede).not.toHaveBeenCalled();
      expect(h.state.commits).toEqual([]);
      expect(h.state.tasksMd).toBe(TWO_TASKS);
    },
  );
});

// ---------------------------------------------------------------------------
// Closeout — marks exactly the task, commits, advances
// ---------------------------------------------------------------------------

describe('project-orchestrator — closeout', () => {
  it('after a task passes gates, marks exactly it, commits, and advances', async () => {
    const h = makeHarness();
    const res = await runProjectOrchestration(h.deps);
    // Both tasks ran to closeout; both checkboxes are ticked.
    expect(h.state.tasksMd).toContain('- [x] Build the streak core');
    expect(h.state.tasksMd).toContain('- [x] Render the streak card');
    // One closeout commit per task.
    expect(h.state.commits).toEqual(['sha-build-the-streak-core', 'sha-render-the-streak-card']);
    expect(res.kind).toBe('finalized');
  });

  it('holds durably without advancing when closeout cannot produce a clean checkpoint', async () => {
    const worktreePath = '/tmp/rune-worktrees/aura/14-dirty-worktree';
    const h = makeHarness({ verifyCleanWorktree: async () => false });
    const res = await runProjectOrchestration({ ...h.deps, worktreePath });
    expectOperationalHold(res, {
      reason: /operational|dirty|worktree|clean/i,
      worktreePath,
    });
    // A dirty worktree halts the run: it does NOT advance to the second task,
    // and it never finalizes.
    expect(h.state.tasksMd).toContain('- [ ] Render the streak card');
    expect(h.state.finalizeCalled).toBe(false);
  });

  it('runs a legacy "Confirm red before implementation." line through the normal role workflow', async () => {
    const tasksMd = [
      '# Tasks',
      '',
      '## Phase 2',
      '- [ ] Confirm red before implementation.',
      '- [ ] Build the run feed',
    ].join('\n');
    const workflow = vi.fn(async (task: SelectedTask): Promise<TaskEvidence> => readyEvidence(task));
    const readSpec = vi.fn(async () => 'spec body');
    const h = makeHarness({ runTaskWorkflow: workflow, readSpec }, tasksMd);

    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('finalized');
    expect(h.state.tasksMd).toContain('- [x] Confirm red before implementation.');
    expect(h.state.tasksMd).toContain('- [x] Build the run feed');
    expect(readSpec).toHaveBeenCalledTimes(2);
    expect(workflow).toHaveBeenCalledTimes(2);
    expect(workflow.mock.calls.map((call) => call[0].text)).toEqual([
      'Confirm red before implementation.',
      'Build the run feed',
    ]);
    expect(h.state.commits).toEqual([
      'sha-confirm-red-before-implementation',
      'sha-build-the-run-feed',
    ]);
  });

  it('blocks without ticking when a legacy "Confirm red before implementation." task fails role review', async () => {
    const tasksMd = [
      '# Tasks',
      '',
      '## Phase 2',
      '- [ ] Confirm red before implementation.',
      '- [ ] Build the run feed',
    ].join('\n');
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'blocked',
        rolesInvoked: ['coder', 'reviewer'],
        findingsLedger: [],
        loopExitReason: 'hard-budget',
        objectionOpen: false,
        handoffNotes: [],
        blockedReason: 'round cap reached with unresolved task feedback',
      }),
    }, tasksMd);

    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('blocked');
    expect(String((res as Extract<OrchestrationResult, { kind: 'blocked' }>).reason)).toMatch(/round cap/i);
    expect(h.state.tasksMd).toContain('- [ ] Confirm red before implementation.');
    expect(h.state.tasksMd).toContain('- [ ] Build the run feed');
    expect(h.state.commits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Operational terminal — non-finding failures hold, never human-park
// ---------------------------------------------------------------------------

describe('project-orchestrator — operational terminal', () => {
  it('attributes an unexpected orchestration exception to the latest execution checkpoint', async () => {
    const checkpoint = {
      taskId: 'build-the-streak-core',
      role: 'coder',
      provider: 'openai',
      format: 'codex',
      model: 'gpt-test',
      workflowStage: 'coder-implementation',
      checkpointedAt: '2026-07-22T00:00:00.000Z',
    } as const;
    const h = makeHarness({
      currentExecutionCheckpoint: () => checkpoint,
      runTaskWorkflow: async () => {
        throw new Error('unexpected /Users/private/operator/worktree failure');
      },
    });

    const res = await runProjectOrchestration(h.deps);

    expect(res).toMatchObject({
      kind: 'held',
      executionFailure: {
        ...checkpoint,
        failureStage: 'orchestration-adjacent',
        retryDisposition: 'not-eligible',
      },
    });
    expect(JSON.stringify(res)).not.toContain('/Users/private/operator/worktree');
  });

  it('routes typed executor failures operationally regardless of diagnostic wording', async () => {
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'failed',
        rolesInvoked: ['qa', 'coder'],
        findingsLedger: [],
        loopExitReason: 'operational',
        objectionOpen: false,
        handoffNotes: [],
        failureReason: 'purple banana',
        executionFailure: {
          taskId: task.id,
          role: 'coder',
          provider: 'openai',
          format: 'codex',
          model: 'gpt-test',
          workflowStage: 'coder-implementation',
          checkpointedAt: '2026-07-22T00:00:00.000Z',
          failureStage: 'provider',
          diagnostic: 'purple banana',
          retryable: true,
          attempts: [{
            attempt: 1,
            startedAt: '2026-07-22T00:00:00.000Z',
            endedAt: '2026-07-22T00:00:01.000Z',
            failureStage: 'provider',
            diagnostic: 'purple banana',
            retryable: true,
          }],
          retryDisposition: 'exhausted',
        },
      }),
    });

    const res = await runProjectOrchestration(h.deps);
    expect(res).toMatchObject({
      kind: 'held',
      reason: 'purple banana',
      executionFailure: { failureStage: 'provider', role: 'coder' },
    });
  });

  it('persists a terminal TaskRunRecord for a failed (non-cancelled) outcome before holding', async () => {
    const persistedRecords: TaskRunRecord[] = [];
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'failed',
        rolesInvoked: ['qa', 'coder'],
        findingsLedger: [],
        loopExitReason: 'operational',
        objectionOpen: false,
        handoffNotes: [],
        failureReason: 'coder execution crashed',
        executionFailure: {
          taskId: task.id,
          role: 'coder',
          provider: 'openai',
          format: 'codex',
          model: 'gpt-test',
          workflowStage: 'coder-implementation',
          checkpointedAt: '2026-07-22T00:00:00.000Z',
          failureStage: 'provider',
          diagnostic: 'coder execution crashed',
          retryable: true,
          attempts: [{
            attempt: 1,
            startedAt: '2026-07-22T00:00:00.000Z',
            endedAt: '2026-07-22T00:00:01.000Z',
            failureStage: 'provider',
            diagnostic: 'coder execution crashed',
            retryable: true,
          }],
          retryDisposition: 'exhausted',
        },
      }),
    });
    const deps = {
      ...h.deps,
      appendTaskRunRecord: async (record: TaskRunRecord) => {
        persistedRecords.push(record);
      },
    };

    const res = await runProjectOrchestration(deps);

    expect(res.kind).toBe('held');
    expect(persistedRecords).toHaveLength(1);
    expect(persistedRecords[0]).toEqual(
      expect.objectContaining({
        taskId: 'build-the-streak-core',
        commitSha: null,
        contextOutcome: 'unchanged',
        outcome: 'failed',
        executionFailure: expect.objectContaining({
          failureStage: 'provider',
          role: 'coder',
          retryDisposition: 'exhausted',
        }),
      }),
    );
  });

  it('routes an invariant-review contract failure to an operational hold and persists typed metadata', async () => {
    const persistedRecords: TaskRunRecord[] = [];
    let closeoutCalled = false;
    const invariantReviewFailure = {
      stage: 'security-ratification' as const,
      cause: 'invalid-evidence' as const,
      diagnostic: 'evidence anchor is absent',
    };
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'blocked',
        rolesInvoked: ['tech-lead', 'security'],
        findingsLedger: [],
        loopExitReason: 'operational',
        objectionOpen: false,
        handoffNotes: [],
        blockedReason: 'pre-coder invariant review failed; preserving clean worktree for retry',
        invariantReviewFailure,
      }),
      runCloseoutChecks: async () => {
        closeoutCalled = true;
        return { ok: true };
      },
    });
    const result = await runProjectOrchestration({
      ...h.deps,
      appendTaskRunRecord: async (record) => { persistedRecords.push(record); },
    });

    expect(result).toMatchObject({
      kind: 'held',
      reason: expect.stringContaining('pre-coder invariant review failed'),
    });
    expect(closeoutCalled).toBe(false);
    expect(persistedRecords[0]).toMatchObject({
      outcome: 'blocked',
      commitSha: null,
      invariantReviewFailure,
    });
  });

  it('persists an accepted pre-coder invariant checklist on a successful task record', async () => {
    const invariantChecklist = buildInvariantChecklistEvidence([{
      id: 'I1',
      category: 'ownership-and-containment',
      invariant: 'Keep writes inside the validated repository root.',
      evidence: [{ path: 'src/guard.ts', anchor: 'assertContained' }],
      draftIds: ['D1'],
    }]);
    const persistedRecords: TaskRunRecord[] = [];
    let workflowCalls = 0;
    const h = makeHarness({
      runTaskWorkflow: async (task) => {
        workflowCalls += 1;
        if (workflowCalls === 1) {
          return { ...readyEvidence(task), invariantChecklist };
        }
        return {
          taskId: task.id,
          outcome: 'blocked',
          rolesInvoked: ['qa', 'coder', 'reviewer'],
          findingsLedger: [],
          loopExitReason: 'hard-budget',
          objectionOpen: false,
          handoffNotes: [],
          blockedReason: 'pause after one persisted task',
        };
      },
    });

    await runProjectOrchestration({
      ...h.deps,
      appendTaskRunRecord: async (record) => { persistedRecords.push(record); },
    });

    expect(persistedRecords[0]).toMatchObject({
      outcome: 'ready-for-closeout',
      invariantChecklist,
    });
  });

  it('holds operationally (never proceeds) when the terminal-evidence write fails for a blocked/failed outcome', async () => {
    let secondTaskAttempted = false;
    const h = makeHarness({
      runTaskWorkflow: async (task) => {
        if (task.id === 'render-the-streak-card') secondTaskAttempted = true;
        return {
          taskId: task.id,
          outcome: 'blocked',
          rolesInvoked: ['qa', 'coder'],
          findingsLedger: [],
          loopExitReason: 'hard-budget',
          objectionOpen: false,
          handoffNotes: [],
          blockedReason: 'round cap reached',
        };
      },
    });
    const deps = {
      ...h.deps,
      appendTaskRunRecord: async () => {
        throw new Error('disk full');
      },
    };

    const res = await runProjectOrchestration(deps);

    // The recording failure leads (it is why the run cannot proceed), but the
    // terminal classification still composes into the reason — the write
    // failure must not mask what actually ended the task.
    expect(res).toMatchObject({
      kind: 'held',
      reason:
        'operational recording failure: disk full; terminal classification: round cap reached',
      preserveBranch: true,
      preserveWorktree: true,
    });
    expect(secondTaskAttempted).toBe(false);
  });

  it('still records terminal bugs for a severe finding when the terminal-evidence write fails', async () => {
    const bugEntries: TerminalBugEntry[] = [];
    const terminalFinding: FindingsLedgerEntry = {
      id: 'finding-streak-rollover-loss',
      sourceGate: 'reviewer',
      class: 'data-integrity',
      severity: 'high',
      location: 'src/streak.ts:12',
      rationale: 'streak rollover silently drops the final day',
      reversible: false,
      raisedRound: 3,
      status: 'open',
    };
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'blocked',
        rolesInvoked: ['qa', 'coder', 'reviewer'],
        findingsLedger: [terminalFinding],
        loopExitReason: 'hard-budget',
        objectionOpen: false,
        handoffNotes: [],
        blockedReason: 'non-reversible high finding must hold the branch',
      }),
    });
    const deps = {
      ...h.deps,
      appendTaskRunRecord: async () => {
        throw new Error('disk full');
      },
      appendTerminalBugEntries: async (entries: TerminalBugEntry[]) => {
        bugEntries.push(...entries);
      },
    };

    const res = await runProjectOrchestration(deps);

    // The compound failure must not swallow bug tracking: classification runs
    // (and records the bug) before the write failure escalates the hold.
    expect(bugEntries).toHaveLength(1);
    expect(bugEntries[0]).toMatchObject({
      findingId: 'finding-streak-rollover-loss',
      severity: 'high',
      reversible: false,
    });
    expect(res).toMatchObject({
      kind: 'held',
      preserveBranch: true,
      preserveWorktree: true,
    });
    expect((res as { reason: string }).reason).toContain(
      'operational recording failure: disk full',
    );
    expect((res as { reason: string }).reason).toContain(
      'terminal classification: non-reversible high finding must hold the branch',
    );
  });

  it('does not infer an operational HOLD from malformed diagnostic wording alone', async () => {
    const worktreePath = '/tmp/rune-worktrees/aura/14-malformed-gate-output';
    let workflowCalls = 0;
    const h = makeHarness({
      runTaskWorkflow: async (task) => {
        workflowCalls += 1;
        return {
          taskId: task.id,
          outcome: 'failed',
          rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
          findingsLedger: [],
          loopExitReason: 'operational',
          objectionOpen: false,
          handoffNotes: [],
          failureReason: 'operational failure: reviewer-verdict was malformed/unparseable JSON',
        };
      },
    });

    const res = await runProjectOrchestration({ ...h.deps, worktreePath });

    expect(res).toMatchObject({
      kind: 'blocked',
      reason: expect.stringMatching(/operational|malformed|unparseable|reviewer-verdict/i),
    });
    expect(h.state.tasksMd).toContain('- [ ] Build the streak core');
    expect(h.state.commits).toEqual([]);
    expect(workflowCalls).toBe(1);
    expect(h.state.finalizeCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Observability — orchestration-granularity lifecycle events
// ---------------------------------------------------------------------------

describe('project-orchestrator — observability events', () => {
  it('emits task-selected, attempt-start, and closeout lifecycle activity for a clean task', async () => {
    const h = makeHarness({}, [
      '# Tasks',
      '',
      '## Phase 1',
      '- [ ] Build the streak core',
    ].join('\n'));

    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('finalized');
    expect(eventNames(h.state.events)).toEqual([
      'task-selected',
      'task-base-captured',
      'attempt-start',
      'closeout-start',
      'closeout-complete',
    ]);

    expect(eventsByName(h.state.events, 'task-selected')[0]).toMatchObject({
      kind: 'activity',
      data: {
        event: 'task-selected',
        taskId: 'build-the-streak-core',
        taskText: 'Build the streak core',
        section: 'Phase 1',
        line: expect.stringContaining('Build the streak core'),
      },
    });
    expect(eventsByName(h.state.events, 'attempt-start')[0]).toMatchObject({
      kind: 'activity',
      data: {
        event: 'attempt-start',
        taskId: 'build-the-streak-core',
        attemptNumber: 1,
        attemptId: 'run-1-build-the-streak-core-attempt-1',
        line: expect.stringContaining('attempt 1'),
      },
    });
    expect(eventsByName(h.state.events, 'closeout-start')[0]).toMatchObject({
      kind: 'activity',
      data: {
        event: 'closeout-start',
        taskId: 'build-the-streak-core',
        line: expect.stringContaining('closeout'),
      },
    });
    expect(eventsByName(h.state.events, 'closeout-complete')[0]).toMatchObject({
      kind: 'activity',
      data: {
        event: 'closeout-complete',
        taskId: 'build-the-streak-core',
        commitSha: 'sha-build-the-streak-core',
        line: expect.stringContaining('sha-build-the-streak-core'),
      },
    });
  });

  it('emits one closeout progress event per successful closeout commit with live task counts', async () => {
    const h = makeHarness();

    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('finalized');
    const progress = closeoutProgressEvents(h.state.events);

    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatchObject({
      kind: 'progress',
      data: {
        event: 'closeout-commit',
        projectSlug: '14-x',
        product: 'aura',
        taskId: 'build-the-streak-core',
        taskText: 'Build the streak core',
        commitSha: 'sha-build-the-streak-core',
        shortSha: 'sha-bui',
        commitSubject: 'actual closeout subject for build-the-streak-core',
        tasksDone: 1,
        tasksTotal: 2,
        tasksRemaining: 1,
        line: expect.stringMatching(/Build the streak core.*1\/2 done.*1 remaining/i),
      },
    });
    expect(progress[1]).toMatchObject({
      kind: 'progress',
      data: {
        event: 'closeout-commit',
        projectSlug: '14-x',
        product: 'aura',
        taskId: 'render-the-streak-card',
        taskText: 'Render the streak card',
        commitSha: 'sha-render-the-streak-card',
        shortSha: 'sha-ren',
        commitSubject: 'actual closeout subject for render-the-streak-card',
        tasksDone: 2,
        tasksTotal: 2,
        tasksRemaining: 0,
        line: expect.stringMatching(/Render the streak card.*2\/2 done.*0 remaining/i),
      },
    });
  });

  it('waits for commitCloseout to succeed before emitting closeout progress', async () => {
    let resolveFirstCommit: (commit: CloseoutCommit) => void = () => {};
    let firstCommitStarted: () => void = () => {};
    const firstCommitStartedPromise = new Promise<void>((resolve) => {
      firstCommitStarted = resolve;
    });
    const firstCommit = new Promise<CloseoutCommit>((resolve) => {
      resolveFirstCommit = resolve;
    });
    let commitCalls = 0;

    const h = makeHarness({
      commitCloseout: async (task) => {
        commitCalls += 1;
        if (commitCalls === 1) {
          firstCommitStarted();
          return firstCommit;
        }
        const sha = `sha-${task.id}`;
        return { sha, subject: `actual closeout subject for ${task.id}` };
      },
    });

    const run = runProjectOrchestration(h.deps);
    await firstCommitStartedPromise;

    expect(closeoutProgressEvents(h.state.events)).toEqual([]);

    resolveFirstCommit({
      sha: 'late-closeout-sha',
      subject: 'actual closeout subject for build-the-streak-core',
    });

    const res = await run;

    expect(res.kind).toBe('finalized');
    expect(closeoutProgressEvents(h.state.events)[0]).toMatchObject({
      kind: 'progress',
      data: {
        event: 'closeout-commit',
        taskId: 'build-the-streak-core',
        commitSha: 'late-closeout-sha',
        shortSha: 'late-cl',
        commitSubject: 'actual closeout subject for build-the-streak-core',
        tasksDone: 1,
        tasksTotal: 2,
        tasksRemaining: 1,
      },
    });
  });

  it('does not re-run a blocked workflow through the legacy outer attempt cap', async () => {
    const feedback: GateRejectionFeedback = {
      rejectingRole: 'tech-lead',
      counterpartRole: 'qa',
      rejectedRole: 'qa',
      artifact: 'test-intent',
      rejectedArtifact: 'test-intent',
      reason: 'tests miss the rollover case',
      whatFailed: 'tests miss the rollover case',
      notes: ['tests miss the rollover case'],
      actionableNotes: ['tests miss the rollover case'],
    };
    let calls = 0;
    const h = makeHarness({
      runTaskWorkflow: async (task) => {
        calls += 1;
        return {
          taskId: task.id,
          outcome: 'blocked',
          rolesInvoked: ['qa', 'tech-lead'],
          findingsLedger: [],
          loopExitReason: 'hard-budget',
          objectionOpen: false,
          handoffNotes: [],
          blockedReason: feedback.reason,
          rejectionFeedback: feedback,
        };
      },
    }, [
      '# Tasks',
      '',
      '## Phase 1',
      '- [ ] Build the streak core',
    ].join('\n'));

    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('blocked');
    expect(calls).toBe(1);
    expect(eventNames(h.state.events)).toEqual([
      'task-selected',
      'task-base-captured',
      'attempt-start',
    ]);
    expect(eventsByName(h.state.events, 'attempt-start')).toEqual([
      expect.objectContaining({
        kind: 'activity',
        data: expect.objectContaining({
          event: 'attempt-start',
          taskId: 'build-the-streak-core',
          attemptNumber: 1,
          attemptId: 'run-1-build-the-streak-core-attempt-1',
        }),
      }),
    ]);
    expect(eventsByName(h.state.events, 'attempt-retry')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Block — a blocked/failed/objection task stops and is not skipped
// ---------------------------------------------------------------------------

describe('project-orchestrator — block', () => {
  it('stops on a blocked task and does not skip to the next', async () => {
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'blocked',
        rolesInvoked: ['qa', 'coder', 'reviewer'],
        findingsLedger: [],
        loopExitReason: 'hard-budget',
        objectionOpen: true,
        handoffNotes: [],
        blockedReason: 'open objection',
      }),
    });
    const res = await runProjectOrchestration(h.deps);
    expect(res.kind).toBe('blocked');
    // Neither task advanced — the blocked first task is not skipped.
    expect(h.state.tasksMd).toContain('- [ ] Build the streak core');
    expect(h.state.commits).toEqual([]);
    expect(h.state.finalizeCalled).toBe(false);
  });

  it('stops without blocked-on-human parking when feedback retries exhaust', async () => {
    const worktreePath = '/tmp/rune-worktrees/aura/14-x';
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'blocked',
        rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
        findingsLedger: [],
        loopExitReason: 'hard-budget',
        objectionOpen: false,
        handoffNotes: ['partial corrective work remains in the run worktree'],
        blockedReason: 'feedback retry cap exhausted',
      }),
    });
    const res = await runProjectOrchestration({
      ...h.deps,
      worktreePath,
    });

    expect(res.kind).toBe('blocked');
    expect(h.state.tasksMd).toContain('- [ ] Build the streak core');
    expect(h.state.tasksMd).toContain('- [ ] Render the streak card');
    expect(h.state.commits).toEqual([]);
    expect(h.state.finalizeCalled).toBe(false);
    expect(res).toMatchObject({
      kind: 'blocked',
      reason: 'feedback retry cap exhausted',
    });
    expect(res).not.toHaveProperty('parked');
  });

  it.each(['high', 'critical'] as const)(
    'stops without blocked-on-human parking when an open %s objection blocks a task',
    async (severity) => {
      const worktreePath = `/tmp/rune-worktrees/aura/14-x-${severity}`;
      const h = makeHarness({
        runTaskWorkflow: async (task) => ({
          taskId: task.id,
          outcome: 'blocked',
          rolesInvoked: ['qa', 'coder', 'reviewer'],
          findingsLedger: [],
          loopExitReason: 'hard-budget',
          objectionOpen: true,
          handoffNotes: ['partial fix remains inspectable on the held branch'],
          blockedReason: 'open objection-class finding',
          reviewerVerdict: {
            pass: false,
            objections: [
              {
                class: 'data-integrity',
                severity,
                location: 'src/state.ts:24',
                rationale: 'accepted work can corrupt persisted project state',
              },
            ],
          },
        }),
      });

      const res = await runProjectOrchestration({
        ...h.deps,
        worktreePath,
      });

      expect(res).toMatchObject({
        kind: 'blocked',
        reason: 'open objection-class finding',
      });
      expect(res).not.toHaveProperty('parked');
      expect(h.state.tasksMd).toContain('- [ ] Build the streak core');
      expect(h.state.commits).toEqual([]);
      expect(h.state.finalizeCalled).toBe(false);
    },
  );

  it('stops without blocked-on-human parking when an objection-open block has no severity details', async () => {
    const worktreePath = '/tmp/rune-worktrees/aura/14-x-objection-open';
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'blocked',
        rolesInvoked: ['qa', 'coder', 'reviewer'],
        findingsLedger: [],
        loopExitReason: 'hard-budget',
        objectionOpen: true,
        handoffNotes: ['the branch contains useful work that needs human objection handling'],
        blockedReason: 'open objection-class finding',
        reviewerVerdict: {
          outcome: 'fail',
          objections: [],
        },
      }),
    });

    const res = await runProjectOrchestration({
      ...h.deps,
      worktreePath,
    });

    expect(res).toMatchObject({
      kind: 'blocked',
      reason: 'open objection-class finding',
    });
    expect(res).not.toHaveProperty('parked');
    expect(h.state.tasksMd).toContain('- [ ] Build the streak core');
    expect(h.state.commits).toEqual([]);
    expect(h.state.finalizeCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Retry feedback — attempt N+1 receives gate feedback from attempt N
// ---------------------------------------------------------------------------

describe('project-orchestrator — retry feedback', () => {
  it('does not thread rejection feedback into a second whole-workflow attempt', async () => {
    const feedback: GateRejectionFeedback = {
      rejectingRole: 'tech-lead',
      counterpartRole: 'qa',
      rejectedRole: 'qa',
      artifact: 'test-intent',
      rejectedArtifact: 'test-intent',
      reason: 'tests miss the rollover case',
      whatFailed: 'tests miss the rollover case',
      notes: ['tests miss the rollover case'],
      actionableNotes: ['tests miss the rollover case'],
    };
    const workflowInputs: Array<{ rejectionFeedback?: GateRejectionFeedback }> = [];
    let calls = 0;
    const h = makeHarness({
      runTaskWorkflow: async (task, ctx) => {
        workflowInputs.push(ctx as { rejectionFeedback?: GateRejectionFeedback });
        calls += 1;
        return {
          taskId: task.id,
          outcome: 'blocked',
          rolesInvoked: ['qa', 'tech-lead'],
          findingsLedger: [],
          loopExitReason: 'hard-budget',
          objectionOpen: false,
          handoffNotes: [],
          blockedReason: feedback.reason,
          rejectionFeedback: feedback,
        };
      },
    });

    const res = await runProjectOrchestration(h.deps);

    expect(res).toMatchObject({ kind: 'blocked', reason: feedback.reason });
    expect(calls).toBe(1);
    expect(workflowInputs).toEqual([
      expect.objectContaining({ rejectionFeedback: undefined }),
    ]);
  });

  it('holds before finalization when terminal evidence has a non-reversible high finding', async () => {
    const worktreePath = '/tmp/rune-worktrees/aura/14-non-reversible-terminal';
    const bugEntries: TerminalBugEntry[] = [];
    const terminalFinding: FindingsLedgerEntry = {
      id: 'finding-auth-write-leak',
      sourceGate: 'reviewer',
      class: 'data-integrity',
      severity: 'high',
      location: 'src/state.ts:88',
      rationale: 'accepted writes can persist incorrect project state after release',
      reversible: false,
      raisedRound: 4,
      status: 'open',
    };
    let workflowCalls = 0;
    const h = makeHarness({
      runTaskWorkflow: async (task) => {
        workflowCalls += 1;
        return {
          taskId: task.id,
          outcome: 'blocked',
          rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
          objectionOpen: false,
          handoffNotes: ['severity loop reached the hard budget with non-reversible residue'],
          blockedReason: 'non-reversible high terminal residue must hold the branch',
          loopExitReason: 'hard-budget',
          reviewerVerdict: {
            outcome: 'fail',
            findings: [terminalFinding],
            objections: [terminalFinding],
          },
          findingsLedger: [terminalFinding],
        };
      },
    }, [
      '# Tasks',
      '',
      '## Phase 14',
      '- [ ] Remove the outer attempt cap',
    ].join('\n'));

    const res = await runProjectOrchestration({
      ...h.deps,
      worktreePath,
      appendTerminalBugEntries: async (entries) => {
        bugEntries.push(...entries);
      },
    });

    expectFindingHold(res, {
      reason: /non-reversible|high|terminal residue|hold/i,
      worktreePath,
    });
    expect(workflowCalls).toBe(1);
    expect(bugEntries).toEqual([
      {
        runId: 'run-1',
        taskId: 'remove-the-outer-attempt-cap',
        findingId: 'finding-auth-write-leak',
        sourceGate: 'reviewer',
        class: 'data-integrity',
        severity: 'high',
        location: 'src/state.ts:88',
        rationale: 'accepted writes can persist incorrect project state after release',
        reversible: false,
      },
    ]);
    expect(eventsByName(h.state.events, 'attempt-start')).toHaveLength(1);
    expect(eventsByName(h.state.events, 'attempt-retry')).toEqual([]);
    expect(h.state.tasksMd).toContain('- [ ] Remove the outer attempt cap');
    expect(h.state.commits).toEqual([]);
    expect(h.state.finalizeCalled).toBe(false);
  });

  it('logs reversible high/critical terminal findings and still proceeds to the gated finalizer', async () => {
    const bugEntries: TerminalBugEntry[] = [];
    const terminalFindings: FindingsLedgerEntry[] = [
      {
        id: 'finding-egress-timeout',
        sourceGate: 'reviewer',
        class: 'outbound',
        severity: 'critical',
        location: 'src/egress.ts:22',
        rationale: 'retry egress can temporarily exceed the outbound budget',
        reversible: true,
        raisedRound: 4,
        status: 'open',
      },
      {
        id: 'finding-cache-fanout',
        sourceGate: 'tech-lead',
        class: 'cost-perf',
        severity: 'high',
        location: 'src/cache.ts:47',
        rationale: 'cache miss fanout can spike compute cost under load',
        reversible: true,
        raisedRound: 4,
        status: 'open',
      },
    ];
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
        reviewerVerdict: {
          outcome: 'fail',
          findings: terminalFindings,
          objections: terminalFindings,
        },
        findingsLedger: terminalFindings,
        loopExitReason: 'hard-budget',
        objectionOpen: false,
        handoffNotes: ['terminal findings are reversible and logged for follow-up'],
      }),
      appendTerminalBugEntries: async (entries) => {
        bugEntries.push(...entries);
      },
    }, [
      '# Tasks',
      '',
      '## Phase 14',
      '- [ ] Log reversible terminal findings',
    ].join('\n'));
    let finalizerHandoff: { branch: string; taskRecords: TaskRunRecord[] } | undefined;
    h.deps.finalize = async (handoff) => {
      finalizerHandoff = handoff;
      return { kind: 'finalized', outcome: 'branch-complete' };
    };

    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('finalized');
    expect(finalizerHandoff).toMatchObject({
      branch: 'rune-work/14-x',
      taskRecords: [expect.objectContaining({ taskId: 'log-reversible-terminal-findings' })],
    });
    expect(bugEntries).toEqual([
      expect.objectContaining({
        findingId: 'finding-egress-timeout',
        severity: 'critical',
        reversible: true,
      }),
      expect.objectContaining({
        findingId: 'finding-cache-fanout',
        severity: 'high',
        reversible: true,
      }),
    ]);
  });

  it('does not fail-close the run when a committed task carries an open finding but no terminal-bug writer is wired', async () => {
    // Regression: the per-task loop recorded terminal bugs fail-closed, so a
    // committed task carrying any open objection-class finding halted the WHOLE
    // run as an operational hold ("writer not configured") because
    // appendTerminalBugEntries is an optional dep not wired in production. A
    // missing writer must be tolerated after a clean closeout.
    const terminalFinding: FindingsLedgerEntry = {
      id: 'finding-stale-objection',
      sourceGate: 'reviewer',
      class: 'data-integrity',
      severity: 'critical',
      location: 'src/finalizer.ts:285',
      rationale: 'reviewer objection raised against a partial diff; the symbol exists in the committed tree',
      reversible: true,
      raisedRound: 4,
      status: 'open',
    };
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
        reviewerVerdict: {
          outcome: 'fail',
          findings: [terminalFinding],
          objections: [terminalFinding],
        },
        findingsLedger: [terminalFinding],
        loopExitReason: 'hard-budget',
        objectionOpen: false,
        handoffNotes: ['open objection carried past the round cap'],
      }),
    }, [
      '# Tasks',
      '',
      '## Phase 14',
      '- [ ] Wire the index writer',
    ].join('\n'));
    // No appendTerminalBugEntries wired — the production default.
    let finalized = false;
    h.deps.finalize = async () => {
      finalized = true;
      return { kind: 'finalized', outcome: 'branch-complete' };
    };

    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('finalized');
    expect(finalized).toBe(true);
    expect(h.state.commits).toEqual(['sha-wire-the-index-writer']);
  });
});

// ---------------------------------------------------------------------------
// Context influence — task N's update reaches task N+1's input
// ---------------------------------------------------------------------------

describe('project-orchestrator — context influence', () => {
  it('feeds the context updated by task N into task N+1', async () => {
    const h = makeHarness({
      curateContext: (_current, evidence) => ({
        kind: 'neutral',
        sections: { 'Current State': `done: ${evidence.taskId}` },
      }),
    });
    await runProjectOrchestration(h.deps);
    // The second task saw a context that records the first task's completion.
    expect(h.state.contextHandoffs).toHaveLength(2);
    expect(h.state.contextHandoffs[1]).toContain('done: build-the-streak-core');
  });
});

// ---------------------------------------------------------------------------
// Durable run state — TaskRunRecords + resume cursor survive a restart
// ---------------------------------------------------------------------------

describe('project-orchestrator — durable run state', () => {
  it('persists TaskRunRecords and a resumable cursor after closeout before advancing', async () => {
    const worktreePath = '/tmp/rune-worktrees/aura/14-x';
    const persistedRecords: TaskRunRecord[] = [];
    const persistedCursors: PersistedRunCursor[] = [];
    let workflowCalls = 0;
    const h = makeHarness({
      runTaskWorkflow: async (task) => {
        workflowCalls += 1;
        if (workflowCalls === 1) {
          return {
            ...readyEvidence(task),
            judgmentOutcomes: [
              { role: 'reviewer', status: 'pass' },
              { role: 'tech-lead', status: 'pass' },
            ],
            coderSelfReviews: [{
              round: 1,
              outcome: 'revised',
              notes: 'Corrected the staged guard.',
              canonicalHash: 'canonical-review-hash',
              changedPaths: ['src/streak.ts'],
            }],
            taskBaseTree: '1111111111111111111111111111111111111111',
            currentReviewTree: '3333333333333333333333333333333333333333',
            fullTaskReviewHash: 'full-task-review-hash',
            adjudications: [{
              round: 1,
              dissentingRole: 'reviewer',
              concurringRole: 'tech-lead',
              signature: 'cost-perf/medium @ src/streak.ts:8',
              upheld: 'pass',
              rationale: 'The bounded update satisfies the task contract.',
              escalated: false,
              executedModelAlias: 'gpt-5.6-terra',
              executedProvider: 'openai',
            }],
            downgradedFindings: [{
              finding: {
                class: 'cost-perf',
                severity: 'medium',
                location: 'src/streak.ts:8',
                rationale: 'A follow-up could simplify the bounded update.',
              },
              sourceGate: 'reviewer',
              round: 1,
              gaps: [],
              reason: 'adjudicator upheld the pass',
              rePrompted: false,
            }],
          };
        }
        return {
          taskId: task.id,
          outcome: 'blocked',
          rolesInvoked: ['qa', 'coder', 'reviewer'],
          findingsLedger: [],
          loopExitReason: 'hard-budget',
          objectionOpen: false,
          handoffNotes: [],
          blockedReason: 'pause after one persisted task',
        };
      },
    });
    const deps = {
      ...h.deps,
      worktreePath,
      appendTaskRunRecord: async (record: TaskRunRecord) => {
        persistedRecords.push(record);
      },
      writeRunCursor: async (cursor: unknown) => {
        persistedCursors.push(cursor as PersistedRunCursor);
      },
    };

    const res = await runProjectOrchestration(deps);

    expect(res.kind).toBe('blocked');
    expect(persistedRecords).toHaveLength(2);
    expect(persistedRecords[0]).toEqual(
      expect.objectContaining({
        taskId: 'build-the-streak-core',
        taskText: 'Build the streak core',
        attemptId: 'run-1-build-the-streak-core',
        rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
        commitSha: 'sha-build-the-streak-core',
        contextOutcome: 'updated',
        gates: { objectionOpen: false },
        outcome: 'ready-for-closeout',
        coderSelfReviews: [{
          round: 1,
          outcome: 'revised',
          notes: 'Corrected the staged guard.',
          canonicalHash: 'canonical-review-hash',
          changedPaths: ['src/streak.ts'],
        }],
        taskBaseTree: '1111111111111111111111111111111111111111',
        currentReviewTree: '3333333333333333333333333333333333333333',
        fullTaskReviewHash: 'full-task-review-hash',
        judgmentOutcomes: [
          { role: 'reviewer', status: 'pass' },
          { role: 'tech-lead', status: 'pass' },
        ],
        adjudications: [expect.objectContaining({
          dissentingRole: 'reviewer',
          upheld: 'pass',
          executedModelAlias: 'gpt-5.6-terra',
        })],
        modelChoices: { adjudicator: 'gpt-5.6-terra' },
        downgradedFindings: [expect.objectContaining({
          sourceGate: 'reviewer',
          reason: 'adjudicator upheld the pass',
        })],
      }),
    );
    expect(persistedRecords[1]).toEqual(
      expect.objectContaining({
        taskId: 'render-the-streak-card',
        commitSha: null,
        contextOutcome: 'unchanged',
        outcome: 'blocked',
      }),
    );
    expect(persistedCursors).toContainEqual({
      runId: 'run-1',
      product: 'aura',
      project: '14-x',
      branch: 'rune-work/14-x',
      baseBranch: 'main',
      worktreePath,
      resumeMarker: 'resumable',
      cursor: {
        completedTaskIds: ['build-the-streak-core'],
        currentTaskId: null,
        nextTaskId: 'render-the-streak-card',
      },
    });

    const reconstructed = reconstructRun({
      tasksMd: h.state.tasksMd,
      records: persistedRecords,
    });
    expect(reconstructed.completedTaskIds).toEqual(['build-the-streak-core']);
    expect(reconstructed.nextTask?.id).toBe('render-the-streak-card');
    expect(reconstructed.drift).toBe(false);
  });

  it('writes a task-start cursor BEFORE the workflow runs — the mid-first-task window is resumable', async () => {
    // bugs.md (restart safety 2/2): before this, the cursor only existed after
    // the first closeout, so a restart during task 1 was orphaned. The
    // task-start cursor's existence is what boot recovery gates on.
    const worktreePath = '/tmp/rune-worktrees/aura/14-x';
    const calls: string[] = [];
    const persistedCursors: PersistedRunCursor[] = [];
    const h = makeHarness({
      runTaskWorkflow: async (task) => {
        calls.push(`workflow:${task.id}`);
        return {
          taskId: task.id,
          outcome: 'blocked',
          rolesInvoked: ['qa', 'coder', 'reviewer'],
          findingsLedger: [],
          loopExitReason: 'hard-budget',
          objectionOpen: false,
          handoffNotes: [],
          blockedReason: 'stop during the first task',
        };
      },
    });
    const deps = {
      ...h.deps,
      worktreePath,
      writeRunCursor: async (cursor: unknown) => {
        const c = cursor as PersistedRunCursor;
        calls.push(`cursor:${c.cursor.currentTaskId ?? 'closeout'}`);
        persistedCursors.push(c);
      },
    };

    const res = await runProjectOrchestration(deps);

    expect(res.kind).toBe('blocked');
    // The cursor landed before the workflow ever ran.
    expect(calls).toEqual(['cursor:build-the-streak-core', 'workflow:build-the-streak-core']);
    expect(persistedCursors[0]).toEqual({
      runId: 'run-1',
      product: 'aura',
      project: '14-x',
      branch: 'rune-work/14-x',
      baseBranch: 'main',
      worktreePath,
      resumeMarker: 'resumable',
      cursor: {
        completedTaskIds: [],
        currentTaskId: 'build-the-streak-core',
        nextTaskId: 'build-the-streak-core',
      },
      taskBase: fixtureTaskBase({
        id: 'build-the-streak-core',
        text: 'Build the streak core',
        section: 'Phase 1',
      }),
    });
    // Round-trip the exact recovery input for this window: cursor present,
    // zero records, zero ticked boxes → resume re-selects the same task.
    const reconstructed = reconstructRun({ tasksMd: h.state.tasksMd, records: [] });
    expect(reconstructed.completedTaskIds).toEqual([]);
    expect(reconstructed.nextTask?.id).toBe('build-the-streak-core');
    expect(reconstructed.drift).toBe(false);
  });

  it('refreshes the task-start cursor each iteration; closeout cursors keep currentTaskId null', async () => {
    const worktreePath = '/tmp/rune-worktrees/aura/14-x';
    const persistedCursors: PersistedRunCursor[] = [];
    const h = makeHarness();
    const deps = {
      ...h.deps,
      worktreePath,
      appendTaskRunRecord: async () => {},
      writeRunCursor: async (cursor: unknown) => {
        persistedCursors.push(cursor as PersistedRunCursor);
      },
    };

    const res = await runProjectOrchestration(deps);

    expect(res.kind).toBe('finalized');
    // start(task1) → closeout → start(task2) → closeout.
    expect(persistedCursors.map((c) => c.cursor.currentTaskId)).toEqual([
      'build-the-streak-core',
      null,
      'render-the-streak-card',
      null,
    ]);
    // The second start-cursor carries the first task's completion.
    expect(persistedCursors[2]!.cursor.completedTaskIds).toEqual(['build-the-streak-core']);
    expect(persistedCursors[2]!.cursor.nextTaskId).toBe('render-the-streak-card');
  });

  it('fails closed before workflow mutation when the task-base cursor write fails', async () => {
    const worktreePath = '/tmp/rune-worktrees/aura/14-x';
    const persistedCursors: PersistedRunCursor[] = [];
    let workflowCalls = 0;
    const h = makeHarness({
      runTaskWorkflow: async (task) => {
        workflowCalls += 1;
        return readyEvidence(task);
      },
    });
    const deps = {
      ...h.deps,
      worktreePath,
      appendTaskRunRecord: async () => {},
      writeRunCursor: async (cursor: unknown) => {
        const c = cursor as PersistedRunCursor;
        if (c.cursor.currentTaskId !== null) throw new Error('start-write disk failure');
        persistedCursors.push(c);
      },
    };

    const res = await runProjectOrchestration(deps);

    expect(res).toMatchObject({
      kind: 'held',
      reason: expect.stringContaining('task-base checkpoint failed before task mutation'),
      preserveWorktree: true,
    });
    expect(workflowCalls).toBe(0);
    expect(persistedCursors).toEqual([]);
  });

  it('fails closed before workflow mutation when captureTaskBase returns a mismatched task id', async () => {
    let workflowCalls = 0;
    const h = makeHarness({
      captureTaskBase: async (task) => ({
        taskId: 'wrong-task-id',
        treeOid: task.id === 'build-the-streak-core'
          ? '1111111111111111111111111111111111111111'
          : '2222222222222222222222222222222222222222',
      }),
      runTaskWorkflow: async (task) => {
        workflowCalls += 1;
        return readyEvidence(task);
      },
    });

    const res = await runProjectOrchestration(h.deps);

    expect(res).toMatchObject({
      kind: 'held',
      reason: expect.stringContaining(
        'task-base capture returned an invalid task/tree identity',
      ),
      preserveWorktree: true,
    });
    expect(workflowCalls).toBe(0);
  });

  it('fails closed before workflow mutation when captureTaskBase returns a malformed tree OID', async () => {
    let workflowCalls = 0;
    const h = makeHarness({
      captureTaskBase: async (task) => ({ taskId: task.id, treeOid: 'not-a-tree-oid' }),
      runTaskWorkflow: async (task) => {
        workflowCalls += 1;
        return readyEvidence(task);
      },
    });

    const res = await runProjectOrchestration(h.deps);

    expect(res).toMatchObject({
      kind: 'held',
      reason: expect.stringContaining(
        'task-base capture returned an invalid task/tree identity',
      ),
    });
    expect(workflowCalls).toBe(0);
  });

  it('fails closed before workflow mutation when no durable run-cursor writer is available', async () => {
    let workflowCalls = 0;
    const h = makeHarness({
      writeRunCursor: undefined,
      runTaskWorkflow: async (task) => {
        workflowCalls += 1;
        return readyEvidence(task);
      },
    });

    const res = await runProjectOrchestration(h.deps);

    expect(res).toMatchObject({
      kind: 'held',
      reason: expect.stringContaining('durable run cursor writer is unavailable'),
      preserveWorktree: true,
    });
    expect(workflowCalls).toBe(0);
  });

  it('records pass-with-warnings findings in the TaskRunRecord and finalizer handoff while proceeding', async () => {
    const persistedRecords: TaskRunRecord[] = [];
    const warningFinding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/cache.ts:44',
      rationale: 'follow-up can reduce duplicate reads; correctness is unaffected',
      reversible: true,
    } as const;
    const warningLedger: FindingsLedgerEntry[] = [{
      id: 'finding-cache-duplicate-reads',
      sourceGate: 'reviewer',
      raisedRound: 1,
      status: 'open',
      ...warningFinding,
    }];
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
        reviewerVerdict: {
          outcome: 'pass-with-warnings',
          objections: [warningFinding],
        },
        findingsLedger: warningLedger,
        loopExitReason: 'all-low',
        objectionOpen: false,
        handoffNotes: ['shipped with a low-severity performance caveat'],
        coderSelfReviews: [{
          round: 1,
          outcome: 'confirmed',
          notes: 'Validated the staged cache change.',
          canonicalHash: 'cache-review-hash',
          changedPaths: ['src/cache.ts'],
        }],
      }),
      appendTaskRunRecord: async (record) => {
        persistedRecords.push(record);
      },
    }, [
      '# Tasks',
      '',
      '## Phase 1',
      '- [ ] Cache repeated reads',
    ].join('\n'));
    let finalizerRecords: TaskRunRecord[] | undefined;
    h.deps.finalize = async (handoff) => {
      finalizerRecords = handoff.taskRecords;
      return { kind: 'finalized', outcome: 'branch-complete' };
    };

    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('finalized');
    expect(h.state.tasksMd).toContain('- [x] Cache repeated reads');
    expect(persistedRecords).toEqual([
      expect.objectContaining({
        taskId: 'cache-repeated-reads',
        outcome: 'ready-for-closeout',
        verdicts: { reviewer: 'pass-with-warnings' },
        warnings: [warningFinding],
        coderSelfReviews: [expect.objectContaining({
          outcome: 'confirmed',
          canonicalHash: 'cache-review-hash',
        })],
      }),
    ]);
    expect(finalizerRecords).toEqual([
      expect.objectContaining({
        taskId: 'cache-repeated-reads',
        warnings: [warningFinding],
        coderSelfReviews: [expect.objectContaining({
          notes: 'Validated the staged cache change.',
          changedPaths: ['src/cache.ts'],
        })],
      }),
    ]);
  });

  it('records all low findings from a primary-exit round as warnings in records and finalizer handoff', async () => {
    const persistedRecords: TaskRunRecord[] = [];
    const reviewerWarning: ObjectionFinding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/cache.ts:44',
      rationale: 'follow-up can reduce duplicate reads; correctness is unaffected',
      reversible: true,
    };
    const techLeadWarning: ObjectionFinding = {
      class: 'concurrency',
      severity: 'low',
      location: 'src/queue.ts:61',
      rationale: 'duplicate starts can race but retry makes them harmless',
      reversible: true,
    };
    const designerWarning: ObjectionFinding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/server/static/app.js:114',
      rationale: 'extra repaint is visible on slow devices',
      reversible: true,
    };
    const allWarnings = [reviewerWarning, techLeadWarning, designerWarning];
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead', 'designer'],
        reviewerVerdict: {
          outcome: 'pass-with-warnings',
          findings: [reviewerWarning],
          objections: [reviewerWarning],
        },
        gateVerdicts: {
          reviewer: {
            outcome: 'pass-with-warnings',
            findings: [reviewerWarning],
          },
          techLeadDiff: {
            outcome: 'pass-with-warnings',
            findings: [techLeadWarning],
          },
          designer: {
            outcome: 'pass-with-warnings',
            findings: [designerWarning],
          },
        },
        findingsLedger: allWarnings.map((finding, index) => ({
          id: `low-${index}`,
          sourceGate: index === 0 ? 'reviewer' : index === 1 ? 'tech-lead' : 'designer',
          ...finding,
          reversible: finding.reversible ?? false,
          status: 'open',
          raisedRound: 1,
        })),
        loopExitReason: 'all-low',
        objectionOpen: false,
        handoffNotes: ['all open findings were low severity'],
      }),
      appendTaskRunRecord: async (record) => {
        persistedRecords.push(record);
      },
    }, [
      '# Tasks',
      '',
      '## Phase 1',
      '- [ ] Polish all-low gates',
    ].join('\n'));
    let finalizerRecords: TaskRunRecord[] | undefined;
    h.deps.finalize = async (handoff) => {
      finalizerRecords = handoff.taskRecords;
      return { kind: 'finalized', outcome: 'branch-complete' };
    };

    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('finalized');
    expect(persistedRecords).toEqual([
      expect.objectContaining({
        taskId: 'polish-all-low-gates',
        outcome: 'ready-for-closeout',
        warnings: allWarnings,
      }),
    ]);
    expect(finalizerRecords).toEqual([
      expect.objectContaining({
        taskId: 'polish-all-low-gates',
        warnings: allWarnings,
      }),
    ]);
  });

  it('records accepted PM rationale in the TaskRunRecord and finalizer handoff while proceeding', async () => {
    const persistedRecords: TaskRunRecord[] = [];
    const acceptance = {
      actor: 'pm',
      decision: 'accepted-with-rationale',
      rationale:
        'Accepting because the remaining concern is a low-risk copy preference and the task contract is satisfied.',
      dissentingRole: 'reviewer',
      overriddenVerdict: {
        outcome: 'fail',
        findings: [],
        notes: 'reviewer wanted copy polish beyond the task contract',
      },
    };
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead', 'pm'],
        reviewerVerdict: {
          outcome: 'fail',
          objections: [],
          notes: 'reviewer wanted copy polish beyond the task contract',
        },
        findingsLedger: [],
        loopExitReason: 'all-low',
        objectionOpen: false,
        handoffNotes: ['PM accepted the remaining non-objection review concern'],
        acceptance,
      } as TaskEvidence),
      appendTaskRunRecord: async (record) => {
        persistedRecords.push(record);
      },
    }, [
      '# Tasks',
      '',
      '## Phase 1',
      '- [ ] Ship acceptable empty-state copy',
    ].join('\n'));
    let finalizerRecords: TaskRunRecord[] | undefined;
    h.deps.finalize = async (handoff) => {
      finalizerRecords = handoff.taskRecords;
      return { kind: 'finalized', outcome: 'branch-complete' };
    };

    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('finalized');
    expect(persistedRecords).toEqual([
      expect.objectContaining({
        taskId: 'ship-acceptable-empty-state-copy',
        outcome: 'ready-for-closeout',
        verdicts: { reviewer: 'fail' },
        acceptance,
      }),
    ]);
    expect(finalizerRecords).toEqual([
      expect.objectContaining({
        taskId: 'ship-acceptable-empty-state-copy',
        acceptance,
      }),
    ]);
  });

  it('emits a pm-acceptance progress event, even when closeout checks subsequently fail', async () => {
    const acceptance = {
      actor: 'pm',
      decision: 'accepted-with-rationale',
      rationale: 'Accepted at /Users/operator/private/notes.md because behavior is correct.',
      dissentingRole: 'reviewer',
      overriddenVerdict: {
        outcome: 'fail',
        findings: [],
        notes: 'reviewer wanted a rename',
      },
    };
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead', 'pm'],
        reviewerVerdict: { outcome: 'fail', objections: [], notes: 'reviewer wanted a rename' },
        findingsLedger: [],
        loopExitReason: 'all-low',
        objectionOpen: false,
        handoffNotes: ['PM accepted over reviewer dissent'],
        acceptance,
      } as TaskEvidence),
      // Even when validation subsequently fails, the operator must already
      // have been told about the override — the emit happens before this call.
      runCloseoutChecks: async () => redCloseout(),
    }, [
      '# Tasks',
      '',
      '## Phase 1',
      '- [ ] Rename the widget',
    ].join('\n'));

    const res = await runProjectOrchestration(h.deps);

    const raw = res as unknown as Record<string, unknown>;
    expect(raw['kind']).toBe('held');

    const events = eventsByName(h.state.events, 'pm-acceptance');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({
      kind: 'progress',
      data: {
        event: 'pm-acceptance',
        projectSlug: '14-x',
        product: 'aura',
        taskId: 'rename-the-widget',
        taskText: 'Rename the widget',
        actor: 'pm',
        overriddenRole: 'reviewer',
        rationale: expect.stringContaining('because behavior is correct'),
      },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('/Users/operator');
  });

  it('does not emit a pm-acceptance event when the task closes out without an override', async () => {
    const h = makeHarness();

    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('finalized');
    expect(eventsByName(h.state.events, 'pm-acceptance')).toEqual([]);
  });

  it('files a downgraded finding as a bugs.md follow-up without holding the run or double-counting severity', async () => {
    const bugEntries: TerminalBugEntry[] = [];
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
        reviewerVerdict: { outcome: 'pass', findings: [], objections: [] },
        findingsLedger: [],
        loopExitReason: 'all-low',
        objectionOpen: false,
        handoffNotes: ['shipped after a downgraded finding'],
        downgradedFindings: [
          {
            finding: {
              class: 'security',
              severity: 'high',
              location: 'unknown',
              rationale: 'a plausible-sounding security concern with no anchor',
            },
            sourceGate: 'reviewer',
            round: 1,
            gaps: ['location'],
            reason: 'downgraded to a non-blocking observation: a blocking security finding ' +
              'requires a concrete location',
            rePrompted: true,
          },
          {
            finding: {
              class: 'concurrency',
              severity: 'low',
              location: 'src/lease.ts:9',
              rationale: 'a low-severity finding that is never blocking to begin with',
            },
            sourceGate: 'tech-lead',
            round: 2,
            gaps: [],
            reason: 'adjudicator upheld the pass',
            rePrompted: false,
          },
        ],
      } as TaskEvidence),
      appendTerminalBugEntries: async (entries) => {
        bugEntries.push(...entries);
      },
    }, [
      '# Tasks',
      '',
      '## Phase 1',
      '- [ ] Ship with a downgraded finding',
    ].join('\n'));

    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('finalized');
    expect(bugEntries).toEqual([
      {
        runId: 'run-1',
        taskId: 'ship-with-a-downgraded-finding',
        findingId: 'downgraded-reviewer-r1-1',
        sourceGate: 'reviewer',
        class: 'security',
        severity: 'high',
        location: 'unknown',
        rationale: 'a plausible-sounding security concern with no anchor ' +
          '[downgraded to a non-blocking observation: a blocking security finding ' +
          'requires a concrete location]',
        reversible: true,
      },
      {
        runId: 'run-1',
        taskId: 'ship-with-a-downgraded-finding',
        findingId: 'downgraded-tech-lead-r2-2',
        sourceGate: 'tech-lead',
        class: 'concurrency',
        // A downgraded `low` finding is bumped to `medium` so it is never
        // indistinguishable from an ordinary non-blocking low finding.
        severity: 'medium',
        location: 'src/lease.ts:9',
        rationale: 'a low-severity finding that is never blocking to begin with ' +
          '[adjudicator upheld the pass]',
        reversible: true,
      },
    ]);
  });

  it('holds as an operational terminal when warning recording fails, without re-running the coder workflow', async () => {
    const worktreePath = '/tmp/rune-worktrees/aura/14-recording-failure';
    const warningFinding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/cache.ts:44',
      rationale: 'follow-up can reduce duplicate reads; correctness is unaffected',
    } as const;
    const warningLedger: FindingsLedgerEntry[] = [{
      id: 'finding-cache-duplicate-reads',
      sourceGate: 'reviewer',
      reversible: true,
      raisedRound: 1,
      status: 'open',
      ...warningFinding,
    }];
    let workflowCalls = 0;
    const h = makeHarness({
      runTaskWorkflow: async (task) => {
        workflowCalls += 1;
        return {
          taskId: task.id,
          outcome: 'ready-for-closeout',
          rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
          reviewerVerdict: {
            outcome: 'pass-with-warnings',
            objections: [warningFinding],
          },
          findingsLedger: warningLedger,
          loopExitReason: 'all-low',
          objectionOpen: false,
          handoffNotes: ['shipped with a low-severity performance caveat'],
        };
      },
      appendTaskRunRecord: async () => {
        throw new Error('task-run-record store unavailable');
      },
    }, [
      '# Tasks',
      '',
      '## Phase 1',
      '- [ ] Cache repeated reads',
    ].join('\n'));
    let finalizeCalled = false;
    h.deps.finalize = async () => {
      finalizeCalled = true;
      return { kind: 'finalized', outcome: 'branch-complete' };
    };

    const res = await runProjectOrchestration({
      ...h.deps,
      worktreePath,
    });

    expectOperationalHold(res, {
      reason: /operational|record/i,
      worktreePath,
    });
    expect(workflowCalls).toBe(1);
    expect(finalizeCalled).toBe(false);
  });

  it('holds as an operational terminal when acceptance recording fails, without parking blocked-on-human', async () => {
    const worktreePath = '/tmp/rune-worktrees/aura/14-acceptance-recording-failure';
    let workflowCalls = 0;
    const h = makeHarness({
      runTaskWorkflow: async (task) => {
        workflowCalls += 1;
        return {
          taskId: task.id,
          outcome: 'ready-for-closeout',
          rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
          reviewerVerdict: {
            outcome: 'fail',
            findings: [],
            objections: [],
            notes: 'non-objection disagreement accepted with rationale',
          },
          findingsLedger: [],
          loopExitReason: 'all-low',
          objectionOpen: false,
          handoffNotes: ['accepted a non-objection disagreement with rationale'],
          acceptance: {
            actor: 'pm',
            decision: 'accepted-with-rationale',
            rationale: 'The remaining disagreement is outside this task contract.',
          },
        };
      },
      appendTaskRunRecord: async () => {
        throw new Error('acceptance record store unavailable');
      },
    }, [
      '# Tasks',
      '',
      '## Phase 1',
      '- [ ] Ship accepted non-objection diff',
    ].join('\n'));
    let finalizeCalled = false;
    h.deps.finalize = async () => {
      finalizeCalled = true;
      return { kind: 'finalized', outcome: 'branch-complete' };
    };

    const res = await runProjectOrchestration({
      ...h.deps,
      worktreePath,
    });

    expectOperationalHold(res, {
      reason: /operational|record|acceptance/i,
      worktreePath,
    });
    expect(workflowCalls).toBe(1);
    expect(finalizeCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Terminal bug recording — unresolved >low findings become Rune bugs
// ---------------------------------------------------------------------------

describe('project-orchestrator — terminal bug recording', () => {
  it('drains terminal findings from TaskEvidence even when reviewerVerdict has no findings', async () => {
    const bugEntries: TerminalBugEntry[] = [];
    let curatedEvidence: TaskEvidence | undefined;
    const terminalFinding: FindingsLedgerEntry = {
      id: 'finding-terminal-worker-race',
      sourceGate: 'tech-lead',
      class: 'concurrency',
      severity: 'medium',
      location: 'src/worker.ts:41',
      rationale: 'terminal handling can still race when two workers close the same task',
      reversible: true,
      raisedRound: 3,
      status: 'open',
    };
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
        reviewerVerdict: {
          outcome: 'pass',
          findings: [],
          objections: [],
        },
        findingsLedger: [terminalFinding],
        loopExitReason: 'stagnation',
        objectionOpen: false,
        handoffNotes: ['terminal severity loop stopped on stagnation'],
      }),
      curateContext: (_current, evidence) => {
        curatedEvidence = evidence;
        return {
          kind: 'neutral',
          sections: { 'Current State': 'terminal findings carried' },
        };
      },
    }, [
      '# Tasks',
      '',
      '## Phase 14',
      '- [ ] Drain terminal findings from evidence',
    ].join('\n'));
    const deps: TerminalBugRecordingDeps = {
      ...h.deps,
      appendTerminalBugEntries: async (entries) => {
        bugEntries.push(...entries);
      },
    };

    const res = await runProjectOrchestration(deps);

    expect(res.kind).toBe('finalized');
    expect(curatedEvidence?.loopExitReason).toBe('stagnation');
    expect(curatedEvidence?.findingsLedger).toEqual([terminalFinding]);
    expect(bugEntries).toEqual([
      {
        runId: 'run-1',
        taskId: 'drain-terminal-findings-from-evidence',
        findingId: 'finding-terminal-worker-race',
        sourceGate: 'tech-lead',
        class: 'concurrency',
        severity: 'medium',
        location: 'src/worker.ts:41',
        rationale: 'terminal handling can still race when two workers close the same task',
        reversible: true,
      },
    ]);
  });

  it('writes one detailed Rune bugs.md entry per remaining open >low finding before finalization', async () => {
    const bugEntries: TerminalBugEntry[] = [];
    const order: string[] = [];
    const terminalFindings: FindingsLedgerEntry[] = [
      {
        id: 'finding-auth-bypass',
        sourceGate: 'reviewer',
        class: 'security',
        severity: 'critical',
        location: 'src/auth.ts:88',
        rationale: 'the authorization guard can still be bypassed on retry',
        reversible: true,
        raisedRound: 4,
        status: 'open',
      },
      {
        id: 'finding-worker-race',
        sourceGate: 'tech-lead',
        class: 'concurrency',
        severity: 'medium',
        location: 'src/worker.ts:41',
        rationale: 'two concurrent terminal handlers can append duplicate state',
        reversible: false,
        raisedRound: 3,
        status: 'open',
      },
      {
        id: 'finding-low-follow-up',
        sourceGate: 'designer',
        class: 'cost-perf',
        severity: 'low',
        location: 'src/server/static/app.js:120',
        rationale: 'minor repaint remains after the terminal banner changes',
        reversible: true,
        raisedRound: 4,
        status: 'open',
      },
      {
        id: 'finding-resolved-egress',
        sourceGate: 'reviewer',
        class: 'outbound',
        severity: 'high',
        location: 'src/egress.ts:27',
        rationale: 'stale egress finding was resolved before terminal handling',
        reversible: true,
        raisedRound: 2,
        status: 'resolved',
      },
      {
        id: 'finding-auth-bypass',
        sourceGate: 'reviewer',
        class: 'security',
        severity: 'critical',
        location: 'src/auth.ts:88',
        rationale: 'the authorization guard can still be bypassed on retry',
        reversible: true,
        raisedRound: 4,
        status: 'open',
      },
    ];
    const authBypassFinding = terminalFindings[0]!;
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead', 'designer'],
        reviewerVerdict: {
          outcome: 'fail',
          findings: [authBypassFinding],
          objections: [authBypassFinding],
        },
        findingsLedger: terminalFindings,
        loopExitReason: 'hard-budget',
        objectionOpen: false,
        handoffNotes: ['terminal severity handling drained the unresolved findings ledger'],
      }),
      finalize: async () => {
        order.push('finalize');
        return { kind: 'finalized', outcome: 'branch-complete' };
      },
    }, [
      '# Tasks',
      '',
      '## Phase 14',
      '- [ ] Drive terminal severity handling',
    ].join('\n'));
    const deps: TerminalBugRecordingDeps = {
      ...h.deps,
      appendTerminalBugEntries: async (entries) => {
        order.push('bugs');
        bugEntries.push(...entries);
      },
    };

    const res = await runProjectOrchestration(deps);

    expect(res.kind).toBe('finalized');
    expect(order).toEqual(['bugs', 'finalize']);
    expect(bugEntries).toEqual([
      {
        runId: 'run-1',
        taskId: 'drive-terminal-severity-handling',
        findingId: 'finding-auth-bypass',
        sourceGate: 'reviewer',
        class: 'security',
        severity: 'critical',
        location: 'src/auth.ts:88',
        rationale: 'the authorization guard can still be bypassed on retry',
        reversible: true,
      },
      {
        runId: 'run-1',
        taskId: 'drive-terminal-severity-handling',
        findingId: 'finding-worker-race',
        sourceGate: 'tech-lead',
        class: 'concurrency',
        severity: 'medium',
        location: 'src/worker.ts:41',
        rationale: 'two concurrent terminal handlers can append duplicate state',
        reversible: false,
      },
    ]);
  });

  it('dedupes terminal bug entries by run/task/finding id using the latest terminal finding facts', async () => {
    const bugEntries: TerminalBugEntry[] = [];
    const staleFinding: FindingsLedgerEntry = {
      id: 'finding-auth-timing',
      sourceGate: 'reviewer',
      class: 'security',
      severity: 'medium',
      location: 'src/auth.ts:42',
      rationale: 'token comparison may leak timing information',
      reversible: true,
      raisedRound: 1,
      status: 'open',
    };
    const terminalFinding: FindingsLedgerEntry = {
      id: 'finding-auth-timing',
      sourceGate: 'reviewer',
      class: 'security',
      severity: 'critical',
      location: 'src/auth.ts:42',
      rationale: 'timing side channel remains exploitable at terminal handling',
      reversible: false,
      raisedRound: 1,
      status: 'regressed',
    };
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
        reviewerVerdict: {
          outcome: 'fail',
          findings: [terminalFinding],
          objections: [terminalFinding],
        },
        findingsLedger: [staleFinding, terminalFinding],
        loopExitReason: 'hard-budget',
        objectionOpen: false,
        handoffNotes: ['terminal severity handling found one repeated auth finding'],
      }),
    }, [
      '# Tasks',
      '',
      '## Phase 14',
      '- [ ] Drive terminal severity handling',
    ].join('\n'));
    const deps: TerminalBugRecordingDeps = {
      ...h.deps,
      appendTerminalBugEntries: async (entries) => {
        bugEntries.push(...entries);
      },
    };

    const res = await runProjectOrchestration(deps);

    expect(res.kind).toBe('finalized');
    expect(bugEntries).toEqual([
      {
        runId: 'run-1',
        taskId: 'drive-terminal-severity-handling',
        findingId: 'finding-auth-timing',
        sourceGate: 'reviewer',
        class: 'security',
        severity: 'critical',
        location: 'src/auth.ts:42',
        rationale: 'timing side channel remains exploitable at terminal handling',
        reversible: false,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Finalizer handoff — no unchecked tasks → finalize, no self-merge
// ---------------------------------------------------------------------------

describe('project-orchestrator — finalizer handoff', () => {
  it('hands branch/run facts to the finalizer when all tasks are checked', async () => {
    let handoffBranch: string | undefined;
    const h = makeHarness({
      finalize: async (handoff) => {
        handoffBranch = handoff.branch;
        return { kind: 'finalized', outcome: 'branch-complete' };
      },
    });
    const res = await runProjectOrchestration(h.deps);
    expect(handoffBranch).toBe('rune-work/14-x');
    expect(res.kind).toBe('finalized');
  });

  it('holds (records payload, no self-merge) when the finalizer is unavailable', async () => {
    const h = makeHarness({
      finalize: async () => ({ kind: 'unavailable', reason: 'finalizer not wired' }),
    });
    const res = await runProjectOrchestration(h.deps);
    expect(res.kind).toBe('held');
    if (res.kind === 'held') {
      expect(res.handoff.branch).toBe('rune-work/14-x');
    }
    // Both tasks still completed; only the terminal landing is held.
    expect(h.state.commits).toHaveLength(2);
  });

});

// ---------------------------------------------------------------------------
// Closeout repair loop — failed checks feed back to the coder, exhaustion
// WIP-commits and holds instead of failing destructively
// ---------------------------------------------------------------------------

describe('project-orchestrator — closeout repair loop', () => {
  it('runs mechanical task validation before context transformation, checkbox mutation, or closeout commit', async () => {
    const operations: string[] = [];
    const h = makeHarness({}, '# Tasks\n- [ ] Validate this task\n');
    Object.assign(h.deps, {
      curateContext: () => {
        operations.push('context:transform');
        return { kind: 'neutral', sections: { 'Current State': 'task complete' } };
      },
      runPreCloseoutValidation: async () => {
        operations.push('pre-closeout-validation');
        return {
          ok: true,
          candidate: {
            evidence: {
              version: 1,
              durationMs: 12,
              outcome: 'passed',
              reuseDecision: 'pending',
            },
          },
        } as const;
      },
      runCloseoutChecks: async () => {
        operations.push('reuse-check');
        return { ok: true } as const;
      },
      writeContextMd: async (content) => {
        operations.push('context:write');
        h.state.contextMd = content;
      },
      writeTasksMd: async (content) => {
        operations.push('tasks:write');
        h.state.tasksMd = content;
      },
      commitCloseout: async (task) => {
        operations.push('closeout:commit');
        return { sha: `sha-${task.id}`, subject: 'closeout' };
      },
    } satisfies Partial<OrchestrationDeps>);

    const result = await runProjectOrchestration(h.deps);

    expect(result.kind).toBe('finalized');
    expect(operations).toEqual([
      'pre-closeout-validation',
      'reuse-check',
      'context:transform',
      'context:write',
      'tasks:write',
      'closeout:commit',
    ]);
  });

  it('rechecks cancellation after validation settles and before closeout mutates files', async () => {
    let cancelled = false;
    const writeContextMd = vi.fn(async () => undefined);
    const writeTasksMd = vi.fn(async () => undefined);
    const commitCloseout = vi.fn(async (): Promise<CloseoutCommit> => ({
      sha: 'must-not-commit',
      subject: 'must not commit',
    }));
    const h = makeHarness({
      cancel: () => cancelled,
      cancelReason: () => 'user',
      runCloseoutChecks: async () => {
        cancelled = true;
        return { ok: true } as const;
      },
      writeContextMd,
      writeTasksMd,
      commitCloseout,
    }, '# Tasks\n- [ ] Validate without crossing cancellation\n');

    const result = await runProjectOrchestration(h.deps);

    expect(result).toMatchObject({
      kind: 'cancelled',
      reason: 'user',
      task: { text: 'Validate without crossing cancellation' },
    });
    expect(writeContextMd).not.toHaveBeenCalled();
    expect(writeTasksMd).not.toHaveBeenCalled();
    expect(commitCloseout).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after pre-closeout validation settles and before closeout checks even start', async () => {
    let cancelled = false;
    const runCloseoutChecks = vi.fn(async () => ({ ok: true }) as const);
    const writeContextMd = vi.fn(async () => undefined);
    const writeTasksMd = vi.fn(async () => undefined);
    const commitCloseout = vi.fn(async (): Promise<CloseoutCommit> => ({
      sha: 'must-not-commit',
      subject: 'must not commit',
    }));
    const h = makeHarness({
      cancel: () => cancelled,
      cancelReason: () => 'user',
      runPreCloseoutValidation: async () => {
        cancelled = true;
        return {
          ok: true,
          candidate: {
            evidence: {
              version: 1,
              durationMs: 5,
              outcome: 'passed',
              reuseDecision: 'pending',
            },
          },
        } as const;
      },
      runCloseoutChecks,
      writeContextMd,
      writeTasksMd,
      commitCloseout,
    }, '# Tasks\n- [ ] Validate without entering closeout checks\n');

    const result = await runProjectOrchestration(h.deps);

    expect(result).toMatchObject({
      kind: 'cancelled',
      reason: 'user',
      task: { text: 'Validate without entering closeout checks' },
    });
    // The new pre-closeout stage must not race past a cancellation that
    // arrives while it runs — closeout checks are Rune-owned identity
    // recapture work that should never start once the run is cancelled.
    expect(runCloseoutChecks).not.toHaveBeenCalled();
    expect(writeContextMd).not.toHaveBeenCalled();
    expect(writeTasksMd).not.toHaveBeenCalled();
    expect(commitCloseout).not.toHaveBeenCalled();
  });

  it('preserves WIP and durable TaskValidationFailure evidence when dependency installation exhausts repair', async () => {
    const command = 'uv sync --all-groups';
    const taskValidationFailure = {
      kind: 'command-failed' as const,
      command,
      prerequisite: 'dependency-install',
      executable: 'uv',
      exitCode: 12,
      timedOut: false,
      diagnostics: 'Failed to resolve package group "test" from <repo>/harness/pyproject.toml',
    };
    const commitWip = vi.fn(async () => ({
      kind: 'committed' as const,
      sha: 'wip-validation-1234',
    }));
    const writeContextMd = vi.fn(async () => undefined);
    const writeTasksMd = vi.fn(async () => undefined);
    const commitCloseout = vi.fn(async (): Promise<CloseoutCommit> => ({
      sha: 'must-not-commit',
      subject: 'must not commit',
    }));
    const h = makeHarness({
      worktreePath: '/tmp/rune-worktrees/assay/task-validation',
      runCloseoutChecks: async () => ({
        ok: false,
        failure: {
          command,
          exitCode: 12,
          timedOut: false,
          outputTail: taskValidationFailure.diagnostics,
          validationFailure: taskValidationFailure,
        },
      } as const),
      commitWip,
      writeContextMd,
      writeTasksMd,
      commitCloseout,
    }, '# Tasks\n- [ ] Run the Assay harness\n  - Validation policy: `required`\n');

    const result = await runProjectOrchestration(h.deps);

    expect(result).toMatchObject({
      kind: 'blocked',
      task: { validationPolicy: 'required' },
      taskValidationFailure,
      parked: {
        status: 'blocked-on-human',
        preserveBranch: true,
        preserveWorktree: true,
      },
    });
    expect(commitWip).toHaveBeenCalledOnce();
    expect(writeContextMd).not.toHaveBeenCalled();
    expect(writeTasksMd).not.toHaveBeenCalled();
    expect(commitCloseout).not.toHaveBeenCalled();
    expect(h.state.tasksMd).toContain('- [ ] Run the Assay harness');
    expect(JSON.stringify(result)).not.toContain('/Users/');
  });

  it('holds operationally (not parked) on the FIRST attempt when closeout validation reports profile-unavailable, skipping the repair loop', async () => {
    const worktreePath = '/tmp/rune-worktrees/aura/14-profile-unavailable';
    const command = 'npm test';
    const taskValidationFailure = {
      kind: 'profile-unavailable' as const,
      command,
      prerequisite: 'sandbox-integration',
      exitCode: null,
      timedOut: false,
      diagnostics: 'required validation capability is unavailable',
    };
    const commitWip = vi.fn(async () => ({
      kind: 'committed' as const,
      sha: 'wip-profile-unavailable-1234',
    }));
    const writeContextMd = vi.fn(async () => undefined);
    const writeTasksMd = vi.fn(async () => undefined);
    const commitCloseout = vi.fn(async (): Promise<CloseoutCommit> => ({
      sha: 'must-not-commit',
      subject: 'must not commit',
    }));
    let checksCalls = 0;
    const runTaskWorkflow = vi.fn(async (task: SelectedTask) => {
      return readyEvidence(task);
    });
    const h = makeHarness({
      worktreePath,
      runTaskWorkflow,
      runCloseoutChecks: async () => {
        checksCalls += 1;
        return {
          ok: false,
          failure: {
            command,
            exitCode: null,
            timedOut: false,
            outputTail: taskValidationFailure.diagnostics,
            validationFailure: taskValidationFailure,
          },
        } as const;
      },
      commitWip,
      writeContextMd,
      writeTasksMd,
      commitCloseout,
    }, '# Tasks\n- [ ] Build the streak core\n');

    const result = await runProjectOrchestration(h.deps);

    expectOperationalHold(result, {
      reason: /validation capability unavailable/i,
      worktreePath,
    });
    // No coder repair round is spent chasing an unavailable host capability —
    // closeout checks run exactly once, not the full repair budget.
    expect(checksCalls).toBe(1);
    expect(runTaskWorkflow).toHaveBeenCalledOnce();
    expect(writeContextMd).not.toHaveBeenCalled();
    expect(writeTasksMd).not.toHaveBeenCalled();
    expect(commitCloseout).not.toHaveBeenCalled();
    // Unlike an ordinary validation failure, this is an operational hold —
    // never a `blocked`/`parked` terminal, even though a worktreePath is set.
    expect((result as unknown as Record<string, unknown>)['kind']).not.toBe('blocked');
  });

  it('keeps a command-failed validation failure in the bounded repair loop instead of holding operationally', async () => {
    // The exact contrast to the profile-unavailable case above, pinned so a
    // future broadening of the operational-hold branch cannot quietly divert
    // real product regressions away from coder repair. Same closeout shape,
    // same worktree, only `kind` differs.
    const worktreePath = '/tmp/rune-worktrees/aura/14-command-failed';
    const command = 'npm test';
    let checksCalls = 0;
    let workflowRuns = 0;
    const h = makeHarness({
      worktreePath,
      runTaskWorkflow: async (task: SelectedTask) => {
        workflowRuns += 1;
        return readyEvidence(task);
      },
      runCloseoutChecks: async () => {
        checksCalls += 1;
        return {
          ok: false,
          failure: {
            command,
            exitCode: 1,
            timedOut: false,
            outputTail: 'AssertionError: expected 3 to be 2',
            validationFailure: {
              kind: 'command-failed' as const,
              command,
              prerequisite: 'executable',
              executable: 'npm',
              exitCode: 1,
              timedOut: false,
              diagnostics: 'AssertionError: expected 3 to be 2',
            },
          },
        } as const;
      },
    }, '# Tasks\n- [ ] Build the streak core\n');

    const result = await runProjectOrchestration(h.deps);

    // The full bounded budget is spent: initial attempt plus every repair.
    expect(checksCalls).toBe(1 + CLOSEOUT_REPAIR_CAP);
    expect(workflowRuns).toBe(1 + CLOSEOUT_REPAIR_CAP);
    // And it lands on the ordinary blocked/parked terminal, not a capability hold.
    expect(result.kind).toBe('blocked');
    expect((result as unknown as Record<string, unknown>)['reason'])
      .not.toMatch(/capability unavailable/i);
  });

  it('blocks a validation-mutated canonical review surface before any closeout transform and exposes hashes, never raw diff', async () => {
    const rawMutatedDiff = 'diff --git a/src/secret.ts b/src/secret.ts\n+RAW-MUTATED-DIFF';
    const reviewSurfaceFailure = {
      kind: 'candidate-mismatch' as const,
      canonicalHash: 'post-validation-hash',
      candidateHash: 'reviewed-hash',
      changedPaths: ['src/secret.ts'],
    };
    const curateContext = vi.fn(() => ({
      kind: 'neutral' as const,
      sections: { 'Current State': 'must not run' },
    }));
    const writeContextMd = vi.fn(async () => undefined);
    const writeTasksMd = vi.fn(async () => undefined);
    const commitCloseout = vi.fn(async (): Promise<CloseoutCommit> => ({
      sha: 'must-not-commit',
      subject: 'must not commit',
    }));
    const h = makeHarness({
      worktreePath: '/tmp/rune-worktrees/assay/review-surface',
      curateContext,
      writeContextMd,
      writeTasksMd,
      commitCloseout,
      commitWip: async () => ({
        kind: 'committed',
        sha: 'wip-review-surface',
      }),
      runCloseoutChecks: async () => ({
        ok: false,
        failure: {
          command: 'full-task review-surface verification',
          exitCode: null,
          timedOut: false,
          outputTail: 'src/secret.ts',
          reviewSurfaceFailure,
        },
      }),
    }, '# Tasks\n- [ ] Validate canonical review surface\n');

    const result = await runProjectOrchestration(h.deps);

    expect(result).toMatchObject({
      kind: 'blocked',
      parked: { status: 'blocked-on-human', preserveWorktree: true },
    });
    expect(curateContext).not.toHaveBeenCalled();
    expect(writeContextMd).not.toHaveBeenCalled();
    expect(writeTasksMd).not.toHaveBeenCalled();
    expect(commitCloseout).not.toHaveBeenCalled();
    expect(h.state.tasksMd).toContain('- [ ] Validate canonical review surface');
    expect(JSON.stringify(reviewSurfaceFailure)).toContain('post-validation-hash');
    expect(JSON.stringify(result)).not.toContain(rawMutatedDiff);
    expect(JSON.stringify(result)).not.toContain('RAW-MUTATED-DIFF');
  });

  it('repairs a failed closeout by re-running the workflow with the failing output as coder feedback', async () => {
    const workflowCtxs: Array<{
      taskId: string;
      feedback: GateRejectionFeedback | undefined;
      taskBaseTree: string;
      workflowAttempt: number;
    }> = [];
    const captureTaskBase = vi.fn(async (task: SelectedTask) => fixtureTaskBase(task));
    let closeoutCalls = 0;
    const runPreCloseoutValidation = vi.fn(async () => ({
      ok: true as const,
      candidate: {
        evidence: {
          version: 1 as const,
          durationMs: 10,
          outcome: 'passed' as const,
          reuseDecision: 'pending' as const,
        },
      },
    }));
    const h = makeHarness({
      runTaskWorkflow: async (task, ctx) => {
        workflowCtxs.push({
          taskId: task.id,
          feedback: ctx.rejectionFeedback,
          taskBaseTree: ctx.taskBase.treeOid,
          workflowAttempt: ctx.workflowAttempt,
        });
        return readyEvidence(task);
      },
      captureTaskBase,
      runPreCloseoutValidation,
      runCloseoutChecks: async () => {
        closeoutCalls++;
        return closeoutCalls === 1
          ? {
              ...redCloseout(),
              failure: {
                ...redCloseout().failure,
                validationCwd: 'harness/',
              },
            }
          : ({ ok: true } as const);
      },
    });
    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('finalized');
    // Task 1 ran twice (initial + one repair), task 2 once.
    expect(workflowCtxs.map((c) => c.taskId)).toEqual([
      'build-the-streak-core',
      'build-the-streak-core',
      'render-the-streak-card',
    ]);
    expect(workflowCtxs.map((c) => c.workflowAttempt)).toEqual([1, 2, 1]);
    expect(workflowCtxs[0]?.taskBaseTree).toBe(workflowCtxs[1]?.taskBaseTree);
    expect(captureTaskBase).toHaveBeenCalledTimes(2);
    // Every closeout-repair workflow obtains fresh Rune-owned evidence; no
    // candidate survives from the failed attempt.
    expect(runPreCloseoutValidation).toHaveBeenCalledTimes(3);
    expect(workflowCtxs[0]?.feedback).toBeUndefined();
    const feedback = workflowCtxs[1]?.feedback;
    expect(feedback).toMatchObject({
      rejectingRole: 'qa',
      counterpartRole: 'coder',
      rejectedRole: 'coder',
      artifact: 'implementation-diff',
      rejectedArtifact: 'implementation-diff',
    });
    expect(feedback?.reason).toContain('closeout validation failed');
    expect(feedback?.reason).toContain('npm test');
    expect(feedback?.reason).toContain('exited 1');
    expect(feedback?.reason).toContain('AssertionError: expected 3 to be 2');
    expect(feedback?.whatFailed).toContain('npm test');
    expect(feedback?.actionableNotes).toContain(
      'Re-run `npm test` from validation directory `harness/` relative to the worktree and drive it green before handing back.',
    );
    expect(feedback?.actionableNotes.join('\n')).not.toContain('from the worktree root');
    // Repair attempts surface as attempt-start events: task 1 attempts 1+2, task 2 attempt 1.
    const attemptNumbers = eventsByName(h.state.events, 'attempt-start')
      .map((event) => eventData(event)?.['attemptNumber']);
    expect(attemptNumbers).toEqual([1, 2, 1]);
    expect(h.state.commits).toHaveLength(2);
    expect((h.state.tasksMd.match(/- \[x\]/g) ?? []).length).toBe(2);
  });

  it('keeps an ordinary related-test regression in the bounded coder-repair loop', async () => {
    let workflowRuns = 0;
    let closeoutCalls = 0;
    const h = makeHarness({
      runTaskWorkflow: async (task) => {
        workflowRuns++;
        return readyEvidence(task);
      },
      runCloseoutChecks: async () => {
        closeoutCalls++;
        if (closeoutCalls > 1) return { ok: true } as const;
        return {
          ok: false,
          failure: {
            command: '"npx" "vitest" "related" "--run" "src/streak.ts"',
            exitCode: 1,
            timedOut: false,
            outputTail: 'AssertionError: expected 3 to be 2',
            relatedTestDiagnostic: {
              state: 'related-test-failure',
              initial: {
                selectedPaths: ['src/streak.ts'],
                argv: ['npx', 'vitest', 'related', '--run', 'src/streak.ts'],
                command: '"npx" "vitest" "related" "--run" "src/streak.ts"',
                validationCwd: '.',
                result: {
                  exitCode: 1,
                  timedOut: false,
                  outputHead: '',
                  outputTail: 'AssertionError: expected 3 to be 2',
                  diagnosticArtifacts: [],
                },
                compatibleMode: false,
              },
              conflictEvidence: [],
            },
          },
        } as const;
      },
    }, '# Tasks\n- [ ] Build the streak core\n');

    const result = await runProjectOrchestration(h.deps);

    expect(result.kind).toBe('finalized');
    expect(workflowRuns).toBe(2);
    expect(closeoutCalls).toBe(2);
    expect(eventsByName(h.state.events, 'attempt-start')
      .map((event) => eventData(event)?.['attemptNumber'])).toEqual([1, 2]);
  });

  it('returns a bounded per-task diagnostic aggregate after successful related fallback closeout', async () => {
    const diagnostic = {
      state: 'related-fallback-passed' as const,
      initial: {
        selectedPaths: ['src/streak.ts'],
        argv: ['npx', 'vitest', 'related', '--run', 'src/streak.ts'],
        command: '"npx" "vitest" "related" "--run" "src/streak.ts"',
        validationCwd: '.',
        result: {
          exitCode: 1,
          timedOut: false,
          outputTail: 'listen EPERM: operation not permitted 127.0.0.1',
          diagnosticArtifacts: [],
          structuredErrorsTotal: 1,
          structuredErrorsComplete: true,
          structuredErrors: [{
            source: 'vitest-json' as const,
            scope: 'suite' as const,
            file: 'src/streak.test.ts',
            message: 'listen EPERM: operation not permitted 127.0.0.1',
          }],
        },
        compatibleMode: false,
      },
      conflictEvidence: [{
        kind: 'loopback-listen-denied' as const,
        source: 'vitest-json' as const,
        scope: 'suite' as const,
        file: 'src/streak.test.ts',
        message: 'listen EPERM: operation not permitted 127.0.0.1',
        code: 'EPERM' as const,
        syscall: 'listen' as const,
        address: '127.0.0.1',
      }],
      fallback: {
        selectedPaths: ['src/streak.ts'],
        argv: ['npx', 'vitest', 'related', '--run', 'src/streak.ts'],
        command: '"npx" "vitest" "related" "--run" "src/streak.ts"',
        validationCwd: '.',
        result: {
          exitCode: 0,
          timedOut: false,
          outputTail: '',
          diagnosticArtifacts: [],
          structuredErrorsTotal: 0,
          structuredErrorsComplete: true,
          structuredErrors: [],
        },
        compatibleMode: true,
      },
    };
    const h = makeHarness({
      runCloseoutChecks: async () => ({
        ok: true,
        relatedTestDiagnostic: diagnostic,
      }),
    }, '# Tasks\n- [ ] Build the streak core\n');

    const result = await runProjectOrchestration(h.deps);

    expect(result).toMatchObject({
      kind: 'finalized',
      relatedTestDiagnostics: [{
        taskId: 'build-the-streak-core',
        diagnostic: { state: 'related-fallback-passed' },
      }],
    });
  });

  it.each([
    {
      state: 'related-validation-host-conflict' as const,
      fallback: undefined,
      label: 'unsupported compatibility confirmation',
    },
    {
      state: 'related-fallback-failed' as const,
      fallback: {
        exitCode: 1,
        timedOut: false,
        outputHead: '',
        outputTail: 'Error: nested sandbox remains unsupported',
      },
      label: 'failed compatibility confirmation',
    },
    {
      state: 'related-fallback-failed' as const,
      fallback: {
        exitCode: null,
        timedOut: true,
        outputHead: '',
        outputTail: 'confirmation timed out',
      },
      label: 'timed-out compatibility confirmation',
    },
  ])(
    'routes $label directly to a WIP-preserving operational hold without consuming repair rounds',
    async ({ state, fallback }) => {
      let workflowRuns = 0;
      const commitWip = vi.fn(async () => ({
        kind: 'committed' as const,
        sha: 'wip-host-conflict-1234',
      }));
      const writeContextMd = vi.fn(async () => undefined);
      const writeTasksMd = vi.fn(async () => undefined);
      const commitCloseout = vi.fn(async (): Promise<CloseoutCommit> => ({
        sha: 'must-not-commit',
        subject: 'must not commit',
      }));
      const initial = {
        selectedPaths: ['src/streak.ts'],
        argv: ['npx', 'vitest', 'related', '--run', 'src/streak.ts'],
        command: '"npx" "vitest" "related" "--run" "src/streak.ts"',
        validationCwd: '.',
        result: {
          exitCode: 1,
          timedOut: false,
          outputHead: '',
          outputTail: 'structured host capability conflict',
          diagnosticArtifacts: [],
        },
        compatibleMode: false,
      };
      const conflictEvidence = [{
          kind: 'loopback-listen-denied' as const,
          source: 'vitest-json' as const,
          scope: 'suite' as const,
          file: 'src/streak.test.ts',
          message: 'listen EPERM: operation not permitted 127.0.0.1',
          code: 'EPERM' as const,
          syscall: 'listen' as const,
          address: '127.0.0.1',
      }];
      const relatedTestDiagnostic: RelatedTestDiagnostic = fallback === undefined
        ? {
            state: 'related-validation-host-conflict',
            initial,
            conflictEvidence,
          }
        : {
          state: 'related-fallback-failed',
          initial,
          conflictEvidence,
          fallback: {
            selectedPaths: ['src/streak.ts'],
            argv: ['npx', 'vitest', 'related', '--run', 'src/streak.ts'],
            command: '"npx" "vitest" "related" "--run" "src/streak.ts"',
            validationCwd: '.',
            result: {
              ...fallback,
              diagnosticArtifacts: [],
            },
            compatibleMode: true,
          },
        };
      const h = makeHarness({
        worktreePath: '/tmp/rune-worktrees/aura/host-conflict',
        runTaskWorkflow: async (task) => {
          workflowRuns++;
          return readyEvidence(task);
        },
        runCloseoutChecks: async () => ({
          ok: false,
          failure: {
            command: '"npx" "vitest" "related" "--run" "src/streak.ts"',
            exitCode: fallback?.exitCode ?? 1,
            timedOut: fallback?.timedOut ?? false,
            outputTail: fallback?.outputTail ?? 'compatible confirmation unavailable',
            relatedTestDiagnostic,
          },
        } as const),
        commitWip,
        writeContextMd,
        writeTasksMd,
        commitCloseout,
      }, '# Tasks\n- [ ] Build the streak core\n');

      const result = await runProjectOrchestration(h.deps);

      expect(result).toMatchObject({
        kind: 'held',
        preserveBranch: true,
        preserveWorktree: true,
        relatedTestDiagnostic: { state },
      });
      expect(String((result as { reason?: string }).reason)).toMatch(
        /validation host|compatib|infrastructure/i,
      );
      expect(workflowRuns).toBe(1);
      expect(eventsByName(h.state.events, 'attempt-start')
        .map((event) => eventData(event)?.['attemptNumber'])).toEqual([1]);
      expect(commitWip).toHaveBeenCalledOnce();
      expect(writeContextMd).not.toHaveBeenCalled();
      expect(writeTasksMd).not.toHaveBeenCalled();
      expect(commitCloseout).not.toHaveBeenCalled();
      expect(h.state.tasksMd).toContain('- [ ] Build the streak core');
    },
  );

  it('routes invalid adjudication output to a WIP-preserving operational hold', async () => {
    const failure = {
      code: 'adjudication-output-invalid' as const,
      cause: 'invalid-artifact' as const,
      attempts: [
        { attempt: 1 as const, code: 'missing-fence' as const },
        { attempt: 2 as const, code: 'blank-rationale' as const },
      ],
      executedModelAlias: 'gpt-adjudicator',
      executedProvider: 'openai' as const,
    };
    const h = makeHarness({
      worktreePath: '/tmp/rune-worktrees/aura/adjudication-hold',
      runTaskWorkflow: async (task) => ({
        ...readyEvidence(task),
        outcome: 'failed',
        failureReason: 'Adjudication operational hold: adjudication-output-invalid (invalid output after 2 attempts)',
        loopExitReason: 'operational',
        adjudicationFailure: failure,
        adjudications: [{
          status: 'operational-failure',
          round: 1,
          dissentingRole: 'reviewer',
          concurringRole: 'tech-lead',
          signature: 'notes: ordering concern',
          escalated: false,
          executedModelAlias: 'gpt-adjudicator',
          executedProvider: 'openai',
          failure,
        }],
      }),
    });

    const result = await runProjectOrchestration(h.deps);

    expect(result).toMatchObject({
      kind: 'held',
      reason: expect.stringContaining('Adjudication operational hold'),
      preserveBranch: true,
      preserveWorktree: true,
      adjudicationFailure: failure,
      handoff: {
        taskRecords: [expect.objectContaining({
          outcome: 'failed',
          adjudicationFailure: failure,
          adjudications: [expect.objectContaining({ status: 'operational-failure' })],
        })],
      },
    });
    expect(h.state.tasksMd).toContain('- [ ] Build the streak core');
    expect(h.state.commits).toEqual([]);
    expect(h.state.finalizeCalled).toBe(false);
  });

  // The substantive counterpart: an ADMISSIBLE upheld fail is an ordinary
  // product block, and carries the typed marker so surfaces can tell it apart
  // from the operational hold above without reading the reason prose.
  it('carries a typed marker on an adjudicator-upheld substantive block', async () => {
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        ...readyEvidence(task),
        outcome: 'blocked',
        blockedReason: "adjudicator upheld reviewer's fail: the lease leaks on abort",
        loopExitReason: 'hard-budget',
        adjudicationUpheldFail: true,
      }),
    });

    const result = await runProjectOrchestration(h.deps);

    expect(result).toMatchObject({ kind: 'blocked', adjudicationUpheldFail: true });
    expect(result).not.toHaveProperty('adjudicationFailure');
    expect(h.state.finalizeCalled).toBe(false);
  });

  it('exhausts the repair budget, WIP-commits, and PARKS blocked-on-human with branch and worktree preserved', async () => {
    let workflowRuns = 0;
    const commitWip = vi.fn(async () => ({
      kind: 'committed' as const,
      sha: 'wipsha1234',
    }));
    const h = makeHarness({
      worktreePath: '/tmp/rune-worktrees/aura/14-x',
      runTaskWorkflow: async (task) => {
        workflowRuns++;
        return readyEvidence(task);
      },
      runCloseoutChecks: async () => redCloseout(),
      commitWip,
    });
    const res = await runProjectOrchestration(h.deps);

    expect(workflowRuns).toBe(1 + CLOSEOUT_REPAIR_CAP);
    expect(commitWip).toHaveBeenCalledTimes(1);
    expect(commitWip).toHaveBeenCalledWith(expect.objectContaining({ id: 'build-the-streak-core' }));
    // Parked, NOT held: a held terminal is invisible to the release path and
    // its preserved git-registered worktree blocks the project's next Start.
    expect(res).toMatchObject({
      kind: 'blocked',
      task: { id: 'build-the-streak-core' },
      parked: {
        status: 'blocked-on-human',
        branch: 'rune-work/14-x',
        worktreePath: '/tmp/rune-worktrees/aura/14-x',
        preserveBranch: true,
        preserveWorktree: true,
      },
    });
    expect(String((res as { reason?: string }).reason ?? '')).toMatch(
      /closeout checks failed after 3 attempts; WIP preserved as wipsha1/,
    );
    expect(h.state.tasksMd).toContain('- [ ] Build the streak core');
    expect(h.state.commits).toEqual([]);
    expect(h.state.finalizeCalled).toBe(false);
    expect(closeoutProgressEvents(h.state.events)).toEqual([]);
  });

  it('still parks on exhaustion when no commitWip dep is wired (fixtures compile without it)', async () => {
    const h = makeHarness({
      worktreePath: '/tmp/rune-worktrees/aura/14-x',
      runCloseoutChecks: async () => redCloseout(),
    });
    const res = await runProjectOrchestration(h.deps);

    expect(res).toMatchObject({
      kind: 'blocked',
      parked: { status: 'blocked-on-human', preserveWorktree: true },
    });
    expect(String((res as { reason?: string }).reason ?? '')).toMatch(
      /closeout checks failed after 3 attempts; WIP checkpoint failed: WIP checkpoint is unavailable/,
    );
    expect(h.state.tasksMd).toContain('- [ ] Build the streak core');
  });

  it('falls back to a preserved operational hold when no worktreePath is wired', async () => {
    const h = makeHarness({ runCloseoutChecks: async () => redCloseout() });
    const res = await runProjectOrchestration(h.deps);

    const raw = res as unknown as Record<string, unknown>;
    expect(raw['kind']).toBe('held');
    expect(String(raw['reason'] ?? '')).toMatch(
      /closeout checks failed after 3 attempts; WIP checkpoint failed: WIP checkpoint is unavailable/,
    );
    expect(raw['preserveBranch']).toBe(true);
    expect(raw['preserveWorktree']).toBe(true);
    expect(raw).not.toHaveProperty('parked');
  });

  it('routes a non-ready repair attempt through the existing blocked handling', async () => {
    let calls = 0;
    const h = makeHarness({
      runTaskWorkflow: async (task) => {
        calls++;
        if (calls === 1) return readyEvidence(task);
        return {
          ...readyEvidence(task),
          outcome: 'blocked',
          blockedReason: 'coder could not repair',
        };
      },
      runCloseoutChecks: async () => redCloseout(),
    });
    const res = await runProjectOrchestration(h.deps);

    expect(res).toMatchObject({
      kind: 'blocked',
      reason: 'coder could not repair',
      task: { id: 'build-the-streak-core' },
    });
    expect(res).not.toHaveProperty('parked');
    expect(h.state.commits).toEqual([]);
    expect(h.state.tasksMd).toContain('- [ ] Build the streak core');
  });

  it('swallows a commitWip throw — the park itself must land', async () => {
    const h = makeHarness({
      worktreePath: '/tmp/rune-worktrees/aura/14-x',
      runCloseoutChecks: async () => redCloseout(),
      commitWip: async () => {
        throw new Error('git broke');
      },
    });
    const res = await runProjectOrchestration(h.deps);

    expect(res).toMatchObject({
      kind: 'blocked',
      parked: { status: 'blocked-on-human' },
    });
    expect(String((res as { reason?: string }).reason ?? '')).toMatch(
      /closeout checks failed after 3 attempts; WIP checkpoint failed: git broke$/,
    );
  });
});

// ---------------------------------------------------------------------------
// Context closeout migration failures — reviewed work must be checkpointed
// before an operational (never blocked-on-human) preservation hold.
// ---------------------------------------------------------------------------

describe('project-orchestrator — context closeout checkpoint', () => {
  function installAmbiguousContext(h: Harness): void {
    h.state.contextMd = `${seedProjectContext({
      product: 'aura',
      projectTitle: 'Assay closeout',
    }).trimEnd()}\n\n## Canonical Interfaces\n\nLegacy competing contract body.\n`;
    Object.assign(h.deps, {
      contextFile: 'docs/projects/resolved-assay/context.md',
    });
  }

  it('WIP-checkpoints before a failed operational preservation hold and performs no closeout writes', async () => {
    const operations: string[] = [];
    const writeContextMd = vi.fn(async () => undefined);
    const writeTasksMd = vi.fn(async () => undefined);
    const commitCloseout = vi.fn(async (): Promise<CloseoutCommit> => ({
      sha: 'must-not-land',
      subject: 'must not land',
    }));
    const h = makeHarness({
      worktreePath: '/tmp/rune-worktrees/assay/resolved-assay',
      writeContextMd,
      writeTasksMd,
      commitCloseout,
      runCloseoutChecks: async () => {
        operations.push('validation');
        return { ok: true } as const;
      },
      curateContext: () => {
        operations.push('context:transform');
        return { kind: 'neutral', sections: {} };
      },
      commitWip: (async () => {
        operations.push('checkpoint');
        return {
          kind: 'committed',
          sha: 'abcdef1234567',
          subject: 'rune(aura): WIP — /Users/operator/private — Build the streak core',
        };
      }) as never,
    }, '# Tasks\n- [ ] Build the streak core\n');
    installAmbiguousContext(h);

    const result = await runProjectOrchestration(h.deps);
    const raw = result as unknown as Record<string, unknown>;

    expect(operations).toEqual(['validation', 'context:transform', 'checkpoint']);
    expect(raw).toMatchObject({
      kind: 'held',
      preserveBranch: true,
      preserveWorktree: true,
      contextFailure: {
        reason: 'managed-heading-collision',
        file: 'docs/projects/resolved-assay/context.md',
        canonicalHeading: '## Interfaces & Contracts',
        conflictingHeadings: ['## Interfaces & Contracts', '## Canonical Interfaces'],
        proposedRepair: expect.stringMatching(/merge|remove|keep/i),
        checkpoint: {
          kind: 'committed',
          sha: 'abcdef1234567',
        },
      },
    });
    expect(raw).not.toHaveProperty('parked');
    expect(JSON.stringify(raw)).not.toMatch(/blocked-on-human/i);
    expect(JSON.stringify(raw)).not.toContain('/Users/operator/');
    expect(writeContextMd).not.toHaveBeenCalled();
    expect(writeTasksMd).not.toHaveBeenCalled();
    expect(commitCloseout).not.toHaveBeenCalled();
    expect(h.state.tasksMd).toContain('- [ ] Build the streak core');
  });

  it('distinguishes an already-clean checkpoint from a failed checkpoint', async () => {
    const cases = [
      {
        checkpoint: { kind: 'already-clean' },
        expected: { kind: 'already-clean' },
      },
      {
        checkpoint: {
          kind: 'failed',
          diagnostic: 'git commit failed at /Users/jarvis/workspace/assay: index.lock exists',
        },
        expected: {
          kind: 'failed',
          diagnostic: expect.stringMatching(/index\.lock exists/),
        },
      },
    ] as const;

    for (const testCase of cases) {
      const h = makeHarness({
        worktreePath: '/tmp/rune-worktrees/assay/resolved-assay',
        commitWip: (async () => testCase.checkpoint) as never,
      }, '# Tasks\n- [ ] Build the streak core\n');
      installAmbiguousContext(h);

      const result = await runProjectOrchestration(h.deps);
      const raw = result as unknown as Record<string, unknown>;

      expect(raw).toMatchObject({
        kind: 'held',
        preserveWorktree: true,
        contextFailure: {
          file: 'docs/projects/resolved-assay/context.md',
          checkpoint: testCase.expected,
        },
      });
      expect(raw).not.toHaveProperty('parked');
      expect((raw['contextFailure'] as Record<string, unknown>)['wipSha']).toBeUndefined();
      expect(JSON.stringify(raw)).not.toContain('/Users/jarvis/');
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end — deterministic fixture through two tasks to a terminal
// ---------------------------------------------------------------------------

describe('project-orchestrator — end-to-end fixture', () => {
  it('runs a two-task project through closeout, context update, and finalizer handoff', async () => {
    const h = makeHarness();
    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('finalized');
    expect(h.state.commits).toHaveLength(2);
    expect(h.state.contextHandoffs).toHaveLength(2);
    // Context advanced between tasks (task 2 saw a different context than task 1).
    expect(h.state.contextHandoffs[0]).not.toBe(h.state.contextHandoffs[1]);
    // Both checkboxes ticked.
    expect((h.state.tasksMd.match(/- \[x\]/g) ?? []).length).toBe(2);
  });
});
