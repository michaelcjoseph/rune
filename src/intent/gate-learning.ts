/**
 * Gate-triggered learning composer (project 14, Phase 12).
 *
 * A role-gate rejection can teach the rejected counterpart, but the rejecting
 * role must not write memory directly. This module orchestrates the safe path:
 * rejecting role drafts a candidate lesson from structured rejection feedback
 * -> neutral Jarvis validates/transforms it into a lesson or no-lesson decision
 * -> the shared role-memory writer receives only the neutral validated lesson.
 *
 * Pure over injected seams: no LLM call, filesystem access, or git operation.
 */

import { ROLE_STAGES, type RoleStage } from './feedback-record.js';
import type { GateRejectionFeedback } from './team-task-workflow.js';
import { ROLE_NAMES, type RoleName } from '../roles/loader.js';

/** Candidate lesson drafted by the rejecting role. It is untrusted input to the
 *  neutral validation step and is never written directly. */
export interface GateLessonCandidate {
  kind: 'candidate-lesson';
  draftedBy: RoleName;
  targetRole: RoleName;
  lesson: string;
}

/** Neutral Jarvis validation accepted and attributed a memory lesson. */
export interface GateValidatedLesson {
  kind: 'lesson';
  stage: RoleStage;
  role: RoleName;
  lesson: string;
}

/** Neutral Jarvis validation declined to write a lesson. */
export interface GateNoLesson {
  kind: 'no-lesson';
  rationale: string;
}

export type GateValidationResult = GateValidatedLesson | GateNoLesson;

export interface GateLearningDeps {
  /** Rejecting role drafts from the structured gate rejection only. */
  draftLesson: (input: {
    rejection: GateRejectionFeedback;
  }) => GateLessonCandidate | Promise<GateLessonCandidate>;
  /** Neutral Jarvis validation/privacy/dedup attribution step. */
  validateLesson: (input: {
    rejection: GateRejectionFeedback;
    candidate: GateLessonCandidate;
  }) => unknown | Promise<unknown>;
  /** Shared role-memory writer seam. Called only for neutral validated lessons. */
  writeLesson: (
    role: RoleName,
    lesson: string,
    rejection: GateRejectionFeedback,
  ) => Promise<{ committed: boolean; captured?: string }>;
}

export type GateLearningResult =
  | {
      kind: 'written';
      role: RoleName;
      lesson: string;
      captured?: string;
    }
  | {
      kind: 'filtered';
      role: RoleName;
      lesson: string;
    }
  | GateNoLesson;

/** Run one gate-triggered learning pass for a structured rejection. */
export async function runGateTriggeredLearning(
  rejection: GateRejectionFeedback,
  deps: GateLearningDeps,
): Promise<GateLearningResult> {
  const candidate = await deps.draftLesson({ rejection });
  const validation = parseGateValidationResult(
    await deps.validateLesson({ rejection, candidate }),
  );

  if (validation.kind === 'no-lesson') {
    return validation;
  }

  const write = await deps.writeLesson(validation.role, validation.lesson, rejection);
  if (!write.committed) {
    return {
      kind: 'filtered',
      role: validation.role,
      lesson: validation.lesson,
    };
  }

  return {
    kind: 'written',
    role: validation.role,
    lesson: validation.lesson,
    ...(write.captured !== undefined ? { captured: write.captured } : {}),
  };
}

function parseGateValidationResult(value: unknown): GateValidationResult {
  if (!value || typeof value !== 'object') {
    return { kind: 'no-lesson', rationale: 'neutral validation output could not be parsed' };
  }
  const obj = value as Record<string, unknown>;

  if (obj['kind'] === 'lesson') {
    const { stage, role, lesson } = obj;
    if (typeof stage !== 'string' || !(ROLE_STAGES as readonly string[]).includes(stage)) {
      return { kind: 'no-lesson', rationale: 'neutral validation output could not be parsed' };
    }
    if (typeof role !== 'string' || !(ROLE_NAMES as readonly string[]).includes(role)) {
      return { kind: 'no-lesson', rationale: 'neutral validation output could not be parsed' };
    }
    if (typeof lesson !== 'string' || !lesson.trim()) {
      return { kind: 'no-lesson', rationale: 'neutral validation output could not be parsed' };
    }
    return {
      kind: 'lesson',
      stage: stage as RoleStage,
      role: role as RoleName,
      lesson: lesson.trim(),
    };
  }

  if (obj['kind'] === 'no-lesson') {
    const { rationale } = obj;
    if (typeof rationale !== 'string' || !rationale.trim()) {
      return { kind: 'no-lesson', rationale: 'neutral validation output could not be parsed' };
    }
    return { kind: 'no-lesson', rationale: rationale.trim() };
  }

  return { kind: 'no-lesson', rationale: 'neutral validation output could not be parsed' };
}
