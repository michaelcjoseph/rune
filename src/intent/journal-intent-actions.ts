/**
 * Real-world `ConsumerDeps` implementation for `actionApprovedIntentProposal`.
 * Phase 6 C8 wire-up: when the cockpit inbox or Telegram callback approves
 * an intent-proposal, the dispatch path invokes the consumer with these
 * deps, turning a proposal into a concrete file write / repo edit /
 * registration trigger.
 *
 * Scope today:
 *   - `vault-intake` → append the note as a journal-sourced bullet to
 *     `projects/<product>.md`. Minimum-viable wiring; an updater-agent
 *     pass that does proper synthesis comes in a follow-up.
 *   - `roadmap` → throws "wire-up deferred". The product-repo write
 *     boundary needs a product-config lookup (`policies/products.json`)
 *     plus the repo's roadmap-file convention; both are out of scope
 *     for the immediate C8 commit. The consumer's slug-validation +
 *     dispatch already guards safety; the dep stays explicit-not-silent.
 *   - `register-product` → throws "wire-up deferred". The Phase 1
 *     registration flow needs the planner integration to fully wire;
 *     the throw surfaces the gap rather than silently no-op'ing.
 *
 * Live verification (the C8 user task) will refine these — the wired-up
 * vault-intake path lets the user observe the propose-and-approve loop
 * end-to-end without waiting on the deferred deps.
 */

import { appendVaultFile, readVaultFile, writeVaultFile } from '../vault/files.js';
import type { ConsumerDeps } from './journal-intent-consumer.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('journal-intent-actions');

/** Real-world dep implementations. Pure module — no state of its own; each
 *  call is independent. */
export const realConsumerDeps: ConsumerDeps = {
  async invokeVaultUpdater({ product, note }) {
    // Append a journal-sourced bullet to `projects/<product>.md`. The
    // product name is already VALID_SLUG-guarded by the consumer before
    // this dep is called — but as a belt-and-suspenders the path is
    // constructed inside the vault root via the existing append helper,
    // which itself goes through `assertWithinVault`.
    const path = `projects/${product}.md`;
    const existing = readVaultFile(path);
    // Initialize the file with a Notes section if it doesn't exist —
    // create-or-append is the safe default. A missing target shouldn't
    // silently drop the user's note.
    if (existing === null) {
      const header = `# ${product}\n\n## Notes (from journal)\n\n`;
      writeVaultFile(path, `${header}- ${note}\n`);
    } else {
      appendVaultFile(path, `- ${note}\n`);
    }
    log.info('vault-intake: appended note', { product, len: note.length });
    return { ok: true };
  },

  async appendRoadmap({ product, item }) {
    // Wire-up deferred — surfaces a clear error instead of silently
    // succeeding. The consumer's dispatch already validated `product`;
    // when this lands it will read the product config from
    // policies/products.json (repo path + roadmap file convention) and
    // append `item` to that file with a git commit, mirroring the
    // existing gen-eval-loop git surface.
    log.warn('appendRoadmap: wire-up deferred', { product, item });
    throw new Error(
      `appendRoadmap is wire-up-deferred — the roadmap proposal for product '${product}' was approved but cannot be actioned yet. Update src/intent/journal-intent-actions.ts to implement.`,
    );
  },

  async registerProduct({ product }) {
    // Wire-up deferred — same shape as appendRoadmap. Phase 1 registration
    // needs the planner-flow integration to fully wire; throwing here
    // surfaces the gap, leaves the queue entry pending, and prevents a
    // silent no-op that would lose the user's intent.
    log.warn('registerProduct: wire-up deferred', { product });
    throw new Error(
      `registerProduct is wire-up-deferred — the register-product proposal for '${product}' was approved but cannot be actioned yet. Run the planner flow manually for now.`,
    );
  },
};
