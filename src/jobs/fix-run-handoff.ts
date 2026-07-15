import type { BacklogItem } from '../intent/backlog-parser.js';
import type { BugScopingFacts } from './bug-fix-gate.js';
import type { ProductConfig } from './sandbox-runtime.js';

export type ProductsConfig = Record<string, ProductConfig>;

export type ResolveDeliverableRepo = (
  bug: BacklogItem,
  product: string,
  products: ProductsConfig,
) => string;

export type SingleProductGuardResult =
  | { accepted: true; repoPath: string }
  | {
    accepted: false;
    reason: 'unknown-product' | 'not-repo-backed' | 'not-single-product';
    detail?: string;
  };

export interface SingleProductGuardDeps {
  products: ProductsConfig;
  resolveDeliverableRepo: ResolveDeliverableRepo;
}

/**
 * Rejects fix runs unless their deliverable belongs to the same repository the
 * selected product is allowed to mutate.
 */
export function guardSingleProduct(
  input: { product: string; bug: BacklogItem },
  deps: SingleProductGuardDeps,
): SingleProductGuardResult {
  const product = deps.products[input.product];
  if (!product) {
    return { accepted: false, reason: 'unknown-product' };
  }
  if (!product.repoPath.trim()) {
    return { accepted: false, reason: 'not-repo-backed' };
  }

  const deliverableRepo = deps.resolveDeliverableRepo(input.bug, input.product, deps.products);
  if (deliverableRepo !== product.repoPath) {
    return { accepted: false, reason: 'not-single-product' };
  }

  return { accepted: true, repoPath: product.repoPath };
}

export interface FixRunScope {
  bug: BacklogItem;
  facts: BugScopingFacts;
}

export interface StartFixRunInput {
  product: string;
  bugId: string;
  scope: FixRunScope;
}

export type StartFixRunResult =
  | { accepted: true; runId: string }
  | { accepted: false; reason: string; detail?: string };

/**
 * Boundary to the deferred cross-repo autorun implementation. The cockpit owns
 * gating and durable attempt state; execution behind an approved gate plugs in here.
 */
export async function startFixRun(_input: StartFixRunInput): Promise<StartFixRunResult> {
  throw new Error('fix-run handoff unavailable');
}
