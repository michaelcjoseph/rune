import type { DispatchProvider } from './dispatch.js';
import { sanitizeExecutionDiagnostic } from './execution-failure.js';
import {
  durableInvariantChecklistEvidence,
  type InvariantChecklistEvidence,
} from './invariant-review.js';

export const REVIEW_BATCH_STATE_VERSION = 1 as const;
export const REVIEW_BATCH_DIAGNOSTIC_MAX_CHARS = 500;
export const REVIEW_BATCH_MAX_ATTEMPTS = 2;

export type ReviewBatchRole = 'reviewer' | 'tech-lead' | 'designer' | 'security';
export type ReviewBatchEligibleRole = Exclude<ReviewBatchRole, 'designer'>;
export type ReviewBatchRoleStatus =
  | 'pending'
  | 'running'
  | 'verdict'
  | 'operational-failure'
  | 'cancelled';
export type ReviewBatchFailureCategory =
  | 'interrupted'
  | 'provider'
  | 'timeout'
  | 'executor-exit'
  | 'checkpoint'
  | 'invalid-verdict'
  | 'unknown';
export type ReviewBatchCancellationReason = 'quorum-satisfied' | 'objection' | 'external';

export interface ReviewBatchBinding {
  model: string;
  provider: DispatchProvider;
  format?: 'claude' | 'codex';
}

export interface ReviewBatchVerdictEvidence {
  outcome: 'pass' | 'pass-with-warnings' | 'fail';
  findingCount: number;
  summary?: string;
  /** Normalized role verdict needed to resume without re-running a completed
   * review. This is role output only (never the prompt) and is size-bounded by
   * the parser. Optional for snapshots written before v1 gained reuse detail. */
  normalizedVerdict?: Record<string, unknown>;
}

export interface ReviewBatchAttemptState extends ReviewBatchBinding {
  attemptId: string;
  attempt: number;
  status: ReviewBatchRoleStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  failureCategory?: ReviewBatchFailureCategory;
  diagnostic?: string;
  retryEligible: boolean;
  verdict?: ReviewBatchVerdictEvidence;
  cancellationReason?: ReviewBatchCancellationReason;
  cancellation?: {
    operationId: string;
    source: 'telegram' | 'cockpit' | 'internal';
    requestedAt: string;
  };
}

export interface ReviewBatchRoleState {
  role: ReviewBatchRole;
  quorumEligible: boolean;
  required: boolean;
  status: ReviewBatchRoleStatus;
  attemptsConsumed: number;
  retryEligible: boolean;
  attempts: ReviewBatchAttemptState[];
}

export interface ReviewBatchResumeContext {
  artifactPass: 'first-pass' | 'coder-retry' | 'closeout-retry';
  tests: string[] | string;
  qa: { kind: 'tests-written'; testIds: string[] } |
    { kind: 'no-code-test-rationale'; rationale: string };
  coderHandoffNotes: string[];
  accumulatedHandoffNotes?: string[];
  testIntentRepair?: {
    outcome: 'repaired' | 'not-repaired';
    reason?: string;
    testIds?: string[];
  };
  adjudications?: Array<Record<string, unknown>>;
  invariantChecklistBlock?: string;
  invariantChecklist?: InvariantChecklistEvidence;
  findingsLedger?: Array<Record<string, unknown>>;
  coderSelfReviews?: Array<Record<string, unknown>>;
  downgradedFindings?: Array<Record<string, unknown>>;
  seenSplitSignatures?: string[];
  explicitNonReversibleFindingIds?: string[];
  previousMaxOpenSeverity?: 'low' | 'medium' | 'high' | 'critical';
  flatMaxOpenSeverityRounds?: number;
}

export interface ReviewBatchState {
  version: typeof REVIEW_BATCH_STATE_VERSION;
  batchId: string;
  taskId: string;
  taskBaseTree: string;
  currentReviewTree: string;
  canonicalHash: string;
  round: number;
  workflowAttempt: number;
  createdAt: string;
  updatedAt: string;
  quorum: {
    status: 'pending' | 'satisfied' | 'failed' | 'objected';
    satisfyingRole?: ReviewBatchEligibleRole;
    objectingRole?: ReviewBatchRole;
  };
  roles: ReviewBatchRoleState[];
  resumeContext?: ReviewBatchResumeContext;
}

export type ReviewBatchResumeFailureCategory =
  | 'review-surface-drift'
  | 'task-mismatch'
  | 'invalid-snapshot';

export class ReviewBatchResumeError extends Error {
  readonly category: ReviewBatchResumeFailureCategory;

