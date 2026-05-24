/**
 * Sandbox fs wrappers — in-process write helpers that gate `fs.*Sync` writes
 * through `isWriteAllowed` plus a symlink-resolution step.
 *
 * ## Scope
 *
 * These wrappers protect **Jarvis's own writes when acting on behalf of a
 * sandboxed Regime B run** (e.g., the future gen-eval-loop runner writing a
 * prompt file, a checkpoint, or a run-scoped temp file under the run's
 * worktree). They are not, and cannot be, a guard against the child process's
 * own fs syscalls — Claude CLI and Codex are separate OS processes with their
 * own kernel-level fs access. The child-process side is handled by the
 * spawner setting `cwd: sandbox.worktree` and refusing absolute paths in
 * argv; that's the A3 runner's contract, not this module's.
 *
 * ## Why symlinks matter
 *
 * `isWriteAllowed` in `src/intent/sandbox.ts` is a **lexical** containment
 * check — it collapses `..` but does not dereference symlinks. A symlink
 * sitting inside the worktree that points at `/etc/passwd` would slip past
 * the lexical check; `assertWritable` here resolves the target (or its
 * closest existing ancestor, for paths that don't exist yet) via
 * `realpathSync` and re-checks the resolved real path. A symlink that
 * resolves back inside the worktree is still allowed.
 *
 * ## TOCTOU
 *
 * Between `assertWritable` and the wrapped syscall a hostile actor could
 * create a symlink racing the write. The Regime B trust model assumes the
 * executor (Claude CLI / Codex) is non-hostile; this guard catches accidental
 * writes that escape the worktree, not malicious symlinks raced into the
 * worktree mid-write. A future enforcer needs `openat` with `O_NOFOLLOW`
 * (Node has no synchronous equivalent today) to close that gap.
 *
 * ## Operations not wrapped
 *
 * `renameSync`, `symlinkSync`, `chmodSync`, `chownSync`, `truncateSync`,
 * `cpSync`, `createWriteStream`, and the `fs.promises` async variants are
 * intentionally absent — no caller needs them yet. Before any of those is
 * used in a Regime B context, add a guarded wrapper here (note: `rename`
 * needs both source AND destination checked through `assertWritable`).
 * Atomic temp-then-rename writes are likewise a future addition modeled on
 * `src/vault/files.ts` if a caller emerges that needs them.
 *
 * See spec.md §"Layer 4", tasks.md Phase 6 A1.4.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { isContainedIn, isWriteAllowed, type SandboxSpec } from '../intent/sandbox.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sandbox-fs');

// ---------------------------------------------------------------------------
// Core guard
// ---------------------------------------------------------------------------

/**
 * Assert that `targetPath` may be written under `sandbox`. Throws a clear
 * error otherwise, naming both the original target and (when it differs) the
 * symlink-resolved real path so the caller can see which check fired.
 *
 * Two-stage check:
 *
 * 1. **Lexical containment** via `isWriteAllowed` — collapses `..`, denies a
 *    path that doesn't lexically live under `sandbox.worktree`.
 * 2. **Symlink resolution** — walks the target up to the closest existing
 *    ancestor, `realpathSync`s it, substitutes the resolved real path into
 *    the original target, and re-checks `isWriteAllowed`. Catches a symlink
 *    at the target or at any ancestor that points outside the worktree.
 */
