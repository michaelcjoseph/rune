import { describe, it, expect } from 'vitest';

/*
 * Test-first suite for test-plan.md §8 — journal-to-intent flow (08-intent-layer, Phase 2).
 *
 * Written BEFORE the implementation. `src/intent/journal-intent.ts` ships as a contract stub
 * whose `planJournalIntent` throws 'not implemented', so every test here is RED. That is the
 * intended, correct state: this is a "Tests (write first)" task — the suite goes green when
 * a Phase 2 journal-intake implementation task lands. Do not implement the flow to make
 * these pass; that is a separate task.
 *
 * Scope note: test-plan §8's "proposals surface on Telegram and in the cockpit" is a
 * delivery property — `planJournalIntent` produces the proposals; routing them to a surface
 * is downstream. This suite asserts the plan produces both intake and roadmap proposals;
 * the Telegram/cockpit delivery is covered when the flow is wired in.
 */

import {
  planJournalIntent,
  type JournalIntentInput,
} from './journal-intent.js';

// --- Fixtures ---

/** A journal-intent input; override any field per test. */
function input(overrides: Partial<JournalIntentInput> = {}): JournalIntentInput {
  return {
    notes: [],
    roadmapCandidates: [],
    registeredProducts: ['aura', 'relay'],
    ...overrides,
  };
}

describe('journal-to-intent flow — vault intake (test-plan §8)', () => {
  it('proposes synthesizing a note about a registered product into that product\'s vault file', () => {
    const plan = planJournalIntent(
      input({ notes: [{ text: 'Aura pricing idea: tier on seats', products: ['aura'] }] }),
    );
    const intake = plan.proposals.find((p) => p.kind === 'vault-intake');
    expect(intake).toBeDefined();
    expect(intake).toMatchObject({ kind: 'vault-intake', product: 'aura' });
  });

  it('is propose-only — planning produces proposals and never writes (the user confirms each)', () => {
    // planJournalIntent takes no effects/writer argument and returns a plan; the inferred
    // change is surfaced as a proposal, never silently applied. Determinism stands in for
    // "pure": the same input always yields the same plan.
    const a = planJournalIntent(input({ notes: [{ text: 'note', products: ['aura'] }] }));
    const b = planJournalIntent(input({ notes: [{ text: 'note', products: ['aura'] }] }));
    expect(a).toEqual(b);
  });

  it('produces no proposals and no noise for a journal day with no product-relevant notes', () => {
    const plan = planJournalIntent(
      input({ notes: [{ text: 'went for a run, felt good', products: [] }] }),
    );
    expect(plan.proposals).toEqual([]);
  });
});

describe('journal-to-intent flow — roadmap proposals (test-plan §8)', () => {
  it('proposes a vault product file\'s actionable item as a roadmap item in the right repo', () => {
    const plan = planJournalIntent(
      input({ roadmapCandidates: [{ product: 'relay', item: 'add SSO to the relay console' }] }),
    );
    const roadmap = plan.proposals.find((p) => p.kind === 'roadmap');
    expect(roadmap).toMatchObject({ kind: 'roadmap', product: 'relay', item: 'add SSO to the relay console' });
  });

  it('does not propose a roadmap item for an unregistered product\'s candidate', () => {
    const plan = planJournalIntent(
      input({ roadmapCandidates: [{ product: 'watt-data', item: 'untracked item' }] }),
    );
    // watt-data is not registered — no roadmap proposal targeting a non-existent repo.
    expect(plan.proposals.some((p) => p.kind === 'roadmap')).toBe(false);
  });

  it('surfaces both intake and roadmap proposals from a single plan', () => {
    const plan = planJournalIntent(
      input({
        notes: [{ text: 'Aura idea', products: ['aura'] }],
        roadmapCandidates: [{ product: 'relay', item: 'relay roadmap item' }],
      }),
    );
    const kinds = new Set(plan.proposals.map((p) => p.kind));
    expect(kinds.has('vault-intake')).toBe(true);
    expect(kinds.has('roadmap')).toBe(true);
  });
});

describe('journal-to-intent flow — unregistered and ambiguous products (test-plan §8)', () => {
  it('routes a note about an unregistered product to product registration, not a dropped note', () => {
    const plan = planJournalIntent(
      input({ notes: [{ text: 'started thinking about watt-data', products: ['watt-data'] }] }),
    );
    // watt-data is not in registeredProducts — the note triggers registration (§2).
    expect(plan.proposals.find((p) => p.kind === 'register-product')).toMatchObject({
      kind: 'register-product',
      product: 'watt-data',
    });
    // It is never synthesized straight into a (non-existent) vault file.
    expect(plan.proposals.some((p) => p.kind === 'vault-intake')).toBe(false);
  });

  it('surfaces an ambiguous note for disambiguation rather than guessing a product silently', () => {
    const plan = planJournalIntent(
      input({ notes: [{ text: 'shared auth idea', products: ['aura', 'relay'] }] }),
    );
    const disambiguation = plan.proposals.find((p) => p.kind === 'disambiguation');
    expect(disambiguation).toMatchObject({
      kind: 'disambiguation',
      candidates: expect.arrayContaining(['aura', 'relay']),
    });
    // No intake proposal is produced — the flow does not guess which product the note is for.
    expect(plan.proposals.some((p) => p.kind === 'vault-intake')).toBe(false);
  });
});
