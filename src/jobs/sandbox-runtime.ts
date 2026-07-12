/**
 * Sandbox runtime — the system-level complement to `src/intent/sandbox.ts`'s
 * deterministic policy core. Creates, destroys, and orphan-cleans the git
 * worktrees a Regime B run executes inside, and reads the per-product config
 * (`policies/products.json`) that names each product's repo, base branch,
 * credential file, and egress allowlist.
 *
 * Scope: worktree lifecycle only. Credential injection (A1.2), egress
 * enforcement (A1.3), and write-guard wrapping (A1.4) are sibling tasks under
 * Phase 6 A1 and live in their own modules — this one stays narrowly the
 * `git worktree` adapter so the boundary contract in `src/intent/sandbox.ts`
 * has one place to call into when it needs an actual worktree on disk.
 *
 * All git invocations go through an injectable `runGit` seam so the test suite
 * (`sandbox-runtime.test.ts`) never shells out to real git; production wires
 * the default which is `execFile('git', …)`-wrapped.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Layer 4"), test-plan.md §11,
 * tasks.md Phase 6 A1}.
 */

import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  isContainedIn,
  VALID_SLUG,
  worktreePathFor,
  type SandboxSpec,
} from '../intent/sandbox.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sandbox-runtime');

const execFile = promisify(execFileCb);

const VITEST_CACHE_ROOT = join(tmpdir(), 'rune-vitest-cache');

/** Deterministic, opaque cache directory for one absolute worktree path. */
export function vitestCacheDirFor(worktreePath: string): string {
  const digest = createHash('sha256').update(resolve(worktreePath)).digest('hex');
  return join(VITEST_CACHE_ROOT, digest);
}

