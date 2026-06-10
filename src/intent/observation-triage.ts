/**
 * Triage formatter for Phase 5's observation loop (project 08). The triage decision —
 * file or discard — is the LLM callback `runObservationLoop` takes; this module is the
 * deterministic formatter that turns the loop's **filed** outcomes into the markdown lines
 * that get appended to `docs/projects/ideas.md`. Discarded, duplicate, and quiet outcomes
 * have no entry to file and produce no output.
 *
 * The actual file append is integration; this module is pure (no I/O), so the formatting
 * is unit-testable. A future nightly orchestrator will call `formatIdeasMarkdown` on the
 * loop's outcomes and append the result to `docs/projects/ideas.md`.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Phase 5"), test-plan.md (§16)}.
 */

import type { LoopOutcome } from './observation-loop.js';

/** Slug shape a product attribution must have to be written (mirrors the
 *  reader's PRODUCT_SUFFIX_RE in observation-ideas-io.ts and VALID_SLUG in
 *  sandbox.ts). Gate at the WRITE boundary: `product` originates from LLM
 *  output (triage agent / App Claude), and docs/projects/ideas.md is a
 *  repo-tracked file — arbitrary text must not ride the suffix. */
const PRODUCT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Turn the loop's outcomes into markdown bullets ready to append to
 * `docs/projects/ideas.md`. Each filed outcome becomes one bullet line carrying the
 * project's title and the friction it addresses; non-filed outcomes (discarded, duplicate,
 * quiet) contribute no line. Returns the empty string when there is nothing to file.
 */
export function formatIdeasMarkdown(outcomes: LoopOutcome[]): string {
  const lines: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === 'filed') {
      // Product attribution (project 16 R3.13): a ` → <product>` suffix,
      // matching the repo's existing `→ <slug>` promotion-suffix convention.
      // Legacy ideas without a product keep the bare bullet form. A product
      // that is not a valid slug is dropped (never written verbatim).
      const product = outcome.idea.product;
      const suffix = product && PRODUCT_SLUG_RE.test(product) ? ` → ${product}` : '';
      lines.push(`- **${outcome.idea.title}** — ${outcome.idea.friction}${suffix}`);
    }
  }
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n`;
}
