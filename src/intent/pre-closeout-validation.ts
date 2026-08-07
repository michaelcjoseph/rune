/** Bounded operator-facing evidence for Rune's one post-review validation stage. */

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;

export type PreCloseoutValidationOutcome =
  | 'passed'
  | 'failed'
  | 'timed-out'
  | 'cancelled'
  | 'skipped';

export type PreCloseoutValidationReuseDecision =
  | 'pending'
  | 'reused'
  | 'fallback';

export type PreCloseoutValidationInvalidationReason =
  | 'missing-evidence'
  | 'tree-drift'
  | 'review-hash-drift'
  | 'argv-drift'
  | 'cwd-drift'
  | 'profile-drift'
  | 'configuration-drift'
  | 'dependency-drift'
  | 'environment-drift'
  | 'toolchain-drift'
  | 'incomplete-execution'
  | 'cancelled'
  | 'corrupt-evidence'
  | 'recovery-uncertain'
  | 'canonical-recapture-failed';

const OUTCOMES = new Set<PreCloseoutValidationOutcome>([
  'passed', 'failed', 'timed-out', 'cancelled', 'skipped',
]);
const DECISIONS = new Set<PreCloseoutValidationReuseDecision>([
  'pending', 'reused', 'fallback',
]);
const INVALIDATIONS = new Set<PreCloseoutValidationInvalidationReason>([
  'missing-evidence',
  'tree-drift',
  'review-hash-drift',
  'argv-drift',
  'cwd-drift',
  'profile-drift',
  'configuration-drift',
  'dependency-drift',
  'environment-drift',
  'toolchain-drift',
  'incomplete-execution',
  'cancelled',
  'corrupt-evidence',
  'recovery-uncertain',
  'canonical-recapture-failed',
]);

export interface PreCloseoutValidationEvidence {
  version: 1;
  receiptId?: string;
  durationMs: number;
  outcome: PreCloseoutValidationOutcome;
  reuseDecision: PreCloseoutValidationReuseDecision;
  invalidationReason?: PreCloseoutValidationInvalidationReason;
}

export function parsePreCloseoutValidationEvidence(
  value: unknown,
): PreCloseoutValidationEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'version', 'receiptId', 'durationMs', 'outcome', 'reuseDecision', 'invalidationReason',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  if (
    record['version'] !== 1 ||
    !Number.isSafeInteger(record['durationMs']) ||
    Number(record['durationMs']) < 0 ||
    Number(record['durationMs']) > MAX_DURATION_MS ||
    !OUTCOMES.has(record['outcome'] as PreCloseoutValidationOutcome) ||
    !DECISIONS.has(record['reuseDecision'] as PreCloseoutValidationReuseDecision) ||
    (record['receiptId'] !== undefined &&
      (typeof record['receiptId'] !== 'string' || !SHA256.test(record['receiptId']))) ||
    (record['invalidationReason'] !== undefined &&
      !INVALIDATIONS.has(record['invalidationReason'] as PreCloseoutValidationInvalidationReason))
  ) return undefined;
  if (
    record['reuseDecision'] === 'reused' &&
    (record['outcome'] !== 'passed' || record['receiptId'] === undefined ||
      record['invalidationReason'] !== undefined)
  ) return undefined;
  if (
    record['reuseDecision'] === 'fallback' && record['invalidationReason'] === undefined
  ) return undefined;
  return {
    version: 1,
    ...(record['receiptId'] !== undefined ? { receiptId: record['receiptId'] as string } : {}),
    durationMs: Number(record['durationMs']),
    outcome: record['outcome'] as PreCloseoutValidationOutcome,
    reuseDecision: record['reuseDecision'] as PreCloseoutValidationReuseDecision,
    ...(record['invalidationReason'] !== undefined
      ? { invalidationReason: record['invalidationReason'] as PreCloseoutValidationInvalidationReason }
      : {}),
  };
}