/** Best-effort cache teardown. Cleanup failures never mask worktree lifecycle results. */
export function removeVitestCache(worktreePath: string): boolean {
  try {
    rmSync(vitestCacheDirFor(worktreePath), { recursive: true, force: true });
    return true;
  } catch (err) {
    log.warn('removeVitestCache: cleanup failed', { error: (err as Error).message });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One product's entry in `policies/products.json`. Tilde-bearing paths are
 *  expanded to absolute paths by `readProductsConfig` before this is returned
 *  to a caller. */
export type ProductClass = 'internal' | 'external';
export type MonitoringCapability = 'enabled' | 'stubbed';
export type CloseoutValidationStrategy = 'vitest-related' | 'product-commands';
export type ArtifactMcpPolicy = 'rune-kb-readonly';

export interface ProductContainerCapabilities {
  projects: boolean;
  bugs: boolean;
  ideas: boolean;
  runs: boolean;
  chat: boolean;
  monitoring: MonitoringCapability;
}

export interface ProductConfig {
  /** Product-OS class used by the cockpit roster. Absent only for legacy fixtures/config. */
  class?: ProductClass;
  /** Product-aware container contract consumed by cockpit clients. */
  containerCapabilities?: ProductContainerCapabilities;
  /**
   * Absolute path of the product's repo (the one `git worktree add` targets).
   * Empty for projection-only product entries whose execution metadata lands in
   * a later phase.
   */
  repoPath: string;
  /** Optional repo-relative scope for products sharing a repository. */
  scopePath?: string;
  /** Branch a fresh worktree is based on when no explicit branch is given. */
  baseBranch: string;
  /** Absolute path of the product's scoped credentials file (A1.2 wires this). */
  credentialsFile: string;
  /** Hosts a sandboxed run for this product may make network egress to. */
  egressAllowlist: string[];
  /** Shell commands the gated-merge finalizer runs in an integration worktree to
   *  decide whether a `branch-complete` run may land on `main` (project 15,
   *  P1.5). `readProductsConfig` ALWAYS populates it — `[]` when absent/non-array
   *  — and an empty list fails the merge gate CLOSED with
   *  `missing-validation-command`, never an unverified merge. (Kept optional on
   *  the type so unrelated `ProductConfig` test literals that don't set it still
   *  compile; the gate-runtime wiring reads it as `?? []`.)
   *  SECURITY-SENSITIVE: editing this authorizes new shell commands to RUN
   *  during automated gated-merge runs — review a change to it like a change to
   *  escalation-policy.json, and see `work-run-gate-runtime.ts` for the
   *  execFile/no-shell spawn requirement the P1.5 runtime MUST honor. */
  validationCommands?: string[];
  /** Per-task closeout policy. Absent config defaults to product commands. */
  closeoutValidationStrategy?: CloseoutValidationStrategy;
  /** Per-product orchestrated-work toggle (project 14, Phase 5). When set, it
   *  OVERRIDES the global `ORCHESTRATED_WORK_ENABLED` default for this product's
   *  work-run dispatch: `true` routes Start to the orchestrated applier, `false`
   *  forces the legacy `/work --auto` applier. Absent ⇒ fall back to the global
   *  default. Optional on the type so existing `ProductConfig` literals (and
   *  products without the key) still compile / read cleanly. */
  orchestratedMode?: boolean;
  /** Optional read-only MCP registration granted only to artifact-role
   *  executor sessions (QA and coder). Unknown values fail config parsing. */
  artifactMcp?: ArtifactMcpPolicy;
}

/** Pluggable git runner — production wraps `execFile('git', …)`, tests inject
 *  a `vi.fn()` so the suite never touches real git. Mirrors the relevant
 *  subset of `execFile`'s result. */
export type GitRunner = (
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default `runGit` — shells out to the real `git` CLI. Tests must inject
 *  their own stub; never call this directly from a test. Exported so other
 *  runtime callers (e.g. `work-runner`'s work-product computation) reuse the
 *  one execFile-based git runner instead of duplicating the wrapper. */
export const defaultRunGit: GitRunner = async (args, opts) => {
  const result = await execFile('git', args, {
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    // Cap a single git invocation so a hung process can't block the runtime.
    timeout: 30_000,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

// ---------------------------------------------------------------------------
// Config readers
// ---------------------------------------------------------------------------

/** Expand a leading `~/` to the current user's home directory. Other paths
 *  are returned verbatim. Kept local rather than imported from `src/config.ts`
 *  so this module stays test-importable without bootstrapping the full
 *  runtime config (which requires TELEGRAM_BOT_TOKEN, VAULT_DIR, …). */
function expandTilde(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function parseContainerCapabilities(
  slug: string,
  path: string,
  raw: unknown,
): ProductContainerCapabilities | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`readProductsConfig: product '${slug}' has invalid containerCapabilities in ${path}`);
  }
  const entry = raw as Record<string, unknown>;
  for (const key of ['projects', 'bugs', 'ideas', 'runs', 'chat'] as const) {
    if (typeof entry[key] !== 'boolean') {
      throw new Error(
        `readProductsConfig: product '${slug}' has invalid containerCapabilities.${key} in ${path} — expected boolean`,
      );
    }
  }
  if (entry['monitoring'] !== 'enabled' && entry['monitoring'] !== 'stubbed') {
    throw new Error(
      `readProductsConfig: product '${slug}' has invalid containerCapabilities.monitoring in ${path} — ` +
        "expected 'enabled' or 'stubbed'",
    );
  }
  return {
    projects: entry['projects'] as boolean,
    bugs: entry['bugs'] as boolean,
    ideas: entry['ideas'] as boolean,
    runs: entry['runs'] as boolean,
    chat: entry['chat'] as boolean,
    monitoring: entry['monitoring'] as MonitoringCapability,
  };
}

/**
 * Read and parse `policies/products.json`. Tilde-expands `repoPath` and
 * `credentialsFile` for each entry. A malformed file or a missing file throws
 * with a clear error that names the file path — there is no silent fall-back
 * to an empty registry, since that would mask a config problem as a "no
 * products configured" state.
 */
export function readProductsConfig(path: string): Record<string, ProductConfig> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `readProductsConfig: could not read ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `readProductsConfig: malformed JSON in ${path}: ${(err as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`readProductsConfig: ${path} did not parse to an object`);
  }

  const out: Record<string, ProductConfig> = {};
  for (const [slug, entryRaw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entryRaw || typeof entryRaw !== 'object') continue;
    if (!VALID_SLUG.test(slug)) {
      throw new Error(
        `readProductsConfig: invalid product slug '${slug}' in ${path} — ` +
          'must be non-empty lowercase alphanumeric/hyphen with an alphanumeric first character',
      );
    }
    const entry = entryRaw as Record<string, unknown>;
    let productClass: ProductClass | undefined;
    if (entry['class'] !== undefined) {
      if (entry['class'] !== 'internal' && entry['class'] !== 'external') {
        throw new Error(
          `readProductsConfig: product '${slug}' has invalid class '${String(entry['class'])}' in ${path} — ` +
            "expected 'internal' or 'external'",
        );
      }
      productClass = entry['class'];
    }
    const repoPath = expandTilde(String(entry['repoPath'] ?? ''));
    if (!repoPath && !productClass) {
      throw new Error(
        `readProductsConfig: product '${slug}' is missing required field 'repoPath' in ${path}`,
      );
    }
    const closeoutValidationStrategy = entry['closeoutValidationStrategy'] ?? 'product-commands';
    if (closeoutValidationStrategy !== 'vitest-related' && closeoutValidationStrategy !== 'product-commands') {
      throw new Error(
        `readProductsConfig: product '${slug}' has invalid closeoutValidationStrategy ` +
          `'${String(closeoutValidationStrategy)}' in ${path} — expected 'vitest-related' or 'product-commands'`,
      );
    }
    if (
      entry['artifactMcp'] !== undefined &&
      entry['artifactMcp'] !== 'rune-kb-readonly'
    ) {
      throw new Error(
        `readProductsConfig: product '${slug}' has invalid artifactMcp ` +
          `'${String(entry['artifactMcp'])}' in ${path} — expected 'rune-kb-readonly'`,
      );
    }
    out[slug] = {
      ...(productClass ? { class: productClass } : {}),
      ...(entry['containerCapabilities'] !== undefined
        ? { containerCapabilities: parseContainerCapabilities(slug, path, entry['containerCapabilities']) }
        : {}),
      repoPath,
      ...(typeof entry['scopePath'] === 'string' && entry['scopePath']
        ? { scopePath: entry['scopePath'] }
        : {}),
      baseBranch: String(entry['baseBranch'] ?? 'main'),
      credentialsFile: expandTilde(String(entry['credentialsFile'] ?? '')),
      egressAllowlist: Array.isArray(entry['egressAllowlist'])
        ? (entry['egressAllowlist'] as unknown[]).map(String)
        : [],
      // Always an array (fail-closed `[]` when absent/non-array) — mirrors
      // egressAllowlist. An empty list fails the merge gate with
      // `missing-validation-command`, never an unverified merge.
      validationCommands: Array.isArray(entry['validationCommands'])
        ? (entry['validationCommands'] as unknown[]).map(String)
        : [],
      closeoutValidationStrategy,
      // Per-product orchestrated-work toggle (project 14). Only a real boolean
      // overrides the global default; anything else leaves it absent so the
      // dispatch seam falls back to the global ORCHESTRATED_WORK_ENABLED.
      ...(typeof entry['orchestratedMode'] === 'boolean'
        ? { orchestratedMode: entry['orchestratedMode'] }
        : {}),
      ...(entry['artifactMcp'] === 'rune-kb-readonly'
        ? { artifactMcp: entry['artifactMcp'] }
        : {}),
    };
  }
  return out;
}

/**
 * Look up a single product's config, throwing a clear error (naming the slug)
 * when the product is missing from the file. Convenience over
 * `readProductsConfig(path)[product]`.
 */
export function getProductConfig(product: string, configPath: string): ProductConfig {
  const all = readProductsConfig(configPath);
  const entry = all[product];
  if (!entry) {
    throw new Error(
      `getProductConfig: product '${product}' not found in ${configPath}`,
    );
  }
  if (!entry.repoPath) {
    throw new Error(
      `getProductConfig: product '${product}' has no configured repoPath in ${configPath}`,
    );
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Worktree lifecycle
// ---------------------------------------------------------------------------

export interface CreateWorktreeOpts {
  product: string;
  project: string;
  /** Branch to check out in the new worktree. When omitted, the product's
   *  `baseBranch` from products.json is used (worktree tracks that branch). */
  branch?: string;
  /** Explicit commit to branch from. When a `branch` is requested and this is
   *  omitted, `createWorktree` resolves `git rev-parse HEAD` of the product
   *  repo itself so capture and branch-point are one atomic operation. The
   *  resolved (or supplied) sha is returned on `SandboxSpec.baseSha`. */
  startPoint?: string;
  worktreeRoot: string;
  productsConfigPath: string;
  runGit?: GitRunner;
}

/**
 * Create a fresh git worktree for `(product, project)` at the deterministic
 * path produced by `worktreePathFor`. Returns a `SandboxSpec` ready for the
 * policy module's checks.
 *
 * - When `branch` is given and does NOT yet exist, a new branch is created and
 *   checked out via `git worktree add -b <branch> <path> <baseSha>`, cut from
 *   `startPoint` (or the repo's HEAD when omitted).
 * - When `branch` is given and ALREADY exists (and no `startPoint` forces a
 *   fresh base), the worktree resumes it via `git worktree add <path> <branch>`
 *   — the project's prior commits are present, `SandboxSpec.resumed` is true,
 *   and `baseSha` is the branch tip after any resume-time base reconciliation
 *   (so the work product is only the commits this run adds). This is what lets
 *   `/work --auto` continue an interrupted project instead of re-forking off
 *   `main` (docs/projects/bugs.md).
 * - When `branch` is omitted, the worktree tracks the product's `baseBranch`
 *   via `git worktree add <path> <baseBranch>`.
 *
 * Pre-conditions checked locally before any git call:
 * - The product must be in products.json (else throw, naming the slug).
 * - The target path must not already exist on disk (else throw — git would
 *   itself reject, but the caller wants the precondition surface explicit).
 *
 * A `runGit` rejection is wrapped with a message that includes the worktree
 * path, so the failure is traceable to a specific sandbox without grepping the
 * stderr line.
 */
/**
 * Symlink the product repo's `node_modules` into a freshly-created worktree.
 *
 * Git worktrees don't copy the (gitignored) `node_modules`, so a new worktree
 * has no installed dependencies — `npx`/`vitest`/`tsx` fail to resolve and a
 * `/work` run can't run the project's tests. Symlinking the parent repo's
 * already-installed modules is fast and avoids a per-run `npm ci`. The run is
 * spawned with `--dangerously-skip-permissions` (work-runner.ts), which lifts
 * the working-dir containment so a link whose target sits outside the worktree
 * still resolves.
 *
 * Best-effort: no-ops when the source is absent (repo never installed) or a
 * `node_modules` already exists in the worktree, and never throws — a run can
 * still do non-test work without deps, so a link failure must not abort setup.
 */
export function linkWorktreeDeps(repoPath: string, worktree: string): void {
  const src = join(repoPath, 'node_modules');
  const dest = join(worktree, 'node_modules');
  if (!existsSync(src) || existsSync(dest)) return;
  try {
    symlinkSync(src, dest, 'dir');
  } catch {
    // Non-fatal: the run proceeds, it just won't have a local test runner.
  }
}

export async function createWorktree(opts: CreateWorktreeOpts): Promise<SandboxSpec> {
  const runGit = opts.runGit ?? defaultRunGit;
  const product = getProductConfig(opts.product, opts.productsConfigPath);
  const worktree = worktreePathFor(opts.product, opts.project, opts.worktreeRoot);

  if (existsSync(worktree)) {
    await reclaimPreservedWorktree(runGit, product.repoPath, worktree);
  }

  // Resolve the branch point + the `git worktree add` args. Three cases:
  //  - branch requested AND already exists (no explicit startPoint) → RESUME:
  //    check the branch out in the new worktree (no -b) so the project's prior
  //    commits are present. Without this every run re-forked off `main` and
  //    restarted the project from scratch, stranding committed work
  //    (docs/projects/bugs.md). After any resume-time base reconciliation, the
  //    checked-out branch tip becomes the diff base, so the work product is
  //    only the commits THIS run adds.
  //  - branch requested, does not exist → FRESH: cut it from `startPoint` or the
  //    repo's HEAD, captured BEFORE the add so a moving HEAD can't shift the
  //    diff base.
  //  - no branch → track the product's baseBranch.
  let baseSha: string | undefined;
  let resumed = false;
  let args: string[];
  let baseReconciled: SandboxSpec['baseReconciled'];
  if (opts.branch) {
    // An explicit `startPoint` means the caller wants a fresh branch from a
    // specific commit — honor it and skip the resume probe.
    const existingTip = opts.startPoint
      ? null
      : await resolveBranchTip(runGit, product.repoPath, opts.branch);
    if (existingTip) {
      resumed = true;
      baseSha = existingTip;
      // The per-project run cap is 1 and the worktree path is per-project, so no
      // other live RUN worktree holds the branch — but the product's MAIN
      // checkout can be sitting on it (e.g. a human checked it out to make a
      // manual fix). Git forbids the branch in two trees at once, so release it
      // from the main checkout before the add (2026-06-29 project-19 collision).
      await freeBranchFromMainCheckout(
        runGit, product.repoPath, opts.branch, product.baseBranch,
      );
      // No -b: check out the existing branch so the project's prior commits are
      // present in the worktree.
      args = ['worktree', 'add', worktree, opts.branch];
    } else {
      baseSha = opts.startPoint?.trim() || undefined;
      if (!baseSha) {
        try {
          const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: product.repoPath });
          baseSha = stdout.trim() || undefined;
        } catch (err) {
          const stderr = (err as { stderr?: string })?.stderr ?? '';
          throw new Error(
            `createWorktree: git rev-parse HEAD failed for ${product.repoPath}: ` +
              `${(err as Error).message}${stderr ? ` — ${stderr.trim()}` : ''}`,
          );
        }
        // A repo that can host a run always has a HEAD commit — empty stdout
        // means a misconfigured/empty repo. Fail loudly rather than silently
        // branching with no base (which leaves the diff base undefined
        // downstream).
        if (!baseSha) {
          throw new Error(
            `createWorktree: git rev-parse HEAD returned empty for ${product.repoPath} ` +
              `(repo has no commits?) — cannot capture a stable base sha`,
          );
        }
      }
      // `git worktree add -b <new-branch> <path> <commit-ish>` — flag before
      // path is the canonical form older git versions require; the start-point
      // goes last. baseSha is guaranteed non-empty here (else we threw).
      args = ['worktree', 'add', '-b', opts.branch, worktree, baseSha];
    }
  } else {
    args = ['worktree', 'add', worktree, product.baseBranch];
  }

  try {
    await runGit(args, { cwd: product.repoPath });
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    throw new Error(
      `createWorktree: git worktree add failed for ${worktree}: ` +
        `${(err as Error).message}${stderr ? ` — ${stderr.trim()}` : ''}`,
    );
  }

  if (resumed && opts.branch && baseSha) {
    try {
      const reconciled = await reconcileResumedBranchBase({
        runGit,
        worktree,
        branch: opts.branch,
        baseBranch: product.baseBranch,
        previousTip: baseSha,
      });
      baseSha = reconciled.baseSha;
      baseReconciled = reconciled.baseReconciled;
    } catch (err) {
      await removeWorktreeAfterReconciliationFailure(
        runGit,
        product.repoPath,
        worktree,
        opts.branch,
        product.baseBranch,
      );
      throw err;
    }
  }

  // A fresh worktree has no node_modules (git worktrees don't carry the
  // gitignored dir), so `npx`/`vitest`/`tsx` can't resolve and a /work run
  // can't run the project's tests — half of the 2026-06-01 noop (bugs.md).
  linkWorktreeDeps(product.repoPath, worktree);

  return {
    product: opts.product,
    project: opts.project,
    worktree,
    egressAllowlist: product.egressAllowlist,
    baseSha,
    baseReconciled,
    resumed,
  };
}

interface ReconcileResumeOpts {
  runGit: GitRunner;
  worktree: string;
  branch: string;
  baseBranch: string;
  previousTip: string;
}

async function reconcileResumedBranchBase(
  opts: ReconcileResumeOpts,
): Promise<{ baseSha: string; baseReconciled?: SandboxSpec['baseReconciled'] }> {
  const { runGit, worktree, branch, baseBranch, previousTip } = opts;
  // Reconcile against the LOCAL base ref — no `git fetch`. Rune lands its
  // out-of-band fixes as commits on the daemon's local base branch (the exact
  // scenario this guards, docs/projects/bugs.md), so the local ref is
  // authoritative; consulting origin would risk rebasing onto unreviewed state.
  const baseTip = await revParse(runGit, worktree, baseBranch, 'base branch');
  const mergeBase = await mergeBaseHead(runGit, worktree, baseBranch);

  if (mergeBase === baseTip) {
    return { baseSha: previousTip };
  }

  const baseAheadCount = await countBaseAhead(runGit, worktree, baseBranch);
  try {
    await runGit(['rebase', baseBranch], { cwd: worktree });
  } catch (err) {
    try {
      await runGit(['rebase', '--abort'], { cwd: worktree });
    } catch (abortErr) {
      log.warn(
        'Failed to abort rebase during resume base reconciliation',
        { branch, baseBranch, worktree, err: (abortErr as Error).message },
      );
    }

    const stderr = (err as { stderr?: string })?.stderr ?? '';
    throw new Error(
      `createWorktree: base reconciliation failed for branch ${branch} ` +
        `against ${baseBranch} (previous tip ${previousTip}, base ahead ` +
        `${baseAheadCount}): ${(err as Error).message}` +
        `${stderr ? ` — ${stderr.trim()}` : ''}`,
    );
  }

  const newTip = await revParse(runGit, worktree, 'HEAD', 'post-rebase HEAD');
  // Surface the rebase so a resumed run that silently moved its base forward is
  // never implicit (docs/projects/bugs.md — "what base does this run build on is
  // never implicit"). The captured baseReconciled rides the SandboxSpec for any
  // downstream operator surface; this log is the minimum observability.
  log.info('Reconciled resumed branch base via rebase', {
    branch,
    baseBranch,
    previousTip,
    newTip,
    baseAheadCount,
  });
  return {
    baseSha: newTip,
    baseReconciled: {
      strategy: 'rebase',
      baseBranch,
      previousTip,
      newTip,
      baseAheadCount,
    },
  };
}

async function removeWorktreeAfterReconciliationFailure(
  runGit: GitRunner,
  repoPath: string,
  worktree: string,
  branch: string,
  baseBranch: string,
): Promise<void> {
  try {
    await runGit(['worktree', 'remove', '--force', worktree], { cwd: repoPath });
    removeVitestCache(worktree);
  } catch (removeErr) {
    log.warn(
      'Failed to remove worktree after resume base reconciliation failure',
      { branch, baseBranch, worktree, err: (removeErr as Error).message },
    );
  }
}

async function revParse(
  runGit: GitRunner,
  cwd: string,
  ref: string,
  label: string,
): Promise<string> {
  try {
    const { stdout } = await runGit(['rev-parse', ref], { cwd });
    const sha = stdout.trim();
    if (!sha) throw new Error(`empty ${label}`);
    return sha;
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    throw new Error(
      `createWorktree: git rev-parse ${ref} failed in ${cwd}: ` +
        `${(err as Error).message}${stderr ? ` — ${stderr.trim()}` : ''}`,
    );
  }
}

async function mergeBaseHead(
  runGit: GitRunner,
  cwd: string,
  baseBranch: string,
): Promise<string> {
  try {
    const { stdout } = await runGit(['merge-base', 'HEAD', baseBranch], { cwd });
    const sha = stdout.trim();
    if (!sha) throw new Error('empty merge-base');
    return sha;
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    throw new Error(
      `createWorktree: git merge-base HEAD ${baseBranch} failed in ${cwd}: ` +
        `${(err as Error).message}${stderr ? ` — ${stderr.trim()}` : ''}`,
    );
  }
}

async function countBaseAhead(
  runGit: GitRunner,
  cwd: string,
  baseBranch: string,
): Promise<number> {
  try {
    const { stdout } = await runGit(['rev-list', '--count', `HEAD..${baseBranch}`], { cwd });
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    throw new Error(
      `createWorktree: git rev-list --count HEAD..${baseBranch} failed in ${cwd}: ` +
        `${(err as Error).message}${stderr ? ` — ${stderr.trim()}` : ''}`,
    );
  }
}

/**
 * Resolve a local branch's tip sha, or `null` when the branch doesn't exist.
 *
 * `git show-ref --verify refs/heads/<branch>` prints "<sha> <ref>" and exits 0
 * when the branch exists, or exits non-zero (→ `runGit` rejects) when it
 * doesn't. Any rejection is treated as "absent" so the caller takes the
 * fresh-branch path. Uses `show-ref` rather than `rev-parse` so a resume probe
 * is never conflated with the HEAD capture in callers/tests that key on the
 * `rev-parse` subcommand.
 */
async function resolveBranchTip(
  runGit: GitRunner,
  repoPath: string,
  branch: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(
      ['show-ref', '--verify', `refs/heads/${branch}`],
      { cwd: repoPath },
    );
    const sha = stdout.trim().split(/\s+/)[0] ?? '';
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * RESUME pre-flight: release the run's branch from the product's MAIN checkout.
 *
 * A resumed run checks the existing branch out into a fresh worktree with no
 * `-b`. Git forbids one branch being checked out in two working trees at once,
 * so if the product's main checkout (`repoPath` itself) is sitting on that
 * branch, `git worktree add` fails with "already used by worktree at '<repo>'".
 * This happens whenever a human checks the run's branch out in the main repo to
 * make a manual fix (the 2026-06-29 project-19 collision).
 *
 * When the main checkout is on the run's branch, switch it back to `baseBranch`
 * to free the branch — but only when that tree is clean. A dirty tree means
 * uncommitted human work; silently switching could strand or carry it across, so
 * fail loudly and tell the caller to commit or stash. A clean switch loses
 * nothing: the branch keeps every commit and the worktree picks them up.
 *
 * No-op when the main checkout is on any other branch (detached HEAD included),
 * so this never disturbs unrelated manual work. A failure to read the current
 * branch is non-fatal — the `git worktree add` that follows surfaces any real
 * problem with its own clear, path-bearing error.
 */
async function freeBranchFromMainCheckout(
  runGit: GitRunner,
  repoPath: string,
  branch: string,
  baseBranch: string,
): Promise<void> {
  let currentBranch: string;
  try {
    const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
    currentBranch = stdout.trim();
  } catch {
    return;
  }
  if (currentBranch !== branch) return;

  const { stdout: status } = await runGit(['status', '--porcelain'], { cwd: repoPath });
  if (status.trim()) {
    throw new Error(
      `createWorktree: cannot resume ${branch}: the product's main checkout at ` +
        `${repoPath} is on that branch with uncommitted changes. Commit or stash ` +
        `them, then retry — the run must check the branch out in its own worktree.`,
    );
  }
  await runGit(['checkout', baseBranch], { cwd: repoPath });
  log.info(
    `freed ${branch} from main checkout at ${repoPath} (switched to ${baseBranch}) for resume`,
  );
}

export interface DestroyWorktreeOpts {
  productsConfigPath: string;
  /** Worktree-root containment guard — when set, `sandbox.worktree` must
   *  resolve to a path inside `worktreeRoot` or the call refuses to run.
   *  Defends against a hand-constructed `SandboxSpec` pointing
   *  `git worktree remove --force` at an unintended directory. Production
   *  callers should always pass this; tests opt in. */
  worktreeRoot?: string;
  runGit?: GitRunner;
}

/**
 * Handle a createWorktree target path that already exists.
 *
 * A held/parked run preserves its worktree, and a preserved worktree is still
 * git-REGISTERED — `cleanupOrphanWorktrees` deliberately skips registered
 * dirs — so without this the project's next Start would fail on the existing
 * path forever (2026-07-07 codex review finding). Reclaim it only when that is
 * provably safe: registered AND `git status --porcelain` clean — any preserved
 * work is already committed on the branch, which survives the removal and is
 * checked back out by the resume path. A dirty tree is never auto-destroyed
 * (it may hold a finding-hold's uncommitted diff or a human's manual fix); an
 * unregistered dir keeps the original throw — that is the boot orphan sweep's
 * job, and the error's `cleanupOrphanWorktrees()` advice actually applies.
 */
async function reclaimPreservedWorktree(
  runGit: GitRunner,
  repoPath: string,
  worktree: string,
): Promise<void> {
  let registered = false;
  try {
    const { stdout } = await runGit(['worktree', 'list', '--porcelain'], { cwd: repoPath });
    registered = parseRegisteredWorktrees(stdout).has(worktree);
  } catch {
    // Probe failure → fail closed to the unregistered throw below.
  }
  if (!registered) {
    throw new Error(
      `createWorktree: target path already exists: ${worktree} ` +
        `(an orphan from a prior run? run cleanupOrphanWorktrees() or remove manually)`,
    );
  }

  let porcelain: string;
  try {
    const { stdout } = await runGit(['status', '--porcelain'], { cwd: worktree });
    porcelain = stdout;
  } catch (err) {
    throw new Error(
      `createWorktree: a preserved worktree exists at ${worktree} but its state is ` +
        `unreadable (${(err as Error).message}) — remove it manually ` +
        `(git worktree remove --force) and retry`,
    );
  }
  if (porcelain.trim() !== '') {
    throw new Error(
      `createWorktree: preserved worktree at ${worktree} has uncommitted changes — ` +
        `inspect it and commit the work to its branch or discard it ` +
        `(git worktree remove --force), then retry; refusing to auto-remove dirty work`,
    );
  }

  // Clean + registered → safe to reclaim. `--force` only bypasses git's
  // untracked/ignored-file refusal (e.g. the node_modules symlink
  // linkWorktreeDeps creates); cleanliness was verified via porcelain above.
  try {
    await runGit(['worktree', 'remove', '--force', worktree], { cwd: repoPath });
  } catch (err) {
    throw new Error(
      `createWorktree: failed to reclaim clean preserved worktree at ${worktree}: ` +
        `${(err as Error).message} — remove it manually (git worktree remove --force) and retry`,
    );
  }
  removeVitestCache(worktree);
  log.warn('createWorktree: reclaimed clean preserved worktree', { worktree });
}

/**
 * Tear down the run's worktree via `git worktree remove --force <path>` (run
 * with `cwd` set to the product's repo).
 *
 * Idempotent on the one case it needs to be: when git reports "not a working
 * tree" (the worktree is already gone, e.g. from a crashed run that left only
 * disk crumbs), the call resolves silently — the caller's intent (this
 * worktree should not exist) is satisfied. Any other failure rethrows with a
 * clear error.
 *
 * When `worktreeRoot` is supplied, the function verifies `sandbox.worktree`
 * lies inside it (lexically, mirroring `isWriteAllowed`'s containment check)
 * before invoking git — so a caller cannot delete an arbitrary directory by
 * constructing a `SandboxSpec` with an out-of-tree path.
 */
export async function destroyWorktree(
  sandbox: SandboxSpec,
  opts: DestroyWorktreeOpts,
): Promise<void> {
  const runGit = opts.runGit ?? defaultRunGit;
  const product = getProductConfig(sandbox.product, opts.productsConfigPath);

  if (opts.worktreeRoot !== undefined &&
      !isContainedIn(opts.worktreeRoot, sandbox.worktree)) {
    throw new Error(
      `destroyWorktree: refusing to remove ${sandbox.worktree} — ` +
        `path is not inside worktreeRoot ${opts.worktreeRoot}`,
    );
  }

  try {
    await runGit(
      ['worktree', 'remove', '--force', sandbox.worktree],
      { cwd: product.repoPath },
    );
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    if (/not a working tree/i.test(stderr)) {
      // Already gone — idempotent success.
      removeVitestCache(sandbox.worktree);
      return;
    }
    throw new Error(
      `destroyWorktree: git worktree remove failed for ${sandbox.worktree}: ` +
        `${(err as Error).message}${stderr ? ` — ${stderr.trim()}` : ''}`,
    );
  }
  removeVitestCache(sandbox.worktree);
}

// ---------------------------------------------------------------------------
// Orphan cleanup
// ---------------------------------------------------------------------------

export interface CleanupOpts {
  worktreeRoot: string;
  productsConfigPath: string;
  /** Optional orchestrated-run artifact dir. When supplied, resumable
   *  `cursor.json` files under it protect their worktree path from the orphan
   *  sweep even if git no longer lists the worktree as registered. */
  workRunsDir?: string;
  runGit?: GitRunner;
}

interface ResumableRunCursor {
  runId: string;
  product: string;
  project: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  resumeMarker: 'resumable';
  cursor: {
    completedTaskIds: string[];
    currentTaskId: string | null;
    nextTaskId: string | null;
  };
}

/**
 * Startup sweep — for each product in products.json, prune the repo's internal
 * worktree records and remove any on-disk `<worktreeRoot>/<product>/*` dir
 * that `git worktree list --porcelain` no longer reports as registered.
 *
 * Returns the list of removed on-disk paths so the caller can log a count.
 *
 * Tolerances:
 * - Missing `worktreeRoot`: returns `[]`, makes no git calls.
 * - Missing `products.json`: returns `[]`, makes no git calls.
 * - A single product's git invocation failing: logged, skipped, the sweep
 *   continues to the next product. One bad repo cannot block startup.
 */
export async function cleanupOrphanWorktrees(opts: CleanupOpts): Promise<string[]> {
  if (!existsSync(opts.productsConfigPath)) return [];
  if (!existsSync(opts.worktreeRoot)) return [];

  const runGit = opts.runGit ?? defaultRunGit;
  const products = readProductsConfig(opts.productsConfigPath);
  const resumableWorktrees = readResumableWorktreePaths(opts.workRunsDir, opts.worktreeRoot);
  const removed: string[] = [];

  for (const [slug, product] of Object.entries(products)) {
    const productRoot = join(opts.worktreeRoot, slug);
    if (!existsSync(productRoot)) continue;

    try {
      await runGit(['worktree', 'prune'], { cwd: product.repoPath });
    } catch (err) {
      log.warn('cleanupOrphanWorktrees: prune failed; skipping product', {
        product: slug,
        error: (err as Error).message,
      });
      continue;
    }

    let porcelain = '';
    try {
      const result = await runGit(
        ['worktree', 'list', '--porcelain'],
        { cwd: product.repoPath },
      );
      porcelain = result.stdout;
    } catch (err) {
      log.warn('cleanupOrphanWorktrees: list failed; skipping product', {
        product: slug,
        error: (err as Error).message,
      });
      continue;
    }

    const registered = parseRegisteredWorktrees(porcelain);

    let onDisk: string[];
    try {
      onDisk = readdirSync(productRoot)
        .map((name) => join(productRoot, name))
        .filter((p) => {
          try { return statSync(p).isDirectory(); } catch { return false; }
        });
    } catch {
      continue;
    }

    for (const dir of onDisk) {
      if (registered.has(dir)) continue;
      if (resumableWorktrees.has(dir)) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
        removeVitestCache(dir);
        removed.push(dir);
      } catch (err) {
        log.warn('cleanupOrphanWorktrees: rm failed', {
          path: dir,
          error: (err as Error).message,
        });
      }
    }
  }

  return removed;
}

/** Pull the `worktree <path>` lines out of `git worktree list --porcelain`
 *  output. The format is groups of records separated by blank lines; each
 *  record starts with a `worktree <absolute-path>` line. */
function parseRegisteredWorktrees(porcelain: string): Set<string> {
  const out = new Set<string>();
  for (const line of porcelain.split('\n')) {
    const m = /^worktree\s+(.+)$/.exec(line);
    if (m && m[1]) out.add(m[1].trim());
  }
  return out;
}

function readResumableWorktreePaths(
  workRunsDir: string | undefined,
  worktreeRoot: string,
): Set<string> {
  const out = new Set<string>();
  if (!workRunsDir || !existsSync(workRunsDir)) return out;

  let runDirs: string[];
  try {
    runDirs = readdirSync(workRunsDir);
  } catch {
    return out;
  }

  for (const name of runDirs) {
    const cursorPath = join(workRunsDir, name, 'cursor.json');
    let raw: string;
    try {
      if (!statSync(join(workRunsDir, name)).isDirectory() || !existsSync(cursorPath)) continue;
      raw = readFileSync(cursorPath, 'utf8');
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isOrchestrationRunCursor(parsed)) continue;
    let expectedPath: string;
    try {
      expectedPath = worktreePathFor(parsed.product, parsed.project, worktreeRoot);
    } catch {
      continue;
    }
    if (parsed.worktreePath === expectedPath) {
      out.add(parsed.worktreePath);
    }
  }

  return out;
}

function isOrchestrationRunCursor(value: unknown): value is ResumableRunCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<ResumableRunCursor>;
  const position = cursor.cursor as Partial<ResumableRunCursor['cursor']> | undefined;
  return (
    cursor.resumeMarker === 'resumable' &&
    typeof cursor.runId === 'string' &&
    typeof cursor.product === 'string' &&
    typeof cursor.project === 'string' &&
    typeof cursor.branch === 'string' &&
    typeof cursor.baseBranch === 'string' &&
    typeof cursor.worktreePath === 'string' &&
    cursor.worktreePath.length > 0 &&
    !!position &&
    Array.isArray(position.completedTaskIds) &&
    position.completedTaskIds.every((taskId) => typeof taskId === 'string') &&
    (position.currentTaskId === null || typeof position.currentTaskId === 'string') &&
    (position.nextTaskId === null || typeof position.nextTaskId === 'string')
  );
}
