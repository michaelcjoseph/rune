/**
 * Phase 12 no-double-write regression.
 *
 * The nightly feedback loop and the gate-time learning path may discover the
 * same lesson through different triggers, but they must persist through one
 * shared role-memory write boundary. The existing `writeRoleLesson` dedupe is
 * the guard: the first trigger may commit the lesson, the second must be a
 * duplicate/no-write result, never a second append or commit.
 *
 * TEST-FIRST / RED-BY-DESIGN. `./learning-write-path.ts` is the expected shared
 * adapter seam and does not exist yet. The clean red is module-not-found until
 * the implementation moves both callers onto the shared path.
 */

import { describe, expect, it, vi } from 'vitest';

import type { FeedbackRecord } from './feedback-record.js';
import type { GateRejectionFeedback } from './team-task-workflow.js';
import {
  writeGateLearningLesson,
  writeNightlyLearningLesson,
  type LearningLessonWriteDeps,
} from './learning-write-path.js';
import type { WriteRoleLessonInput, WriteRoleLessonResult } from '../roles/memory-writer.js';

function feedback(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    projectSlug: 'demo',
    source: 'telegram',
    createdAt: '2026-06-17T10:00:00.000Z',
    issueSummary: 'QA missed a redaction edge case.',
    evidence: 'The test asserted a placeholder instead of proving the raw token was absent.',
    ...overrides,
  };
}

function gateRejection(overrides: Partial<GateRejectionFeedback> = {}): GateRejectionFeedback {
  return {
    rejectingRole: 'tech-lead',
    counterpartRole: 'qa',
    rejectedRole: 'qa',
    artifact: 'test-intent',
    rejectedArtifact: 'test-intent',
    reason: 'redaction tests asserted the redacted placeholder',
    whatFailed: 'the tests would pass even if raw token-shaped input leaked',
    notes: ['Use a raw token-shaped fixture.'],
    actionableNotes: ['Assert the raw value is absent and a redacted-shape marker is present.'],
    ...overrides,
  };
}

describe('learning write path - nightly + gate-time dedupe', () => {
  it('routes both triggers through the same writeRoleLesson boundary and does not double-write the same lesson', async () => {
    const lesson =
      'When testing redaction, use a raw token-shaped fixture and assert the raw value is absent.';
    const appendedLessons: string[] = [];
    const seen = new Set<string>();

    const writeRoleLesson = vi.fn(
      async (input: WriteRoleLessonInput): Promise<WriteRoleLessonResult> => {
        const key = `${input.role}:${input.lesson.trim().toLowerCase()}`;
        if (seen.has(key)) {
          return { committed: false, skipReason: 'duplicate' };
        }
        seen.add(key);
        appendedLessons.push(input.lesson);
        return {
          committed: true,
          captured: `- [2026-06-17 · source: ${input.sourceSlug}] ${input.lesson}`,
        };
      },
    );
    const deps: LearningLessonWriteDeps = { writeRoleLesson };

    const nightlyResult = await writeNightlyLearningLesson(
      {
        role: 'qa',
        lesson,
        record: feedback(),
      },
      deps,
    );
    const gateResult = await writeGateLearningLesson(
      {
        role: 'qa',
        lesson,
        projectSlug: 'demo',
        rejection: gateRejection(),
      },
      deps,
    );

    expect(writeRoleLesson).toHaveBeenCalledTimes(2);
    expect(writeRoleLesson).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ role: 'qa', lesson }),
    );
    expect(writeRoleLesson).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ role: 'qa', lesson }),
    );

    expect(nightlyResult).toMatchObject({ committed: true });
    expect(gateResult).toMatchObject({ committed: false, skipReason: 'duplicate' });
    expect(appendedLessons).toEqual([lesson]);
  });
});
