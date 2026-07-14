import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestrationRunCursor } from '../intent/project-orchestrator.js';
import { writeFileAtomic } from '../intent/backlog-write-lock.js';

const ORCHESTRATED_CURSOR_FILE = 'cursor.json';

export function writeOrchestratedRunCursor(
  baseDir: string,
  runId: string,
  cursor: OrchestrationRunCursor,
): void {
  const dir = join(baseDir, runId);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, ORCHESTRATED_CURSOR_FILE);
  const tmp = join(dir, `.${ORCHESTRATED_CURSOR_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(cursor, null, 2), 'utf8');
  renameSync(tmp, target);
}

export function readOrchestratedRunCursor(baseDir: string, runId: string): OrchestrationRunCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(baseDir, runId, ORCHESTRATED_CURSOR_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!isOrchestrationRunCursor(parsed) || parsed.runId !== runId) return null;
  return parsed;
}

/** Atomically replace a resumable cursor with a non-resumable tombstone. */
export function invalidateOrchestratedRunCursor(baseDir: string, runId: string, reason: string): void {
  const target = join(baseDir, runId, ORCHESTRATED_CURSOR_FILE);
  if (!existsSync(target)) return;
  writeFileAtomic(
    target,
    JSON.stringify({ runId, invalidatedAt: new Date().toISOString(), reason }, null, 2),
  );
}

function isOrchestrationRunCursor(value: unknown): value is OrchestrationRunCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<OrchestrationRunCursor>;
  const position = cursor.cursor as Partial<OrchestrationRunCursor['cursor']> | undefined;
  return (
    cursor.resumeMarker === 'resumable' &&
    typeof cursor.runId === 'string' &&
    typeof cursor.product === 'string' &&
    typeof cursor.project === 'string' &&
    typeof cursor.branch === 'string' &&
    typeof cursor.baseBranch === 'string' &&
    typeof cursor.worktreePath === 'string' &&
    !!position &&
    Array.isArray(position.completedTaskIds) &&
    position.completedTaskIds.every((taskId) => typeof taskId === 'string') &&
    (position.currentTaskId === null || typeof position.currentTaskId === 'string') &&
    (position.nextTaskId === null || typeof position.nextTaskId === 'string')
  );
}