export function assertWritable(sandbox: SandboxSpec, targetPath: string): void {
  // `isWriteAllowed` throws on a non-absolute worktree, so the absoluteness
  // invariant is enforced once at the lexical stage and inherited by the
  // symlink-resolved stage below.
  if (!isWriteAllowed(targetPath, sandbox)) {
    log.warn('sandbox-fs: write denied (lexical containment)', {
      target: targetPath,
      worktree: sandbox.worktree,
      product: sandbox.product,
      project: sandbox.project,
    });
    throw new Error(
      `sandbox-fs: write denied (lexical containment): ${targetPath} ` +
        `is not inside worktree ${sandbox.worktree}`,
    );
  }

  // Walk up the target to find the closest existing ancestor — what
  // `realpathSync` can actually resolve. The not-yet-existing suffix is
  // recovered by slicing the original target after the loop.
  let existingAncestor = targetPath;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      // Defensive against synthetic filesystems where `/` may not satisfy
      // existsSync. On real POSIX `existsSync('/')` is true so this branch
      // doesn't fire — but if it does, the lexical check is the only gate
      // available since there's nothing to realpath against.
      return;
    }
    existingAncestor = parent;
  }

  // realpathSync throws ELOOP on a cyclic symlink chain. Treat that as a
  // structured denial so callers see the same "sandbox-fs:" error shape
  // they get for the escape cases, not a raw filesystem error.
  let realAncestor: string;
  try {
    realAncestor = realpathSync(existingAncestor);
  } catch (err) {
    log.warn('sandbox-fs: write denied (realpath failure)', {
      target: targetPath,
      ancestor: existingAncestor,
      worktree: sandbox.worktree,
      error: (err as Error).message,
    });
    throw new Error(
      `sandbox-fs: write denied (realpath failure on ${existingAncestor}): ` +
        `${(err as Error).message}`,
    );
  }

  // On macOS the worktree itself may sit behind a symlink (e.g. `/var/folders`
  // → `/private/var/folders` for mkdtemp paths). For the resolved-target
  // check, compare against the worktree's resolved real path so a target
  // whose realpath crosses that prefix is recognized as contained. If
  // realpath on the worktree itself fails (e.g. the worktree was removed
  // mid-run), fall back to the un-resolved worktree path — this is
  // conservative: it produces a false deny rather than a false allow.
  //
  // The expression `realAncestor + targetPath.slice(existingAncestor.length)`
  // produces `targetPath` verbatim when no symlink redirect occurred
  // (realAncestor === existingAncestor and the suffix is the empty tail),
  // and the resolved real path otherwise — one expression, no branch.
  const resolvedTarget = realAncestor + targetPath.slice(existingAncestor.length);
  let realWorktree: string;
  try {
    realWorktree = realpathSync(sandbox.worktree);
  } catch {
    realWorktree = sandbox.worktree;
  }
  if (!isContainedIn(realWorktree, resolvedTarget)) {
    log.warn('sandbox-fs: write denied (symlink escape)', {
      target: targetPath,
      resolved: resolvedTarget,
      worktree: sandbox.worktree,
      product: sandbox.product,
      project: sandbox.project,
    });
    throw new Error(
      `sandbox-fs: write denied (symlink escape): ${targetPath} resolves to ` +
        `${resolvedTarget}, which is not inside worktree ${sandbox.worktree}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Guarded fs wrappers
// ---------------------------------------------------------------------------

/** `fs.writeFileSync` behind the sandbox write guard. */
export function writeFileInSandbox(
  sandbox: SandboxSpec,
  targetPath: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): void {
  assertWritable(sandbox, targetPath);
  writeFileSync(targetPath, data, encoding);
}

/** `fs.appendFileSync` behind the sandbox write guard. Creates the file if
 *  it doesn't exist (the underlying `O_APPEND | O_CREAT` semantics). */
export function appendFileInSandbox(
  sandbox: SandboxSpec,
  targetPath: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): void {
  assertWritable(sandbox, targetPath);
  appendFileSync(targetPath, data, encoding);
}

/** `fs.mkdirSync` behind the sandbox write guard. `recursive: true` creates
 *  intermediate dirs as needed; intermediate paths inherit the guard
 *  transitively because the lexical check still applies to each. */
export function mkdirInSandbox(
  sandbox: SandboxSpec,
  targetPath: string,
  opts?: { recursive?: boolean },
): void {
  assertWritable(sandbox, targetPath);
  mkdirSync(targetPath, opts);
}

/** `fs.rmSync` behind the sandbox write guard. Pass `{ recursive: true }`
 *  to remove a directory tree; `{ force: true }` to silence ENOENT. */
export function rmInSandbox(
  sandbox: SandboxSpec,
  targetPath: string,
  opts?: { recursive?: boolean; force?: boolean },
): void {
  assertWritable(sandbox, targetPath);
  rmSync(targetPath, opts);
}
