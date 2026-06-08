/**
 * Learning-loop composer (project 14, Phase 6).
 *
 * The build loop gets the work done; the learning loop makes the team better. This
 * module wires the Phase 6 pieces into one nightly pass: read explicit feedback
 * records through an injected reader → validate each (malformed ones skipped with a
 * DURABLE reason, never silent no-feedback) → run a Jarvis-owned post-mortem
 * (`attribute`) → write the attributed lesson into the responsible role's `memory.md`
 * (`writeLesson`). "No lesson warranted" is a first-class outcome that writes nothing.
 *
 * Every dependency is injected — the feedback source, the post-mortem judgment, and
 * the memory write. The module is pure orchestration: no LLM call, no file/git I/O of
 * its own, so the wiring is unit-tested with fixtures (spec §"Learning Loop", reqs
 * 29-32). Production fills the seams with the configured feedback reader, the LLM
 * post-mortem, and `writeRoleLesson`.
 *
 * Mirrors the injected-deps nightly composer pattern of `observation-nightly.ts`.
 */

import type { FeedbackRecord, FeedbackReader, FeedbackSkipReason, RoleStage } from './feedback-record.js';
import { parseFeedbackRecord } from './feedback-record.js';
import type { RoleName } from '../roles/loader.js';

/** A post-mortem that attributes the miss to a stage/role and proposes one lesson. */
export interface PostMortemLesson {
  kind: 'lesson';
  /** The stage the miss is attributed to. */
  stage: RoleStage;
  /** The role whose `memory.md` the lesson is written to. */
  role: RoleName;
  /** The distilled, privacy-clean craft lesson (the memory writer filters again). */
  lesson: string;
}

/** A post-mortem that judges the miss uncatchable — nothing is written. */
export interface PostMortemNoLesson {
  kind: 'no-lesson';
  /** Why no lesson is warranted (recorded for the run report, not memory). */
  rationale: string;
}

/** The Jarvis-owned post-mortem decision. */
export type PostMortemAttribution = PostMortemLesson | PostMortemNoLesson;

/** Injected seams — all fully fakeable for tests, no real I/O in this module. */
export interface LearningLoopDeps {
  /** Reads RAW, unvalidated feedback records from the configured source.
   *  Synchronous — must return the full array in one call (production pre-loads
   *  the records; an `async` reader would be mis-handled as a single Promise). */
  readFeedback: FeedbackReader;
  /** Jarvis-owned post-mortem: LLM in production, fixture in tests. Decides
   *  attribution for one VALID record. May be sync or async. */
  attribute: (record: FeedbackRecord) => PostMortemAttribution | Promise<PostMortemAttribution>;
  /** Writes the attributed lesson into the role's `memory.md`, returning whether it
   *  committed. Production wires this to `writeRoleLesson`. */
  writeLesson: (
    role: RoleName,
    lesson: string,
    record: FeedbackRecord,
  ) => Promise<{ committed: boolean; captured?: string }>;
}

/** One malformed record skipped, carrying its durable validation reason. */
export interface LearningLoopSkip {
  reason: FeedbackSkipReason;
}

/** The composer's report for one nightly pass. */
export interface LearningLoopResult {
  /** Raw records read from the source. */
  total: number;
  /** Valid records that ran a post-mortem. */
  processed: number;
  /** Malformed records skipped, each with its durable reason. */
  skipped: LearningLoopSkip[];
  /** Lessons written to role memory this pass (the write committed). */
  lessonsWritten: number;
  /** Lessons attributed but rejected at the write boundary (privacy-filtered,
   *  deduped, or empty). Distinct from `noLessonOutcomes` — the post-mortem DID
   *  warrant a lesson, the memory writer declined it. Keeps the per-pass invariant
   *  `processed === lessonsWritten + lessonsFiltered + noLessonOutcomes` honest. */
  lessonsFiltered: number;
  /** Post-mortems that judged no lesson warranted. */
  noLessonOutcomes: number;
}

/**
 * Run one pass of the nightly learning loop. Reads feedback, validates each record,
 * skips malformed ones with a durable reason (no post-mortem, no write), and for each
 * valid record runs the Jarvis-owned post-mortem: a `lesson` attribution writes into
 * the role's memory; a `no-lesson` attribution writes nothing. No feedback at all → a
 * clean zero pass: `attribute` and `writeLesson` are never called (spec req 29).
 */
export async function runLearningLoop(deps: LearningLoopDeps): Promise<LearningLoopResult> {
  const raw = deps.readFeedback();
  const result: LearningLoopResult = {
    total: raw.length,
    processed: 0,
    skipped: [],
    lessonsWritten: 0,
    lessonsFiltered: 0,
    noLessonOutcomes: 0,
  };

  for (const candidate of raw) {
    const validation = parseFeedbackRecord(candidate);
    if (!validation.ok) {
      // Malformed → visible skip with a durable reason; no post-mortem, no write.
      result.skipped.push({ reason: validation.reason });
      continue;
    }

    result.processed += 1;
    const attribution = await deps.attribute(validation.record);
    if (attribution.kind === 'lesson') {
      const write = await deps.writeLesson(attribution.role, attribution.lesson, validation.record);
      if (write.committed) result.lessonsWritten += 1;
      else result.lessonsFiltered += 1;
    } else {
      result.noLessonOutcomes += 1;
    }
  }

  return result;
}
