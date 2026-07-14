import { beforeEach, describe, it, expect, vi } from 'vitest';

import type { MutationDescriptor } from '../transport/mutations.js';
import type { TaskRunRecord } from '../intent/orch-run-record.js';
import type { OrchestrationRunCursor } from '../intent/project-orchestrator.js';
import type { SelectedTask } from '../intent/orch-task-select.js';

vi.hoisted(() => {
  process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
  process.env['TELEGRAM_USER_ID'] = '12345';
  process.env['VAULT_DIR'] = '/tmp/test-vault';
  process.env['WORKSPACE_DIR'] = '/tmp/test-workspace';
});

const mockReconstructRun = vi.hoisted(() => vi.fn());

vi.mock('../intent/orch-reconstruct.js', () => ({
  reconstructRun: mockReconstructRun,
}));

import { recoverOrchestratedWorkRuns, requestOrchestratedRunRecovery } from './orchestrated-work-runner.js';

beforeEach(() => {
  mockReconstructRun.mockReset();
});

function runningOrchestratedMutation(): MutationDescriptor<{ projectSlug: string; product: string }> {
  return {
    id: 'mut-orch-resume',
    kind: 'orchestrated-work',
    source: 'webview',
    target: { type: 'orchestrated-work', ref: '14-product-team-agents' },
    preview: { summary: 'orchestrated-work on 14-product-team-agents' },
    payload: { projectSlug: '14-product-team-agents', product: 'rune' },
    createdAt: '2026-06-17T12:00:00.000Z',
    status: 'running',
  };
}

function readyRecord(): TaskRunRecord {
  return {
    taskId: 'persist-records-and-cursor',
    taskText: 'Persist records and cursor',
    attemptId: 'mut-orch-resume-persist-records-and-cursor',
    rolesInvoked: ['qa', 'coder', 'reviewer', 'tech-lead'],
    transcriptIds: ['transcript-1'],
    modelChoices: { coder: 'codex', reviewer: 'claude' },
    commitSha: 'abc1234',
    verdicts: { reviewer: 'pass', 'tech-lead': 'pass' },
    contextOutcome: 'updated',
    gates: { objectionOpen: false },
    outcome: 'ready-for-closeout',
  };
}

function cursor(): OrchestrationRunCursor {
  return {
    runId: 'mut-orch-resume',
    product: 'rune',
    project: '14-product-team-agents',
    branch: 'rune-work/14-product-team-agents',
    baseBranch: 'main',
    worktreePath: '/tmp/rune-worktrees/rune/14-product-team-agents',
    resumeMarker: 'resumable',
    cursor: {
      completedTaskIds: ['persist-records-and-cursor'],
      currentTaskId: null,
      nextTaskId: 'resume-boot',
    },
  };
}

function selectedResumeTask(): SelectedTask {
  return {
    id: 'resume-boot',
    text: 'Resume boot',
    section: 'Phase 11B',
  };
}

