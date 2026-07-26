import type { OperationCancellation } from '../cancellation.js';
import type { DispatchProvider } from './dispatch.js';
import { redactSecrets } from '../utils/redact-secrets.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';

export type ExecutionFailureStage =
  | 'artifact-mcp'
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

export interface ExecutionCheckpoint {
  taskId: string;
  role: string;
  provider: DispatchProvider;
  format: 'claude' | 'codex';
  model: string;
  workflowStage: string;
  checkpointedAt: string;
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
  'artifact-mcp', 'environment', 'spawn', 'timeout', 'cancellation', 'provider',
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
    boundedString(v['checkpointedAt'], 128);
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
    typeof v['retryable'] === 'boolean';
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
