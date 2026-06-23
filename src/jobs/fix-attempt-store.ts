import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type FixAttemptState =
  | 'gating'
  | 'declined'
  | 'handoff-failed'
  | 'proceeding'
  | 'interrupted';

export interface FixAttempt {
  attemptId: string;
  product: string;
  bugId: string;
  state: FixAttemptState;
  reason?: string;
  detail?: string;
  runId?: string;
  updatedAt: string;
}

export type LatestFixAttempts = Map<string, FixAttempt>;

interface ReconcileOptions {
  now?: () => string;
}

const STATES = new Set<FixAttemptState>([
  'gating',
  'declined',
  'handoff-failed',
  'proceeding',
  'interrupted',
]);

function attemptKey(product: string, bugId: string): string {
  return `${product}:${bugId}`;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function parseFixAttempt(raw: unknown): FixAttempt | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<FixAttempt>;
  if (!isString(candidate.attemptId)) return null;
  if (!isString(candidate.product)) return null;
  if (!isString(candidate.bugId)) return null;
  if (!isString(candidate.updatedAt)) return null;
  if (!isString(candidate.state) || !STATES.has(candidate.state)) return null;
  if (!optionalString(candidate.reason)) return null;
  if (!optionalString(candidate.detail)) return null;
  if (!optionalString(candidate.runId)) return null;
  if (candidate.state === 'proceeding' && !isString(candidate.runId)) return null;

  return {
    attemptId: candidate.attemptId,
    product: candidate.product,
    bugId: candidate.bugId,
    state: candidate.state,
    ...(candidate.reason !== undefined ? { reason: candidate.reason } : {}),
    ...(candidate.detail !== undefined ? { detail: candidate.detail } : {}),
    ...(candidate.runId !== undefined ? { runId: candidate.runId } : {}),
    updatedAt: candidate.updatedAt,
  };
}

export function appendFixAttempt(filePath: string, attempt: FixAttempt): void {
  const parsed = parseFixAttempt(attempt);
  if (!parsed) {
    throw new Error('invalid FixAttempt');
  }
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(parsed)}\n`, 'utf8');
}

export function readLatestFixAttempts(filePath: string): LatestFixAttempts {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return new Map();
  }

  const latest: LatestFixAttempts = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const attempt = parseFixAttempt(JSON.parse(line));
      if (!attempt) continue;
      latest.set(attemptKey(attempt.product, attempt.bugId), attempt);
    } catch {
      // Preserve torn-line tolerance: malformed rows are ignored on replay.
    }
  }
  return latest;
}

export function getLatestFixAttempt(
  attempts: LatestFixAttempts,
  product: string,
  bugId: string,
): FixAttempt | undefined {
  return attempts.get(attemptKey(product, bugId));
}

export function reconcileInterruptedFixAttempts(
  filePath: string,
  options: ReconcileOptions = {},
): FixAttempt[] {
  const now = options.now?.() ?? new Date().toISOString();
  const latest = readLatestFixAttempts(filePath);
  const interrupted: FixAttempt[] = [];

  for (const attempt of latest.values()) {
    if (attempt.state !== 'gating') continue;
    interrupted.push({
      attemptId: attempt.attemptId,
      product: attempt.product,
      bugId: attempt.bugId,
      state: 'interrupted',
      detail: `Fix attempt ${attempt.attemptId} was interrupted by restart.`,
      updatedAt: now,
    });
  }

  for (const attempt of interrupted) {
    appendFixAttempt(filePath, attempt);
  }
  return interrupted;
}
