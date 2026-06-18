/**
 * Shared learning-memory write path (project 14, Phase 12).
 *
 * Both the nightly feedback loop and gate-triggered learning eventually persist
 * one neutral, validated craft lesson into a role's memory. This module is the
 * single adapter from those trigger-specific records to the role-memory writer's
 * provenance-stamped, deduping write boundary.
 */

import type { FeedbackRecord } from './feedback-record.js';
import type { GateRejectionFeedback } from './team-task-workflow.js';
import type { RoleName } from '../roles/loader.js';
import {
  writeRoleLesson as defaultWriteRoleLesson,
  type WriteRoleLessonInput,
  type WriteRoleLessonResult,
} from '../roles/memory-writer.js';

export interface LearningLessonWriteDeps {
  writeRoleLesson?: (input: WriteRoleLessonInput) => Promise<WriteRoleLessonResult>;
}

export interface NightlyLearningLessonInput {
  role: RoleName;
  lesson: string;
  record: FeedbackRecord;
}

export interface GateLearningLessonInput {
  role: RoleName;
  lesson: string;
  projectSlug: string;
  rejection: GateRejectionFeedback;
}

export function writeNightlyLearningLesson(
  input: NightlyLearningLessonInput,
  deps: LearningLessonWriteDeps = {},
): Promise<WriteRoleLessonResult> {
  const writer = deps.writeRoleLesson ?? defaultWriteRoleLesson;
  const sourceSlug = `${input.record.projectSlug}-fb-${input.record.createdAt.slice(0, 10)}`;
  return writer({
    role: input.role,
    lesson: input.lesson,
    sourceSlug,
    fallbackTopic: input.record.projectSlug,
  });
}

export function writeGateLearningLesson(
  input: GateLearningLessonInput,
  deps: LearningLessonWriteDeps = {},
): Promise<WriteRoleLessonResult> {
  const writer = deps.writeRoleLesson ?? defaultWriteRoleLesson;
  const sourceSlug = `${input.projectSlug}-gate-${input.rejection.rejectedArtifact}`;
  return writer({
    role: input.role,
    lesson: input.lesson,
    sourceSlug,
    fallbackTopic: input.projectSlug,
  });
}
