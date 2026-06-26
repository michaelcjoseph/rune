/**
 * Scaffold-target resolution (09-expand-cockpit, Phase 4).
 *
 * When a planning session is approved, the `project-setup-writer` agent must scaffold into the
 * TARGET PRODUCT's repo — not always Rune's. This module is the pure boundary that turns a
 * product name into a concrete, writable repo path:
 *
 * - `resolveScaffoldTarget(product, registry, productsConfig)` validates the product against the
 *   registry (unknown / not-repo-backed are rejected BEFORE any agent dispatch) and resolves its
 *   `repoPath` from `policies/products.json`. Rune is just another registry/products entry — it
 *   is never a hard-coded default, so a custom config path for `rune` resolves to that path.
 * - `scaffoldWriteScope(repoPath)` produces the runAgent write-scope (cwd + the single writable
 *   directory) so the agent gets REAL write access to the target repo, not merely the path in
 *   prompt text.
 *
 * Pure — no I/O. Callers supply the already-read registry and products config.
 *
 * Security boundary note: `scaffoldWriteScope` asserts the path is absolute (a relative cwd would
 * silently anchor the child to Rune's own cwd). Full canonicalization — `realpath` + containment
 * under `$WORKSPACE_ROOT`, mirroring `assertBacklogWriteAllowed` / `backlog-reader.ts` — is the
 * responsibility of the approval-path wiring task that actually constructs the scope from
 * `policies/products.json`; this pure module deliberately does no I/O (no `realpathSync`).
 *
 * Contract pinned by `scaffold-target.test.ts` (test-plan §"product-scaffold-target").
 */

import { isAbsolute } from 'node:path';
// Type-only import: erased at compile time, so this adds NO runtime dependency on ai/claude.ts
// (its module-load `resolveClaudePath()` never fires) and no import cycle. It pins the scaffold
// write-scope to the single `runAgent` contract so the shapes can't silently drift apart.
import type { AgentWriteScope } from '../ai/claude.js';

/** The minimal registry shape this resolver reads — a real `Registry` is assignable. */
export interface ScaffoldRegistryLike {
  products: Array<{ name: string; repoBacked: boolean }>;
}

/** The minimal products-config shape this resolver reads — a real `Record<string, ProductConfig>`
 *  is assignable. */
export type ScaffoldProductsConfigLike = Record<string, { repoPath: string }>;

/** Result of resolving a product to a scaffold target. */
export type ScaffoldTarget =
  | { ok: true; product: string; repoPath: string }
  | { ok: false; error: 'unknown-product' | 'not-repo-backed' };

/** The write-scope handed to the setup-writer agent so it can actually write to the target repo.
 *  Aliases `runAgent`'s `AgentWriteScope` — same shape, single source of truth (see import note). */
export type ScaffoldWriteScope = AgentWriteScope;

/**
 * Resolve a product name to its scaffold target repo path, or an error.
 *
 * - Unknown product (absent from the registry) → `unknown-product`.
 * - Non-repo-backed product (in the registry but `repoBacked: false`) → `not-repo-backed`.
 * - Repo-backed product missing from `products.json` (config gap — no repo path to resolve) →
 *   `not-repo-backed`.
 *
 * Both rejections happen before any agent dispatch.
 */
export function resolveScaffoldTarget(
  product: string,
  registry: ScaffoldRegistryLike,
  productsConfig: ScaffoldProductsConfigLike,
): ScaffoldTarget {
  const entry = registry.products.find((p) => p.name === product);
  if (!entry) return { ok: false, error: 'unknown-product' };
  if (!entry.repoBacked) return { ok: false, error: 'not-repo-backed' };
  const config = productsConfig[product];
  // Repo-backed in the registry but absent from products.json: we can't resolve a repo path, so
  // the product is not actually scaffold-able. Treat as not-repo-backed rather than inventing one.
  if (!config) return { ok: false, error: 'not-repo-backed' };
  return { ok: true, product, repoPath: config.repoPath };
}

/**
 * Build the runAgent write-scope for a resolved target repo: the repo is both the agent's cwd and
 * its single writable directory. Scoping writes to exactly the target repo (not Rune, not a
 * parent dir) is what keeps a scaffold for product A from being able to write into product B.
 */
export function scaffoldWriteScope(repoPath: string): ScaffoldWriteScope {
  // A relative or empty path would anchor the child's cwd to Rune's own process cwd rather than
  // the intended repo root — reject it before it reaches the spawn. (Deeper realpath/containment
  // canonicalization is the wiring task's job — see the module header.)
  if (!isAbsolute(repoPath)) {
    throw new Error(`scaffoldWriteScope: repoPath must be an absolute path — got '${repoPath}'`);
  }
  return { cwd: repoPath, writableDirs: [repoPath] };
}
