/**
 * Phase 5 test suite for `src/intent/project-orchestrator.ts` — the multi-task
 * orchestrator loop (project 14, test-plan §5).
 *
 * Written TEST-FIRST — RED until `project-orchestrator.ts` lands in a later
 * `/work` run.
 *
 * The loop ties the Phase 3/4 substrate together: select the first unchecked
 * task → assemble bounded context → run the team-task workflow → on
 * ready-for-closeout, perform Jarvis-owned closeout (context update + tick
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

import { describe, it, expect } from 'vitest';

import {
  runProjectOrchestration,
  type OrchestrationDeps,
  type OrchestrationResult,
} from './project-orchestrator.js';
import type { GateRejectionFeedback, TaskEvidence } from './team-task-workflow.js';
import type { SelectedTask } from './orch-task-select.js';
import type { FinalizerAdapter } from './finalizer-handoff.js';
import type { TaskRunRecord } from './orch-run-record.js';
import { reconstructRun } from './orch-reconstruct.js';
import { seedProjectContext } from './project-context.js';

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
    events: Array<{ kind: 'activity' | 'output'; data?: Record<string, unknown> }>;
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
    objectionOpen: false,
    handoffNotes: [`did ${task.text}`],
  };
}

function makeHarness(over: Partial<OrchestrationDeps> = {}, tasksMd = TWO_TASKS): Harness {
  const state = {
    tasksMd,
    contextMd: seedProjectContext({ product: 'aura', projectTitle: 'Streaks' }),
    commits: [] as string[],
    contextHandoffs: [] as string[],
    finalizeCalled: false,
    events: [] as Array<{ kind: 'activity' | 'output'; data?: Record<string, unknown> }>,
  };

  const finalize: FinalizerAdapter = async () => {
    state.finalizeCalled = true;
    return { kind: 'finalized', outcome: 'branch-complete' };
  };

  const deps: OrchestrationDeps = {
    runId: 'run-1',
    project: '14-x',
    product: 'aura',
    branch: 'jarvis-work/14-x',
    baseBranch: 'main',
    attemptCap: 2,
    readTasksMd: async () => state.tasksMd,
    readContextMd: async () => state.contextMd,
    readSpec: async () => 'spec body',
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
    runCloseoutChecks: async () => true,
    commitCloseout: async (task) => {
      const sha = `sha-${task.id}`;
      state.commits.push(sha);
      return sha;
    },
    verifyCleanWorktree: async () => true,
    finalize,
    emit: (event) => {
      state.events.push(event as { kind: 'activity' | 'output'; data?: Record<string, unknown> });
    },
    ...over,
  };

  return { deps, state };
}

function eventsByName(
  events: Array<{ kind: 'activity' | 'output'; data?: Record<string, unknown> }>,
  name: string,
): Array<{ kind: 'activity' | 'output'; data?: Record<string, unknown> }> {
  return events.filter((event) => event.data?.['event'] === name);
}

function eventNames(events: Array<{ kind: 'activity' | 'output'; data?: Record<string, unknown> }>): string[] {
  return events
    .map((event) => event.data?.['event'])
    .filter((name): name is string => typeof name === 'string');
}

interface PersistedRunCursor {
  runId: string;
  product: string;
  project: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  attemptCap: number;
  resumeMarker: 'resumable';
  cursor: {
    completedTaskIds: string[];
    currentTaskId: string | null;
    nextTaskId: string | null;
  };
}

type DurableRunStateDeps = OrchestrationDeps & {
  appendTaskRunRecord: (record: TaskRunRecord) => Promise<void>;
  writeRunCursor: (cursor: PersistedRunCursor) => Promise<void>;
};

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

  it('blocks durably without advancing when closeout cannot produce a clean checkpoint', async () => {
    const h = makeHarness({ verifyCleanWorktree: async () => false });
    const res = await runProjectOrchestration(h.deps);
    expect(res.kind).toBe('blocked');
    // A dirty worktree halts the run: it does NOT advance to the second task,
    // and it never finalizes.
    expect(h.state.tasksMd).toContain('- [ ] Render the streak card');
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

  it('emits attempt-retry between failed and replacement attempts, carrying retry context', async () => {
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
      attemptCap: 2,
      runTaskWorkflow: async (task) => {
        calls += 1;
        if (calls === 1) {
          return {
            taskId: task.id,
            outcome: 'blocked',
            rolesInvoked: ['qa', 'tech-lead'],
            objectionOpen: false,
            handoffNotes: [],
            blockedReason: feedback.reason,
            rejectionFeedback: feedback,
          };
        }
        return readyEvidence(task);
      },
    }, [
      '# Tasks',
      '',
      '## Phase 1',
      '- [ ] Build the streak core',
    ].join('\n'));

    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('finalized');
    expect(eventNames(h.state.events)).toEqual([
      'task-selected',
      'attempt-start',
      'attempt-retry',
      'attempt-start',
      'closeout-start',
      'closeout-complete',
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
      expect.objectContaining({
        kind: 'activity',
        data: expect.objectContaining({
          event: 'attempt-start',
          taskId: 'build-the-streak-core',
          attemptNumber: 2,
          attemptId: 'run-1-build-the-streak-core-attempt-2',
        }),
      }),
    ]);
    expect(eventsByName(h.state.events, 'attempt-retry')[0]).toMatchObject({
      kind: 'activity',
      data: {
        event: 'attempt-retry',
        taskId: 'build-the-streak-core',
        previousAttemptNumber: 1,
        nextAttemptNumber: 2,
        previousOutcome: 'blocked',
        reason: feedback.reason,
        line: expect.stringContaining(feedback.reason),
      },
    });
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

  it('parks blocked-on-human with branch and worktree preserved when feedback retries exhaust', async () => {
    const worktreePath = '/tmp/jarvis-worktrees/aura/14-x';
    const h = makeHarness({
      attemptCap: 1,
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'blocked',
        rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
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
      parked: {
        status: 'blocked-on-human',
        branch: 'jarvis-work/14-x',
        worktreePath,
        preserveBranch: true,
        preserveWorktree: true,
      },
    });
  });

  it.each(['high', 'critical'] as const)(
    'parks and preserves the run when an open %s objection blocks a task',
    async (severity) => {
      const worktreePath = `/tmp/jarvis-worktrees/aura/14-x-${severity}`;
      const h = makeHarness({
        attemptCap: 1,
        runTaskWorkflow: async (task) => ({
          taskId: task.id,
          outcome: 'blocked',
          rolesInvoked: ['qa', 'coder', 'reviewer'],
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
        parked: {
          status: 'blocked-on-human',
          branch: 'jarvis-work/14-x',
          worktreePath,
          preserveBranch: true,
          preserveWorktree: true,
        },
      });
      expect(h.state.tasksMd).toContain('- [ ] Build the streak core');
      expect(h.state.commits).toEqual([]);
      expect(h.state.finalizeCalled).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Retry feedback — attempt N+1 receives gate feedback from attempt N
// ---------------------------------------------------------------------------

describe('project-orchestrator — retry feedback', () => {
  it('threads structured rejection feedback into the next task workflow attempt', async () => {
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
      attemptCap: 2,
      runTaskWorkflow: async (task, ctx) => {
        workflowInputs.push(ctx as { rejectionFeedback?: GateRejectionFeedback });
        calls += 1;
        if (calls === 1) {
          return {
            taskId: task.id,
            outcome: 'blocked',
            rolesInvoked: ['qa', 'tech-lead'],
            objectionOpen: false,
            handoffNotes: [],
            blockedReason: feedback.reason,
            rejectionFeedback: feedback,
          };
        }
        return readyEvidence(task);
      },
    });

    const res = await runProjectOrchestration(h.deps);

    expect(res.kind).toBe('finalized');
    expect(workflowInputs[0]?.rejectionFeedback).toBeUndefined();
    expect(workflowInputs[1]?.rejectionFeedback).toEqual(feedback);
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
    const worktreePath = '/tmp/jarvis-worktrees/aura/14-x';
    const persistedRecords: TaskRunRecord[] = [];
    const persistedCursors: PersistedRunCursor[] = [];
    let workflowCalls = 0;
    const h = makeHarness({
      runTaskWorkflow: async (task) => {
        workflowCalls += 1;
        if (workflowCalls === 1) return readyEvidence(task);
        return {
          taskId: task.id,
          outcome: 'blocked',
          rolesInvoked: ['qa', 'coder', 'reviewer'],
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
      writeRunCursor: async (cursor: PersistedRunCursor) => {
        persistedCursors.push(cursor);
      },
    } satisfies DurableRunStateDeps;

    const res = await runProjectOrchestration(deps);

    expect(res.kind).toBe('blocked');
    expect(persistedRecords).toEqual([
      expect.objectContaining({
        taskId: 'build-the-streak-core',
        taskText: 'Build the streak core',
        attemptId: 'run-1-build-the-streak-core',
        rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
        commitSha: 'sha-build-the-streak-core',
        contextOutcome: 'updated',
        gates: { objectionOpen: false },
        outcome: 'ready-for-closeout',
      }),
    ]);
    expect(persistedCursors).toContainEqual({
      runId: 'run-1',
      product: 'aura',
      project: '14-x',
      branch: 'jarvis-work/14-x',
      baseBranch: 'main',
      worktreePath,
      attemptCap: 2,
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

  it('records pass-with-warnings findings in the TaskRunRecord and finalizer handoff while proceeding', async () => {
    const persistedRecords: TaskRunRecord[] = [];
    const warningFinding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/cache.ts:44',
      rationale: 'follow-up can reduce duplicate reads; correctness is unaffected',
    } as const;
    const h = makeHarness({
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'ready-for-closeout',
        rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
        reviewerVerdict: {
          outcome: 'pass-with-warnings',
          objections: [warningFinding],
        },
        objectionOpen: false,
        handoffNotes: ['shipped with a low-severity performance caveat'],
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
      }),
    ]);
    expect(finalizerRecords).toEqual([
      expect.objectContaining({
        taskId: 'cache-repeated-reads',
        warnings: [warningFinding],
      }),
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
    expect(handoffBranch).toBe('jarvis-work/14-x');
    expect(res.kind).toBe('finalized');
  });

  it('holds (records payload, no self-merge) when the finalizer is unavailable', async () => {
    const h = makeHarness({
      finalize: async () => ({ kind: 'unavailable', reason: 'finalizer not wired' }),
    });
    const res = await runProjectOrchestration(h.deps);
    expect(res.kind).toBe('held');
    if (res.kind === 'held') {
      expect(res.handoff.branch).toBe('jarvis-work/14-x');
    }
    // Both tasks still completed; only the terminal landing is held.
    expect(h.state.commits).toHaveLength(2);
  });

  it('does not finalize when starting from an already-complete task list with a blocked task mid-way', async () => {
    // A run that blocks never reaches the finalizer.
    const h = makeHarness({ runCloseoutChecks: async () => false });
    const res = await runProjectOrchestration(h.deps);
    expect(res.kind).toBe('blocked');
    expect(h.state.finalizeCalled).toBe(false);
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