  constructor(category: ReviewBatchResumeFailureCategory, message: string) {
    super(message);
    this.name = 'ReviewBatchResumeError';
    this.category = category;
  }
}

export interface ReviewBatchResumeIdentity {
  taskId: string;
  baseTree: string;
  currentTree: string;
  canonicalHash: string;
  interruptedAt: string;
}

export function serializeReviewBatchState(state: ReviewBatchState): unknown {
  const parsed = parseReviewBatchState(state);
  if (parsed === undefined) {
    throw new TypeError('review batch state is invalid');
  }
  return structuredClone(parsed);
}

export function parseReviewBatchState(value: unknown): ReviewBatchState | undefined {
  if (!record(value) || serializedLength(value) > 256_000 ||
      value['version'] !== REVIEW_BATCH_STATE_VERSION) return undefined;
  const quorum = value['quorum'];
  const roles = value['roles'];
  if (
    !text(value['batchId'], 128) ||
    !text(value['taskId'], 512) ||
    !text(value['taskBaseTree'], 128) ||
    !text(value['currentReviewTree'], 128) ||
    !text(value['canonicalHash'], 256) ||
    !positiveInt(value['round']) ||
    !positiveInt(value['workflowAttempt']) ||
    !timestamp(value['createdAt']) ||
    !timestamp(value['updatedAt']) ||
    !record(quorum) ||
    !['pending', 'satisfied', 'failed', 'objected'].includes(String(quorum['status'])) ||
    !Array.isArray(roles) || roles.length < 2 || roles.length > 4
  ) return undefined;

  const parsedRoles = roles.map(parseRoleState);
  if (parsedRoles.some((role) => role === undefined)) return undefined;
  const normalizedRoles = parsedRoles as ReviewBatchRoleState[];
  if (new Set(normalizedRoles.map(({ role }) => role)).size !== normalizedRoles.length) {
    return undefined;
  }
  if (normalizedRoles.some(({ role, quorumEligible, required }) =>
    quorumEligible !== (role !== 'designer') || required !== (role === 'designer'))) {
    return undefined;
  }
  const satisfyingRole = quorum['satisfyingRole'];
  const objectingRole = quorum['objectingRole'];
  if (
    (satisfyingRole !== undefined && !eligibleRole(satisfyingRole)) ||
    (objectingRole !== undefined && !batchRole(objectingRole)) ||
    (quorum['status'] === 'satisfied' &&
      (satisfyingRole === undefined || objectingRole !== undefined)) ||
    (quorum['status'] === 'objected' &&
      (objectingRole === undefined || satisfyingRole !== undefined)) ||
    ((quorum['status'] === 'pending' || quorum['status'] === 'failed') &&
      (satisfyingRole !== undefined || objectingRole !== undefined))
  ) return undefined;
  if (satisfyingRole !== undefined) {
    const role = normalizedRoles.find((item) => item.role === satisfyingRole);
    const outcome = role?.attempts.at(-1)?.verdict?.outcome;
    if (role?.status !== 'verdict' || (outcome !== 'pass' && outcome !== 'pass-with-warnings')) {
      return undefined;
    }
  }
  if (objectingRole !== undefined) {
    const role = normalizedRoles.find((item) => item.role === objectingRole);
    if (role?.status !== 'verdict' || role.attempts.at(-1)?.verdict?.outcome !== 'fail') {
      return undefined;
    }
  }

  const resumeContext = value['resumeContext'] === undefined
    ? undefined
    : parseResumeContext(value['resumeContext']);
  if (value['resumeContext'] !== undefined && resumeContext === undefined) return undefined;
  const securityPresent = normalizedRoles.some(({ role }) => role === 'security');
  if (securityPresent && (resumeContext?.invariantChecklist === undefined ||
      resumeContext.invariantChecklistBlock === undefined)) return undefined;
  if ((resumeContext?.invariantChecklist !== undefined ||
      resumeContext?.invariantChecklistBlock !== undefined) &&
      resumeContext?.invariantChecklist?.canonicalBlock !==
        resumeContext?.invariantChecklistBlock) return undefined;

  return {
    version: REVIEW_BATCH_STATE_VERSION,
    batchId: value['batchId'] as string,
    taskId: value['taskId'] as string,
    taskBaseTree: value['taskBaseTree'] as string,
    currentReviewTree: value['currentReviewTree'] as string,
    canonicalHash: value['canonicalHash'] as string,
    round: value['round'] as number,
    workflowAttempt: value['workflowAttempt'] as number,
    createdAt: value['createdAt'] as string,
    updatedAt: value['updatedAt'] as string,
    quorum: {
      status: quorum['status'] as ReviewBatchState['quorum']['status'],
      ...(satisfyingRole !== undefined
        ? { satisfyingRole: satisfyingRole as ReviewBatchEligibleRole }
        : {}),
      ...(objectingRole !== undefined ? { objectingRole: objectingRole as ReviewBatchRole } : {}),
    },
    roles: normalizedRoles,
    ...(resumeContext !== undefined ? { resumeContext } : {}),
  };
}

