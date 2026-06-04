/**
 * Backlog write mechanics (09-expand-cockpit, Phase 3) — the safe-write substrate the add
 * endpoint composes:
 *
 *   - `withFileLock(key, fn)` — a per-key async mutex. Concurrent appends to the same backlog
 *     file serialize (read → append → write is one critical section), so two near-simultaneous
 *     `+` clicks can't both read the pre-append content and clobber each other on rename.
 *   - `writeFileAtomic(path, content)` — temp-then-rename so a reader never observes a torn write.
 *   - `assertBacklogWriteAllowed(repoPath, absPath)` — the write target must be EXACTLY one of the
 *     two allowed files under the repo, and its realpath must not escape the repo (symlink guard).
 *   - `appendBacklogMutationLog(filePath, entry)` — append-only JSONL audit of every write.
 *
 * Pure-of-config: imports only `node:*` + the sandbox containment helper, so it stays importable
 * in the intent layer without bootstrapping the runtime config. Contract pinned by
 * `backlog-append-api.test.ts` (mutex + temp-then-rename) and `backlog-security.test.ts`.
 */

import { appendFileSync, existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isContainedIn } from './sandbox.js';

/** Thrown when a write target fails the allowed-file / containment guard. The endpoint maps
 *  this to a 500. */
export class BacklogWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BacklogWriteError';
  }
}

// ---------------------------------------------------------------------------
// Per-file mutex
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` exclusively for `key`: it starts only after the previously-queued operation for the
 * same key has settled. Different keys never block each other. The map entry is pruned once the
 * tail settles (when no newer waiter has replaced it) so the lock table doesn't grow unboundedly.
 *
 * This guards only Jarvis's OWN in-process writes; a Claude CLI child (work-run) is a separate
 * actor with no shared lock. The returned promise REJECTS if `fn` throws (a synchronous throw in
 * `fn` surfaces as a rejected `run`) — callers must `await` or attach `.catch()`; the internal
 * cleanup chain never rejects.
 */
export function withFileLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  // Run after prev settles, regardless of whether prev fulfilled or rejected.
  const run = prev.then(() => fn(), () => fn());
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/** Write `content` to `path` via a `.tmp` sibling then rename, so a concurrent reader never sees
 *  a partial file. Creates the parent directory if needed.
 *
 *  Pair this with `assertBacklogWriteAllowed(repoPath, path)` BEFORE calling — there is an
 *  inherent guard-then-write TOCTOU (a symlink swapped in between the check and the write would
 *  be followed), the same OS-level gap documented in `src/jobs/sandbox-fs.ts`. Acceptable under
 *  the single-user local-daemon trust model; `O_NOFOLLOW` is the only true fix and is unavailable
 *  in synchronous Node fs. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Write-target security guard
// ---------------------------------------------------------------------------

/** The only two relative paths a backlog write may target, per repo. */
export const ALLOWED_BACKLOG_FILES = ['docs/projects/bugs.md', 'docs/projects/ideas.md'] as const;

/**
 * Assert `absPath` is a permitted backlog write target under `repoPath`: it must resolve to
 * exactly one of the two allowed files, AND the realpath of its closest existing ancestor must
 * stay inside the repo (so a symlinked file — or symlinked `docs/` dir — escaping the repo is
 * rejected). Throws `BacklogWriteError` otherwise.
 *
 * The realpath is taken on the closest EXISTING ancestor (not the target) so a not-yet-created
 * `bugs.md`/`ideas.md` doesn't ENOENT on the happy path.
 */
export function assertBacklogWriteAllowed(repoPath: string, absPath: string): void {
  const target = resolve(absPath);
  const allowed = ALLOWED_BACKLOG_FILES.map((rel) => resolve(join(repoPath, rel)));
  if (!allowed.includes(target)) {
    throw new BacklogWriteError(`backlog write rejected: '${target}' is not an allowed backlog file`);
  }

  let canonicalRepo: string;
  try {
    canonicalRepo = realpathSync(repoPath);
  } catch {
    throw new BacklogWriteError(`backlog write rejected: repo path '${repoPath}' is unresolvable`);
  }

  let ancestor = target;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
    ancestor = dirname(ancestor);
  }
  let canonicalAncestor: string;
  try {
    canonicalAncestor = realpathSync(ancestor);
  } catch {
    throw new BacklogWriteError(`backlog write rejected: '${target}' is unresolvable`);
  }
  if (!isContainedIn(canonicalRepo, canonicalAncestor)) {
    throw new BacklogWriteError(`backlog write rejected: '${target}' resolves outside the repo`);
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/** One audit record per successful backlog write. `file` is repo-relative (the caller passes the
 *  kind-derived relative path — never an absolute host path). */
export interface BacklogMutationLogEntry {
  product: string;
  file: string;
  branch: string;
  dirty: boolean;
  before: string;
  after: string;
}

/** Append one JSONL audit line to `filePath` (append-only; creates the dir on first write). */
export function appendBacklogMutationLog(filePath: string, entry: BacklogMutationLogEntry): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}
