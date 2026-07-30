import type { OperationCancellation } from '../cancellation.js';
import type { DispatchProvider } from './dispatch.js';
import { redactSecrets } from '../utils/redact-secrets.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';

export type ExecutionFailureStage =
  | 'artifact-mcp'
  | 'artifact-contract'
  | 'environment'
  | 'spawn'
  | 'timeout'
  | 'cancellation'
  | 'provider'
  | 'executor-exit'
  | 'git-stage'
  | 'git-diff'
  | 'orchestration-adjacent';

export type ExecutionRetryDisposition =
  | 'not-eligible'
  | 'retrying'
  | 'exhausted'
  | 'worktree-changed'
  | 'cancelled';

export type TerminalArtifactStatus =
  | 'captured'
  | 'parsed'
  | 'missing'
  | 'malformed'
  | 'ambiguous'
  | 'non-final'
  | 'rejected';

/** Bounded evidence about one terminal-artifact attempt. Raw model output is
 * intentionally absent: only enough metadata to diagnose the contract crosses
 * a durable boundary. */
export interface ArtifactAttemptEvidence {
  attempt: number;
  status: TerminalArtifactStatus;
  provider: DispatchProvider;
  progressCount: number;
  candidateCount: number;
  diagnostic: string;
}

export interface JudgmentBatchCheckpointMember {
  role: string;
  provider: DispatchProvider;
  format: 'claude' | 'codex';
  model: string;
  workflowStage: string;
}

export interface JudgmentBatchCheckpoint {
  batchId: string;
  members: JudgmentBatchCheckpointMember[];
}

export interface ExecutionCheckpoint {
  taskId: string;
  role: string;
  provider: DispatchProvider;
  format: 'claude' | 'codex';
  model: string;
  workflowStage: string;
  checkpointedAt: string;
  /** Bounded active-role set for a concurrent post-coder judgment batch.
   * Scalar role/model fields remain a stable recovery attribution anchor for
   * historical consumers; this set is the truthful concurrent cursor. */
  judgmentBatch?: JudgmentBatchCheckpoint;
  /** Optional for historical checkpoints and non-artifact stages. */
  artifactAttempts?: ArtifactAttemptEvidence[];
}

export interface ExecutionAttempt {
  attempt: number;
  startedAt: string;
  endedAt: string;
  failureStage: ExecutionFailureStage;
  diagnostic: string;
  retryable: boolean;
  /** Bounded secondary cleanup context; the primary failure remains authoritative. */
  cleanupDiagnostic?: string;
  artifactAttempts?: ArtifactAttemptEvidence[];
}

export interface ExecutionFailure extends ExecutionCheckpoint {
  failureStage: ExecutionFailureStage;
  diagnostic: string;
  retryable: boolean;
  attempts: ExecutionAttempt[];
  retryDisposition: ExecutionRetryDisposition;
  cancellation?: OperationCancellation;
}

export interface ExecutionTerminalTrigger {
  kind: 'success' | 'failure' | 'cancellation';
  reason: string;
  cancellationSource?: 'user' | 'system' | 'quiet-run' | 'max-runtime' | 'shutdown' | 'recovery';
  executionFailure?: ExecutionFailure;
  cancellation?: OperationCancellation;
}

export interface ExecutionTerminalDisposition {
  kind: 'removed' | 'preserved' | 'parked';
  reason: string;
  wipSha?: string;
}

export const EXECUTION_DIAGNOSTIC_MAX_CHARS = 2_000;
const FAILURE_STAGES = new Set<ExecutionFailureStage>([
  'artifact-mcp', 'artifact-contract', 'environment', 'spawn', 'timeout', 'cancellation', 'provider',
  'executor-exit', 'git-stage', 'git-diff', 'orchestration-adjacent',
]);
const RETRY_DISPOSITIONS = new Set<ExecutionRetryDisposition>([
  'not-eligible', 'retrying', 'exhausted', 'worktree-changed', 'cancelled',
]);

export function sanitizeExecutionDiagnostic(
  value: unknown,
  exactValues: readonly string[] = [],
): string {
  const text = value instanceof Error ? value.message : String(value ?? 'unknown execution failure');
  return redactSecrets(scrubGenericAbsolutePaths(scrubAbsolutePaths(text)), exactValues)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, EXECUTION_DIAGNOSTIC_MAX_CHARS) || 'unknown execution failure';
}