export function resumeReviewBatchState(
  state: ReviewBatchState,
  identity: ReviewBatchResumeIdentity,
): ReviewBatchState {
  const parsed = parseReviewBatchState(state);
  if (parsed === undefined) {
    throw new ReviewBatchResumeError('invalid-snapshot', 'durable review batch is invalid');
  }
  if (parsed.taskId !== identity.taskId) {
    throw new ReviewBatchResumeError('task-mismatch', 'durable review batch belongs to another task');
  }
  if (
    parsed.taskBaseTree !== identity.baseTree ||
    parsed.currentReviewTree !== identity.currentTree ||
    parsed.canonicalHash !== identity.canonicalHash
  ) {
    throw new ReviewBatchResumeError(
      'review-surface-drift',
      'durable review batch does not match the canonical review surface',
    );
  }

  const roles = parsed.roles.map((role) => {
    if (role.status !== 'running') return role;
    const attempts = role.attempts.map((attempt) => {
      if (attempt.status !== 'running') return attempt;
      const started = attempt.startedAt === undefined ? NaN : Date.parse(attempt.startedAt);
      const ended = Date.parse(identity.interruptedAt);
      return {
        ...attempt,
        status: 'operational-failure' as const,
        endedAt: identity.interruptedAt,
        durationMs: Number.isFinite(started) && Number.isFinite(ended)
          ? Math.max(0, ended - started)
          : 0,
        failureCategory: 'interrupted' as const,
        diagnostic: 'review attempt interrupted by process restart',
        retryEligible: attempt.attempt < REVIEW_BATCH_MAX_ATTEMPTS,
      };
    });
    return {
      ...role,
      status: 'operational-failure' as const,
      retryEligible: attempts.length < REVIEW_BATCH_MAX_ATTEMPTS,
      attempts,
    };
  });
  return {
    ...parsed,
    updatedAt: identity.interruptedAt,
    roles,
  };
}

function parseRoleState(value: unknown): ReviewBatchRoleState | undefined {
  if (!record(value) || !batchRole(value['role']) || typeof value['quorumEligible'] !== 'boolean' ||
      typeof value['required'] !== 'boolean' || !roleStatus(value['status']) ||
      !nonnegativeInt(value['attemptsConsumed']) || typeof value['retryEligible'] !== 'boolean' ||
      !Array.isArray(value['attempts']) || value['attempts'].length > REVIEW_BATCH_MAX_ATTEMPTS) {
    return undefined;
  }
  const attempts = value['attempts'].map(parseAttemptState);
  if (attempts.some((attempt) => attempt === undefined)) return undefined;
  if (value['attemptsConsumed'] !== attempts.length) return undefined;
  const normalizedAttempts = attempts as ReviewBatchAttemptState[];
  if (normalizedAttempts.some((attempt, index) => attempt.attempt !== index + 1)) return undefined;
  if (normalizedAttempts.length === 0) {
    if (value['status'] !== 'pending') return undefined;
  } else {
    const latest = normalizedAttempts.at(-1)!;
    if (value['status'] === 'pending' || value['status'] !== latest.status) return undefined;
    if (normalizedAttempts.slice(0, -1).some((attempt) =>
      attempt.status !== 'operational-failure')) return undefined;
  }
  const retryEligible = value['role'] !== 'designer' &&
    (value['status'] === 'pending' || value['status'] === 'running' ||
      value['status'] === 'operational-failure') &&
    normalizedAttempts.length < REVIEW_BATCH_MAX_ATTEMPTS;
  if (value['retryEligible'] !== retryEligible) return undefined;
  return {
    role: value['role'],
    quorumEligible: value['quorumEligible'],
    required: value['required'],
    status: value['status'],
    attemptsConsumed: value['attemptsConsumed'],
    retryEligible: value['retryEligible'],
    attempts: normalizedAttempts,
  };
}

