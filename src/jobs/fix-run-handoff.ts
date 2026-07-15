import type { BacklogItem } from '../intent/backlog-parser.js';
import config from '../config.js';
import { createMutation } from '../transport/mutations.js';
import { createLogger } from '../utils/logger.js';
import type { BugScopingFacts } from './bug-fix-gate.js';
import { scaffoldAndCommitFixProject } from './fix-project-scaffold.js';
import { readProductsConfig, type ProductConfig } from './sandbox-runtime.js';

const log = createLogger('fix-run-handoff');

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

export interface StartFixRunDeps extends SingleProductGuardDeps {
  scaffoldAndCommitFixProject: typeof scaffoldAndCommitFixProject;
  createMutation: typeof createMutation;
}

function defaultResolveDeliverableRepo(
  _bug: BacklogItem,
  product: string,
  products: ProductsConfig,
): string {
  return products[product]?.repoPath ?? '';
}

function defaultStartFixRunDeps(): StartFixRunDeps {
  return {
    products: readProductsConfig(config.PRODUCTS_CONFIG_FILE),
    resolveDeliverableRepo: defaultResolveDeliverableRepo,
    scaffoldAndCommitFixProject,
    createMutation,
  };
}

/**
 * Turns a gate-approved, single-product bug into the one-task project consumed
 * by orchestrated-work. Expected guard and pipeline rejections are returned;
 * unexpected dependency failures remain throws for the caller to diagnose.
 */
export async function startFixRun(
  input: StartFixRunInput,
  deps: StartFixRunDeps = defaultStartFixRunDeps(),
): Promise<StartFixRunResult> {
  const guard = guardSingleProduct(
    { product: input.product, bug: input.scope.bug },
    deps,
  );
  if (!guard.accepted) {
    log.info('fix run guard rejected', { product: input.product, reason: guard.reason });
    return guard;
  }
  log.info('fix run guard accepted', { product: input.product });

  const product = deps.products[input.product]!;
  const scaffold = await deps.scaffoldAndCommitFixProject({
    repoPath: guard.repoPath,
    baseBranch: product.baseBranch,
    product: input.product,
    bugId: input.bugId,
    bug: input.scope.bug,
    facts: input.scope.facts,
  });
  if (!scaffold.ok) {
    log.warn('fix run scaffold rejected', {
      product: input.product,
      reason: scaffold.reason,
      ...(scaffold.detail ? { detail: scaffold.detail } : {}),
    });
    return {
      accepted: false,
      reason: scaffold.reason,
      ...(scaffold.detail ? { detail: scaffold.detail } : {}),
    };
  }

  const dispatch = await deps.createMutation(
    'orchestrated-work',
    { projectSlug: scaffold.projectSlug, product: input.product },
    'webview',
  );
  if (!dispatch.ok) {
    log.warn('fix run dispatch rejected', {
      product: input.product,
      projectSlug: scaffold.projectSlug,
      reason: dispatch.reason,
    });
    return { accepted: false, reason: 'dispatch-rejected', detail: dispatch.reason };
  }

  log.info('fix run dispatched', {
    product: input.product,
    projectSlug: scaffold.projectSlug,
    runId: dispatch.descriptor.id,
    dispatchKind: 'orchestrated-work',
  });
  return { accepted: true, runId: dispatch.descriptor.id };
}