function scrubGenericAbsolutePaths(value: string): string {
  return value
    .replace(/\/(?:Users|home|private|tmp|var|opt|etc)\/[^\s"'<>]+/g, '<absolute-path>')
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, '<absolute-path>');
}

export function executionFailureSummary(failure: ExecutionFailure): string {
  return sanitizeExecutionDiagnostic(
    `${failure.role} ${failure.workflowStage} failed at ${failure.failureStage}: ${failure.diagnostic}`,
  );
}

export function durableArtifactAttempts(
  attempts: readonly ArtifactAttemptEvidence[] | undefined,
): ArtifactAttemptEvidence[] | undefined {
  return attempts?.slice(0, 2).map((attempt) => ({
    attempt: attempt.attempt,
    status: attempt.status,
    provider: attempt.provider,
    progressCount: Math.max(0, Math.min(10_000, attempt.progressCount)),
    candidateCount: Math.max(0, Math.min(10_000, attempt.candidateCount)),
    diagnostic: sanitizeExecutionDiagnostic(attempt.diagnostic),
  }));
}

/** Rebuild durable/diagnostic evidence from an explicit allowlist. Runtime
 * excess properties must never cross a persistence or model-facing boundary. */
export function durableExecutionFailure(failure: ExecutionFailure): ExecutionFailure {
  const artifactAttempts = durableArtifactAttempts(failure.artifactAttempts);
  return {
    taskId: failure.taskId,
    role: failure.role,
    provider: failure.provider,
    format: failure.format,
    model: failure.model,
    workflowStage: failure.workflowStage,
    checkpointedAt: failure.checkpointedAt,
    ...(failure.judgmentBatch !== undefined
      ? {
          judgmentBatch: {
            batchId: failure.judgmentBatch.batchId,
            members: failure.judgmentBatch.members.map((member) => ({
              role: member.role,
              provider: member.provider,
              format: member.format,
              model: member.model,
              workflowStage: member.workflowStage,
            })),
          },
        }
      : {}),
    ...(artifactAttempts !== undefined ? { artifactAttempts } : {}),
    failureStage: failure.failureStage,
    diagnostic: sanitizeExecutionDiagnostic(failure.diagnostic),
    retryable: failure.retryable,
    attempts: failure.attempts.slice(0, 2).map((attempt) => {
      const attemptArtifacts = durableArtifactAttempts(attempt.artifactAttempts);
      return {
        attempt: attempt.attempt,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        failureStage: attempt.failureStage,
        diagnostic: sanitizeExecutionDiagnostic(attempt.diagnostic),
        retryable: attempt.retryable,
        ...(attempt.cleanupDiagnostic !== undefined
          ? { cleanupDiagnostic: sanitizeExecutionDiagnostic(attempt.cleanupDiagnostic) }
          : {}),
        ...(attemptArtifacts !== undefined ? { artifactAttempts: attemptArtifacts } : {}),
      };
    }),
    retryDisposition: failure.retryDisposition,
    ...(failure.cancellation !== undefined
      ? {
          cancellation: {
            operationId: failure.cancellation.operationId,
            source: failure.cancellation.source,
            requestedAt: failure.cancellation.requestedAt,
          },
        }
      : {}),
  };
}

export function adjacentExecutionFailure(
  checkpoint: ExecutionCheckpoint,
  diagnostic: unknown,
): ExecutionFailure {
  const safe = sanitizeExecutionDiagnostic(diagnostic);
  const endedAt = new Date().toISOString();
  return {
    ...checkpoint,
    failureStage: 'orchestration-adjacent',
    diagnostic: safe,
    retryable: false,
    attempts: [{
      attempt: 1,
      startedAt: checkpoint.checkpointedAt,
      endedAt,
      failureStage: 'orchestration-adjacent',
      diagnostic: safe,
      retryable: false,
    }],
    retryDisposition: 'not-eligible',
  };
}

export function isExecutionCheckpoint(value: unknown): value is ExecutionCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return boundedString(v['taskId'], 512) && boundedString(v['role'], 128) &&
    (v['provider'] === 'anthropic' || v['provider'] === 'openai') &&
    (v['format'] === 'claude' || v['format'] === 'codex') &&
    boundedString(v['model'], 256) && boundedString(v['workflowStage'], 256) &&
    boundedString(v['checkpointedAt'], 128) &&
    (v['judgmentBatch'] === undefined || isJudgmentBatchCheckpoint(v['judgmentBatch'])) &&
    (v['artifactAttempts'] === undefined || isArtifactAttempts(v['artifactAttempts']));
}