function parseAttemptState(value: unknown): ReviewBatchAttemptState | undefined {
  if (!record(value) || Object.keys(value).some((key) => ![
    'attemptId', 'attempt', 'status', 'model', 'provider', 'format', 'retryEligible',
    'startedAt', 'endedAt', 'durationMs', 'failureCategory', 'diagnostic', 'verdict',
    'cancellationReason', 'cancellation',
  ].includes(key)) || !text(value['attemptId'], 128) || !positiveInt(value['attempt']) ||
      Number(value['attempt']) > REVIEW_BATCH_MAX_ATTEMPTS || !roleStatus(value['status']) ||
      !text(value['model'], 256) || !provider(value['provider']) ||
      (value['format'] !== undefined && value['format'] !== 'claude' && value['format'] !== 'codex') ||
      typeof value['retryEligible'] !== 'boolean' ||
      (value['startedAt'] !== undefined && !timestamp(value['startedAt'])) ||
      (value['endedAt'] !== undefined && !timestamp(value['endedAt'])) ||
      (value['durationMs'] !== undefined && !nonnegativeInt(value['durationMs'])) ||
      (value['failureCategory'] !== undefined && !failureCategory(value['failureCategory'])) ||
      (value['diagnostic'] !== undefined && !text(value['diagnostic'], REVIEW_BATCH_DIAGNOSTIC_MAX_CHARS)) ||
      (value['cancellationReason'] !== undefined && !cancellationReason(value['cancellationReason'])) ||
      (value['cancellation'] !== undefined && !validCancellation(value['cancellation']))) {
    return undefined;
  }
  const verdict = value['verdict'] === undefined ? undefined : parseVerdict(value['verdict']);
  if (value['verdict'] !== undefined && verdict === undefined) return undefined;
  if (value['status'] === 'pending' || value['startedAt'] === undefined) return undefined;
  const terminal = value['status'] !== 'running';
  if (terminal !== (value['endedAt'] !== undefined && value['durationMs'] !== undefined)) {
    return undefined;
  }
  if ((value['status'] === 'verdict') !== (verdict !== undefined)) return undefined;
  if ((value['status'] === 'operational-failure') !== (value['failureCategory'] !== undefined)) {
    return undefined;
  }
  if ((value['status'] === 'cancelled') !== (value['cancellationReason'] !== undefined)) {
    return undefined;
  }
  if ((value['cancellationReason'] === 'external') !== (value['cancellation'] !== undefined)) {
    return undefined;
  }
  return {
    attemptId: value['attemptId'],
    attempt: value['attempt'],
    status: value['status'],
    model: value['model'],
    provider: value['provider'],
    ...(value['format'] !== undefined ? { format: value['format'] as 'claude' | 'codex' } : {}),
    retryEligible: value['retryEligible'],
    ...(value['startedAt'] !== undefined ? { startedAt: value['startedAt'] as string } : {}),
    ...(value['endedAt'] !== undefined ? { endedAt: value['endedAt'] as string } : {}),
    ...(value['durationMs'] !== undefined ? { durationMs: value['durationMs'] as number } : {}),
    ...(value['failureCategory'] !== undefined
      ? { failureCategory: value['failureCategory'] as ReviewBatchFailureCategory }
      : {}),
    ...(value['diagnostic'] !== undefined
      ? { diagnostic: boundedDiagnostic(value['diagnostic']) }
      : {}),
    ...(verdict !== undefined ? { verdict } : {}),
    ...(value['cancellationReason'] !== undefined
      ? { cancellationReason: value['cancellationReason'] as ReviewBatchCancellationReason }
      : {}),
    ...(value['cancellation'] !== undefined
      ? {
          cancellation: structuredClone(value['cancellation']) as ReviewBatchAttemptState['cancellation'],
        }
      : {}),
  };
}

function validCancellation(value: unknown): boolean {
  return record(value) && Object.keys(value).every((key) =>
    ['operationId', 'source', 'requestedAt'].includes(key)) &&
    text(value['operationId'], 256) &&
    (value['source'] === 'telegram' || value['source'] === 'cockpit' || value['source'] === 'internal') &&
    timestamp(value['requestedAt']);
}