describe('orchestrated-work boot recovery', () => {
  it('reconstructs a still-running orchestrated mutation and re-dispatches its existing branch', async () => {
    const mutation = runningOrchestratedMutation();
    const runCursor = cursor();
    const records = [readyRecord()];
    const tasksMd = [
      '# Tasks',
      '',
      '## Phase 11B',
      '- [x] Persist records and cursor',
      '- [ ] Resume boot',
    ].join('\n');
    const reconstruction = {
      completedTaskIds: ['persist-records-and-cursor'],
      nextTask: selectedResumeTask(),
      drift: false,
    };
    mockReconstructRun.mockReturnValue(reconstruction);

    const deps = {
      readRunningOrchestratedMutations: vi.fn(async () => [mutation]),
      preflightRecovery: vi.fn(async () => ({ kind: 'recoverable' as const, cursor: runCursor, reconstruction })),
      redispatchOrchestratedMutation: vi.fn(async () => {}),
      markOrphaned: vi.fn(async () => {}),
      writeTerminal: vi.fn(async () => {}),
    };

    const result = await recoverOrchestratedWorkRuns(deps);

    expect(deps.preflightRecovery).toHaveBeenCalledWith(mutation);
    expect(deps.redispatchOrchestratedMutation).toHaveBeenCalledWith(
      mutation,
      expect.objectContaining({
        branch: runCursor.branch,
        baseBranch: runCursor.baseBranch,
        worktreePath: runCursor.worktreePath,
        reconstruction,
        resumeFromTaskId: 'resume-boot',
        existingBranch: true,
      }),
    );
    expect(deps.markOrphaned).not.toHaveBeenCalled();
    expect(deps.writeTerminal).not.toHaveBeenCalled();
    expect(result).toEqual({
      resumed: ['mut-orch-resume'],
      orphaned: [],
      skipped: [],
    });
  });

  it('re-dispatches a mid-first-task run: task-start cursor present, zero records, zero ticked boxes', async () => {
    // bugs.md (restart safety 2/2): this exact input used to be orphaned
    // because no cursor existed before the first closeout. With the
    // task-start cursor, recovery reconstructs an empty-progress run
    // (drift: false) and re-dispatches from the first unchecked task.
    const mutation = runningOrchestratedMutation();
    const runCursor: OrchestrationRunCursor = {
      ...cursor(),
      cursor: {
        completedTaskIds: [],
        currentTaskId: 'persist-records-and-cursor',
        nextTaskId: 'persist-records-and-cursor',
      },
    };
    const tasksMd = [
      '# Tasks',
      '',
      '## Phase 11B',
      '- [ ] Persist records and cursor',
      '- [ ] Resume boot',
    ].join('\n');
    const reconstruction = {
      completedTaskIds: [],
      nextTask: { id: 'persist-records-and-cursor', text: 'Persist records and cursor', section: 'Phase 11B' },
      drift: false,
    };
    mockReconstructRun.mockReturnValue(reconstruction);

    const deps = {
      readRunningOrchestratedMutations: vi.fn(async () => [mutation]),
      preflightRecovery: vi.fn(async () => ({ kind: 'recoverable' as const, cursor: runCursor, reconstruction })),
      redispatchOrchestratedMutation: vi.fn(async () => {}),
      markOrphaned: vi.fn(async () => {}),
      writeTerminal: vi.fn(async () => {}),
    };

    const result = await recoverOrchestratedWorkRuns(deps);

    expect(deps.preflightRecovery).toHaveBeenCalledWith(mutation);
    expect(deps.redispatchOrchestratedMutation).toHaveBeenCalledWith(
      mutation,
      expect.objectContaining({
        branch: runCursor.branch,
        baseBranch: runCursor.baseBranch,
        worktreePath: runCursor.worktreePath,
        reconstruction,
        resumeFromTaskId: 'persist-records-and-cursor',
        existingBranch: true,
      }),
    );
    expect(deps.markOrphaned).not.toHaveBeenCalled();
    expect(result).toEqual({ resumed: ['mut-orch-resume'], orphaned: [], skipped: [] });
  });

  it('does not redispatch a resumable mutation when another process owns its recovery lease', async () => {
    const mutation = runningOrchestratedMutation();
    const runCursor = cursor();
    const records = [readyRecord()];
    const tasksMd = [
      '# Tasks',
      '',
      '## Phase 11B',
      '- [x] Persist records and cursor',
      '- [ ] Resume boot',
    ].join('\n');
    mockReconstructRun.mockReturnValue({
      completedTaskIds: ['persist-records-and-cursor'],
      nextTask: selectedResumeTask(),
      drift: false,
    });

    const deps = {
      readRunningOrchestratedMutations: vi.fn(async () => [mutation]),
      acquireRecoveryLease: vi.fn(async (runId: string) => {
        expect(runId).toBe(mutation.id);
        return false;
      }),
      releaseRecoveryLease: vi.fn(async () => {}),
      preflightRecovery: vi.fn(async () => ({
        kind: 'recoverable' as const,
        cursor: runCursor,
        reconstruction: { completedTaskIds: [], nextTask: null, drift: false },
      })),
      redispatchOrchestratedMutation: vi.fn(async () => {}),
      markOrphaned: vi.fn(async () => {}),
      writeTerminal: vi.fn(async () => {}),
    };

    const result = await recoverOrchestratedWorkRuns(deps);

    expect(deps.acquireRecoveryLease).toHaveBeenCalledWith(mutation.id);
    expect(mockReconstructRun).not.toHaveBeenCalled();
    expect(deps.redispatchOrchestratedMutation).not.toHaveBeenCalled();
    expect(deps.markOrphaned).not.toHaveBeenCalled();
    expect(deps.writeTerminal).not.toHaveBeenCalled();
    expect(deps.releaseRecoveryLease).not.toHaveBeenCalled();
    expect(result).toEqual({
      resumed: [],
      orphaned: [],
      skipped: ['mut-orch-resume'],
    });
  });
});

