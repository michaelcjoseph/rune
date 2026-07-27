/**
 * Stable domain contract for managed-context closeout failures.
 *
 * The curator produces these records; orchestration, persistence, and Cockpit
 * surfaces consume them. Keeping the durable vocabulary here avoids coupling
 * those consumers to either the curator or the project-orchestrator
 * implementation.
 */

export const CONTEXT_UPDATE_REASONS = [
  'missing-section',
  'duplicate-managed-section',
  'managed-heading-collision',
  'embedded-section-header',
  'over-budget',
  'transcript-dump',
  'needs-tech-lead-validation',
  'needs-pm-validation',
] as const;

export type ContextUpdateReason = typeof CONTEXT_UPDATE_REASONS[number];

/** Durable display bounds shared by the producer and persistence reader. */
export const CONTEXT_CONFLICTING_HEADINGS_MAX = 10;
export const CONTEXT_PROPOSED_REPAIR_MAX_CHARS = 500;

export interface ContextUpdateFailure {
  reason: ContextUpdateReason;
  canonicalHeading?: string;
  /** Bounded sample of the conflicting managed headings. */
  conflictingHeadings?: string[];
  /** Total conflicts when the bounded sample omits one or more occurrences. */
  conflictingHeadingCount?: number;
  proposedRepair: string;
}

export type WipCheckpointResult =
  | { kind: 'committed'; sha: string }
  | { kind: 'already-clean' }
  | { kind: 'failed'; diagnostic: string };

export interface ContextCloseoutFailure extends ContextUpdateFailure {
  /** Scrubbed worktree-relative path derived from the resolved project dir. */
  file: string;
  checkpoint: WipCheckpointResult;
}

export function isContextUpdateReason(value: unknown): value is ContextUpdateReason {
  return typeof value === 'string' &&
    CONTEXT_UPDATE_REASONS.includes(value as ContextUpdateReason);
}

export function checkpointWipSha(
  checkpoint: WipCheckpointResult,
): string | undefined {
  return checkpoint.kind === 'committed' ? checkpoint.sha : undefined;
}