function parseVerdict(value: unknown): ReviewBatchVerdictEvidence | undefined {
  if (!record(value) || !['pass', 'pass-with-warnings', 'fail'].includes(String(value['outcome'])) ||
      !nonnegativeInt(value['findingCount']) || Number(value['findingCount']) > 1_000 ||
      (value['summary'] !== undefined && !text(value['summary'], REVIEW_BATCH_DIAGNOSTIC_MAX_CHARS))) {
    return undefined;
  }
  const normalizedVerdict = value['normalizedVerdict'];
  if (normalizedVerdict !== undefined) {
    if (!record(normalizedVerdict) || normalizedVerdict['outcome'] !== value['outcome']) return undefined;
    const allowedKeys = new Set([
      'outcome', 'findings', 'notes', 'suggestedChange', 'objections', 'verifiedFindings',
    ]);
    if (Object.keys(normalizedVerdict).some((key) => !allowedKeys.has(key))) return undefined;
    const findings = normalizedVerdict['findings'];
    if (!Array.isArray(findings) || findings.length !== value['findingCount'] ||
        !findings.every(validNormalizedFinding) ||
        (normalizedVerdict['notes'] !== undefined &&
          !boundedString(normalizedVerdict['notes'], 2_000)) ||
        (normalizedVerdict['suggestedChange'] !== undefined &&
          !boundedString(normalizedVerdict['suggestedChange'], 2_000)) ||
        !validNormalizedObjections(normalizedVerdict['objections'], findings) ||
        !validFindingVerifications(normalizedVerdict['verifiedFindings'])) return undefined;
    if (serializedLength(normalizedVerdict) > 32_000) return undefined;
  }
  return {
    outcome: value['outcome'] as ReviewBatchVerdictEvidence['outcome'],
    findingCount: value['findingCount'] as number,
    ...(value['summary'] !== undefined ? { summary: boundedDiagnostic(value['summary']) } : {}),
    ...(normalizedVerdict !== undefined
      ? { normalizedVerdict: structuredClone(normalizedVerdict) }
      : {}),
  };
}

function validNormalizedObjections(value: unknown, findings: unknown[]): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length !== findings.length ||
      !value.every(validNormalizedFinding)) return false;
  try {
    return JSON.stringify(value) === JSON.stringify(findings);
  } catch {
    return false;
  }
}

function validFindingVerifications(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= 128 && value.every((item) =>
    record(item) && Object.keys(item).every((key) => ['id', 'status', 'notes'].includes(key)) &&
    text(item['id'], 512) && ['open', 'resolved', 'regressed'].includes(String(item['status'])) &&
    boundedString(item['notes'], 2_000));
}

