import { describe, expect, it } from 'vitest';

import {
  EXECUTION_DIAGNOSTIC_MAX_CHARS,
  adjacentExecutionFailure,
  executionFailureSummary,
  isExecutionCheckpoint,
  isExecutionFailure,
  isExecutionTerminalDisposition,
  isExecutionTerminalTrigger,
  sanitizeExecutionDiagnostic,
  type ExecutionCheckpoint,
  type ExecutionFailure,
  type ExecutionFailureStage,
  type ExecutionRetryDisposition,
} from './execution-failure.js';

const checkpoint: ExecutionCheckpoint = {
  taskId: 'task-one',
  role: 'coder',
  provider: 'openai',
  format: 'codex',
  model: 'gpt-test',
  workflowStage: 'coder-implementation',
  checkpointedAt: '2026-07-22T00:00:00.000Z',
};

function failure(
  failureStage: ExecutionFailureStage = 'provider',
  retryDisposition: ExecutionRetryDisposition = 'exhausted',
): ExecutionFailure {
  return {
    ...checkpoint,
    failureStage,
    diagnostic: `${failureStage} failed`,
    retryable: retryDisposition === 'exhausted',
    attempts: [{
      attempt: 1,
      startedAt: checkpoint.checkpointedAt,
      endedAt: '2026-07-22T00:00:01.000Z',
      failureStage,
      diagnostic: `${failureStage} failed`,
      retryable: retryDisposition === 'exhausted',
    }],
    retryDisposition,
  };
}

