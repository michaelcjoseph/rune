/**
 * Per-class evidence contract for blocking findings (bugs.md: "A blocking role
 * rejection requires no evidence, so a one-sentence assertion outweighs two
 * grounded approvals").
 *
 * Pure: no I/O, no clock, no model calls — same shape as `terminal-bug-backlog.ts`.
 * The workflow owns the re-prompt and the downgrade; this module only answers
 * "does this finding carry the evidence its class demands?".
 *
 * SCOPE, deliberately narrow on two axes:
 *
 *  1. Findings only, never a bare `fail`. A verdict that fails with no findings
 *     is ordinary quality disagreement by design (both the reviewer and
 *     tech-lead charters say so) — it routes to a coder retry, and at the round
 *     cap it is what the PM adjudicates. Downgrading those would delete a
 *     load-bearing path, not fix one.
 *  2. Blocking severities in the three classes bugs.md names. A `low` finding
 *     maps to `pass-with-warnings` and never blocks, so holding it to a
 *     blocking-evidence contract would buy nothing and cost a re-prompt.
 *
 * The mechanical checks are intentionally shallow: an anchor regex and a length
 * floor cannot judge whether prose is *substantive*. They are a cheap filter in
 * front of the bounded re-prompt, which does the semantic work. A finding that
 * cites a reproducible failure is exempt outright — bugs.md's explicit
 * "never downgrade a fail backed by a reproducible failing command" guarantee.
 */

import type { ObjectionClass, ObjectionFinding, ObjectionSeverity } from './team-task-workflow.js';

/** Classes whose defects are invisible in normal usage, so a reviewer cannot
 *  confirm or refute them without a location and a concrete scenario. */
export const EVIDENCE_REQUIRED_CLASSES: ReadonlySet<ObjectionClass> = new Set([
  'concurrency',
  'data-integrity',
  'security',
]);

/** What a blocking finding failed to supply. Carried into the re-prompt as the
 *  ask, and into the run record as the downgrade reason. */
export type EvidenceGap = 'location' | 'failure-scenario';

/** Below this a rationale is an exclamation, not a description.
 *
 *  Deliberately LOW. An earlier draft used a 40-char floor as a proxy for
 *  "concrete scenario" and it flagged real findings — `unsanitized shell
 *  interpolation` is 31 characters and is a perfectly good security rationale.
 *  Prose substance is not mechanically detectable without false positives, and
 *  a false positive here downgrades a genuine blocking objection, which is the
 *  exact failure this contract exists to prevent. So the mechanical scenario
 *  check only catches the degenerate cases (empty, or a bare restatement of the
 *  class), and the re-prompt asks for the real thing. The load-bearing
 *  mechanical check is the LOCATION anchor — which is what the run-815bdec6
 *  verdict actually lacked. */
export const MIN_FAILURE_SCENARIO_CHARS = 12;

/** A rationale that only names the risk category — "security issue",
 *  "concurrency bug", "data integrity problem". */
const BARE_CLASS_RESTATEMENT =
  /^(?:a|an|the)?\s*(?:security|privacy|data[\s-]?integrity|concurrency|outbound|cost[\s-]?perf(?:ormance)?)\s*(?:issue|problem|bug|risk|concern|defect|violation|vulnerability)?\.?$/i;

/** Strings roles reach for instead of naming a place. */
const PLACEHOLDER_LOCATIONS: ReadonlySet<string> = new Set([
  '',
  '-',
  'n/a',
  'na',
  'none',
  'unknown',
  'unclear',
  'various',
  'multiple',
  'multiple files',
  'several files',
  'throughout',
  'everywhere',
  'the diff',
  'this diff',
  'see above',
  'see notes',
  'tbd',
]);

/** A path with a file extension, optionally `:line`. Deliberately not anchored
 *  to the whole string so `src/lease.ts:42 (withLease)` counts. */
const FILE_ANCHOR = /[\w./-]*[\w-]+\.[a-z][a-z0-9]{0,7}(?::\d+)?/i;

/** A command or test file a human can re-run to see the failure. */
const REPRODUCIBLE_FAILURE =
  /(\b(?:npm|npx|pnpm|yarn|vitest|jest|pytest|cargo|gradle|make|go)\s+\S)|\.(?:test|spec)\.[a-z]+\b/i;

export function isAnchoredLocation(location: string): boolean {
  const trimmed = location.trim();
  if (PLACEHOLDER_LOCATIONS.has(trimmed.toLowerCase())) return false;
  return FILE_ANCHOR.test(trimmed);
}

/** True when the rationale names something re-runnable. Such a finding is never
 *  downgraded, whatever its location and length. */
export function citesReproducibleFailure(rationale: string): boolean {
  return REPRODUCIBLE_FAILURE.test(rationale);
}

/** Whether this finding can block at all — `low` maps to pass-with-warnings. */
function isBlockingSeverity(severity: ObjectionSeverity): boolean {
  return severity !== 'low';
}

/** The contract, as a list of what is missing. Empty ⇒ the finding blocks
 *  exactly as it does today. */
export function evidenceGapsForFinding(finding: ObjectionFinding): EvidenceGap[] {
  if (!EVIDENCE_REQUIRED_CLASSES.has(finding.class)) return [];
  if (!isBlockingSeverity(finding.severity)) return [];
  if (citesReproducibleFailure(finding.rationale)) return [];

  const gaps: EvidenceGap[] = [];
  if (!isAnchoredLocation(finding.location)) gaps.push('location');
  if (!describesFailureScenario(finding.rationale)) gaps.push('failure-scenario');
  return gaps;
}

/** Degenerate-case check only — see `MIN_FAILURE_SCENARIO_CHARS`. */
export function describesFailureScenario(rationale: string): boolean {
  const trimmed = rationale.trim();
  if (trimmed.length < MIN_FAILURE_SCENARIO_CHARS) return false;
  return !BARE_CLASS_RESTATEMENT.test(trimmed);
}

/** One-line, human-readable ask — used both to re-prompt the role and to record
 *  why a finding was downgraded. */
export function describeEvidenceGaps(gaps: readonly EvidenceGap[]): string {
  const parts = gaps.map((gap) =>
    gap === 'location'
      ? 'a concrete location (file with extension, ideally file:line)'
      : 'a concrete failure scenario describing how the defect actually manifests');
  return parts.join(' and ');
}

/** Stable identity for a finding across a re-prompt and across rounds. Mirrors
 *  the terminal-bug dedup key so the same defect reads the same everywhere. */
export function findingSignature(finding: ObjectionFinding): string {
  return `${finding.class}/${finding.severity} @ ${finding.location.trim()} — ` +
    finding.rationale.replace(/\s+/g, ' ').trim();
}
