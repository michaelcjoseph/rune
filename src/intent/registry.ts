/**
 * Product/project registry — the uniform product → projects → lifecycle-status index.
 *
 * The registry is an *aggregating index*: the cockpit reads it, the intent layer writes
 * it. It does not own the underlying truth — product repos and vault product files do —
 * so it is always rebuildable. It holds durable **lifecycle status** (planned / active /
 * done) only; live **run-status** (running, blocked on Michael) lives in the supervision
 * layer and is surfaced to the cockpit separately.
 *
 * STATUS: contract stub. The type surface and function signatures below are the contract
 * pinned by the test-first suite in `registry.test.ts` (test-plan.md §1). The function
 * bodies are intentionally unimplemented — Phase 1's registry implementation tasks fill
 * them in. Until then the suite is RED by design.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Product/project registry"), test-plan.md (§1)}.
 */

import config from '../config.js';

/** Durable lifecycle status of a project. Never run-status (running / blocked). */
export type LifecycleStatus = 'planned' | 'active' | 'done';

/** A single project within a product. */
export interface RegistryProject {
  /** Project slug, e.g. `08-intent-layer`. */
  slug: string;
  /** Durable lifecycle status — derived from the product repo's project docs. */
  status: LifecycleStatus;
}

/** A product and the projects under it. */
export interface RegistryProduct {
  /** Product name, e.g. `jarvis`, `assay`. */
  name: string;
  /** Whether the product has a code repo (repo-backed products are executable). */
  repoBacked: boolean;
  /** Projects under this product; empty when the product has no project docs. */
  projects: RegistryProject[];
}

/** The aggregating index: every product, each with its projects and their status. */
export interface Registry {
  /** Schema version, for forward-compatible reads. */
  version: number;
  /** ISO-8601 timestamp of when this registry was built. */
  builtAt: string;
  /** Every product in the system. */
  products: RegistryProduct[];
}

/** Raw scanned input for a single product — one entry per product repo / vault product file. */
export interface ProductSource {
  name: string;
  repoBacked: boolean;
  /**
   * Raw text of the product repo's `docs/projects/index.md`, or `null` when the repo has
   * no project docs (or the product has no repo at all).
   */
  projectsIndex: string | null;
}

/** The complete set of scanned product sources — the input to a registry build. */
export interface RegistrySources {
  products: ProductSource[];
}

/** A project flattened with its owning product — the shape the cockpit query returns. */
export interface RegistryProjectRef extends RegistryProject {
  product: string;
}

/** Absolute path of the persisted registry file. */
export const REGISTRY_FILE = config.REGISTRY_FILE;

const NOT_IMPLEMENTED =
  'registry: not implemented — Phase 1 registry tasks (docs/projects/08-intent-layer) fill this in';

/**
 * Build the registry model from scanned product sources. Pure and deterministic: the same
 * sources always yield the same products/projects model (only `builtAt` varies). Logs the
 * build timing and the count of products/projects scanned.
 */
export function buildRegistry(_sources: RegistrySources): Registry {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Flatten the registry into every project across every product — the single-call query
 * the cockpit consumes ("show me every project and its status").
 */
export function getAllProjects(_registry: Registry): RegistryProjectRef[] {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Persist the registry atomically: write a temp file, then rename it over the target, so
 * a concurrent reader never observes a torn write.
 */
export function writeRegistry(_registry: Registry): void {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Read the persisted registry. Throws a clear error if the file is missing or malformed —
 * a corrupt registry is never silently treated as an empty model.
 */
export function readRegistry(): Registry {
  throw new Error(NOT_IMPLEMENTED);
}
