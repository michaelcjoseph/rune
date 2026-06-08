/**
 * Phase 3 test suite for the orchestrator task-lifecycle substrate (project 14,
 * test-plan §3 "Orchestrator substrate"): task selection, pure closeout
 * (checkbox tick), and restart reconstruction.
 *
 * Written TEST-FIRST — RED until `orch-task-select.ts`, `orch-closeout.ts`, and
 * `orch-reconstruct.ts` land in later `/work` runs.
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §3
 */

import { describe, it, expect } from 'vitest';

import { selectNextTask } from './orch-task-select.js';
import { markSelectedTaskComplete } from './orch-closeout.js';
import { reconstructRun } from './orch-reconstruct.js';
import type { TaskRunRecord } from './orch-run-record.js';

const TASKS_MD = [
  '# Tasks',
  '',
  '## Phase 1',
  '- [x] First task done',
  '- [ ] Second task pending',
  '- [ ] Third task pending',
  '',
  '## Phase 2',
  '- [ ] Fourth task pending',
].join('\n');

// ---------------------------------------------------------------------------
// Task selection — first unchecked, in document order
// ---------------------------------------------------------------------------

describe('orch-task-select — selection', () => {
  it('selects the first unchecked task in document order', () => {
    const sel = selectNextTask(TASKS_MD);
    expect(sel.kind).toBe('task');
    if (sel.kind === 'task') {
      expect(sel.task.text).toBe('Second task pending');
    }
  });

  it('skips a completed earlier task and an earlier section', () => {
    const sel = selectNextTask(TASKS_MD);
    if (sel.kind !== 'task') throw new Error('expected a task');
    // Not the Phase 2 task — the first unchecked is in Phase 1.
    expect(sel.task.text).not.toContain('Fourth');
  });

  it('reports all-complete when no unchecked task remains', () => {
    const done = '# Tasks\n- [x] a\n- [x] b\n';
    expect(selectNextTask(done).kind).toBe('all-complete');
  });

  it('gives each task a stable id derived from its text (not line number)', () => {
    const a = selectNextTask(TASKS_MD);
    // Inserting a blank line above must not change the selected task's id.
    const shifted = TASKS_MD.replace('# Tasks', '# Tasks\n');
    const b = selectNextTask(shifted);
    if (a.kind !== 'task' || b.kind !== 'task') throw new Error('expected tasks');
    expect(a.task.id).toBe(b.task.id);
  });
});

// ---------------------------------------------------------------------------
// Closeout — tick EXACTLY the selected task
// ---------------------------------------------------------------------------

describe('orch-closeout — selected checkbox', () => {
  it('ticks exactly the selected task and leaves the others untouched', () => {
    const sel = selectNextTask(TASKS_MD);
    if (sel.kind !== 'task') throw new Error('expected a task');
    const res = markSelectedTaskComplete(TASKS_MD, sel.task);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content).toContain('- [x] Second task pending');
      // The other unchecked tasks stay unchecked.
      expect(res.content).toContain('- [ ] Third task pending');
      expect(res.content).toContain('- [ ] Fourth task pending');
      // Exactly one new checkbox flipped — total checked count went 1 → 2.
      expect((res.content.match(/- \[x\]/g) ?? []).length).toBe(2);
    }
  });

  it('refuses when the selected task text is no longer present (stale)', () => {
    const res = markSelectedTaskComplete(TASKS_MD, {
      id: 'gone',
      text: 'A task that does not exist',
      section: 'Phase 1',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('stale-task');
  });
});

// ---------------------------------------------------------------------------
// Restart reconstruction — rebuild partial run without replaying done tasks
// ---------------------------------------------------------------------------

describe('orch-reconstruct — partial run', () => {
  const records: TaskRunRecord[] = [
    {
      taskId: 'first-task-done',
      taskText: 'First task done',
      attemptId: 'a1',
      rolesInvoked: ['qa', 'coder', 'reviewer'],
      transcriptIds: ['t1'],
      modelChoices: { coder: 'claude', reviewer: 'codex' },
      commitSha: 'abc1234',
      verdicts: { reviewer: 'pass', techLead: 'pass' },
      contextOutcome: 'updated',
      gates: { objectionOpen: false },
      outcome: 'ready-for-closeout',
    },
  ];

  it('reconstructs completed tasks from durable records without replay', () => {
    const recon = reconstructRun({ tasksMd: TASKS_MD, records });
    // The done task is recognized as already complete.
    expect(recon.completedTaskIds).toContain('first-task-done');
    // The next task to run is the first unchecked, not the completed one.
    expect(recon.nextTask?.text).toBe('Second task pending');
  });

  it('returns no next task when tasks.md is fully checked', () => {
    const recon = reconstructRun({ tasksMd: '# T\n- [x] a\n', records: [] });
    expect(recon.nextTask).toBeNull();
  });

  it('flags drift when a record claims a task that tasks.md shows unchecked', () => {
    // Record says "Second task pending" completed, but tasks.md shows it unchecked.
    const drifted: TaskRunRecord[] = [
      { ...records[0]!, taskId: 'second-task-pending', taskText: 'Second task pending' },
    ];
    const recon = reconstructRun({ tasksMd: TASKS_MD, records: drifted });
    expect(recon.drift).toBe(true);
  });
});
