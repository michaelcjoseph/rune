/**
 * Per-task attempt cap + escalation decision (project 14, Phase 3).
 *
 * Retries are bounded. `decideAttemptOutcome` is the pure decision Jarvis makes
 * after a task attempt: retry within the cap, or escalate. An open
 * objection-class finding is a hard gate — it goes straight to blocked-on-human
 * regardless of attempts (PM wrap-up can never clear it). Otherwise, below the
 * cap a non-success retries; AT the cap, non-objection disagreement routes to PM
 * wrap-up. Jarvis never spins forever on one task.
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

export type AttemptAction = 'proceed' | 'retry' | 'pm-wrapup' | 'blocked-on-human';

export interface AttemptDecision {
  action: AttemptAction;
}

/**
 * Decide what to do after an attempt. Precedence:
 *   1. open objection-class finding → blocked-on-human (hard gate, any attempt,
 *      any outcome — PM wrap-up can never clear it).
 *   2. success → proceed (to closeout). Total for all inputs, not a caller
 *      precondition: a success on the final allowed attempt advances, it does
 *      not fall through to PM wrap-up.
 *   3. below cap → retry.
 *   4. at/over cap → PM wrap-up (non-objection disagreement).
 */
export function decideAttemptOutcome(input: AttemptInput): AttemptDecision {
  if (input.objectionOpen) {
    return { action: 'blocked-on-human' };
  }
  if (input.outcome === 'ready-for-closeout') {
    return { action: 'proceed' };
  }
  if (input.attempts < input.cap) {
    return { action: 'retry' };
  }
  return { action: 'pm-wrapup' };
}
