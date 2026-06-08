/**
 * Restart reconstruction for a partial orchestrated run (project 14, Phase 3).
 *
 * After a crash/restart, Jarvis rebuilds where a project run stood from durable
 * inputs — the task run records plus the on-disk `tasks.md` — WITHOUT replaying
 * tasks already done. It also surfaces DRIFT: a record that claims a task
 * complete while `tasks.md` still shows it unchecked (a closeout that didn't
 * finish its checkbox tick), so the orchestrator can block/reload safely instead
 * of advancing on an inconsistent state.
 *
 * Pure — no I/O. The caller reads `tasks.md` + records from disk and passes them in.
 */

import { selectNextTask, computeTaskId, type SelectedTask } from './orch-task-select.js';
import type { TaskRunRecord } from './orch-run-record.js';

export interface ReconstructInput {
  /** Current `tasks.md` content. */
  tasksMd: string;
  /** Durable task run records recovered for this run. */
  records: TaskRunRecord[];
}

export interface RunReconstruction {
  /** Ids of tasks a record marked ready-for-closeout. */
  completedTaskIds: string[];
  /** The next task to run (first unchecked), or null when all are checked. */
  nextTask: SelectedTask | null;
  /** True when a record claims a completed task that `tasks.md` shows unchecked. */
  drift: boolean;
}

// Body capture is `\S(?:.*\S)?` to avoid quadratic backtracking on padded lines.
const CHECKED_RE = /^\s*-\s*\[x\]\s+(\S(?:.*\S)?)\s*$/i;

/** Ids of every checked (`- [x]`) task in `tasks.md`, by the same text-stable
 *  slug `selectNextTask` uses. */
function checkedTaskIds(tasksMd: string): Set<string> {
  const ids = new Set<string>();
  for (const line of tasksMd.split('\n')) {
    const m = CHECKED_RE.exec(line);
    if (m) ids.add(computeTaskId(m[1]!));
  }
  return ids;
}

/**
 * Reconstruct partial run state. `completedTaskIds` comes from the records that
 * reached ready-for-closeout; `nextTask` is the first unchecked task; `drift` is
 * set when any completed record's task is not actually checked on disk.
 */
export function reconstructRun(input: ReconstructInput): RunReconstruction {
  const checked = checkedTaskIds(input.tasksMd);

  const completed = input.records.filter((r) => r.outcome === 'ready-for-closeout');
  const completedTaskIds = completed.map((r) => r.taskId);

  // Drift: a record says done, but the checkbox on disk says not.
  const drift = completed.some((r) => !checked.has(r.taskId));

  const sel = selectNextTask(input.tasksMd);
  const nextTask = sel.kind === 'task' ? sel.task : null;

  return { completedTaskIds, nextTask, drift };
}
