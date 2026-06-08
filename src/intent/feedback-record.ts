/**
 * Feedback-record schema + validator (project 14, Phase 6 — learning loop).
 *
 * The learning loop is fed by EXPLICIT, machine-readable feedback records — never
 * inferred from arbitrary chat, transcripts, or usage logs (spec §"Learning Loop":
 * "Feedback records are explicit input"). This module owns the record SHAPE and a
 * pure, deterministic validator; the records themselves are produced upstream (a
 * configured source) and read through the injected `FeedbackReader` seam so tests
 * supply fixtures with no real vault/file access.
 *
 * `parseFeedbackRecord` is fail-closed and returns a DURABLE skip reason for every
 * malformed input rather than throwing or silently coercing — the nightly loop
 * records that reason so a malformed record is visibly skipped, not silently
 * treated as "no feedback" (spec req 30). Pure, no I/O.
 */

import { VALID_SLUG } from './sandbox.js';

/** The stage a feedback miss is attributed to — mirrors the team's review edges.
 *  Used as the optional reporter hint here and as the post-mortem's attribution
 *  target in the learning loop. */
export type RoleStage = 'spec' | 'tech-spec' | 'test' | 'implementation' | 'review' | 'design';

/** Canonical stage inventory — backs the optional-hint validation. */
export const ROLE_STAGES: readonly RoleStage[] = [
  'spec',
  'tech-spec',
  'test',
  'implementation',
  'review',
  'design',
] as const;

/** A validated feedback record. The five required fields are always present and
 *  non-empty; optionals are present only when the raw input carried them. */
export interface FeedbackRecord {
  /** Product/project slug the feedback concerns — must satisfy `VALID_SLUG`. */
  projectSlug: string;
  /** Where the record came from (e.g. 'telegram', 'manual', a file path). */
  source: string;
  /** ISO-8601 timestamp the record was created. */
  createdAt: string;
  /** One-line summary of the observed issue. */
  issueSummary: string;
  /** Concrete evidence (logs, file/line, repro) backing the issue. */
  evidence: string;
  /** Expected behavior, when applicable. */
  expectedBehavior?: string;
  /** Actual behavior, when applicable. */
  actualBehavior?: string;
  /** Originating run id, when known. */
  runId?: string;
  /** Originating task id, when known. */
  taskId?: string;
  /** Reporter's guess at the responsible stage — a hint, not the attribution. */
  reporterStage?: RoleStage;
}

/** Durable, machine-readable reason a raw record was rejected. The nightly loop
 *  records this so a malformed record is a visible skip, never silent no-feedback. */
export type FeedbackSkipReason =
  | 'not-an-object'
  | 'missing-project-slug'
  | 'invalid-project-slug'
  | 'missing-source'
  | 'missing-created-at'
  | 'invalid-created-at'
  | 'missing-issue-summary'
  | 'missing-evidence'
  | 'field-too-long';

/** Trust-boundary length caps. This module is the single validation boundary for
 *  externally-sourced feedback, so it bounds field length here — before any value
 *  reaches an LLM prompt (the post-mortem `attribute` call) or `memory.md`. Generous
 *  enough for real stack-trace evidence; rejects pathological/abusive input. */
const MAX_TEXT_CHARS = 4000; // issueSummary / evidence / expected / actual
const MAX_IDENT_CHARS = 500; // source / runId / taskId

/** Loose ISO-8601 date or date-time shape (`YYYY-MM-DD` with optional `T`/space
 *  time + zone). Paired with a `Date.parse` sanity check so impossible values
 *  like `2099-99-99T99:99:99Z` are rejected, not just non-date strings. */
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isIso8601(v: string): boolean {
  return ISO_8601_RE.test(v) && !Number.isNaN(Date.parse(v));
}

/** Discriminated validation result — fail-closed, first-failure-wins. */
export type FeedbackValidation =
  | { ok: true; record: FeedbackRecord }
  | { ok: false; reason: FeedbackSkipReason };

/** Injected reader seam: returns RAW, unvalidated records. The learning loop
 *  validates each via `parseFeedbackRecord`. Production wires this to the
 *  configured feedback source; tests return in-memory fixtures. */
export type FeedbackReader = () => unknown[];

/** True for a present, non-empty string. Empty/whitespace counts as missing so a
 *  blank field is rejected with the same durable reason as an absent one. */
function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** Validate one raw record. Pure and deterministic: non-object → 'not-an-object';
 *  then required fields in a fixed order (first failure wins) with a field-specific
 *  reason; a present-but-malformed `projectSlug` is distinguished from a missing one.
 *  Optional fields are copied through only when present (strings; `reporterStage`
 *  only when it names a known stage). */
export function parseFeedbackRecord(raw: unknown): FeedbackValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not-an-object' };
  }

  const r = raw as Record<string, unknown>;

  if (!nonEmptyString(r['projectSlug'])) return { ok: false, reason: 'missing-project-slug' };
  if (!VALID_SLUG.test(r['projectSlug'])) return { ok: false, reason: 'invalid-project-slug' };
  if (!nonEmptyString(r['source'])) return { ok: false, reason: 'missing-source' };
  if (!nonEmptyString(r['createdAt'])) return { ok: false, reason: 'missing-created-at' };
  if (!isIso8601(r['createdAt'])) return { ok: false, reason: 'invalid-created-at' };
  if (!nonEmptyString(r['issueSummary'])) return { ok: false, reason: 'missing-issue-summary' };
  if (!nonEmptyString(r['evidence'])) return { ok: false, reason: 'missing-evidence' };

  // Trust-boundary length caps — reject pathological input before it can reach an
  // LLM prompt or memory.md. Required free-form/identifier fields checked here;
  // optionals checked at their assignment guards below.
  if (
    r['source'].length > MAX_IDENT_CHARS ||
    r['issueSummary'].length > MAX_TEXT_CHARS ||
    r['evidence'].length > MAX_TEXT_CHARS
  ) {
    return { ok: false, reason: 'field-too-long' };
  }

  const record: FeedbackRecord = {
    projectSlug: r['projectSlug'],
    source: r['source'],
    createdAt: r['createdAt'],
    issueSummary: r['issueSummary'],
    evidence: r['evidence'],
  };

  // Optional fields: present + within cap → copy through; over-cap → reject the
  // whole record (a single trust boundary, not a silently-truncated value).
  if (nonEmptyString(r['expectedBehavior'])) {
    if (r['expectedBehavior'].length > MAX_TEXT_CHARS) return { ok: false, reason: 'field-too-long' };
    record.expectedBehavior = r['expectedBehavior'];
  }
  if (nonEmptyString(r['actualBehavior'])) {
    if (r['actualBehavior'].length > MAX_TEXT_CHARS) return { ok: false, reason: 'field-too-long' };
    record.actualBehavior = r['actualBehavior'];
  }
  if (nonEmptyString(r['runId'])) {
    if (r['runId'].length > MAX_IDENT_CHARS) return { ok: false, reason: 'field-too-long' };
    record.runId = r['runId'];
  }
  if (nonEmptyString(r['taskId'])) {
    if (r['taskId'].length > MAX_IDENT_CHARS) return { ok: false, reason: 'field-too-long' };
    record.taskId = r['taskId'];
  }
  if (typeof r['reporterStage'] === 'string' && (ROLE_STAGES as readonly string[]).includes(r['reporterStage'])) {
    record.reporterStage = r['reporterStage'] as RoleStage;
  }

  return { ok: true, record };
}
