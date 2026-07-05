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
      readRunCursor: vi.fn(async (runId: string) => (runId === mutation.id ? runCursor : null)),
      readTaskRunRecords: vi.fn(async (runId: string) => (runId === mutation.id ? records : [])),
      readTasksMd: vi.fn(async (loadedCursor: OrchestrationRunCursor) => {
        expect(loadedCursor).toBe(runCursor);
        return tasksMd;
      }),
      redispatchOrchestratedMutation: vi.fn(async () => {}),
      markOrphaned: vi.fn(async () => {}),
      writeTerminal: vi.fn(async () => {}),
    };

    const result = await recoverOrchestratedWorkRuns(deps);

    expect(mockReconstructRun).toHaveBeenCalledWith({ tasksMd, records });
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
      readRunCursor: vi.fn(async () => runCursor),
      readTaskRunRecords: vi.fn(async () => records),
      readTasksMd: vi.fn(async () => tasksMd),
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
    const cancel = vi.fn();
    mockReconstructRun.mockReturnValue(reconstruction);

    const deps = {
      readRunCursor: vi.fn(async (runId: string) => (runId === mutation.id ? runCursor : null)),
      readTaskRunRecords: vi.fn(async (runId: string) => (runId === mutation.id ? records : [])),
      readTasksMd: vi.fn(async (loadedCursor: OrchestrationRunCursor) => {
        expect(loadedCursor).toBe(runCursor);
        return tasksMd;
      }),
      redispatchOrchestratedMutation: vi.fn(() => ({ ok: true as const })),
      activeRun: vi.fn(() => ({ descriptor: mutation, cancel })),
      detachActiveRun: vi.fn(),
    };

    const result = await requestOrchestratedRunRecovery(mutation.id, deps);

    expect(mockReconstructRun).toHaveBeenCalledWith({ tasksMd, records });
    expect(cancel).toHaveBeenCalledWith('system');
    expect(deps.detachActiveRun).toHaveBeenCalledWith(mutation.id);
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
    expect(result).toEqual({ kind: 'recovered', runId: mutation.id });
  });

  it('refuses to recover when the active run is not orchestrated-work', async () => {
    const descriptor = {
      ...runningOrchestratedMutation(),
      kind: 'work-run' as const,
    };
    const cancel = vi.fn();
    const deps = {
      readRunCursor: vi.fn(),
      readTaskRunRecords: vi.fn(),
      readTasksMd: vi.fn(),
      redispatchOrchestratedMutation: vi.fn(),
      activeRun: vi.fn(() => ({ descriptor, cancel })),
      detachActiveRun: vi.fn(),
    };

    const result = await requestOrchestratedRunRecovery('mut-orch-resume', deps);

    expect(result.kind).toBe('not-orchestrated');
    expect(cancel).not.toHaveBeenCalled();
    expect(deps.detachActiveRun).not.toHaveBeenCalled();
    expect(deps.redispatchOrchestratedMutation).not.toHaveBeenCalled();
  });

  it('refuses to recover when the durable cursor is missing', async () => {
    const mutation = runningOrchestratedMutation();
    const cancel = vi.fn();
    const deps = {
      readRunCursor: vi.fn(async () => null),
      readTaskRunRecords: vi.fn(),
      readTasksMd: vi.fn(),
      redispatchOrchestratedMutation: vi.fn(),
      activeRun: vi.fn(() => ({ descriptor: mutation, cancel })),
      detachActiveRun: vi.fn(),
    };

    const result = await requestOrchestratedRunRecovery(mutation.id, deps);

    expect(result).toEqual({
      kind: 'not-resumable',
      reason: 'missing resumable orchestrated cursor',
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(deps.detachActiveRun).not.toHaveBeenCalled();
  });

  it('refuses to recover when task records drift from tasks.md', async () => {
    const mutation = runningOrchestratedMutation();
    const cancel = vi.fn();
    mockReconstructRun.mockReturnValue({
      completedTaskIds: ['persist-records-and-cursor'],
      nextTask: selectedResumeTask(),
      drift: true,
    });
    const deps = {
      readRunCursor: vi.fn(async () => cursor()),
      readTaskRunRecords: vi.fn(async () => [readyRecord()]),
      readTasksMd: vi.fn(async () => '- [ ] Resume boot\n'),
      redispatchOrchestratedMutation: vi.fn(),
      activeRun: vi.fn(() => ({ descriptor: mutation, cancel })),
      detachActiveRun: vi.fn(),
    };

    const result = await requestOrchestratedRunRecovery(mutation.id, deps);

    expect(result).toEqual({
      kind: 'not-resumable',
      reason: 'completed task records disagree with tasks.md',
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(deps.detachActiveRun).not.toHaveBeenCalled();
  });
});
