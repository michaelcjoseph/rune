/**
 * Self-generated-project dispatch adapter (Phase 5, project 08). The observation loop files
 * a `ProjectIdea` for a worthwhile friction; this adapter turns it into a `DispatchPlan` —
 * either dispatch to the existing project-execution engine, or hold for Michael's approval
 * — gated on the escalation policy. The escalation policy is injected so the adapter is
 * unit-testable; in production it is `decide`/`decideFailClosed` from
 * `src/intent/escalation.ts` evaluated with `specOrigin: 'self-generated'`.
 *
 * Per §16, this **uses the existing project-execution engine** (mutation pipeline +
 * work-runner) — no new execution subsystem. The orchestration layer reads the plan and
 * calls `createMutation('work-run', { projectSlug })` when the action is `dispatch`, or
 * surfaces an approval request when it is `await-approval`.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Phase 5"), test-plan.md (§16)}.
 */

import type { ProjectIdea } from './observation-loop.js';

/** The dispatch decision for a filed self-generated project. */
export type DispatchPlan =
  | { action: 'dispatch'; projectSlug: string }
  | { action: 'await-approval'; reason: string };

/**
 * Plan the dispatch for one filed idea. Calls `decideEscalation(idea)`; an `escalate`
 * verdict holds the run pending Michael's approval (a self-generated spec the policy flags
 * as too consequential), and a `proceed` verdict dispatches under the project slug derived
 * from the idea's id. The actual `createMutation` call is the integration layer's job.
 */
export function planEngineDispatch(
  idea: ProjectIdea,
  decideEscalation: (idea: ProjectIdea) => 'proceed' | 'escalate',
): DispatchPlan {
  if (decideEscalation(idea) === 'escalate') {
    return {
      action: 'await-approval',
      reason: 'escalation policy flagged the self-generated spec — awaiting approval',
    };
  }
  return { action: 'dispatch', projectSlug: idea.id };
}
