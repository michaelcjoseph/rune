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
import type { GateRejectionFeedback, ObjectionFinding, TaskEvidence } from './team-task-workflow.js';
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
  expect(raw['branch'] ?? handoff['branch']).toBe('jarvis-work/14-x');
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

  it('holds durably without advancing when closeout cannot produce a clean checkpoint', async () => {
    const worktreePath = '/tmp/jarvis-worktrees/aura/14-dirty-worktree';
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
});

// ---------------------------------------------------------------------------
// Operational terminal — non-finding failures hold, never human-park
// ---------------------------------------------------------------------------

describe('project-orchestrator — operational terminal', () => {
  it('treats malformed gate output as a non-finding operational HOLD with branch/worktree preserved', async () => {
    const worktreePath = '/tmp/jarvis-worktrees/aura/14-malformed-gate-output';
    let workflowCalls = 0;
    const h = makeHarness({
      runTaskWorkflow: async (task) => {
        workflowCalls += 1;
        return {
          taskId: task.id,
          outcome: 'failed',
          rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
          objectionOpen: false,
          handoffNotes: [],
          failureReason: 'operational failure: reviewer-verdict was malformed/unparseable JSON',
        };
      },
    });

    const res = await runProjectOrchestration({ ...h.deps, worktreePath });

    expectOperationalHold(res, {
      reason: /operational|malformed|unparseable|reviewer-verdict/i,
      worktreePath,
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

  it('stops without blocked-on-human parking when feedback retries exhaust', async () => {
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
    });
    expect(res).not.toHaveProperty('parked');
  });

  it.each(['high', 'critical'] as const)(
    'stops without blocked-on-human parking when an open %s objection blocks a task',
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
      });
      expect(res).not.toHaveProperty('parked');
      expect(h.state.tasksMd).toContain('- [ ] Build the streak core');
      expect(h.state.commits).toEqual([]);
      expect(h.state.finalizeCalled).toBe(false);
    },
  );

  it('stops without blocked-on-human parking when an objection-open block has no severity details', async () => {
    const worktreePath = '/tmp/jarvis-worktrees/aura/14-x-objection-open';
    const h = makeHarness({
      attemptCap: 1,
      runTaskWorkflow: async (task) => ({
        taskId: task.id,
        outcome: 'blocked',
        rolesInvoked: ['qa', 'coder', 'reviewer'],
        objectionOpen: true,
        handoffNotes: ['the branch contains useful work that needs human objection handling'],
        blockedReason: 'open objection-class finding',
        reviewerVerdict: {
          outcome: 'block',
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

  it('holds as an operational terminal when warning recording fails, without re-running the coder workflow', async () => {
    const worktreePath = '/tmp/jarvis-worktrees/aura/14-recording-failure';
    const warningFinding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/cache.ts:44',
      rationale: 'follow-up can reduce duplicate reads; correctness is unaffected',
    } as const;
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

  it('does not finalize when an operational closeout failure holds mid-way', async () => {
    // A run that holds on an operational terminal never reaches the finalizer.
    const worktreePath = '/tmp/jarvis-worktrees/aura/14-closeout-checks';
    const h = makeHarness({ runCloseoutChecks: async () => false });
    const res = await runProjectOrchestration({ ...h.deps, worktreePath });
    expectOperationalHold(res, {
      reason: /operational|closeout checks/i,
      worktreePath,
    });
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
