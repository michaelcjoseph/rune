/**
 * Test-suite-as-deliverable for journal-to-intent end-to-end (project
 * 08-intent-layer Phase 6 Track C / test-plan.md §21). Written
 * test-first ahead of C7 (nightly producer) and C8 (post-approval
 * consumer/actioning). Failing tests pin the contracts the impl
 * must satisfy.
 *
 * The pure planner `planJournalIntent` (`src/intent/journal-intent.ts`)
 * is already shipped — it's the proposal-construction core. What's
 * missing:
 *   - C7: `scanJournalForIntent(content, registeredProducts)` — extract
 *     `JournalNote[]` from a day's journal text. The nightly step then
 *     feeds these (plus vault-product-file `RoadmapCandidate[]`) into
 *     `planJournalIntent` and writes the result to
 *     `logs/intent-proposal-queue.json`.
 *   - C8: `actionApprovedIntentProposal(proposal)` — given an approved
 *     proposal, perform the write side-effect: `vault-intake` invokes
 *     an updater agent against `projects/<product>.md`; `roadmap`
 *     appends to the product repo's roadmap file; `register-product`
 *     triggers the registration flow from Phase 1.
 *   - Dedupe + idempotency at the queue level: rejected proposals stay
 *     rejected; the producer doesn't re-enqueue the same source-note
 *     twice on consecutive nightly runs.
 *
 * DOM-side UX (surface in cockpit + Telegram) is covered by §19/§20
 * suites; this file is the data-flow end-to-end pinning.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// The pure planner exists today.
import { planJournalIntent, type JournalNote, type IntentProposal } from './journal-intent.js';

// ---------------------------------------------------------------------------
// §21. Journal scanner (C7)
// ---------------------------------------------------------------------------
//
// `scanJournalForIntent` is the C7 producer's tag-parser. Given a day's
// journal markdown and the list of registered products, it returns the
// `JournalNote[]` the planner consumes.

describe('scanJournalForIntent (C7)', () => {
  it('detects #<product> tags and attributes the surrounding note to that product', async () => {
    // Dynamic import so the test file loads even before the module exists.
    let scan: undefined | ((content: string) => JournalNote[]);
    try {
      const mod = await import('./journal-intent-producer.js');
      scan = mod.scanJournalForIntent;
    } catch {
      // module not yet implemented
    }
    expect(scan).toBeDefined();
    const notes = scan!(
      '## Notes\n- 10am #aura investigate caching layer for API gateway\n- 11am morning notes\n',
    );
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0]!.products).toContain('aura');
    expect(notes[0]!.text).toContain('caching layer');
  });

  it('returns an empty array when no product-tagged notes exist', async () => {
    let scan: undefined | ((content: string) => JournalNote[]);
    try {
      scan = (await import('./journal-intent-producer.js')).scanJournalForIntent;
    } catch {}
    expect(scan).toBeDefined();
    expect(scan!('## Notes\n- 10am morning thoughts\n- 11am coffee\n')).toEqual([]);
  });

  it('routes a note with multiple #product tags to multiple products → planner emits a disambiguation', async () => {
    let scan: undefined | ((content: string) => JournalNote[]);
    try {
      scan = (await import('./journal-intent-producer.js')).scanJournalForIntent;
    } catch {}
    expect(scan).toBeDefined();
    const notes = scan!(
      '- 10am #aura #rune cross-cutting friction with the resolver',
    );
    expect(notes.length).toBeGreaterThanOrEqual(1);
    const first = notes[0]!;
    expect(first.products.length).toBeGreaterThanOrEqual(2);
    // Routing through the planner produces a disambiguation proposal.
    const plan = planJournalIntent({
      notes, roadmapCandidates: [], registeredProducts: ['aura', 'rune'],
    });
    expect(plan.proposals.some((p: IntentProposal) => p.kind === 'disambiguation')).toBe(true);
  });

  it('ignores purely-numeric #<n> tags (prose list refs, not products)', async () => {
    let scan: undefined | ((content: string) => JournalNote[]);
    try {
      scan = (await import('./journal-intent-producer.js')).scanJournalForIntent;
    } catch {}
    expect(scan).toBeDefined();
    // Real misfires from the 2026-06-03 journal: "#4 is from your Julien call",
    // "approach #2". These must produce no product attribution at all.
    const notes = scan!(
      '- The cold-data item (#4) is from your Julien call, not Peter\n' +
        '- I narrowed the calldata question (#2) to just the assembly locus',
    );
    expect(notes).toEqual([]);
    // And mixed: a real product tag on a line that also has a numeric ref keeps
    // only the product.
    const mixed = scan!('- 10am #aura preferred approach #2 for the resolver');
    expect(mixed[0]!.products).toEqual(['aura']);
    // End-to-end: a numeric-only line yields no register-product / disambiguation.
    const plan = planJournalIntent({
      notes, roadmapCandidates: [], registeredProducts: ['aura'],
    });
    expect(plan.proposals).toEqual([]);
  });

  it('a note tagged with an UNregistered product yields a JournalNote so the planner emits a register-product proposal', async () => {
    let scan: undefined | ((content: string) => JournalNote[]);
    try {
      scan = (await import('./journal-intent-producer.js')).scanJournalForIntent;
    } catch {}
    expect(scan).toBeDefined();
    const notes = scan!('- 10am #newproduct first thought about a new product');
    expect(notes[0]!.products).toContain('newproduct');
    const plan = planJournalIntent({
      notes, roadmapCandidates: [], registeredProducts: ['aura'],
    });
    expect(plan.proposals.some((p: IntentProposal) => p.kind === 'register-product')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §21. Nightly producer step + queue write (C7)
// ---------------------------------------------------------------------------
//
// `runJournalIntentProducer({journalContent, vaultProductFiles, registeredProducts,
//   existingQueueEntries})` is the C7 step body. It builds the planner inputs,
// calls planJournalIntent, dedupes against existingQueueEntries by source-note
// id, and returns the proposals to enqueue. The actual queue I/O is the
// step caller's job (logs/intent-proposal-queue.json via
// src/intent/intent-proposal-queue.ts).

describe('runJournalIntentProducer (C7 — idempotency + dedupe)', () => {
  interface QueueEntry { sourceNoteId: string; proposal: IntentProposal }
  interface RunInput {
    journalContent: string;
    registeredProducts: string[];
    existingQueueEntries: QueueEntry[];
  }
  interface RunOutput {
    toEnqueue: QueueEntry[];
  }

  async function load(): Promise<undefined | ((input: RunInput) => RunOutput)> {
    try {
      return (await import('./journal-intent-producer.js')).runJournalIntentProducer;
    } catch {
      return undefined;
    }
  }

  it('a tagged note produces an IntentProposal entry ready for enqueue', async () => {
    const run = await load();
    expect(run).toBeDefined();
    const out = run!({
      journalContent: '- 10am #aura investigate caching layer',
      registeredProducts: ['aura'],
      existingQueueEntries: [],
    });
    expect(out.toEnqueue.length).toBeGreaterThanOrEqual(1);
    const first = out.toEnqueue[0]!;
    expect(first.proposal.kind).toBe('vault-intake');
    expect(first.sourceNoteId).toBeDefined();
  });

  it('idempotent: re-running on the same journal does not re-enqueue the same source-note', async () => {
    const run = await load();
    expect(run).toBeDefined();
    const journalContent = '- 10am #aura investigate caching layer';
    const firstPass = run!({
      journalContent, registeredProducts: ['aura'], existingQueueEntries: [],
    });
    expect(firstPass.toEnqueue.length).toBeGreaterThanOrEqual(1);
    // Second pass with the first pass's enqueued items already in the queue.
    const secondPass = run!({
      journalContent, registeredProducts: ['aura'],
      existingQueueEntries: firstPass.toEnqueue,
    });
    expect(secondPass.toEnqueue).toHaveLength(0);
  });

  it('a rejected proposal stays rejected — sourceNoteId still dedupes on next pass', async () => {
    const run = await load();
    expect(run).toBeDefined();
    const journalContent = '- 10am #aura investigate caching layer';
    const firstPass = run!({
      journalContent, registeredProducts: ['aura'], existingQueueEntries: [],
    });
    // Caller marks the proposal as rejected (status: 'rejected' is a queue
    // concept; we model it as the entry still being in existingQueueEntries
    // — the dedupe key is sourceNoteId, not status).
    const secondPass = run!({
      journalContent, registeredProducts: ['aura'],
      existingQueueEntries: firstPass.toEnqueue,
    });
    expect(secondPass.toEnqueue).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §21. Post-approval consumer (C8)
// ---------------------------------------------------------------------------
//
// `actionApprovedIntentProposal(proposal, deps)` dispatches the
// proposal-type-specific write side-effect. Tests pin the dispatch
// shape, not the actual file writes (those are covered by the updater
// agent's own contract).

describe('actionApprovedIntentProposal (C8)', () => {
  // Mirror the real ConsumerDeps signature but with vi.fn typings so the
  // test can assert call shape. Casting at the call boundary (where the
  // consumer receives a ConsumerDeps) preserves the structural contract.
  interface MockDeps {
    invokeVaultUpdater: ReturnType<typeof vi.fn>;
    appendRoadmap: ReturnType<typeof vi.fn>;
    registerProduct: ReturnType<typeof vi.fn>;
  }

  function deps(): MockDeps {
    return {
      invokeVaultUpdater: vi.fn(async () => ({ ok: true })),
      appendRoadmap: vi.fn(async () => ({ ok: true })),
      registerProduct: vi.fn(async () => ({ ok: true })),
    };
  }

  async function load(): Promise<undefined | ((proposal: IntentProposal, d: MockDeps) => Promise<unknown>)> {
    try {
      return (await import('./journal-intent-consumer.js')).actionApprovedIntentProposal;
    } catch {
      return undefined;
    }
  }

  it('vault-intake proposal calls invokeVaultUpdater with product + note', async () => {
    const action = await load();
    expect(action).toBeDefined();
    const d = deps();
    await action!(
      { kind: 'vault-intake', product: 'aura', note: 'investigate caching layer' },
      d,
    );
    expect(d.invokeVaultUpdater).toHaveBeenCalledTimes(1);
    expect(d.invokeVaultUpdater).toHaveBeenCalledWith(
      expect.objectContaining({ product: 'aura', note: 'investigate caching layer' }),
    );
    expect(d.appendRoadmap).not.toHaveBeenCalled();
    expect(d.registerProduct).not.toHaveBeenCalled();
  });

  it('roadmap proposal calls appendRoadmap with product + item', async () => {
    const action = await load();
    expect(action).toBeDefined();
    const d = deps();
    await action!(
      { kind: 'roadmap', product: 'aura', item: 'Add caching layer to API gateway' },
      d,
    );
    expect(d.appendRoadmap).toHaveBeenCalledTimes(1);
    expect(d.appendRoadmap).toHaveBeenCalledWith(
      expect.objectContaining({ product: 'aura', item: 'Add caching layer to API gateway' }),
    );
    expect(d.invokeVaultUpdater).not.toHaveBeenCalled();
  });

  it('register-product proposal calls registerProduct with the product slug', async () => {
    const action = await load();
    expect(action).toBeDefined();
    const d = deps();
    await action!(
      { kind: 'register-product', product: 'newproduct', note: 'first thought' },
      d,
    );
    expect(d.registerProduct).toHaveBeenCalledTimes(1);
    expect(d.registerProduct).toHaveBeenCalledWith(
      expect.objectContaining({ product: 'newproduct' }),
    );
  });

  it('disambiguation proposal does NOT dispatch any write — needs human pick first', async () => {
    const action = await load();
    expect(action).toBeDefined();
    const d = deps();
    await action!(
      { kind: 'disambiguation', note: 'cross-cutting friction', candidates: ['aura', 'rune'] },
      d,
    );
    expect(d.invokeVaultUpdater).not.toHaveBeenCalled();
    expect(d.appendRoadmap).not.toHaveBeenCalled();
    expect(d.registerProduct).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §21. Integration verification — outside this unit suite
// ---------------------------------------------------------------------------
//
// The full journal → producer → queue → cockpit → consumer → vault/repo
// path is exercised by the test-plan §21 integration check during live
// verification. The producer + consumer impls are unit-pinned above;
// the cross-surface plumbing (cockpit approve button → consumer fire,
// Telegram inline-keyboard tap → consumer fire) is covered by the
// §19/§20 suites in their respective files.

describe('§21 integration verification — live (out of unit scope)', () => {
  it.todo('end-to-end: tagged journal note → producer → queue → cockpit/Telegram → approve → vault/repo write');
});
