/**
 * Lesson capture (project 12, Phase 2).
 *
 * Capture is TypeScript-owned, NOT model-owned. `askClaudeWithContext` only
 * returns text, so the writer *proposes* candidate lessons in a fenced
 * ```writer-memory-candidates JSON block; this module does the rest
 * deterministically: parse the block, gate on feedback, privacy-filter, dedupe
 * against existing entries, provenance-stamp, append to `memory.md`, and make
 * one atomic commit via the memory-scoped helper (`./commit.ts`).
 *
 * `feedbackSeen: false`, a missing block, an empty `lessons` array, or a lesson
 * that fails the privacy filter means NO memory write and NO commit.
 *
 * The privacy filter is deterministic: reject a lesson containing a configured
 * private name, a markdown link, a wikilink, an email/phone pattern, or a
 * quoted/raw-excerpt span longer than a small threshold.
 *
 * SCAFFOLD: bodies throw `notImplemented(...)` so the Phase 2 capture/parse/
 * dedup/privacy tests are RED until the implementation lands.
 */

import type { CommitWriterMemoryResult } from './commit.js';

/** The fence language tag for the writer's candidate block. */
export const CANDIDATE_FENCE = 'writer-memory-candidates';

/** Valid `sourceSlug` shape — opaque, lowercase, no leading hyphen. Mirrors the
 *  seed slug contract so seed and captured provenance stamps share one format. */
export const SOURCE_SLUG_RE = /^[a-z0-9][a-z0-9-]{2,80}$/;

/** The parsed candidate block the writer proposes. */
export interface WriterMemoryCandidates {
  /** Opaque source slug, ideally matching SOURCE_SLUG_RE; the handler may
   *  substitute a derived fallback slug when this is invalid. */
  sourceSlug: string;
  /** Must be true for any capture to occur — the no-phantom-write gate. */
  feedbackSeen: boolean;
  /** Candidate abstract-craft lessons. */
  lessons: string[];
}

/** Why a capture produced no write. `parseCandidateBlock` returns null for both
 *  an absent and a malformed block, so both collapse to `no-block` here. */
export type CaptureSkipReason =
  | 'no-block' // no parseable writer-memory-candidates block (absent or malformed)
  | 'no-feedback' // feedbackSeen !== true
  | 'empty' // lessons array empty
  | 'all-filtered'; // every candidate deduped or privacy-rejected

export interface CaptureLessonsInput {
  /** The writer's assistant text carrying the candidate block. */
  assistantText: string;
  /** Session topic/date, used to derive a fallback opaque slug when the
   *  candidate slug is missing/invalid. */
  fallbackTopic?: string;
  /** Private names to reject (defaults to config.FAMILY_NAMES). */
  privateNames?: string[];
  /** Provenance date `YYYY-MM-DD` (defaults to today, America/Chicago). */
  date?: string;
  /** Read current `memory.md` for dedup. Default: real read from WRITER_DIR. */
  readMemory?: () => string;
  /** Append one provenance line to `memory.md`. Default: real append. */
  appendLine?: (line: string) => void;
  /** Memory-scoped commit. Default: real `commitWriterMemory`. Async to match
   *  the git-helper convention (see `./commit.ts`). */
  commit?: (message: string) => Promise<CommitWriterMemoryResult>;
}

export interface CaptureResult {
  /** Provenance-stamped lines appended this capture (empty when nothing written). */
  captured: string[];
  /** Set when nothing was captured. */
  skipReason?: CaptureSkipReason;
  /** True when a commit was made. */
  committed: boolean;
}

function notImplemented(fn: string): never {
  throw new Error(`writer/capture: ${fn} not implemented (project 12 Phase 2 pending)`);
}

/** Parse the fenced ```writer-memory-candidates JSON block. Returns null when the
 *  block is absent or not a valid {sourceSlug, feedbackSeen, lessons} object. */
export function parseCandidateBlock(_text: string): WriterMemoryCandidates | null {
  return notImplemented('parseCandidateBlock');
}

/** Deterministic privacy gate: false when the lesson carries a private name, a
 *  markdown link, a wikilink, an email/phone pattern, or a long raw-excerpt span. */
export function isLessonPrivacySafe(_lesson: string, _privateNames: string[]): boolean {
  return notImplemented('isLessonPrivacySafe');
}

/** Parse → gate on feedback → privacy-filter → dedupe → stamp → append → commit.
 *  No feedback / no block / empty / all-filtered → no write and no commit. Async
 *  because it awaits the memory-scoped commit (`./commit.ts`). */
export function captureLessons(_input: CaptureLessonsInput): Promise<CaptureResult> {
  return notImplemented('captureLessons');
}