function parseResumeContext(value: unknown): ReviewBatchResumeContext | undefined {
  if (!record(value) || Object.keys(value).some((key) => ![
    'artifactPass', 'tests', 'qa', 'coderHandoffNotes', 'invariantChecklistBlock',
    'invariantChecklist', 'findingsLedger', 'coderSelfReviews', 'downgradedFindings',
    'accumulatedHandoffNotes', 'testIntentRepair', 'adjudications',
    'seenSplitSignatures', 'explicitNonReversibleFindingIds',
    'previousMaxOpenSeverity', 'flatMaxOpenSeverityRounds',
  ].includes(key)) || !['first-pass', 'coder-retry', 'closeout-retry'].includes(String(value['artifactPass'])) ||
      !(text(value['tests'], 32_000) || boundedStringArray(value['tests'], 256, 512, 32_000)) ||
      !Array.isArray(value['coderHandoffNotes']) ||
      value['coderHandoffNotes'].length > 64 ||
      !value['coderHandoffNotes'].every((item) => text(item, 2_000)) ||
      serializedLength(value['coderHandoffNotes']) > 32_000 ||
      !optionalBoundedStringArray(value['accumulatedHandoffNotes'], 256, 2_000, 64_000) ||
      (value['testIntentRepair'] !== undefined && !validTestIntentRepair(value['testIntentRepair'])) ||
      !optionalRecordArray(value['adjudications'], 8, 64_000, validAdjudicationRecord) ||
      !record(value['qa']) ||
      (value['invariantChecklistBlock'] !== undefined &&
        !text(value['invariantChecklistBlock'], 16_000)) ||
      !optionalRecordArray(value['findingsLedger'], 32, 64_000, validLedgerFinding) ||
      !optionalRecordArray(value['coderSelfReviews'], 8, 64_000, validCoderSelfReview) ||
      !optionalRecordArray(value['downgradedFindings'], 32, 64_000, validDowngradedFinding) ||
      !optionalBoundedStringArray(value['seenSplitSignatures'], 128, 512, 32_000) ||
      !optionalBoundedStringArray(value['explicitNonReversibleFindingIds'], 128, 512, 32_000) ||
      (value['previousMaxOpenSeverity'] !== undefined &&
        !['low', 'medium', 'high', 'critical'].includes(String(value['previousMaxOpenSeverity']))) ||
      (value['flatMaxOpenSeverityRounds'] !== undefined &&
        (!nonnegativeInt(value['flatMaxOpenSeverityRounds']) ||
          Number(value['flatMaxOpenSeverityRounds']) > 100))) return undefined;
  const invariantChecklist = value['invariantChecklist'] === undefined
    ? undefined
    : durableInvariantChecklistEvidence(value['invariantChecklist'] as InvariantChecklistEvidence);
  if (value['invariantChecklist'] !== undefined && invariantChecklist === undefined) return undefined;
  const qa = value['qa'];
  if (qa['kind'] === 'tests-written') {
    if (!boundedStringArray(qa['testIds'], 256, 512, 32_000)) return undefined;
  } else if (qa['kind'] === 'no-code-test-rationale') {
    if (!text(qa['rationale'], 2_000)) return undefined;
  } else return undefined;
  return {
    artifactPass: value['artifactPass'] as ReviewBatchResumeContext['artifactPass'],
    tests: structuredClone(value['tests']) as string[] | string,
    qa: structuredClone(qa) as ReviewBatchResumeContext['qa'],
    coderHandoffNotes: [...value['coderHandoffNotes']] as string[],
    ...(value['accumulatedHandoffNotes'] !== undefined
      ? { accumulatedHandoffNotes: [...(value['accumulatedHandoffNotes'] as string[])] }
      : {}),
    ...(value['testIntentRepair'] !== undefined
      ? {
          testIntentRepair: structuredClone(value['testIntentRepair']) as NonNullable<
            ReviewBatchResumeContext['testIntentRepair']
          >,
        }
      : {}),
    ...(value['adjudications'] !== undefined
      ? { adjudications: structuredClone(value['adjudications']) as Array<Record<string, unknown>> }
      : {}),
    ...(value['invariantChecklistBlock'] !== undefined
      ? { invariantChecklistBlock: value['invariantChecklistBlock'] as string }
      : {}),
    ...(invariantChecklist !== undefined ? { invariantChecklist } : {}),
    ...(value['findingsLedger'] !== undefined
      ? { findingsLedger: structuredClone(value['findingsLedger']) as Array<Record<string, unknown>> }
      : {}),
    ...(value['coderSelfReviews'] !== undefined
      ? {
          coderSelfReviews: (value['coderSelfReviews'] as Array<Record<string, unknown>>)
            .map((review) => ({
              ...structuredClone(review),
              ...(Array.isArray(review['artifactAttempts'])
                ? {
                    artifactAttempts: (review['artifactAttempts'] as Array<Record<string, unknown>>)
                      .map((attempt) => ({
                        ...structuredClone(attempt),
                        diagnostic: boundedDiagnostic(attempt['diagnostic']),
                      })),
                  }
                : {}),
            })),
        }
      : {}),
    ...(value['downgradedFindings'] !== undefined
      ? { downgradedFindings: structuredClone(value['downgradedFindings']) as Array<Record<string, unknown>> }
      : {}),
    ...(value['seenSplitSignatures'] !== undefined
      ? { seenSplitSignatures: [...(value['seenSplitSignatures'] as string[])] }
      : {}),
    ...(value['explicitNonReversibleFindingIds'] !== undefined
      ? { explicitNonReversibleFindingIds: [...(value['explicitNonReversibleFindingIds'] as string[])] }
      : {}),
    ...(value['previousMaxOpenSeverity'] !== undefined
      ? { previousMaxOpenSeverity: value['previousMaxOpenSeverity'] as ReviewBatchResumeContext['previousMaxOpenSeverity'] }
      : {}),
    ...(value['flatMaxOpenSeverityRounds'] !== undefined
      ? { flatMaxOpenSeverityRounds: value['flatMaxOpenSeverityRounds'] as number }
      : {}),
  };
}

function validTestIntentRepair(value: unknown): boolean {
  if (!record(value) || Object.keys(value).some((key) =>
    !['outcome', 'reason', 'testIds'].includes(key))) return false;
  if (value['outcome'] === 'repaired') {
    return value['reason'] === undefined &&
      boundedStringArray(value['testIds'], 256, 512, 32_000);
  }
  if (value['outcome'] === 'not-repaired') {
    return text(value['reason'], 2_000) && value['testIds'] === undefined;
  }
  return false;
}

