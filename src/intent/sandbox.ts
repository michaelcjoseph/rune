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
  /** The commit the run's branch was cut from — the stable diff base
   *  (`baseSha..branch`) for work-product computation. Set by `createWorktree`
   *  when a branch is created (captured atomically with the branch point so a
   *  moving `HEAD` can't change it); absent for base-branch-tracking worktrees.
   *  On a resume (the requested branch already existed), this is the branch's
   *  pre-run tip, so the work product is only the commits THIS run adds. */
  baseSha?: string;
  /** True when `createWorktree` checked out an existing branch (a resumed,
   *  in-progress project) rather than cutting a fresh one. The runner uses this
   *  to tell the agent prior commits are already present so it continues from
   *  the first incomplete task instead of restarting from Phase 1. */
  resumed?: boolean;
}

/**
 * A valid product/project slug — non-empty, lowercase alphanumeric-or-hyphen with an
 * alphanumeric first character (the same rule the registry enforces). Such a slug carries
 * no path separator and no `.`, so it is always a single safe path segment, and the
 * mapping slug → segment is injective (no collisions). Exported so sibling modules that
 * validate slugs from external config (`src/jobs/sandbox-runtime.ts`) share one rule.
 */
export const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Stable per-PROJECT work-run branch name (not per-run-id) — the deterministic
 * resume target a run's worktree is checked out on. A per-project name lets
 * `createWorktree` check out an existing branch (carrying committed progress
 * forward) instead of re-forking off the base branch and restarting from Phase
 * 1. `projectSlug` is git-ref-safe (VALID_SLUG-validated by callers), and
 * branches are per-repo so two products sharing a slug never collide.
 *
 * Lives here (the light sandbox-policy module) rather than in the heavy
 * `work-runner.ts` so consumers like `work-run-release.ts` can reuse it without
 * pulling in the Claude-CLI spawn chain. `work-runner.ts` re-exports it for
 * back-compat with existing importers.
 */
export function workBranchName(projectSlug: string): string {
  return `jarvis-work/${projectSlug}`;
}

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
 * Whether `target` is the same path as `root` or a descendant of it. Both paths are
 * resolved to absolute, normalized form first, so a `..` traversal that escapes `root`
 * collapses away and is denied. The check requires either an exact match or a
 * `root + separator` prefix, so a sibling that merely shares the root's name as a prefix
 * (`/x/02-growth-evil` against `/x/02-growth`) does not pass.
 *
 * Lexical only — does not dereference symlinks. Callers that take a path from an
 * untrusted source must resolve symlinks (`fs.realpathSync`) before consulting this, or
 * keep the root free of symlinks. Exported so sibling modules (the runtime sandbox in
 * `src/jobs/sandbox-runtime.ts`) share one containment rule with `isWriteAllowed`.
 */
export function isContainedIn(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r + sep);
}

/**
 * Whether `targetPath` may be written by the run — true only when it resolves to a location
 * inside `sandbox.worktree`. A vault path, another run's worktree, or any path outside the
 * worktree is denied — Regime B writes only within its own worktree, never the vault.
 *
 * `sandbox.worktree` must be an absolute path — this function throws otherwise rather than
 * silently anchoring a relative worktree to the process cwd. The containment check itself
 * is delegated to `isContainedIn`; see that for the lexical-vs-symlink note.
 */
export function isWriteAllowed(targetPath: string, sandbox: SandboxSpec): boolean {
  if (!isAbsolute(sandbox.worktree)) {
    throw new Error(
      `isWriteAllowed: sandbox.worktree must be an absolute path — got '${sandbox.worktree}'`,
    );
  }
  return isContainedIn(sandbox.worktree, targetPath);
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
