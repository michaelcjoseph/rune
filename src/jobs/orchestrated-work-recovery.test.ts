import { describe, it, expect, vi } from 'vitest';

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

import { recoverOrchestratedWorkRuns } from './orchestrated-work-runner.js';

function runningOrchestratedMutation(): MutationDescriptor<{ projectSlug: string; product: string }> {
  return {
    id: 'mut-orch-resume',
    kind: 'orchestrated-work',
    source: 'webview',
    target: { type: 'orchestrated-work', ref: '14-product-team-agents' },
    preview: { summary: 'orchestrated-work on 14-product-team-agents' },
    payload: { projectSlug: '14-product-team-agents', product: 'jarvis' },
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
    product: 'jarvis',
    project: '14-product-team-agents',
    branch: 'jarvis-work/14-product-team-agents',
    baseBranch: 'main',
    worktreePath: '/tmp/jarvis-worktrees/jarvis/14-product-team-agents',
    attemptCap: 3,
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
        attemptCap: runCursor.attemptCap,
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
});
