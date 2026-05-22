/**
 * Journal-to-intent flow — turns raw daily-journal notes about a product into proposals:
 * synthesis into the product's vault file, and the actionable part of a vault product file
 * carried as roadmap items into the product's repo.
 *
 * This module is the **propose** half. `planJournalIntent` is pure — it computes what
 * *would* change and never writes. It never silently rewrites scope: every inferred change
 * is a proposal the user sees and confirms (Regime A, propose-and-approve). The synthesis
 * itself (raw notes → polished vault prose) and the post-approval apply are separate steps;
 * this module decides *what* to propose and *to which product*.
 *
 * STATUS: contract stub. The type surface and signature below are the contract pinned by
 * the test-first suite in `journal-intent.test.ts` (test-plan.md §8). `planJournalIntent`
 * is intentionally unimplemented — a Phase 2 journal-intake task fills it in. Until then the
 * suite is RED by design.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Journal-to-intent flow"), test-plan.md (§8)}.
 */

/** A raw note from the daily journal, with the product(s) it is attributed to. */
export interface JournalNote {
  /** The note text. */
  text: string;
  /**
   * Products this note is attributed to — from `#product` tags, `[[wikilinks]]`, or an
   * upstream classifier. Empty when the note carries no product signal; more than one
   * when the attribution is ambiguous.
   */
  products: string[];
}

/** An actionable item lifted from a vault product file, headed for that product's repo. */
export interface RoadmapCandidate {
  /** The product whose vault file the item came from. */
  product: string;
  /** The actionable item text. */
  item: string;
}

/** Everything the journal-to-intent planner reads. */
export interface JournalIntentInput {
  /** Raw notes scanned from the day's journal. */
  notes: JournalNote[];
  /** Actionable items lifted from vault product files, to be proposed into repos. */
  roadmapCandidates: RoadmapCandidate[];
  /** Products that already have a registry entry. */
  registeredProducts: string[];
}

/**
 * One proposal the flow surfaces for approval. A discriminated union on `kind`:
 * - `vault-intake` — synthesize a note into a registered product's vault file.
 * - `roadmap` — carry an actionable item into a product's repo roadmap.
 * - `register-product` — a note names a product with no registry entry; register it first (§2).
 * - `disambiguation` — a note could belong to more than one product; the user must pick.
 */
export type IntentProposal =
  | { kind: 'vault-intake'; product: string; note: string }
  | { kind: 'roadmap'; product: string; item: string }
  | { kind: 'register-product'; product: string; note: string }
  | { kind: 'disambiguation'; note: string; candidates: string[] };

/** The propose half of propose-and-approve: every proposal the journal scan produced. */
export interface JournalIntentPlan {
  /** Ordered proposals; empty when the day's journal held nothing product-relevant. */
  proposals: IntentProposal[];
}

const NOT_IMPLEMENTED =
  'journal-intent: not implemented — a Phase 2 journal-intake task (docs/projects/08-intent-layer) fills this in';

/**
 * Plan the journal-to-intent proposals for a day. Pure — it computes what *would* change
 * and never writes; applying a proposal is a separate, post-approval step.
 *
 * Each note is routed by its attribution: a note with no product signal is skipped (no
 * proposal, no noise); a note attributed to one registered product yields a `vault-intake`
 * proposal; a note attributed to one *unregistered* product yields a `register-product`
 * proposal rather than being dropped; a note attributed to two or more products yields a
 * `disambiguation` proposal rather than a silent guess. Each roadmap candidate for a
 * registered product yields a `roadmap` proposal.
 */
export function planJournalIntent(_input: JournalIntentInput): JournalIntentPlan {
  throw new Error(NOT_IMPLEMENTED);
}
