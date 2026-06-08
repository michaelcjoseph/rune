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
import type { TaskEvidence } from './team-task-workflow.js';
import type { SelectedTask } from './orch-task-select.js';
import type { FinalizerAdapter } from './finalizer-handoff.js';
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
    ...over,
  };

  return { deps, state };
}

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