function validAdjudicationRecord(value: unknown): boolean {
  if (!record(value) || Object.keys(value).some((key) => ![
    'status', 'round', 'dissentingRole', 'concurringRole', 'signature', 'escalated',
    'executedModelAlias', 'executedProvider', 'upheld', 'rationale', 'failure',
  ].includes(key)) || !positiveInt(value['round']) || Number(value['round']) > 100 ||
      !reviewSource(value['dissentingRole']) || !reviewSource(value['concurringRole']) ||
      value['dissentingRole'] === value['concurringRole'] || !text(value['signature'], 2_000) ||
      typeof value['escalated'] !== 'boolean' ||
      (value['executedModelAlias'] !== undefined && !text(value['executedModelAlias'], 512)) ||
      (value['executedProvider'] !== undefined &&
        value['executedProvider'] !== 'anthropic' && value['executedProvider'] !== 'openai')) {
    return false;
  }
  if (value['status'] === 'ruling') {
    return (value['upheld'] === 'pass' || value['upheld'] === 'fail') &&
      text(value['rationale'], 2_000) && value['failure'] === undefined;
  }
  return value['status'] === 'operational-failure' && value['upheld'] === undefined &&
    value['rationale'] === undefined && validAdjudicationFailure(value['failure']);
}

function validAdjudicationFailure(value: unknown): boolean {
  const diagnosticCodes = [
    'missing-fence', 'invalid-fence', 'invalid-json', 'unsupported-verdict',
    'blank-rationale', 'missing-finding', 'malformed-finding',
    'incomplete-finding-evidence', 'provider-failure',
  ];
  return record(value) && Object.keys(value).every((key) => [
    'code', 'cause', 'attempts', 'executedModelAlias', 'executedProvider',
  ].includes(key)) && value['code'] === 'adjudication-output-invalid' &&
    ['invalid-artifact', 'provider-failure', 'unavailable'].includes(String(value['cause'])) &&
    Array.isArray(value['attempts']) && value['attempts'].length >= 1 &&
    value['attempts'].length <= 2 && value['attempts'].every((attempt) =>
      record(attempt) && Object.keys(attempt).every((key) => ['attempt', 'code'].includes(key)) &&
      (attempt['attempt'] === 1 || attempt['attempt'] === 2) &&
      diagnosticCodes.includes(String(attempt['code']))) &&
    (value['executedModelAlias'] === undefined || text(value['executedModelAlias'], 512)) &&
    (value['executedProvider'] === undefined || value['executedProvider'] === 'anthropic' ||
      value['executedProvider'] === 'openai');
}

function validNormalizedFinding(value: unknown): boolean {
  if (!record(value) || Object.keys(value).some((key) => ![
    'class',
    'severity',
    'location',
    'rationale',
    'suggestedChange',
    'reversible',
  ].includes(key)) || !['security', 'privacy', 'data-integrity', 'concurrency', 'outbound', 'cost-perf']
    .includes(String(value['class'])) ||
      !['low', 'medium', 'high', 'critical'].includes(String(value['severity'])) ||
      !text(value['location'], 2_000) || !text(value['rationale'], 4_000) ||
      (value['suggestedChange'] !== undefined && !text(value['suggestedChange'], 4_000)) ||
      (value['reversible'] !== undefined && typeof value['reversible'] !== 'boolean')) return false;
  return true;
}

const FINDING_KEYS = [
  'class', 'severity', 'location', 'rationale', 'suggestedChange', 'reversible',
] as const;

function validLedgerFinding(value: unknown): boolean {
  return record(value) && Object.keys(value).every((key) => [
    ...FINDING_KEYS, 'id', 'sourceGate', 'raisedRound', 'status',
  ].includes(key as never)) && validResumeFinding(Object.fromEntries(
    FINDING_KEYS.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
  )) && text(value['id'], 512) && reviewSource(value['sourceGate']) &&
    positiveInt(value['raisedRound']) &&
    ['open', 'resolved', 'regressed'].includes(String(value['status'])) &&
    typeof value['reversible'] === 'boolean';
}

function validDowngradedFinding(value: unknown): boolean {
  return record(value) && Object.keys(value).every((key) =>
    ['finding', 'sourceGate', 'round', 'gaps', 'reason', 'rePrompted'].includes(key)) &&
    validResumeFinding(value['finding']) && reviewSource(value['sourceGate']) &&
    positiveInt(value['round']) && Array.isArray(value['gaps']) && value['gaps'].length <= 2 &&
    value['gaps'].every((gap) => gap === 'location' || gap === 'failure-scenario') &&
    text(value['reason'], 2_000) && typeof value['rePrompted'] === 'boolean';
}

