/**
 * Phase 12 gate-triggered learning tests — draft-then-validate.
 *
 * A gate rejection should teach the counterpart role without letting any role
 * write memory directly. The rejecting role drafts a candidate lesson from the
 * structured gate-rejection record; neutral Jarvis validation then privacy-filters,
 * dedupes, attributes/transforms, and may fail safe to no-lesson BEFORE the shared
 * memory-writer seam is called.
 *
 * TEST-FIRST / RED-BY-DESIGN. `./gate-learning.ts` does not exist yet; the clean
 * expected failure is module-not-found until the implementation lands.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  runGateTriggeredLearning,
  type GateLearningDeps,
  type GateLessonCandidate,
} from './gate-learning.js';
import type { GateRejectionFeedback } from './team-task-workflow.js';

function rejection(overrides: Partial<GateRejectionFeedback> = {}): GateRejectionFeedback {
  return {
    rejectingRole: 'tech-lead',
    counterpartRole: 'qa',
    rejectedRole: 'qa',
    artifact: 'test-intent',
    rejectedArtifact: 'test-intent',
    reason: 'tests used already-redacted placeholders instead of raw secret-shaped inputs',
    whatFailed: 'redaction tests would pass even if raw secrets leaked',
    notes: ['Use a raw secret-shaped fixture, then assert the raw value is absent.'],
    actionableNotes: ['Assert raw token absence and redacted-shape presence.'],
    ...overrides,
  };
}

describe('gate-triggered learning — draft then neutral-validate', () => {
  it('asks the rejecting role to draft, then writes only the neutral-validated counterpart lesson', async () => {
    const record = rejection();
    const steps: string[] = [];
    const rawCandidate: GateLessonCandidate = {
      kind: 'candidate-lesson',
      draftedBy: 'tech-lead',
      targetRole: 'tech-lead',
      lesson: 'Tech lead should remember the exact redaction fixture from this run.',
    };
    const validatedLesson =
      'When writing redaction tests, use a raw secret-shaped fixture and assert the raw value is absent while a redacted-shape marker is present.';

    const deps: GateLearningDeps = {
      draftLesson: vi.fn(async (input) => {
        steps.push('draft');
        expect(input.rejection).toEqual(record);
        expect(input.rejection.rejectingRole).toBe('tech-lead');
        expect(input.rejection.counterpartRole).toBe('qa');

        // The role is only a drafter. It must not receive any memory-writing
        // capability or filesystem target through the draft seam.
        expect(input).not.toHaveProperty('writeLesson');
        expect(input).not.toHaveProperty('memoryPath');
        return rawCandidate;
      }),
      validateLesson: vi.fn(async (input) => {
        steps.push('validate');
        expect(input.rejection).toEqual(record);
        expect(input.candidate).toEqual(rawCandidate);
        return {
          kind: 'lesson',
          stage: 'test',
          role: 'qa',
          lesson: validatedLesson,
        };
      }),
      writeLesson: vi.fn(async (role, lesson, inputRecord) => {
        steps.push('write');
        expect(inputRecord).toEqual(record);
        expect(role).toBe('qa');
        expect(lesson).toBe(validatedLesson);
        expect(lesson).not.toBe(rawCandidate.lesson);
        return { committed: true, captured: `- [2026-06-17 · source: gate-test] ${lesson}` };
      }),
    };

    const result = await runGateTriggeredLearning(record, deps);

    expect(result).toMatchObject({
      kind: 'written',
      role: 'qa',
      lesson: validatedLesson,
    });
    expect(steps).toEqual(['draft', 'validate', 'write']);
    expect(deps.draftLesson).toHaveBeenCalledTimes(1);
    expect(deps.validateLesson).toHaveBeenCalledTimes(1);
    expect(deps.writeLesson).toHaveBeenCalledTimes(1);
  });

  it('treats neutral validation no-lesson as terminal and never calls the memory writer', async () => {
    const record = rejection();
    const rawCandidate: GateLessonCandidate = {
      kind: 'candidate-lesson',
      draftedBy: 'tech-lead',
      targetRole: 'qa',
      lesson: 'Copy the private project-17 redaction example exactly next time.',
    };

    const deps: GateLearningDeps = {
      draftLesson: vi.fn(async () => rawCandidate),
      validateLesson: vi.fn(async (input) => {
        expect(input.candidate).toEqual(rawCandidate);
        return {
          kind: 'no-lesson',
          rationale: 'candidate was too specific and failed the neutral privacy/abstraction check',
        };
      }),
      writeLesson: vi.fn(),
    };

    const result = await runGateTriggeredLearning(record, deps);

    expect(result).toEqual({
      kind: 'no-lesson',
      rationale: 'candidate was too specific and failed the neutral privacy/abstraction check',
    });
    expect(deps.draftLesson).toHaveBeenCalledTimes(1);
    expect(deps.validateLesson).toHaveBeenCalledTimes(1);
    expect(deps.writeLesson).not.toHaveBeenCalled();
  });
});
