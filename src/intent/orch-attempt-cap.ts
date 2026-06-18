/**
 * Per-task attempt cap + escalation decision (project 14, Phase 3).
 *
 * Retries are bounded. `decideAttemptOutcome` is the pure decision Jarvis makes
 * after a task attempt: retry within the cap, proceed on success, or stop with
 * the task evidence. Per-task terminals are machine-handled; they never route to
 * PM wrap-up or blocked-on-human. Jarvis never spins forever on one task.
 *
 * Pure — no I/O.
 */

import type { TaskWorkflowOutcome } from './orch-run-record.js';

export interface AttemptInput {
  /** Attempts made so far, including the one that just produced `outcome`. */
  attempts: number;
  /** The configured attempt cap for this task. */
  cap: number;
  /** The workflow outcome of the latest attempt. */
  outcome: TaskWorkflowOutcome;
  /** Whether an objection-class finding is open (hard gate). */
  objectionOpen: boolean;
}

export type AttemptAction = 'proceed' | 'retry' | 'stop';

export interface AttemptDecision {
  action: AttemptAction;
}

/**
 * Decide what to do after an attempt. Precedence:
 *   1. open objection-class finding → stop (hard gate, any attempt).
 *   2. success → proceed (to closeout). Total for all inputs, not a caller
 *      precondition: a success on the final allowed attempt advances.
 *   3. below cap → retry.
 *   4. at/over cap → stop with the task evidence.
 */
export function decideAttemptOutcome(input: AttemptInput): AttemptDecision {
  if (input.objectionOpen) {
    return { action: 'stop' };
  }
  if (input.outcome === 'ready-for-closeout') {
    return { action: 'proceed' };
  }
  if (input.attempts < input.cap) {
    return { action: 'retry' };
  }
  return { action: 'stop' };
}
