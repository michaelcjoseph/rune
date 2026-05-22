import { describe, it, expect } from 'vitest';

/*
 * Test suite for test-plan.md §9 — Planner, Layer 1 (08-intent-layer, Phase 3).
 *
 * Written test-first; `src/intent/planner.ts` now implements the lifecycle state machine,
 * so the suite is green.
 *
 * Scope note: the conversation itself (the questions the Planner asks, the LLM scoping) is
 * orchestration and not unit-testable here. This suite pins the lifecycle state machine and
 * the approval gate — the deterministic contract beneath the conversation.
 */

import {
  startPlanning,
  proposeSpec,
  approvePlan,
  abandonPlan,
  isScaffoldReady,
  buildSetupWriterBrief,
  type SpecArtifact,
  type PlanningSurface,
} from './planner.js';

// --- Fixtures ---

/** A complete spec artifact, as the Planner would propose it. */
function sampleArtifact(): SpecArtifact {
  return {
    product: 'aura',
    title: 'Seat-based pricing tiers',
    spec: 'Add seat-based pricing tiers to Aura.',
    tasks: '## Phase 1\n### Tests (write first)\n- [ ] ...\n### Implementation\n- [ ] ...',
    testPlan: '## 1. Pricing tiers\n- [ ] tiers compute correctly',
  };
}

describe('Planner — scoping the idea (test-plan §9)', () => {
  it('starts a fuzzy idea in scoping — it does not jump straight to a spec', () => {
    const session = startPlanning('maybe do something with pricing', 'chat', 'aura');
    expect(session.status).toBe('scoping');
    // No spec exists yet — the Planner has questions to ask first.
    expect(session.artifact).toBeUndefined();
    expect(session).toMatchObject({ idea: 'maybe do something with pricing', product: 'aura' });
  });
});

describe('Planner — the approval gate (test-plan §9)', () => {
  it('is not scaffold-ready while scoping or after a spec is merely proposed', () => {
    const scoping = startPlanning('an idea', 'chat', 'aura');
    expect(isScaffoldReady(scoping)).toBe(false);
    const proposed = proposeSpec(scoping, sampleArtifact());
    expect(proposed.status).toBe('spec-proposed');
    // A proposed-but-unapproved spec still dispatches nothing.
    expect(isScaffoldReady(proposed)).toBe(false);
  });

  it('becomes scaffold-ready only once the spec is approved', () => {
    const approved = approvePlan(proposeSpec(startPlanning('an idea', 'chat', 'aura'), sampleArtifact()));
    expect(approved.status).toBe('approved');
    expect(isScaffoldReady(approved)).toBe(true);
  });

  it('refuses to approve a session that has no proposed spec yet', () => {
    // Nothing is approved before the artifact exists.
    expect(() => approvePlan(startPlanning('an idea', 'chat', 'aura'))).toThrow(/spec|propos/i);
  });

  it('refuses to propose a spec on a session that is not scoping', () => {
    const proposed = proposeSpec(startPlanning('an idea', 'chat', 'aura'), sampleArtifact());
    expect(() => proposeSpec(proposed, sampleArtifact())).toThrow(/scoping|propos|already/i);
  });
});

describe('Planner — the spec artifact (test-plan §9)', () => {
  it('carries the spec, tasks, and test-plan that scaffold into the three project files', () => {
    const approved = approvePlan(proposeSpec(startPlanning('an idea', 'chat', 'aura'), sampleArtifact()));
    // The approved session carries exactly the proposed artifact — spec, tasks, test-plan.
    expect(approved.artifact).toEqual(sampleArtifact());
  });
});

describe('Planner — scaffolding the approved plan (test-plan §9)', () => {
  it('builds a project-setup-writer brief carrying all three artifact parts', () => {
    const approved = approvePlan(proposeSpec(startPlanning('an idea', 'chat', 'aura'), sampleArtifact()));
    const brief = buildSetupWriterBrief(approved);
    const art = sampleArtifact();
    expect(brief).toContain(art.title);
    expect(brief).toContain(art.product);
    expect(brief).toContain(art.spec); // → spec.md
    expect(brief).toContain(art.tasks); // → tasks.md
    expect(brief).toContain(art.testPlan); // → test-plan.md
  });

  it('carries the per-phase Tests (write first) block into the brief', () => {
    const approved = approvePlan(proposeSpec(startPlanning('an idea', 'chat', 'aura'), sampleArtifact()));
    expect(buildSetupWriterBrief(approved)).toContain('Tests (write first)');
  });

  it('refuses to build a scaffold brief before the plan is approved', () => {
    // Nothing is scaffolded before approval.
    const proposed = proposeSpec(startPlanning('an idea', 'chat', 'aura'), sampleArtifact());
    expect(() => buildSetupWriterBrief(proposed)).toThrow(/approv|scaffold/i);
  });
});

describe('Planner — chat and cockpit surfaces (test-plan §9)', () => {
  it('runs the full scoping → propose → approve flow identically on both surfaces', () => {
    for (const surface of ['chat', 'cockpit'] as const satisfies readonly PlanningSurface[]) {
      const approved = approvePlan(
        proposeSpec(startPlanning('an idea', surface, 'aura'), sampleArtifact()),
      );
      expect(approved.status).toBe('approved');
      expect(approved.surface).toBe(surface);
      expect(isScaffoldReady(approved)).toBe(true);
    }
  });
});

describe('Planner — abandonment (test-plan §9)', () => {
  it('abandoning a scoping session leaves nothing half-written and nothing scaffold-ready', () => {
    const abandoned = abandonPlan(startPlanning('an idea', 'chat', 'aura'));
    expect(abandoned.status).toBe('abandoned');
    // Scoping wrote no project files; an abandoned session is never scaffold-ready.
    expect(isScaffoldReady(abandoned)).toBe(false);
  });

  it('abandoning a session after a spec was proposed is allowed', () => {
    const proposed = proposeSpec(startPlanning('an idea', 'cockpit', 'aura'), sampleArtifact());
    expect(abandonPlan(proposed).status).toBe('abandoned');
  });

  it('refuses to abandon a session that has already reached a terminal state', () => {
    const approved = approvePlan(proposeSpec(startPlanning('an idea', 'chat', 'aura'), sampleArtifact()));
    expect(() => abandonPlan(approved)).toThrow(/approved|terminal|already/i);
  });
});

describe('Planner — product scoping (test-plan §9)', () => {
  it('scopes the session to a product — the basis for product-scoped retrieval (overlay §3)', () => {
    const session = startPlanning('an idea', 'chat', 'relay');
    expect(session.product).toBe('relay');
  });
});
