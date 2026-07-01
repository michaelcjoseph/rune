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

/** The PM-only approval artifact emitted by the project-20 scoping flow. */
function samplePmSpecArtifact() {
  return {
    version: 2,
    kind: 'pm-spec',
    product: 'aura',
    title: 'Seat-based pricing tiers',
    spec: 'Add seat-based pricing tiers to Aura.',
    assumptions: ['Seat count is already tracked.'],
    selfReview: { revised: false, summary: 'Spec is internally consistent.' },
  } as const;
}

function approvedPmSpecSession(surface: PlanningSurface = 'chat') {
  return approvePlan(
    proposeSpec(startPlanning('an idea', surface, 'aura'), samplePmSpecArtifact() as any),
  ) as any;
}

function approvedSessionWithDownstream(surface: PlanningSurface = 'chat') {
  return {
    ...approvedPmSpecSession(surface),
    downstreamArtifact: sampleArtifact(),
  } as any;
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
    const proposed = proposeSpec(scoping, samplePmSpecArtifact() as any);
    expect(proposed.status).toBe('spec-proposed');
    // A proposed-but-unapproved spec still dispatches nothing.
    expect(isScaffoldReady(proposed)).toBe(false);
  });

  it('does not become scaffold-ready when only the PM spec has been approved', () => {
    const approved = approvedPmSpecSession();
    expect(approved.status).toBe('approved');
    expect(isScaffoldReady(approved)).toBe(false);
  });

  it('becomes scaffold-ready only after the downstream full scaffold artifact is persisted', () => {
    const approved = approvedSessionWithDownstream();
    expect(approved.status).toBe('approved');
    expect(isScaffoldReady(approved)).toBe(true);
  });

  it('refuses to approve a session that has no proposed spec yet', () => {
    // Nothing is approved before the artifact exists.
    expect(() => approvePlan(startPlanning('an idea', 'chat', 'aura'))).toThrow(/spec|propos/i);
  });

  it('refuses to propose a spec on a session that is not scoping', () => {
    const proposed = proposeSpec(startPlanning('an idea', 'chat', 'aura'), samplePmSpecArtifact() as any);
    expect(() => proposeSpec(proposed, samplePmSpecArtifact() as any)).toThrow(
      /scoping|propos|already/i,
    );
  });

  it('has exactly one planning-flow human approval gate before downstream automation', () => {
    const scoping = startPlanning('an idea', 'chat', 'aura');
    const proposed = proposeSpec(scoping, samplePmSpecArtifact() as any);
    const approved = approvePlan(proposed);
    const downstreamReady = { ...approved, downstreamArtifact: sampleArtifact() } as any;

    const planningFlowStates = [scoping, proposed, approved, downstreamReady];
    const humanGateStates = planningFlowStates.filter((session) => session.status === 'spec-proposed');

    expect(humanGateStates).toHaveLength(1);
    expect(() => approvePlan(scoping)).toThrow(/spec|propos/i);
    expect(() => approvePlan(approved)).toThrow(/spec|propos|approved/i);
    expect(() => approvePlan(downstreamReady)).toThrow(/spec|propos|approved/i);
  });
});

describe('Planner — the spec artifact (test-plan §9)', () => {
  it('keeps the approved PM spec separate from the downstream scaffold artifact', () => {
    const approved = approvedSessionWithDownstream();
    expect(approved.approvedSpec).toEqual(samplePmSpecArtifact());
    expect(approved.artifact).toBeUndefined();
    expect(approved.downstreamArtifact).toEqual(sampleArtifact());
  });
});

describe('Planner — PM-spec approval state (project 20 test-plan §1)', () => {
  it('stores the pending approval as a versioned PM-only artifact, not a full scaffold artifact', () => {
    const approved = approvedPmSpecSession();

    expect(approved.status).toBe('approved');
    expect(approved.approvedSpec).toEqual(samplePmSpecArtifact());
    expect(approved.artifact).toBeUndefined();
    expect(approved.downstreamArtifact).toBeUndefined();
  });

  it('does not treat an approved PM-only spec as scaffold-ready until downstream planning is persisted', () => {
    const approved = approvedPmSpecSession();

    expect(isScaffoldReady(approved)).toBe(false);
    expect(() => buildSetupWriterBrief(approved)).toThrow(/downstream|full scaffold|approved spec/i);
  });

  it('hard-fails legacy proposed artifacts by the absence of the versioned pm-spec discriminant', () => {
    const legacyProposed = proposeSpec(startPlanning('legacy idea', 'chat', 'aura'), sampleArtifact());

    expect(() => approvePlan(legacyProposed)).toThrow(/restart planning|legacy|pm-spec/i);
  });

  it('requires the exact version 2 pm-spec discriminant, not only a pm-spec-shaped object', () => {
    const wrongVersion = {
      ...samplePmSpecArtifact(),
      version: 1,
    };
    const proposed = proposeSpec(startPlanning('old pm-spec idea', 'chat', 'aura'), wrongVersion as any);

    expect(() => approvePlan(proposed)).toThrow(/restart planning|legacy|pm-spec/i);
  });
});

describe('Planner — scaffolding the approved plan (test-plan §9)', () => {
  it('builds a project-setup-writer brief carrying all three artifact parts', () => {
    const approved = approvedSessionWithDownstream();
    const brief = buildSetupWriterBrief(approved);
    const art = sampleArtifact();
    expect(brief).toContain(art.title);
    expect(brief).toContain(art.product);
    expect(brief).toContain(art.spec); // → spec.md
    expect(brief).toContain(art.tasks); // → tasks.md
    expect(brief).toContain(art.testPlan); // → test-plan.md
  });

  it('carries the per-phase Tests (write first) block into the brief', () => {
    const approved = approvedSessionWithDownstream();
    expect(buildSetupWriterBrief(approved)).toContain('Tests (write first)');
  });

  it('refuses to build a scaffold brief before the plan is approved', () => {
    // Nothing is scaffolded before approval.
    const proposed = proposeSpec(startPlanning('an idea', 'chat', 'aura'), samplePmSpecArtifact() as any);
    expect(() => buildSetupWriterBrief(proposed)).toThrow(/approv|scaffold/i);
  });
});

describe('Planner — chat and cockpit surfaces (test-plan §9)', () => {
  it('runs the full scoping → propose → approve flow identically on both surfaces', () => {
    for (const surface of ['chat', 'cockpit'] as const satisfies readonly PlanningSurface[]) {
      const approved = approvedSessionWithDownstream(surface);
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
    const proposed = proposeSpec(startPlanning('an idea', 'cockpit', 'aura'), samplePmSpecArtifact() as any);
    expect(abandonPlan(proposed).status).toBe('abandoned');
  });

  it('refuses to abandon a session that has already reached a terminal state', () => {
    const approved = approvedPmSpecSession();
    expect(() => abandonPlan(approved)).toThrow(/approved|terminal|already/i);
  });
});

describe('Planner — product scoping (test-plan §9)', () => {
  it('scopes the session to a product — the basis for product-scoped retrieval (overlay §3)', () => {
    const session = startPlanning('an idea', 'chat', 'relay');
    expect(session.product).toBe('relay');
  });
});
