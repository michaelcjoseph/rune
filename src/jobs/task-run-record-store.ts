/** Neutral persistence helpers for orchestrated task-attempt records. */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskRunRecord } from '../intent/orch-run-record.js';
import { VALID_SLUG } from '../intent/sandbox.js';
import { createLogger } from '../utils/logger.js';
import { readJsonlTail } from './jsonl-tail.js';

const log = createLogger('task-run-record-store');
export const TASK_RUN_RECORDS_FILE = 'task-records.jsonl';

export function appendOrchestratedTaskRunRecord(baseDir: string, runId: string, record: TaskRunRecord): void {
  if (!VALID_SLUG.test(runId)) throw new Error('Invalid run ID.');
  const dir = join(baseDir, runId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, TASK_RUN_RECORDS_FILE), JSON.stringify(record) + '\n', 'utf8');
}

export function readOrchestratedTaskRunRecords(baseDir: string, runId: string): TaskRunRecord[] {
  if (!VALID_SLUG.test(runId)) return [];
  let raw: string;
  try {
    raw = readFileSync(join(baseDir, runId, TASK_RUN_RECORDS_FILE), 'utf8');
  } catch {
    return [];
  }
  const records: TaskRunRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as TaskRunRecord); } catch {
      log.warn('task-records.jsonl: skipped malformed line', { runId });
    }
  }
  return records;
}

export function readRecentOrchestratedTaskRunRecords(
  baseDir: string,
  runId: string,
  limit: number,
  maxBytes = 512 * 1024,
): TaskRunRecord[] {
  if (!VALID_SLUG.test(runId) || !Number.isInteger(limit) || limit < 1) return [];
  return readJsonlTail(join(baseDir, runId, TASK_RUN_RECORDS_FILE), maxBytes, limit * 4)
    .filter(isDiagnosticTaskRunRecord)
    .slice(-limit);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(entry => typeof entry === 'string');
}

function isDiagnosticWarning(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const warning = value as Record<string, unknown>;
  return typeof warning['severity'] === 'string' &&
    typeof warning['class'] === 'string' &&
    typeof warning['location'] === 'string' &&
    typeof warning['rationale'] === 'string';
}

function isDiagnosticTaskRunRecord(value: unknown): value is TaskRunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['taskId'] === 'string' &&
    Array.isArray(candidate['rolesInvoked']) && candidate['rolesInvoked'].every(role => typeof role === 'string') &&
    (candidate['taskText'] === undefined || typeof candidate['taskText'] === 'string') &&
    (candidate['attemptId'] === undefined || typeof candidate['attemptId'] === 'string') &&
    (candidate['modelChoices'] === undefined || isStringRecord(candidate['modelChoices'])) &&
    (candidate['verdicts'] === undefined || isStringRecord(candidate['verdicts'])) &&
    (candidate['commitSha'] === undefined || candidate['commitSha'] === null || typeof candidate['commitSha'] === 'string') &&
    (candidate['contextOutcome'] === undefined || typeof candidate['contextOutcome'] === 'string') &&
    (candidate['outcome'] === undefined || typeof candidate['outcome'] === 'string') &&
    (candidate['warnings'] === undefined ||
      (Array.isArray(candidate['warnings']) && candidate['warnings'].every(isDiagnosticWarning)));
}
