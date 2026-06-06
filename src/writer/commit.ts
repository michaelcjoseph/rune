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
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from '../utils/logger.js';

const execFile = promisify(execFileCb);
const log = createLogger('writer-commit');

/** The only branch capture commits may land on. Mirrors the vault's on-main
 *  guard (src/vault/git.ts) — automation must never accumulate commits on a
 *  stray/feature branch. */
const CANONICAL_BRANCH = 'main';

// Repo root derived from the module path (src/writer/ → ../..), the same way
// memory.ts derives WRITER_DIR — keeps this module free of the env-heavy
// config.ts so its unit tests run without the app's required env vars.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

// Per-git-call budget (not the whole sequence). The outer withTimeout in
// src/reviews/blog.ts (20s) is the binding wall-clock guard for the blog turn.
const GIT_TIMEOUT_MS = 15_000;

/** Stage ONLY `agents/writer/memory.md` and create one commit. Never runs
 *  `git add -A`, so unrelated dirty files in the repo stay unstaged. No push.
 *  Async to match every other git helper in the codebase (src/vault/git.ts,
 *  src/jobs/sandbox-runtime.ts) and to avoid blocking the event loop during the
 *  blog `handleMessage` turn that triggers capture. */
export async function commitWriterMemory(
  opts: CommitWriterMemoryOpts,
): Promise<CommitWriterMemoryResult> {
  const cwd = opts.cwd ?? REPO_ROOT;
  const execOpts = { cwd, timeout: GIT_TIMEOUT_MS };

  // Refuse to commit off the canonical branch — a daemon stuck on a feature
  // branch would otherwise quietly pollute it with capture commits. Loud log so
  // a stray-branch daemon is noticed (mirrors the vault's ensureOnMain).
  const { stdout: branchOut } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], execOpts);
  const branch = branchOut.trim();
  if (branch !== CANONICAL_BRANCH) {
    log.error('Refusing writer-memory commit off the canonical branch', { branch });
    return { committed: false };
  }

  // Stage only the one path — a pathspec, never `git add -A`.
  await execFile('git', ['add', '--', MEMORY_REPO_PATH], execOpts);

  // Nothing staged for memory.md (unchanged) → no empty commit.
  const { stdout: staged } = await execFile(
    'git',
    ['diff', '--cached', '--name-only', '--', MEMORY_REPO_PATH],
    execOpts,
  );
  if (!staged.trim()) return { committed: false };

  // Pathspec commit: records ONLY memory.md, leaving any other staged or dirty
  // files untouched. No push — capture commits locally; review/revert happen later.
  await execFile('git', ['commit', '-m', opts.message, '--', MEMORY_REPO_PATH], execOpts);

  const { stdout: sha } = await execFile('git', ['rev-parse', '--short', 'HEAD'], execOpts);
  return { committed: true, sha: sha.trim() };
}
