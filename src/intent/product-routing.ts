/**
 * Product routing for captured ideas/bugs — project 16-claude-app-connector,
 * spec R3 / tech-spec "R3 — routing".
 *
 * `resolveProductTarget` validates an explicit candidate against the known
 * product list (policies/products.json, read via the injected loader). It
 * infers NOTHING on its own — inference is the App Claude's job — and every
 * unresolved path lands on the explicit {@link INBOX_PRODUCT} target so an
 * item is never silently dropped or filed under a non-existent product.
 *
 * Pure decision logic; the products.json read is injected so tool handlers
 * (log_idea) bind the real reader and tests bind fixtures.
 */

/** Reserved fallback target for items that resolve to no known product. */
export const INBOX_PRODUCT = 'inbox';

export type ProductRouteReason =
  | 'explicit-match'
  | 'unknown-product'
  | 'no-candidate'
  | 'config-read-error';

export interface ProductRoute {
  /** A known product name, or {@link INBOX_PRODUCT}. */
  product: string;
  /** True iff the item routed to a known product (never true for the inbox). */
  routed: boolean;
  reason: ProductRouteReason;
}

/**
 * Resolve a candidate product target against the known product list.
 *
 * - Trim + case-insensitive EXACT match only — never fuzzy, never a guess.
 * - Omitted/blank candidate → inbox (`no-candidate`).
 * - Unknown candidate → inbox (`unknown-product`).
 * - Loader failure → inbox (`config-read-error`); this function never throws
 *   into the tool call.
 *
 * The loader is expected to return lowercase product slugs (products.json
 * keys are VALID_SLUG-constrained); the returned `product` is always the
 * lowercase slug form — an explicit normalization, not an accident.
 * {@link INBOX_PRODUCT} is reserved: even if a product named "inbox" were
 * ever registered, it can never resolve as a routed target.
 */
export function resolveProductTarget(
  candidate: string | undefined,
  loadKnownProducts: () => string[],
): ProductRoute {
  const normalized = candidate?.trim().toLowerCase() ?? '';
  if (normalized === '') {
    return { product: INBOX_PRODUCT, routed: false, reason: 'no-candidate' };
  }
  if (normalized === INBOX_PRODUCT) {
    // Reserved fallback name — never a routed product, even if registered.
    return { product: INBOX_PRODUCT, routed: false, reason: 'unknown-product' };
  }

  let known: string[];
  try {
    known = loadKnownProducts();
  } catch {
    return { product: INBOX_PRODUCT, routed: false, reason: 'config-read-error' };
  }

  const match = known.map((p) => p.toLowerCase()).find((p) => p === normalized);
  if (match !== undefined) {
    return { product: match, routed: true, reason: 'explicit-match' };
  }
  return { product: INBOX_PRODUCT, routed: false, reason: 'unknown-product' };
}
