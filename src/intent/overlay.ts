/**
 * Product-overlay index — a per-product knowledge manifest that points at the vault
 * slices relevant to one product (journal entries, pages, world-view sections, wiki
 * concepts). The vault is organized by type, not by product; the overlay lets sub-agent
 * retrieval scope to a single product without pulling in unrelated context.
 *
 * It is an overlay, not a re-org: the vault never moves. A manifest only points into the
 * existing type-organized structure — every pointer is a vault-relative path.
 *
 * STATUS: contract stub. The type surface and signatures below are the contract pinned by
 * the test-first suite in `overlay.test.ts` (test-plan.md §3). The function bodies are
 * intentionally unimplemented — Phase 1's overlay-index tasks fill them in. Until then the
 * suite is RED by design.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Product-overlay index"), test-plan.md (§3)}.
 */

/** The kinds of vault slice an overlay pointer can reference. */
export type OverlayKind = 'journal' | 'page' | 'worldview-section' | 'wiki-concept';

/** A pointer into the vault. The overlay references content in place — it never moves it. */
export interface OverlayPointer {
  kind: OverlayKind;
  /** Vault-relative path of the referenced file. */
  path: string;
  /** Section heading or concept name within the file — for worldview-section / wiki-concept. */
  anchor?: string;
}

/** A per-product knowledge manifest — pointers into the type-organized vault, no re-org. */
export interface OverlayManifest {
  product: string;
  /** Pointers for this product: journal entries, pages, world-view sections, wiki concepts. */
  pointers: OverlayPointer[];
}

/** A scanned vault slice and the products it relates to — the input to building a manifest. */
export interface OverlayCandidate {
  pointer: OverlayPointer;
  /** Products this slice relates to; a slice may relate to more than one. */
  products: string[];
}

const NOT_IMPLEMENTED =
  'overlay: not implemented — Phase 1 overlay-index tasks (docs/projects/08-intent-layer) fill this in';

/**
 * Build a product's overlay manifest from scanned vault candidates. Pure: it selects the
 * candidates that relate to `product` and references them in place — it never reads, moves,
 * or rewrites vault content. A product with no related candidates yields a valid manifest
 * with an empty pointer list, not an error.
 */
export function buildOverlayManifest(_product: string, _candidates: OverlayCandidate[]): OverlayManifest {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Product-scoped retrieval for a sub-agent: return the pointers of the named product's
 * manifest and nothing else. A product with no manifest returns an empty list, not an
 * error.
 */
export function scopedRetrieval(_manifests: OverlayManifest[], _product: string): OverlayPointer[] {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Find the manifest pointers whose target file no longer resolves — stale-pointer
 * detection for content that was deleted or renamed. Returns the dead pointers (empty when
 * all resolve); never throws on a missing file.
 */
export function findStalePointers(
  _manifest: OverlayManifest,
  _fileExists: (path: string) => boolean,
): OverlayPointer[] {
  throw new Error(NOT_IMPLEMENTED);
}