function isJudgmentBatchCheckpoint(value: unknown): value is JudgmentBatchCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!boundedString(v['batchId'], 128) || !Array.isArray(v['members'])) return false;
  if (v['members'].length < 3 || v['members'].length > 4) return false;
  const roles = new Set<string>();
  for (const member of v['members']) {
    if (!member || typeof member !== 'object' || Array.isArray(member)) return false;
    const m = member as Record<string, unknown>;
    if (
      !boundedString(m['role'], 128) ||
      (m['provider'] !== 'anthropic' && m['provider'] !== 'openai') ||
      (m['format'] !== 'claude' && m['format'] !== 'codex') ||
      !boundedString(m['model'], 256) ||
      !boundedString(m['workflowStage'], 256)
    ) {
      return false;
    }
    roles.add(m['role']);
  }
  return roles.size === v['members'].length;
}

export function isExecutionFailure(value: unknown): value is ExecutionFailure {
  if (!isExecutionCheckpoint(value)) return false;
  const v = value as unknown as Record<string, unknown>;
  return FAILURE_STAGES.has(v['failureStage'] as ExecutionFailureStage) &&
    boundedString(v['diagnostic'], EXECUTION_DIAGNOSTIC_MAX_CHARS) &&
    typeof v['retryable'] === 'boolean' && Array.isArray(v['attempts']) &&
    v['attempts'].length >= 1 && v['attempts'].length <= 2 &&
    v['attempts'].every(isExecutionAttempt) &&
    RETRY_DISPOSITIONS.has(v['retryDisposition'] as ExecutionRetryDisposition);
}

export function isExecutionTerminalTrigger(value: unknown): value is ExecutionTerminalTrigger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (v['kind'] === 'success' || v['kind'] === 'failure' || v['kind'] === 'cancellation') &&
    boundedString(v['reason'], EXECUTION_DIAGNOSTIC_MAX_CHARS) &&
    (v['executionFailure'] === undefined || isExecutionFailure(v['executionFailure'])) &&
    (v['cancellationSource'] === undefined || [
      'user', 'system', 'quiet-run', 'max-runtime', 'shutdown', 'recovery',
    ].includes(String(v['cancellationSource']))) &&
    (v['cancellation'] === undefined || isOperationCancellation(v['cancellation']));
}

export function isExecutionTerminalDisposition(value: unknown): value is ExecutionTerminalDisposition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (v['kind'] === 'removed' || v['kind'] === 'preserved' || v['kind'] === 'parked') &&
    boundedString(v['reason'], EXECUTION_DIAGNOSTIC_MAX_CHARS) &&
    (v['wipSha'] === undefined || (typeof v['wipSha'] === 'string' && /^[0-9a-f]{7,64}$/i.test(v['wipSha'])));
}

function isExecutionAttempt(value: unknown): value is ExecutionAttempt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Number.isInteger(v['attempt']) && Number(v['attempt']) >= 1 && Number(v['attempt']) <= 2 &&
    boundedString(v['startedAt'], 128) && boundedString(v['endedAt'], 128) &&
    FAILURE_STAGES.has(v['failureStage'] as ExecutionFailureStage) &&
    boundedString(v['diagnostic'], EXECUTION_DIAGNOSTIC_MAX_CHARS) &&
    (v['cleanupDiagnostic'] === undefined ||
      boundedString(v['cleanupDiagnostic'], EXECUTION_DIAGNOSTIC_MAX_CHARS)) &&
    (v['artifactAttempts'] === undefined || isArtifactAttempts(v['artifactAttempts'])) &&
    typeof v['retryable'] === 'boolean';
}

function isArtifactAttempts(value: unknown): value is ArtifactAttemptEvidence[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return false;
  return value.every((attempt, index) => {
    if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) return false;
    const v = attempt as Record<string, unknown>;
    return v['attempt'] === index + 1 &&
      [
        'captured', 'parsed', 'missing', 'malformed', 'ambiguous', 'non-final', 'rejected',
      ].includes(String(v['status'])) &&
      (v['provider'] === 'anthropic' || v['provider'] === 'openai') &&
      Number.isInteger(v['progressCount']) && Number(v['progressCount']) >= 0 &&
      Number(v['progressCount']) <= 10_000 &&
      Number.isInteger(v['candidateCount']) && Number(v['candidateCount']) >= 0 &&
      Number(v['candidateCount']) <= 10_000 &&
      boundedString(v['diagnostic'], EXECUTION_DIAGNOSTIC_MAX_CHARS);
  });
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isOperationCancellation(value: unknown): value is OperationCancellation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return boundedString(v['operationId'], 512) &&
    (v['source'] === 'telegram' || v['source'] === 'cockpit' || v['source'] === 'internal') &&
    boundedString(v['requestedAt'], 128);
}
