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
import { existsSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One product's entry in `policies/products.json`. Tilde-bearing paths are
 *  expanded to absolute paths by `readProductsConfig` before this is returned
 *  to a caller. */
export interface ProductConfig {
  /** Absolute path of the product's repo (the one `git worktree add` targets). */
  repoPath: string;
  /** Branch a fresh worktree is based on when no explicit branch is given. */
  baseBranch: string;
  /** Absolute path of the product's scoped credentials file (A1.2 wires this). */
  credentialsFile: string;
  /** Hosts a sandboxed run for this product may make network egress to. */
  egressAllowlist: string[];
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
    const repoPath = expandTilde(String(entry['repoPath'] ?? ''));
    if (!repoPath) {
      throw new Error(
        `readProductsConfig: product '${slug}' is missing required field 'repoPath' in ${path}`,
      );
    }
    out[slug] = {
      repoPath,
      baseBranch: String(entry['baseBranch'] ?? 'main'),
      credentialsFile: expandTilde(String(entry['credentialsFile'] ?? '')),
      egressAllowlist: Array.isArray(entry['egressAllowlist'])
        ? (entry['egressAllowlist'] as unknown[]).map(String)
        : [],
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
 * - When `branch` is given, a new branch is created and the worktree checks
 *   it out via `git worktree add -b <branch> <path>` (no implicit base —
 *   git uses HEAD of the repo).
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
    throw new Error(
      `createWorktree: target path already exists: ${worktree} ` +
        `(an orphan from a prior run? run cleanupOrphanWorktrees() or remove manually)`,
    );
  }

  // When branching, capture the base sha BEFORE the add so the branch point
  // and the diff base are one stable value — a `HEAD` that moves after this
  // can't change `baseSha..branch`. An explicit `startPoint` skips the resolve.
  let baseSha: string | undefined;
  if (opts.branch) {
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
      // A repo that can host a run always has a HEAD commit — empty stdout means
      // a misconfigured/empty repo. Fail loudly rather than silently branching
      // with no base (which would leave the diff base undefined downstream).
      if (!baseSha) {
        throw new Error(
          `createWorktree: git rev-parse HEAD returned empty for ${product.repoPath} ` +
            `(repo has no commits?) — cannot capture a stable base sha`,
        );
      }
    }
  }

  // `git worktree add [-b <new-branch>] <path> [<commit-ish>]` — flag before
  // path is the canonical form and what older git versions require. The
  // start-point (baseSha) goes last when branching from a captured commit.
  // When branching, baseSha is guaranteed non-empty above (else we threw).
  const args: string[] = opts.branch
    ? ['worktree', 'add', '-b', opts.branch, worktree, baseSha!]
    : ['worktree', 'add', worktree, product.baseBranch];

  try {
    await runGit(args, { cwd: product.repoPath });
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    throw new Error(
      `createWorktree: git worktree add failed for ${worktree}: ` +
        `${(err as Error).message}${stderr ? ` — ${stderr.trim()}` : ''}`,
    );
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
  };
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
      return;
    }
    throw new Error(
      `destroyWorktree: git worktree remove failed for ${sandbox.worktree}: ` +
        `${(err as Error).message}${stderr ? ` — ${stderr.trim()}` : ''}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Orphan cleanup
// ---------------------------------------------------------------------------

export interface CleanupOpts {
  worktreeRoot: string;
  productsConfigPath: string;
  runGit?: GitRunner;
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
      try {
        rmSync(dir, { recursive: true, force: true });
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