function validResumeFinding(value: unknown): boolean {
  return record(value) && Object.keys(value).every((key) => FINDING_KEYS.includes(key as never)) &&
    ['security', 'privacy', 'data-integrity', 'concurrency', 'outbound', 'cost-perf']
      .includes(String(value['class'])) &&
    ['low', 'medium', 'high', 'critical'].includes(String(value['severity'])) &&
    typeof value['location'] === 'string' && value['location'].length <= 2_000 &&
    text(value['rationale'], 4_000) &&
    (value['suggestedChange'] === undefined || text(value['suggestedChange'], 4_000)) &&
    (value['reversible'] === undefined || typeof value['reversible'] === 'boolean');
}

function validCoderSelfReview(value: unknown): boolean {
  if (!record(value) || Object.keys(value).some((key) => ![
    'round', 'outcome', 'notes', 'canonicalHash', 'taskBaseTree',
    'currentReviewTree', 'changedPaths', 'artifactAttempts',
  ].includes(key)) || !positiveInt(value['round']) ||
      !['confirmed', 'revised'].includes(String(value['outcome'])) ||
      !text(value['notes'], 2_000) || !text(value['canonicalHash'], 256) ||
      (value['taskBaseTree'] !== undefined && !text(value['taskBaseTree'], 128)) ||
      (value['currentReviewTree'] !== undefined && !text(value['currentReviewTree'], 128)) ||
      !boundedStringArray(value['changedPaths'], 200, 512, 64_000)) return false;
  if (value['artifactAttempts'] === undefined) return true;
  return Array.isArray(value['artifactAttempts']) && value['artifactAttempts'].length <= 8 &&
    value['artifactAttempts'].every((attempt) => record(attempt) &&
      Object.keys(attempt).every((key) => [
        'attempt', 'status', 'provider', 'progressCount', 'candidateCount', 'diagnostic',
      ].includes(key)) && positiveInt(attempt['attempt']) &&
      ['captured', 'parsed', 'missing', 'malformed', 'ambiguous', 'non-final', 'rejected']
        .includes(String(attempt['status'])) &&
      (attempt['provider'] === 'anthropic' || attempt['provider'] === 'openai') &&
      nonnegativeInt(attempt['progressCount']) && nonnegativeInt(attempt['candidateCount']) &&
      text(attempt['diagnostic'], REVIEW_BATCH_DIAGNOSTIC_MAX_CHARS));
}

function reviewSource(value: unknown): boolean {
  return value === 'reviewer' || value === 'tech-lead' ||
    value === 'designer' || value === 'security';
}

function boundedStringArray(
  value: unknown,
  maxItems: number,
  maxItemChars: number,
  maxChars: number,
): value is string[] {
  return Array.isArray(value) && value.length <= maxItems &&
    value.every((item) => text(item, maxItemChars)) && serializedLength(value) <= maxChars;
}

function optionalBoundedStringArray(
  value: unknown,
  maxItems: number,
  maxItemChars: number,
  maxChars: number,
): boolean {
  return value === undefined || boundedStringArray(value, maxItems, maxItemChars, maxChars);
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function optionalRecordArray(
  value: unknown,
  maxItems: number,
  maxChars: number,
  validate: (item: unknown) => boolean,
): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > maxItems || !value.every(validate)) return false;
  return serializedLength(value) <= maxChars;
}

function boundedDiagnostic(value: unknown): string {
  return sanitizeExecutionDiagnostic(value).slice(0, REVIEW_BATCH_DIAGNOSTIC_MAX_CHARS);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}
function timestamp(value: unknown): value is string {
  return text(value, 128) && Number.isFinite(Date.parse(value));
}
function nonnegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function positiveInt(value: unknown): value is number {
  return nonnegativeInt(value) && Number(value) > 0;
}
function provider(value: unknown): value is DispatchProvider {
  return value === 'anthropic' || value === 'openai';
}
function batchRole(value: unknown): value is ReviewBatchRole {
  return value === 'reviewer' || value === 'tech-lead' || value === 'designer' || value === 'security';
}
function eligibleRole(value: unknown): value is ReviewBatchEligibleRole {
  return value === 'reviewer' || value === 'tech-lead' || value === 'security';
}
function roleStatus(value: unknown): value is ReviewBatchRoleStatus {
  return value === 'pending' || value === 'running' || value === 'verdict' ||
    value === 'operational-failure' || value === 'cancelled';
}
function failureCategory(value: unknown): value is ReviewBatchFailureCategory {
  return value === 'interrupted' || value === 'provider' || value === 'timeout' ||
    value === 'executor-exit' || value === 'checkpoint' || value === 'invalid-verdict' ||
    value === 'unknown';
}
function cancellationReason(value: unknown): value is ReviewBatchCancellationReason {
  return value === 'quorum-satisfied' || value === 'objection' || value === 'external';
}
