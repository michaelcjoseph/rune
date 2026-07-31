import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkRunDiagnostics as createDiagnosticsService,
  readTranscriptDisplayTail,
} from './work-run-diagnostics.js';
import type { WorkRunSummary, WorkRunSummaryReadResult } from './work-run-store.js';
import type { SupervisedRun } from '../intent/supervision.js';
import type { TaskRunRecord } from '../intent/orch-run-record.js';

const assaySummary: WorkRunSummary = {
  id: 'assay-run-1',
  product: 'assay',
  project: '01-analysis',
  outcome: 'failed',
  reason: 'validation failed',
  exit: { exitCode: 1, signal: null, cancelled: false, durationMs: 300_000 },
  workProduct: {
    commitCount: 0,
    commitShas: [],
    filesChanged: [],
    diffstat: '',
    dirty: false,
    untracked: false,
    transitions: { tasksNewlyChecked: 0, tasksRemaining: 1, tasksAdded: 0, tasksRemoved: 0 },
  },
  baseSha: 'deadbeef',
  branch: 'rune-work/assay-run-1',
  startedAt: '2026-07-13T10:00:00.000Z',
  endedAt: '2026-07-13T10:05:00.000Z',
  transcriptPath: '/Users/example/workspace/rune/logs/work-runs/assay-run-1/transcript.jsonl',
  forensicsPath: '/Users/example/workspace/rune/logs/work-runs/assay-run-1/forensics.json',
};

function taskRecord(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
  return {
    taskId: 'validate-results',
    taskText: 'Validate results',
    attemptId: 'attempt-1',
    rolesInvoked: ['qa', 'coder'],
    transcriptIds: [],
    modelChoices: { qa: 'codex' },
    commitSha: null,
    verdicts: { qa: 'fail' },
    contextOutcome: 'unchanged',
    gates: { objectionOpen: false },
    outcome: 'failed',
    ...overrides,
  };
}

function makeDeps() {
  const summaries: WorkRunSummary[] = [
    assaySummary,
    { ...assaySummary, id: 'rune-run-1', product: 'rune', project: 'rune-private' },
  ];
  const supervisedRuns: SupervisedRun[] = [
    {
      id: 'assay-run-1', product: 'assay', project: '01-analysis', status: 'failed',
      startedAt: assaySummary.startedAt, lastHeartbeatAt: assaySummary.endedAt,
      operatorWorktreePath: '/Users/example/.rune-worktrees/assay-private',
    },
    {
      id: 'assay-active', product: 'assay', project: '02-live', status: 'running',
      startedAt: assaySummary.startedAt, lastHeartbeatAt: assaySummary.endedAt,
    },
    {
      id: 'rune-active', product: 'rune', project: 'private', status: 'running',
      startedAt: assaySummary.startedAt, lastHeartbeatAt: assaySummary.endedAt,
    },
  ];
  const readSummary = vi.fn((runId: string): WorkRunSummaryReadResult => {
    const summary = summaries.find((run) => run.id === runId);
    return summary ? { status: 'found', summary } : { status: 'missing' };
  });
  return {
    readRecentSummaries: vi.fn(() => summaries),
    readSummary,
    readSupervisedRuns: vi.fn(() => ({ runs: supervisedRuns, complete: true })),
    readTaskRunRecords: vi.fn((): TaskRunRecord[] => [taskRecord()]),
    readTranscriptTail: vi.fn((runId: string) => ({
      lines: runId === 'assay-run-1'
        ? [
          'old line that must be trimmed',
          'failure at /Users/example/workspace/assay/private.ts',
          'cache at /private/tmp/rune/secret.json',
          'provider returned sk-supersecret123',
        ]
        : Array.from({ length: 50 }, (_, index) => `line ${index}`),
      sourceTruncated: false,
    })),
  };
}

function createWorkRunDiagnostics(deps: ReturnType<typeof makeDeps>, product: string) {
  return createDiagnosticsService(deps, product);
}

