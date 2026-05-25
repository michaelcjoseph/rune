/**
 * Journal-to-intent consumer — actions an approved `IntentProposal` by
 * dispatching the proposal-type-specific write side-effect. The dispatch
 * shape is what this module pins; the actual file writes / repo edits /
 * registration call are injected as `ConsumerDeps` so the module stays
 * pure-of-I/O and the test suite can assert on dispatch without staging
 * a vault or repo.
 *
 * The four IntentProposal kinds dispatch as follows:
 *   - `vault-intake`     → `invokeVaultUpdater({product, note})` — synthesize
 *     the note into `projects/<product>.md` via an updater agent.
 *   - `roadmap`          → `appendRoadmap({product, item})` — append a
 *     roadmap item to the product repo's roadmap file.
 *   - `register-product` → `registerProduct({product})` — kick off the
 *     Phase 1 registration flow for the new product.
 *   - `disambiguation`   → no-op. The user must pick a product first; until
 *     they do, no write is safe. The cockpit/Telegram surface re-asks the
 *     user; on a second-round approval they'll see a concrete proposal
 *     (vault-intake or register-product), not the original disambiguation.
 *
 * STATUS: Phase 6 C8 — consumer. The wire-up from the approval surface
 * (cockpit POST /api/approvals/:id/approve → this consumer; Telegram
 * callback_query → this consumer) belongs to a follow-up; this module is
 * the dispatch core that wire-up consumes.
 *
 * Test contract: `src/intent/journal-intent-e2e.test.ts` §"C8".
 */

import type { IntentProposal } from './journal-intent.js';
import { VALID_SLUG } from './sandbox.js';

/** I/O dependencies the consumer needs — injected so tests can assert
 *  dispatch shape without staging real file writes or agent spawns. Each
 *  function is async to mirror real-world writes; return shape is
 *  implementation-defined (the wire-up caller decides what to do with the
 *  result — typically log on failure, surface to the user). */
export interface ConsumerDeps {
  /** Synthesize a note into `projects/<product>.md`. */
  invokeVaultUpdater(input: { product: string; note: string }): Promise<unknown>;
  /** Append an actionable item to the product repo's roadmap. */
  appendRoadmap(input: { product: string; item: string }): Promise<unknown>;
  /** Run the Phase 1 product registration flow for a new product. */
  registerProduct(input: { product: string }): Promise<unknown>;
}

/**
 * Action an approved IntentProposal. Returns whatever the dispatched dep
 * returns, or `undefined` for the no-op `disambiguation` branch. Failures
 * propagate from the dep — the consumer doesn't try/catch them, so the
 * wire-up caller decides whether a failed write should re-queue the
 * proposal, surface an error to the user, or both.
 */
export async function actionApprovedIntentProposal(
  proposal: IntentProposal,
  deps: ConsumerDeps,
): Promise<unknown> {
  // Slug-validate at the boundary — every dep below feeds `product` into
  // either a vault path (`projects/<product>.md`) or a spawn argument; a
  // crafted journal note with `../` would otherwise break out of the
  // expected target. The scanner already restricts to `[a-z0-9_-]+`, but
  // the consumer accepts any `IntentProposal` and can't trust upstream
  // construction. Same pattern as src/intent/sandbox.ts / dispatch-runtime.
  if (proposal.kind !== 'disambiguation' && !VALID_SLUG.test(proposal.product)) {
    throw new Error(`actionApprovedIntentProposal: invalid product slug ${JSON.stringify(proposal.product)}`);
  }
  switch (proposal.kind) {
    case 'vault-intake':
      return deps.invokeVaultUpdater({ product: proposal.product, note: proposal.note });
    case 'roadmap':
      return deps.appendRoadmap({ product: proposal.product, item: proposal.item });
    case 'register-product':
      return deps.registerProduct({ product: proposal.product });
    case 'disambiguation':
      // Disambiguation needs a human pick first — no safe write to make.
      // The cockpit/Telegram surface re-asks the user; a future round of
      // approval will see a concrete proposal kind, not this one.
      return undefined;
    default: {
      // Compile-time exhaustiveness — same pattern as
      // src/intent/registration.ts / src/intent/journal-intent-producer.ts.
      // Adding a new IntentProposal kind without updating the switch
      // becomes a TS error, not a silent undefined return.
      const _exhaustive: never = proposal;
      throw new Error(`actionApprovedIntentProposal: unhandled kind ${JSON.stringify(_exhaustive)}`);
    }
  }
}
