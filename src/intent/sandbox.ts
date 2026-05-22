/**
 * Sandboxing and security — Layer 4 of the intent layer's execution engine. A Regime B run
 * executes inside an isolated **git worktree** of its product's repo: it writes only within
 * that worktree (never the vault, never another run's tree), reaches only its own product's
 * scoped credentials, and may make network egress only to an allowlisted set of hosts.
 *
 * This module is the deterministic **policy core** of that sandbox — the pure checks a
 * caller consults before allowing a write, an egress, or a credential read. The system-level
 * enforcement (creating and tearing down the git worktree, injecting scoped credentials,
 * blocking egress at the network layer) is integration that builds on these checks; what is
 * pinned here is the boundary logic, including path-traversal defense on the write check.
 *
 * STATUS: implemented. All four policy checks — `worktreePathFor`, `isWriteAllowed`,
 * `isEgressAllowed`, `canReachCredential` — are live; the contract is pinned by the test
 * suite in `sandbox.test.ts` (test-plan.md §11). Prompt-injection defense is structural:
 * these checks are enforced around the agent, not by it, so an injected agent cannot talk
 * its way past the write boundary, the egress allowlist, or credential scoping.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Layer 4"), test-plan.md (§11)}.
 */

import { isAbsolute, join, resolve, sep } from 'node:path';

/** The sandbox a single Regime B run executes inside. */
export interface SandboxSpec {
  /** The product whose repo the run operates on. */
  product: string;
  /** The project slug the run is executing. */
  project: string;
  /** Absolute path of the run's isolated git worktree — its only writable area. Must be a
   *  path produced by `worktreePathFor`; callers must never point it at an arbitrary path. */
  worktree: string;
  /** Hosts the run may make network egress to; anything else is denied. */
  egressAllowlist: string[];
}

/**
 * A valid product/project slug — non-empty, lowercase alphanumeric-or-hyphen with an
 * alphanumeric first character (the same rule the registry enforces). Such a slug carries
 * no path separator and no `.`, so it is always a single safe path segment, and the
 * mapping slug → segment is injective (no collisions).
 */
const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The deterministic worktree path for a (product, project) under `worktreeRoot`. Distinct
 * projects always get distinct paths, so two concurrent runs never share a working tree.
 *
 * A `product` or `project` that is not a valid slug is **rejected** with a clear error — a
 * traversal-laden, empty, or separator-bearing slug never silently produces a path. Slugs
 * reaching here come from the registry, which already constrains them; this is the loud
 * boundary check. `worktreeRoot` is trusted, absolute configuration and is not sanitized.
 */
export function worktreePathFor(
  product: string,
  project: string,
  worktreeRoot: string,
): string {
  // `as const` keeps these as tuples — under noUncheckedIndexedAccess the destructured
  // `slug` is then `string`, not `string | undefined`.
  for (const [label, slug] of [['product', product], ['project', project]] as const) {
    if (!VALID_SLUG.test(slug)) {
      throw new Error(
        `worktreePathFor: invalid ${label} slug '${slug}' — must be a non-empty ` +
          'alphanumeric/hyphen slug with no path separators',
      );
    }
  }
  return join(worktreeRoot, product, project);
}

/**
 * Whether `targetPath` may be written by the run — true only when it resolves to a location
 * inside `sandbox.worktree`. Both paths are resolved to absolute, normalized form first, so
 * `..` traversal that escapes the worktree collapses away and is denied. The containment
 * check requires either an exact match or a `worktree + separator` prefix, so a sibling
 * that merely shares the worktree name (`…/02-growth-evil`) does not pass. A vault path,
 * another run's worktree, or any path outside the worktree is denied — Regime B writes only
 * within its own worktree, never the vault.
 *
 * This is a **lexical** containment check: it collapses `..` but does not dereference
 * symlinks. The system-level enforcement layer must pass a real (symlink-resolved) path, or
 * keep the worktree free of symlinks, so a symlink inside the worktree cannot redirect a
 * write out of it. `sandbox.worktree` must be an absolute path — `isWriteAllowed` throws
 * otherwise rather than silently anchoring a relative worktree to the process cwd.
 */
export function isWriteAllowed(targetPath: string, sandbox: SandboxSpec): boolean {
  if (!isAbsolute(sandbox.worktree)) {
    throw new Error(
      `isWriteAllowed: sandbox.worktree must be an absolute path — got '${sandbox.worktree}'`,
    );
  }
  const root = resolve(sandbox.worktree);
  const target = resolve(targetPath);
  return target === root || target.startsWith(root + sep);
}

/**
 * Normalize a hostname for allowlist comparison: surrounding whitespace is trimmed, DNS
 * host names are case-insensitive (RFC 4343) so case is folded, and a single trailing dot
 * denotes the same FQDN so it is dropped. Comparison stays exact on the normalized form —
 * no prefix/suffix/substring matching.
 */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Whether the run may make network egress to `host` — true only when `host`, normalized, is
 * an **exact** member of `sandbox.egressAllowlist`. Exact membership (not
 * prefix/suffix/substring) is what makes a subdomain (`evil.github.com`), a suffix-spoof
 * (`github.com.evil.example`), and a substring collision (`evil-github.com`) all deny
 * against a `github.com` allowlist. `host` must be a bare hostname — no scheme, no port;
 * case and a trailing FQDN dot are normalized away. An empty allowlist denies all egress.
 */
export function isEgressAllowed(host: string, sandbox: SandboxSpec): boolean {
  const target = normalizeHost(host);
  return sandbox.egressAllowlist.some((entry) => normalizeHost(entry) === target);
}

/**
 * Whether the run may read credentials owned by `credentialProduct` — true only when it is
 * **exactly** the run's own product. A run can never reach another product's secrets,
 * Jarvis's own credentials, or a prefix/case-variant of its product name. Both values are
 * registry slugs; a non-slug `credentialProduct` simply fails the exact match (deny).
 */
export function canReachCredential(sandbox: SandboxSpec, credentialProduct: string): boolean {
  return sandbox.product === credentialProduct;
}