describe('product-scoped work-run diagnostics', () => {
  it('projects the durable scrubbed cancellation record after the child operation is gone', () => {
    const cancellation = {
      role: 'tech-lead',
      operationId: 'abc12345-1234-1234-1234-123456789abc',
      source: 'cockpit' as const,
      requestedAt: '2026-07-13T12:34:56.000Z',
    };
    const cancelledSummary = {
      ...assaySummary,
      reason: 'tech-lead cancelled from cockpit (operation abc12345)',
      cancellation,
    };
    const deps = makeDeps();
    deps.readRecentSummaries.mockReturnValue([cancelledSummary]);
    deps.readSummary.mockReturnValue({ status: 'found', summary: cancelledSummary });

    const result = createWorkRunDiagnostics(deps, 'assay').inspectRun({ runId: 'assay-run-1' }) as {
      cancellation?: typeof cancellation;
    };

    expect(result.cancellation).toEqual(cancellation);
  });

  it('lists only the authorized product and honors the requested limit', async () => {
    const service = createWorkRunDiagnostics(makeDeps(), 'assay');
    const result = await service.listRuns({ limit: 1 }) as { runs: Array<Record<string, unknown>> };

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toEqual(expect.objectContaining({
      id: 'assay-run-1',
      target: { kind: 'project', slug: '01-analysis' },
      state: 'failed',
      outcome: 'failed',
      reason: 'validation failed',
      startedAt: assaySummary.startedAt,
      endedAt: assaySummary.endedAt,
    }));
    expect(JSON.stringify(result)).not.toContain('rune-run-1');
  });

  it('projects a persisted bug target without relabeling it as a project', () => {
    const deps = makeDeps();
    const bugSummary = {
      ...assaySummary,
      id: 'assay-bug-run',
      project: 'bug-fix-worktree',
      target: { kind: 'bug' as const, slug: 'BUG-42' },
    };
    deps.readRecentSummaries.mockReturnValue([bugSummary]);
    deps.readSummary.mockReturnValue({ status: 'found', summary: bugSummary });
    deps.readSupervisedRuns.mockReturnValue({ runs: [], complete: true });

    const result = createWorkRunDiagnostics(deps, 'assay').listRuns() as {
      runs: Array<{ target: { kind: string; slug: string } }>;
    };
    expect(result.runs[0]?.target).toEqual({ kind: 'bug', slug: 'BUG-42' });
  });

  it('uses supervision target identity when a legacy summary has no target', () => {
    const deps = makeDeps();
    deps.readRecentSummaries.mockReturnValue([assaySummary]);
    deps.readSupervisedRuns.mockReturnValue({ runs: [{
      id: assaySummary.id,
      product: 'assay',
      project: assaySummary.project,
      target: { kind: 'bug', slug: 'BUG-legacy-summary' },
      status: 'failed',
      startedAt: assaySummary.startedAt,
      lastHeartbeatAt: assaySummary.endedAt,
    }], complete: true });

    const result = createWorkRunDiagnostics(deps, 'assay').listRuns() as {
      runs: Array<{ target: { kind: string; slug: string } }>;
    };
    expect(result.runs[0]?.target).toEqual({ kind: 'bug', slug: 'BUG-legacy-summary' });
  });

  it('validates run ids and gives unknown and cross-product runs the same non-disclosing denial', async () => {
    const deps = makeDeps();
    const service = createWorkRunDiagnostics(deps, 'assay');

    await expect(Promise.resolve().then(() => service.inspectRun({ runId: '../escape' })))
      .rejects.toThrow(/invalid run id/i);
    expect(deps.readSummary).not.toHaveBeenCalledWith('../escape');

    const messageFor = async (runId: string) => {
      try {
        await service.inspectRun({ runId });
        return 'resolved unexpectedly';
      } catch (error) {
        return (error as Error).message;
      }
    };
    const missing = await messageFor('missing-run');
    const otherProduct = await messageFor('rune-run-1');
    expect(otherProduct).toBe(missing);
    expect(otherProduct).toMatch(/not available in this product scope/i);
    expect(otherProduct).not.toMatch(/rune|exists|product mismatch/i);
  });

  it('returns task evidence and a bounded, redacted, path-scrubbed display transcript', async () => {
    const service = createWorkRunDiagnostics(makeDeps(), 'assay');
    const result = await service.inspectRun({ runId: 'assay-run-1', transcriptLines: 3 }) as {
      taskRecords: unknown[];
      transcript: { lines: string[]; truncated: boolean; available: boolean };
    };

    expect(result.taskRecords).toEqual([expect.objectContaining({
      taskId: 'validate-results',
      rolesInvoked: ['qa', 'coder'],
      outcome: 'failed',
    })]);
    expect(result.transcript).toEqual(expect.objectContaining({
      available: true,
      truncated: true,
    }));
    expect(result.transcript.lines).toHaveLength(3);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('old line that must be trimmed');
    expect(serialized).not.toContain('sk-supersecret123');
    expect(serialized).not.toContain('/Users/example');
    expect(serialized).not.toContain('/private/tmp');
    expect(serialized).not.toContain('transcriptPath');
    expect(serialized).not.toContain('forensicsPath');
    expect(serialized).not.toContain('operatorWorktreePath');
  });

  it('projects well-formed full-task base/current-tree/hash evidence and drops malformed values', async () => {
    const deps = makeDeps();
    deps.readTaskRunRecords.mockReturnValue([
      taskRecord({
        taskId: 'valid-evidence',
        taskBaseTree: '1'.repeat(40),
        currentReviewTree: '2'.repeat(40),
        fullTaskReviewHash: 'a'.repeat(64),
      }),
      taskRecord({
        taskId: 'malformed-evidence',
        taskBaseTree: '/Users/example/workspace/leaked-path' as unknown as string,
        currentReviewTree: 'not-a-tree-oid' as unknown as string,
        fullTaskReviewHash: 'short-hash' as unknown as string,
      }),
    ]);
    const service = createWorkRunDiagnostics(deps, 'assay');

    const result = await service.inspectRun({ runId: 'assay-run-1' }) as {
      taskRecords: Array<Record<string, unknown>>;
    };

    expect(result.taskRecords).toEqual([
      expect.objectContaining({
        taskId: 'valid-evidence',
        taskBaseTree: '1'.repeat(40),
        currentReviewTree: '2'.repeat(40),
        fullTaskReviewHash: 'a'.repeat(64),
      }),
      expect.not.objectContaining({
        taskBaseTree: expect.anything(),
        currentReviewTree: expect.anything(),
        fullTaskReviewHash: expect.anything(),
      }),
    ]);
    expect(result.taskRecords[1]).toMatchObject({ taskId: 'malformed-evidence' });
    expect(JSON.stringify(result)).not.toContain('/Users/example');
  });

  it('projects only a compact validation receipt from durable attestation evidence', async () => {
    const deps = makeDeps();
    deps.readTaskRunRecords.mockReturnValue([
      taskRecord({
        fullSuiteAttestation: {
          version: 1,
          treeOid: '1'.repeat(40),
          fullTaskReviewHash: 'a'.repeat(64),
          validationCwd: '.',
          configuredArgv: [['npm', 'test']],
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
          // Historical/untrusted extras must never cross the diagnostic surface.
          outputTail: 'TELEGRAM_BOT_TOKEN=secret',
          reporterPath: '/Users/operator/private/reporter.ts',
        },
        validationReceipt: {
          provenance: 'full-suite-reused',
          command: 'npm test',
          treeOid: '1'.repeat(40),
          outcome: 'passed',
          coverage: 'complete',
          discovered: { suites: 3, tests: 7 },
          completed: {
            suites: 3, tests: 7, passed: 4, failed: 0, skipped: 1, todo: 2, cancelled: 0,
          },
        },
      } as unknown as Partial<TaskRunRecord>),
    ]);

    const result = await createWorkRunDiagnostics(deps, 'assay').inspectRun({
      runId: 'assay-run-1',
    }) as { taskRecords: Array<Record<string, unknown>> };
    const serialized = JSON.stringify(result.taskRecords);

    expect(result.taskRecords[0]).toMatchObject({
      validationReceipt: {
        provenance: 'full-suite-reused',
        command: 'npm test',
        treeOid: '1'.repeat(40),
        outcome: 'passed',
        coverage: 'complete',
        discovered: { suites: 3, tests: 7 },
        completed: {
          suites: 3, tests: 7, passed: 4, failed: 0, skipped: 1, todo: 2, cancelled: 0,
        },
      },
    });
    expect(serialized).not.toContain('fullSuiteAttestation');
    expect(serialized).not.toContain('configurationFingerprint');
    expect(serialized).not.toContain('outputTail');
    expect(serialized).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(serialized).not.toContain('/Users/operator');
    expect(serialized.length).toBeLessThan(4_000);
  });

  it('projects bounded coder-self-review artifact evidence without raw artifacts', async () => {
    const deps = makeDeps();
    deps.readTaskRunRecords.mockReturnValue([
      taskRecord({
        executionFailure: {
          taskId: 'validate-results',
          role: 'coder',
          provider: 'openai',
          format: 'codex',
          model: 'gpt-test',
          workflowStage: 'coder-self-review',
          checkpointedAt: '2026-07-30T00:00:00.000Z',
          failureStage: 'artifact-contract',
          diagnostic: 'missing artifact at /Users/operator/private',
          retryable: false,
          attempts: [{
            attempt: 1,
            startedAt: '2026-07-30T00:00:00.000Z',
            endedAt: '2026-07-30T00:00:01.000Z',
            failureStage: 'artifact-contract',
            diagnostic: 'missing artifact at /Users/operator/private',
            retryable: false,
          }],
          retryDisposition: 'exhausted',
        },
        coderSelfReviews: [{
          round: 1,
          outcome: 'confirmed',
          notes: 'Checked the final implementation.',
          canonicalHash: 'a'.repeat(64),
          changedPaths: ['src/result.ts'],
          artifactAttempts: [{
            attempt: 1,
            status: 'parsed',
            provider: 'openai',
            progressCount: 2,
            candidateCount: 1,
            diagnostic: 'parsed terminal artifact at /Users/operator/private',
          }],
        }],
      }),
    ]);

    const result = await createWorkRunDiagnostics(deps, 'assay').inspectRun({
      runId: 'assay-run-1',
    }) as { taskRecords: Array<Record<string, unknown>> };
    const serialized = JSON.stringify(result.taskRecords);

    expect(result.taskRecords[0]).toMatchObject({
      coderSelfReviews: [{
        round: 1,
        outcome: 'confirmed',
        artifactAttempts: [{
          attempt: 1,
          status: 'parsed',
          provider: 'openai',
          progressCount: 2,
          candidateCount: 1,
        }],
      }],
      executionFailure: {
        failureStage: 'artifact-contract',
        retryDisposition: 'exhausted',
      },
    });
    expect(serialized).not.toContain('/Users/operator');
    expect(serialized).not.toContain('```coder-self-review');
  });

  it('allowlists valid execution-failure diagnostics and omits invalid failure records', async () => {
    const deps = makeDeps();
    const valid = taskRecord({
      executionFailure: {
        taskId: 'valid',
        role: 'coder',
        provider: 'openai',
        format: 'codex',
        model: 'gpt-test',
        workflowStage: 'coder-self-review',
        checkpointedAt: '2026-07-30T00:00:00.000Z',
        failureStage: 'artifact-contract',
        diagnostic: 'invalid artifact',
        retryable: false,
        attempts: [{
          attempt: 1,
          startedAt: '2026-07-30T00:00:00.000Z',
          endedAt: '2026-07-30T00:00:01.000Z',
          failureStage: 'artifact-contract',
          diagnostic: 'invalid artifact',
          retryable: false,
          rawArtifact: '```coder-self-review\nsecret\n```',
        }],
        retryDisposition: 'exhausted',
        rawArtifact: '```coder-self-review\nsecret\n```',
      } as unknown as TaskRunRecord['executionFailure'],
    });
    const invalid = taskRecord({
      taskId: 'invalid',
      executionFailure: {
        failureStage: 'artifact-contract',
        rawArtifact: '```coder-self-review\nsecret\n```',
      } as unknown as TaskRunRecord['executionFailure'],
    });
    deps.readTaskRunRecords.mockReturnValue([valid, invalid]);

    const result = await createWorkRunDiagnostics(deps, 'assay').inspectRun({
      runId: 'assay-run-1',
    }) as { taskRecords: Array<Record<string, unknown>> };

    expect(result.taskRecords[0]?.executionFailure).toMatchObject({
      failureStage: 'artifact-contract',
      retryDisposition: 'exhausted',
    });
    expect(result.taskRecords[0]?.executionFailure).not.toHaveProperty('rawArtifact');
    expect((result.taskRecords[0]?.executionFailure as {
      attempts: Array<Record<string, unknown>>;
    }).attempts[0]).not.toHaveProperty('rawArtifact');
    expect(result.taskRecords[1]).not.toHaveProperty('executionFailure');
    expect(JSON.stringify(result)).not.toContain('```coder-self-review');
  });

  it('returns only active or parked runs for the authorized product with a capped safe log tail', async () => {
    const service = createWorkRunDiagnostics(makeDeps(), 'assay');
    const result = await service.activeRuns() as { runs: Array<Record<string, unknown>> };

    expect(result.runs.map((run) => run['id'])).toEqual(['assay-active']);
    expect(JSON.stringify(result)).not.toContain('rune-active');
    const lines = result.runs[0]?.['lastLogLines'] as string[];
    expect(lines.length).toBeLessThanOrEqual(20);
  });

  it('resolves an authorized unique prefix to the full run id', async () => {
    const service = createWorkRunDiagnostics(makeDeps(), 'assay');
    const result = await service.inspectRun({ runId: 'assay-ru' }) as unknown as { id: string };
    expect(result.id).toBe('assay-run-1');
  });

  it('fails closed on conflicting persisted product evidence before reading artifacts', async () => {
    const deps = makeDeps();
    deps.readSupervisedRuns.mockReturnValue({ runs: [{
      id: 'assay-run-1', product: 'rune', project: 'private', status: 'running',
      startedAt: assaySummary.startedAt, lastHeartbeatAt: assaySummary.endedAt,
    }], complete: true });
    const service = createWorkRunDiagnostics(deps, 'assay');

    await expect(Promise.resolve().then(() => service.inspectRun({ runId: 'assay-run-1' })))
      .rejects.toThrow(/not available in this product scope/i);
    expect(deps.readTaskRunRecords).not.toHaveBeenCalled();
    expect(deps.readTranscriptTail).not.toHaveBeenCalled();
  });

  it('omits an active run with conflicting summary ownership without reading its artifacts', async () => {
    const deps = makeDeps();
    deps.readSummary.mockImplementation((runId: string) => runId === 'assay-active'
      ? { status: 'found', summary: { ...assaySummary, id: runId, product: 'rune' } }
      : { status: 'missing' });
    const service = createWorkRunDiagnostics(deps, 'assay');
    const result = await service.activeRuns() as unknown as { runs: Array<{ id: string }> };

    expect(result.runs).toEqual([]);
    expect(deps.readTaskRunRecords).not.toHaveBeenCalledWith('assay-active');
    expect(deps.readTranscriptTail).not.toHaveBeenCalledWith('assay-active');
  });

  it('groups duplicate active supervision evidence and fails closed before artifact reads', async () => {
    const deps = makeDeps();
    const shared: Omit<SupervisedRun, 'product'> = {
      id: 'assay-active', project: 'live', status: 'running',
      startedAt: assaySummary.startedAt, lastHeartbeatAt: assaySummary.endedAt,
    };
    deps.readSupervisedRuns.mockReturnValue({ runs: [
      { ...shared, product: 'assay' },
      { ...shared, product: 'rune' },
    ], complete: true });
    deps.readSummary.mockReturnValue({ status: 'missing' });
    const result = await createWorkRunDiagnostics(deps, 'assay').activeRuns() as { runs: unknown[] };
    expect(result.runs).toEqual([]);
    expect(deps.readTaskRunRecords).not.toHaveBeenCalled();
    expect(deps.readTranscriptTail).not.toHaveBeenCalled();
  });

  it('scrubs single-component Unix and Windows absolute paths', async () => {
    const deps = makeDeps();
    deps.readRecentSummaries.mockReturnValue([{
      ...assaySummary,
      reason: 'checked /tmp and C:\\tmp',
    }]);
    deps.readSummary.mockReturnValue({
      status: 'found',
      summary: { ...assaySummary, reason: 'checked /tmp and C:\\tmp' },
    });
    const result = await createWorkRunDiagnostics(deps, 'assay').inspectRun({ runId: 'assay-run-1' });
    expect(JSON.stringify(result)).not.toContain('/tmp');
    expect(JSON.stringify(result)).not.toContain('C:\\tmp');
  });

  it('rechecks a summary loaded after prefix discovery and denies conflicting ownership', async () => {
    const deps = makeDeps();
    deps.readRecentSummaries.mockReturnValue([]);
    deps.readSupervisedRuns.mockReturnValue({ runs: [{
      id: 'assay-only-run', product: 'assay', project: 'live', status: 'running',
      startedAt: assaySummary.startedAt, lastHeartbeatAt: assaySummary.endedAt,
    }], complete: true });
    deps.readSummary.mockImplementation((id: string) => id === 'assay-only-run'
      ? { status: 'found', summary: { ...assaySummary, id, product: 'rune' } }
      : { status: 'missing' });
    const service = createWorkRunDiagnostics(deps, 'assay');

    await expect(Promise.resolve().then(() => service.inspectRun({ runId: 'assay-on' })))
      .rejects.toThrow(/not available in this product scope/i);
    expect(deps.readTaskRunRecords).not.toHaveBeenCalled();
    expect(deps.readTranscriptTail).not.toHaveBeenCalled();
  });

  it('denies malformed ownership evidence and ignores invalid persisted run ids', async () => {
    const deps = makeDeps();
    deps.readRecentSummaries.mockReturnValue([{ ...assaySummary, product: undefined } as any]);
    deps.readSupervisedRuns.mockReturnValue({ runs: [
      {
        id: 'assay-run-1', product: 'assay', project: 'live', status: 'running',
        startedAt: assaySummary.startedAt, lastHeartbeatAt: assaySummary.endedAt,
      },
      {
        id: 'abcdefgh-../../foreign', product: 'assay', project: 'bad', status: 'running',
        startedAt: assaySummary.startedAt, lastHeartbeatAt: assaySummary.endedAt,
      },
    ], complete: true });
    const service = createWorkRunDiagnostics(deps, 'assay');

    await expect(Promise.resolve().then(() => service.inspectRun({ runId: 'assay-run-1' })))
      .rejects.toThrow(/not available in this product scope/i);
    const active = await service.activeRuns() as unknown as { runs: Array<{ id: string }> };
    expect(active.runs.map(run => run.id)).not.toContain('abcdefgh-../../foreign');
    expect(deps.readTaskRunRecords).not.toHaveBeenCalledWith('abcdefgh-../../foreign');
  });

  it('fails closed when a persisted summary is invalid or unreadable', async () => {
    const deps = makeDeps();
    deps.readRecentSummaries.mockReturnValue([]);
    deps.readSummary.mockReturnValue({ status: 'invalid' });
    deps.readSupervisedRuns.mockReturnValue({ runs: [{
      id: 'assay-run-1', product: 'assay', project: '01-analysis', status: 'running',
      startedAt: assaySummary.startedAt, lastHeartbeatAt: assaySummary.endedAt,
    }], complete: true });

    expect(() => createWorkRunDiagnostics(deps, 'assay').inspectRun({ runId: 'assay-run-1' }))
      .toThrow(/not available in this product scope/i);
    expect(deps.readTaskRunRecords).not.toHaveBeenCalled();
    expect(deps.readTranscriptTail).not.toHaveBeenCalled();
  });

  it('fails closed when the bounded supervision snapshot is incomplete', async () => {
    const deps = makeDeps();
    deps.readSupervisedRuns.mockReturnValue({ runs: [], complete: false });
    const service = createWorkRunDiagnostics(deps, 'assay');

    await expect(Promise.resolve().then(() => service.inspectRun({ runId: 'assay-run-1' })))
      .rejects.toThrow(/not available in this product scope/i);
    await expect(Promise.resolve().then(() => service.listRuns()))
      .rejects.toThrow(/not available in this product scope/i);
    await expect(Promise.resolve().then(() => service.activeRuns()))
      .rejects.toThrow(/not available in this product scope/i);
    expect(deps.readTaskRunRecords).not.toHaveBeenCalled();
    expect(deps.readTranscriptTail).not.toHaveBeenCalled();
  });

  it('skips malformed nested task and parked-question values without crashing projection', async () => {
    const deps = makeDeps();
    deps.readTaskRunRecords.mockReturnValue([{
      taskId: 'bad-warning',
      rolesInvoked: ['qa'],
      warnings: [null],
    } as any]);
    deps.readSupervisedRuns.mockReturnValue({ runs: [{
      id: 'assay-run-1', product: 'assay', project: '01-analysis', status: 'blocked-on-human',
      startedAt: assaySummary.startedAt, lastHeartbeatAt: assaySummary.endedAt,
      parkedQuestion: { question: 'bad', options: [null], askedAt: assaySummary.endedAt },
    } as any], complete: true });

    expect(() => createWorkRunDiagnostics(deps, 'assay').inspectRun({ runId: 'assay-run-1' }))
      .not.toThrow();
  });

  it('keeps pathological task maps and keys within the serialized response budget', async () => {
    const deps = makeDeps();
    deps.readTaskRunRecords.mockReturnValue(Array.from({ length: 20 }, (_, index) => taskRecord({
      taskId: `task-${index}`,
      rolesInvoked: ['qa'],
      modelChoices: Object.fromEntries(Array.from({ length: 100 }, (__, key) => [
        `/opt/private/key-${key}`,
        'x'.repeat(2_000),
      ])),
      verdicts: { qa: 'fail' },
      outcome: 'failed',
    })));
    const result = await createWorkRunDiagnostics(deps, 'assay').inspectRun({ runId: 'assay-run-1' });
    const serialized = JSON.stringify(result);
    expect(serialized.length).toBeLessThanOrEqual(64_000);
    expect(serialized).not.toContain('/opt/private');
  });

  it('reads only a fixed-byte transcript tail, drops the partial leading frame, and sanitizes display lines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rune-diagnostics-'));
    const runId = 'run-tail-1234';
    const runDir = join(root, runId);
    mkdirSync(runDir);
    writeFileSync(join(runDir, 'transcript.jsonl'), [
      JSON.stringify({ kind: 'output', data: { line: `old ${'x'.repeat(2_000)}` } }),
      JSON.stringify({ kind: 'output', data: { line: 'latest /Users/example/private.ts sk-supersecret123' } }),
      '',
    ].join('\n'));
    try {
      const result = readTranscriptDisplayTail(root, runId, 256);
      expect(result.sourceTruncated).toBe(true);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]).toContain('latest');
      expect(result.lines[0]).not.toContain('/Users/example');
      expect(result.lines[0]).not.toContain('sk-supersecret123');
      expect(result.lines.join('\n')).not.toContain('old ');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