describe('orchestrated-work active recovery request', () => {
  it('cancels and detaches one active orchestrated run, then redispatches from its durable cursor', async () => {
    const mutation = runningOrchestratedMutation();
    const runCursor = cursor();
    const records = [readyRecord()];
    const tasksMd = [
      '# Tasks',
      '',
      '## Phase 11B',
      '- [x] Persist records and cursor',
      '- [ ] Resume boot',
    ].join('\n');
    const reconstruction = {
      completedTaskIds: ['persist-records-and-cursor'],
      nextTask: selectedResumeTask(),
      drift: false,
    };
    const order: string[] = [];
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = () => { order.push('settled'); resolve(); }; });
    const cancel = vi.fn(() => { settle(); });
    const handle = { descriptor: mutation, cancel, settled };

    const deps = {
      preflightRecovery: vi.fn(async () => ({ kind: 'recoverable' as const, cursor: runCursor, reconstruction })),
      redispatchOrchestratedMutation: vi.fn(() => { order.push('redispatch'); return { ok: true as const }; }),
      activeRun: vi.fn(() => handle),
      preserveForHandoff: vi.fn(() => { order.push('preserve'); return true; }),
      releaseHandoff: vi.fn(() => { order.push('release'); }),
    };

    const result = await requestOrchestratedRunRecovery(mutation.id, deps);

    expect(deps.preflightRecovery).toHaveBeenCalledWith(mutation);
    expect(cancel).toHaveBeenCalledWith('system');
    expect(deps.redispatchOrchestratedMutation).toHaveBeenCalledWith(
      mutation,
      expect.objectContaining({
        branch: runCursor.branch,
        baseBranch: runCursor.baseBranch,
        worktreePath: runCursor.worktreePath,
        reconstruction,
        resumeFromTaskId: 'resume-boot',
        existingBranch: true,
      }),
    );
    expect(order).toEqual(['preserve', 'settled', 'redispatch', 'release']);
    expect(result).toEqual({ kind: 'recovered', runId: mutation.id });
  });

  it('revalidates eligibility under preservation and redispatches from the post-settlement cursor', async () => {
    const mutation = runningOrchestratedMutation();
    const staleCursor = cursor();
    const settledCursor = {
      ...cursor(),
      cursor: {
        completedTaskIds: ['persist-records-and-cursor', 'resume-boot'],
        currentTaskId: null,
        nextTaskId: 'finish-recovery',
      },
    };
    const staleReconstruction = {
      completedTaskIds: ['persist-records-and-cursor'],
      nextTask: selectedResumeTask(),
      drift: false,
    };
    const settledReconstruction = {
      completedTaskIds: ['persist-records-and-cursor', 'resume-boot'],
      nextTask: { id: 'finish-recovery', text: 'Finish recovery', section: 'Phase 11B' },
      drift: false,
    };
    const order: string[] = [];
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = () => { order.push('settled'); resolve(); }; });
    const cancel = vi.fn(() => { order.push('cancel'); settle(); });
    const handle = { descriptor: mutation, cancel, settled };
    const preflightRecovery = vi
      .fn()
      .mockImplementationOnce(async () => {
        order.push('initial-preflight');
        return { kind: 'recoverable' as const, cursor: staleCursor, reconstruction: staleReconstruction };
      })
      .mockImplementationOnce(async () => {
        order.push('protected-preflight');
        return { kind: 'recoverable' as const, cursor: staleCursor, reconstruction: staleReconstruction };
      })
      .mockImplementationOnce(async () => {
        order.push('settled-preflight');
        return { kind: 'recoverable' as const, cursor: settledCursor, reconstruction: settledReconstruction };
      });
    const redispatchOrchestratedMutation = vi.fn(() => {
      order.push('redispatch');
      return { ok: true as const };
    });
    const deps = {
      preflightRecovery,
      redispatchOrchestratedMutation,
      activeRun: vi.fn(() => handle),
      preserveForHandoff: vi.fn(() => { order.push('preserve'); return true; }),
      releaseHandoff: vi.fn(() => { order.push('release'); }),
    };

    await expect(requestOrchestratedRunRecovery(mutation.id, deps)).resolves.toEqual({
      kind: 'recovered',
      runId: mutation.id,
    });

    expect(preflightRecovery).toHaveBeenCalledTimes(3);
    expect(order).toEqual([
      'initial-preflight',
      'preserve',
      'protected-preflight',
      'cancel',
      'settled',
      'settled-preflight',
      'redispatch',
      'release',
    ]);
    expect(redispatchOrchestratedMutation).toHaveBeenCalledWith(
      mutation,
      expect.objectContaining({
        reconstruction: settledReconstruction,
        resumeFromTaskId: 'finish-recovery',
      }),
    );
  });

  it('refuses to recover when the active run is not orchestrated-work', async () => {
    const descriptor = {
      ...runningOrchestratedMutation(),
      kind: 'work-run' as const,
    };
    const cancel = vi.fn();
    const deps = {
      preflightRecovery: vi.fn(),
      redispatchOrchestratedMutation: vi.fn(),
      activeRun: vi.fn(() => ({ descriptor, cancel, settled: Promise.resolve() })),
      preserveForHandoff: vi.fn(),
      releaseHandoff: vi.fn(),
    };

    const result = await requestOrchestratedRunRecovery('mut-orch-resume', deps);

    expect(result.kind).toBe('not-orchestrated');
    expect(cancel).not.toHaveBeenCalled();
    expect(deps.preserveForHandoff).not.toHaveBeenCalled();
    expect(deps.redispatchOrchestratedMutation).not.toHaveBeenCalled();
  });

  it('refuses to recover when the durable cursor is missing', async () => {
    const mutation = runningOrchestratedMutation();
    const cancel = vi.fn();
    const deps = {
      preflightRecovery: vi.fn(async () => ({ kind: 'not-resumable' as const, reason: 'missing resumable orchestrated cursor' })),
      redispatchOrchestratedMutation: vi.fn(),
      activeRun: vi.fn(() => ({ descriptor: mutation, cancel, settled: Promise.resolve() })),
      preserveForHandoff: vi.fn(),
      releaseHandoff: vi.fn(),
    };

    const result = await requestOrchestratedRunRecovery(mutation.id, deps);

    expect(result).toEqual({
      kind: 'not-resumable',
      reason: 'missing resumable orchestrated cursor',
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(deps.preserveForHandoff).not.toHaveBeenCalled();
  });

  it('refuses to recover when task records drift from tasks.md', async () => {
    const mutation = runningOrchestratedMutation();
    const cancel = vi.fn();
    const deps = {
      preflightRecovery: vi.fn(async () => ({ kind: 'not-resumable' as const, reason: 'completed task records disagree with tasks.md' })),
      redispatchOrchestratedMutation: vi.fn(),
      activeRun: vi.fn(() => ({ descriptor: mutation, cancel, settled: Promise.resolve() })),
      preserveForHandoff: vi.fn(),
      releaseHandoff: vi.fn(),
    };

    const result = await requestOrchestratedRunRecovery(mutation.id, deps);

    expect(result).toEqual({
      kind: 'not-resumable',
      reason: 'completed task records disagree with tasks.md',
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(deps.preserveForHandoff).not.toHaveBeenCalled();
  });

  it('releases the preservation handoff and does not redispatch when old-invocation settlement fails', async () => {
    const mutation = runningOrchestratedMutation();
    let rejectSettlement!: (error: Error) => void;
    const settled = new Promise<void>((_resolve, reject) => { rejectSettlement = reject; });
    const cancel = vi.fn(() => { rejectSettlement(new Error('teardown failed')); });
    const handle = { descriptor: mutation, cancel, settled };
    const releaseHandoff = vi.fn();
    const deps = {
      preflightRecovery: vi.fn(async () => ({
        kind: 'recoverable' as const,
        cursor: cursor(),
        reconstruction: { completedTaskIds: [], nextTask: selectedResumeTask(), drift: false },
      })),
      redispatchOrchestratedMutation: vi.fn(),
      activeRun: vi.fn(() => handle),
      preserveForHandoff: vi.fn(() => true),
      releaseHandoff,
    };

    const result = await requestOrchestratedRunRecovery(mutation.id, deps);

    expect(cancel).toHaveBeenCalledWith('system');
    expect(deps.redispatchOrchestratedMutation).not.toHaveBeenCalled();
    expect(releaseHandoff).toHaveBeenCalledWith(mutation.id);
    expect(result).toEqual({ kind: 'error', reason: 'teardown failed' });
  });
});
