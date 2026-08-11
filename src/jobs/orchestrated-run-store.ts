import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestrationRunCursor } from '../intent/project-orchestrator.js';
import { isExecutionCheckpoint } from '../intent/execution-failure.js';
import { isGitObjectId } from '../intent/team-task-workflow.js';
import { parseReviewBatchState } from '../intent/review-batch-state.js';
import { writeFileAtomic } from '../intent/backlog-write-lock.js';

const ORCHESTRATED_CURSOR_FILE = 'cursor.json';

/** Atomically persist a resumable cursor.
 *
 *  Deliberately synchronous. `persistReviewBatch` calls this on every review-role
 *  state transition with a `ReviewBatchState` bounded at 256,000 chars, so this
 *  is a real blocking cost on the shared event loop — but the callers in
 *  `orchestrated-work-runner.test.ts` drive terminal flows through a
 *  microtask-only `waitForCondition` (deliberately not setTimeout, because the
 *  suite runs under fake timers), and real `fs/promises` I/O resolves on the
 *  thread pool where a microtask poll can never observe it. Converting this to
 *  async requires reworking that helper first — see the review notes. */
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
    (position.nextTaskId === null || typeof position.nextTaskId === 'string') &&
    (
      cursor.taskBase === undefined ||
      (
        typeof cursor.taskBase === 'object' &&
        cursor.taskBase !== null &&
        typeof cursor.taskBase.taskId === 'string' &&
        typeof cursor.taskBase.treeOid === 'string' &&
        isGitObjectId(cursor.taskBase.treeOid) &&
        position.currentTaskId === cursor.taskBase.taskId
      )
    ) &&
    (cursor.executionCheckpoint === undefined || isExecutionCheckpoint(cursor.executionCheckpoint)) &&
    (cursor.reviewBatch === undefined || parseReviewBatchState(cursor.reviewBatch) !== undefined)
  );
}
