/**
 * Pure decision core for the cockpit Fix gate. Runtime code gathers PM and
 * Tech-Lead facts; this function only applies the ordered, fail-closed gate.
 */
export type FixDeclineReason =
  | 'ineligible'
  | 'incomplete-fields'
  | 'pm-not-well-scoped'
  | 'tech-lead-objection';

export type FixGateResult =
  | { decision: 'declined'; reason: FixDeclineReason; detail?: string }
  | { decision: 'proceeding' };

export interface BugScopingFacts {
  /** The backlog item is an open bug with no parse warning / completed state. */
  itemEligible?: boolean;
  /** The bug has the minimum title/body detail required to act on. */
  fieldsComplete?: boolean;
  /** PM returned a parseable scoping assessment. */
  pmAssessed?: boolean;
  /** PM judged the bug well scoped enough for a one-click Fix run. */
  pmWellScoped?: boolean;
  /** PM's reason when the bug is not well scoped. */
  pmReason?: string;
  /** Tech Lead returned a parseable review. */
  techLeadReviewed?: boolean;
  /** Tech Lead objection when the run should not proceed. */
  techLeadObjection?: string;
}

const PM_UNASSESSED_DETAIL = 'PM scoping assessment was unavailable or unparseable.';
const PM_NOT_WELL_SCOPED_DETAIL = 'PM did not confirm the bug is well scoped.';
const TECH_LEAD_UNREVIEWED_DETAIL = 'Tech-Lead review was unavailable or unparseable.';

/**
 * Decide the Fix gate on already-gathered facts. First failure wins:
 *
 *   ineligible
 *   -> incomplete-fields
 *   -> pm-not-well-scoped
 *   -> tech-lead-objection
 *   -> proceeding
 */
export function evaluateBugFixGate(facts: BugScopingFacts): FixGateResult {
  if (facts.itemEligible !== true) return { decision: 'declined', reason: 'ineligible' };
  if (facts.fieldsComplete !== true) return { decision: 'declined', reason: 'incomplete-fields' };

  if (facts.pmAssessed !== true) {
    return { decision: 'declined', reason: 'pm-not-well-scoped', detail: PM_UNASSESSED_DETAIL };
  }
  if (facts.pmWellScoped !== true) {
    return {
      decision: 'declined',
      reason: 'pm-not-well-scoped',
      detail: facts.pmReason ?? PM_NOT_WELL_SCOPED_DETAIL,
    };
  }

  if (facts.techLeadReviewed !== true) {
    return { decision: 'declined', reason: 'tech-lead-objection', detail: TECH_LEAD_UNREVIEWED_DETAIL };
  }
  if (facts.techLeadObjection) {
    return { decision: 'declined', reason: 'tech-lead-objection', detail: facts.techLeadObjection };
  }

  return { decision: 'proceeding' };
}
