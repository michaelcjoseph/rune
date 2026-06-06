/**
 * Memory-scoped commit helper (project 12, Phase 2).
 *
 * Captured lessons are auto-committed, one atomic commit per capture. This helper
 * stages ONLY `agents/writer/memory.md` in the jarvis repo and makes a single
 * commit — deliberately NOT the vault's `gitCommitAndPush` (which runs
 * `git add -A` in `VAULT_DIR` and so cannot guarantee atomicity here, and would
 * sweep in unrelated dirty files). No push: capture commits locally; review and
 * any revert happen later, one commit at a time.
 *
 * SCAFFOLD: the body throws `notImplemented(...)` so the Phase 2 atomic-commit
 * test is RED until the implementation lands.
 */

/** Repo-relative path the helper is allowed to stage — a closed constant so the
 *  commit can never be widened to `git add -A`. */
export const MEMORY_REPO_PATH = 'agents/writer/memory.md';

export interface CommitWriterMemoryOpts {
  /** Repo root containing `agents/writer/memory.md`. Defaults to the jarvis repo
   *  root, derived from the module path the same way `src/writer/memory.ts`
   *  derives WRITER_DIR (NOT via env-heavy config), so this stays self-contained.
   *  TRUSTED test seam — tests point this at a temp git repo. */
  cwd?: string;
  /** Commit subject. */
  message: string;
}

export interface CommitWriterMemoryResult {
  /** True when a commit was created; false when there was nothing to commit
   *  (memory.md unchanged). */
  committed: boolean;
  /** Short SHA of the created commit, when one was made. */
  sha?: string;
}

function notImplemented(fn: string): never {
  throw new Error(`writer/commit: ${fn} not implemented (project 12 Phase 2 pending)`);
}

/** Stage ONLY `agents/writer/memory.md` and create one commit. Never runs
 *  `git add -A`, so unrelated dirty files in the repo stay unstaged. No push.
 *  Async to match every other git helper in the codebase (src/vault/git.ts,
 *  src/jobs/sandbox-runtime.ts) and to avoid blocking the event loop during the
 *  blog `handleMessage` turn that triggers capture. */
export function commitWriterMemory(
  _opts: CommitWriterMemoryOpts,
): Promise<CommitWriterMemoryResult> {
  return notImplemented('commitWriterMemory');
}
