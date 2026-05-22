import { describe, it, expect } from 'vitest';

/*
 * Test suite for the self-generated-project dispatch adapter (08-intent-layer, Phase 5).
 * The loop files a `ProjectIdea`; this adapter turns it into a `DispatchPlan` — either
 * dispatch to the existing project-execution engine or hold for Michael's approval — gated
 * on the escalation policy. The escalation decision is injected so the adapter is
 * unit-testable; in production it is the policy from src/intent/escalation.ts evaluated
 * with `specOrigin: 'self-generated'`.
 *
 * Scope: the adapter is pure; the actual createMutation / workRunApplier dispatch is
 * orchestration that uses the existing engine ("no new execution subsystem").
 */

import { planEngineDispatch, type DispatchPlan } from './observation-dispatch.js';
import type { ProjectIdea } from './observation-loop.js';

const idea: ProjectIdea = {
  title: 'Fix the friction',
  friction: 'the recurring friction',
  id: 'fix-friction',
};

describe('observation dispatch — planEngineDispatch', () => {
  it('dispatches when the escalation policy proceeds', () => {
    const plan = planEngineDispatch(idea, () => 'proceed');
    const expected: DispatchPlan = { action: 'dispatch', projectSlug: 'fix-friction' };
    expect(plan).toEqual(expected);
  });

  it('holds for approval when the escalation policy flags the change', () => {
    const plan = planEngineDispatch(idea, () => 'escalate');
    expect(plan.action).toBe('await-approval');
    expect(plan).toMatchObject({ action: 'await-approval', reason: expect.stringMatching(/escalat|approval/i) });
  });

  it('derives the projectSlug from the idea.id', () => {
    const other: ProjectIdea = { ...idea, id: 'different-slug' };
    const plan = planEngineDispatch(other, () => 'proceed');
    expect(plan).toEqual({ action: 'dispatch', projectSlug: 'different-slug' });
  });

  it('passes the idea to the decideEscalation callback', () => {
    let seen: ProjectIdea | undefined;
    planEngineDispatch(idea, (i) => {
      seen = i;
      return 'proceed';
    });
    expect(seen).toBe(idea);
  });
});