describe('execution failure durable contracts', () => {
  it('bounds diagnostics and scrubs exact credentials plus POSIX and Windows absolute paths', () => {
    const secret = 'opaque-service-token';
    const diagnostic = sanitizeExecutionDiagnostic(
      new Error(`/Users/operator/private/file C:\\Users\\operator\\private ${secret}\n${'x'.repeat(5_000)}`),
      [secret],
    );

    expect(diagnostic).toHaveLength(EXECUTION_DIAGNOSTIC_MAX_CHARS);
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain('/Users/operator');
    expect(diagnostic).not.toContain('C:\\Users\\operator');
    expect(diagnostic).not.toContain('\n');
  });

  it('attributes orchestration-adjacent failures to the complete checkpoint and summarizes them', () => {
    const result = adjacentExecutionFailure(
      checkpoint,
      new Error('unexpected /private/tmp/operator/worktree failure'),
    );

    expect(result).toMatchObject({
      ...checkpoint,
      failureStage: 'orchestration-adjacent',
      retryable: false,
      retryDisposition: 'not-eligible',
      attempts: [{
        attempt: 1,
        failureStage: 'orchestration-adjacent',
        retryable: false,
      }],
    });
    expect(result.diagnostic).not.toContain('/private/tmp/operator/worktree');
    expect(executionFailureSummary(result)).toContain(
      'coder coder-implementation failed at orchestration-adjacent',
    );
  });

  it.each([
    'artifact-mcp',
    'artifact-contract',
    'environment',
    'spawn',
    'timeout',
    'cancellation',
    'provider',
    'executor-exit',
    'git-stage',
    'git-diff',
    'orchestration-adjacent',
  ] satisfies ExecutionFailureStage[])('accepts the %s failure stage', (stage) => {
    expect(isExecutionFailure(failure(stage))).toBe(true);
  });

  it.each([
    'not-eligible',
    'retrying',
    'exhausted',
    'worktree-changed',
    'cancelled',
  ] satisfies ExecutionRetryDisposition[])('accepts the %s retry disposition', (disposition) => {
    expect(isExecutionFailure(failure('provider', disposition))).toBe(true);
  });

  it('accepts legacy-compatible checkpoints while rejecting malformed durable failure records', () => {
    expect(isExecutionCheckpoint(checkpoint)).toBe(true);
    expect(isExecutionCheckpoint({ ...checkpoint, provider: 'unknown' })).toBe(false);
    expect(isExecutionCheckpoint({ ...checkpoint, taskId: '' })).toBe(false);

    expect(isExecutionFailure({ ...failure(), attempts: [] })).toBe(false);
    expect(isExecutionFailure({
      ...failure(),
      attempts: [failure().attempts[0], failure().attempts[0], failure().attempts[0]],
    })).toBe(false);
    expect(isExecutionFailure({
      ...failure(),
      attempts: [{ ...failure().attempts[0], diagnostic: '' }],
    })).toBe(false);
    expect(isExecutionFailure({ ...failure(), retryDisposition: 'unknown' })).toBe(false);
  });

  it('validates terminal trigger cancellation correlation and disposition WIP SHAs', () => {
    const cancellation = {
      operationId: 'operation-one',
      source: 'cockpit',
      requestedAt: '2026-07-22T00:00:00.000Z',
    } as const;
    expect(isExecutionTerminalTrigger({
      kind: 'cancellation',
      reason: 'cancelled by operator',
      cancellationSource: 'user',
      cancellation,
    })).toBe(true);
    expect(isExecutionTerminalTrigger({
      kind: 'failure',
      reason: 'executor failed',
      executionFailure: failure(),
    })).toBe(true);
    expect(isExecutionTerminalTrigger({
      kind: 'cancellation',
      reason: 'cancelled by operator',
      cancellation: { ...cancellation, source: 'unknown' },
    })).toBe(false);

    expect(isExecutionTerminalDisposition({
      kind: 'parked',
      reason: 'WIP preserved',
      wipSha: 'deadbeef',
    })).toBe(true);
    expect(isExecutionTerminalDisposition({
      kind: 'parked',
      reason: 'WIP preserved',
      wipSha: '../not-a-sha',
    })).toBe(false);
  });

  it('keeps a composed maximum-size failure summary valid for durable triggers', () => {
    const oversized = failure();
    oversized.diagnostic = 'x'.repeat(EXECUTION_DIAGNOSTIC_MAX_CHARS);
    oversized.attempts[0]!.diagnostic = oversized.diagnostic;

    const reason = executionFailureSummary(oversized);
    expect(reason.length).toBeLessThanOrEqual(EXECUTION_DIAGNOSTIC_MAX_CHARS);
    expect(isExecutionTerminalTrigger({
      kind: 'failure',
      reason,
      executionFailure: oversized,
    })).toBe(true);
  });

  it('validates a bounded secondary cleanup diagnostic without replacing the attempt cause', () => {
    const withCleanup = failure();
    withCleanup.attempts[0] = {
      ...withCleanup.attempts[0]!,
      cleanupDiagnostic: 'artifact MCP cleanup failed',
    };
    expect(isExecutionFailure(withCleanup)).toBe(true);
    expect(isExecutionFailure({
      ...withCleanup,
      attempts: [{
        ...withCleanup.attempts[0]!,
        cleanupDiagnostic: 'x'.repeat(EXECUTION_DIAGNOSTIC_MAX_CHARS + 1),
      }],
    })).toBe(false);
  });

  it('accepts bounded artifact-attempt evidence while keeping legacy checkpoints valid', () => {
    const artifactAttempts = [{
      attempt: 1,
      status: 'malformed' as const,
      provider: 'openai' as const,
      progressCount: 3,
      candidateCount: 1,
      diagnostic: 'terminal message had trailing prose',
    }];
    const value = {
      ...failure('artifact-contract', 'exhausted'),
      artifactAttempts,
      attempts: [{
        ...failure().attempts[0]!,
        failureStage: 'artifact-contract' as const,
        artifactAttempts,
      }],
    };

    expect(isExecutionFailure(value)).toBe(true);
    expect(isExecutionCheckpoint({ ...checkpoint, artifactAttempts })).toBe(true);
    expect(isExecutionCheckpoint({
      ...checkpoint,
      artifactAttempts: [{ ...artifactAttempts[0], diagnostic: '' }],
    })).toBe(false);
    expect(isExecutionCheckpoint({
      ...checkpoint,
      artifactAttempts: [{ ...artifactAttempts[0], candidateCount: -1 }],
    })).toBe(false);
  });
});
