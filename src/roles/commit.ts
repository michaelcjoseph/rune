/**
 * Role-memory-scoped commit helper (project 14, Phase 6).
 *
 * Generalizes `src/writer/commit.ts` to the six product-team roles. Captured
 * lessons are auto-committed one atomic commit per write. This helper stages ONLY
 * `agents/<role>/memory.md` in the jarvis repo — never `git add -A`, so unrelated
 * dirty files stay untouched and a learning-loop write can never sweep in other
 * work. No push: capture commits locally; review and any revert happen later, one
 * commit at a time. Refuses to commit off `main` (mirrors the vault's on-main guard).
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from '../utils/logger.js';
import { MEMORY_FILENAME, type RoleName } from './loader.js';

const execFile = promisify(execFileCb);
const log = createLogger('role-commit');

/** The only branch capture commits may land on (mirrors src/writer/commit.ts). */
const CANONICAL_BRANCH = 'main';

// Repo root derived from the module path (src/roles/ → ../..), the same way
// loader.ts derives REPO_ROOT — keeps this module free of the env-heavy config.ts
// so its unit tests run without the app's required env vars.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Repo-relative path to a role's memory file — the only pathspec this helper
 *  stages. `role` is a closed union (`RoleName`), so no `../` traversal is
 *  expressible through it. */
export function roleMemoryRepoPath(role: RoleName): string {
  return `agents/${role}/${MEMORY_FILENAME}`;
}

export interface CommitRoleMemoryOpts {
  /** The role whose `memory.md` to stage + commit. */
  role: RoleName;
  /** Commit subject. */
  message: string;
  /** Repo root containing `agents/<role>/memory.md`. Defaults to the jarvis repo
   *  root, derived from the module path. TRUSTED test seam — tests point this at a
   *  temp git repo. */
  cwd?: string;
}

export interface CommitRoleMemoryResult {
  /** True when a commit was created; false when nothing to commit (memory unchanged). */
  committed: boolean;
  /** Short SHA of the created commit, when one was made. */
  sha?: string;
}

// Per-git-call budget (not the whole sequence).
const GIT_TIMEOUT_MS = 15_000;

/** Stage ONLY `agents/<role>/memory.md` and create one commit. Never runs
 *  `git add -A`. No push. Async to match every other git helper in the codebase. */
export async function commitRoleMemory(
  opts: CommitRoleMemoryOpts,
): Promise<CommitRoleMemoryResult> {
  const cwd = opts.cwd ?? REPO_ROOT;
  const execOpts = { cwd, timeout: GIT_TIMEOUT_MS };
  const memoryPath = roleMemoryRepoPath(opts.role);
  // Defensive boundary: collapse newlines and cap length so a future caller passing
  // a message derived from feedback/lesson text can't produce a multi-line commit
  // subject in the repo's public history. execFile (no shell) already blocks
  // injection; this bounds the message shape.
  const safeMessage = opts.message.replace(/[\r\n]+/g, ' ').slice(0, 500);

  // Refuse to commit off the canonical branch — a daemon stuck on a feature branch
  // would otherwise quietly pollute it with capture commits (mirrors ensureOnMain).
  const { stdout: branchOut } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], execOpts);
  const branch = branchOut.trim();
  if (branch !== CANONICAL_BRANCH) {
    log.error('Refusing role-memory commit off the canonical branch', { branch, role: opts.role });
    return { committed: false };
  }

  // Stage only the one path — a pathspec, never `git add -A`.
  await execFile('git', ['add', '--', memoryPath], execOpts);

  // Nothing staged for this memory.md (unchanged) → no empty commit.
  const { stdout: staged } = await execFile(
    'git',
    ['diff', '--cached', '--name-only', '--', memoryPath],
    execOpts,
  );
  if (!staged.trim()) return { committed: false };

  // Pathspec commit: records ONLY this memory.md, leaving any other staged or dirty
  // files untouched. No push.
  await execFile('git', ['commit', '-m', safeMessage, '--', memoryPath], execOpts);

  const { stdout: sha } = await execFile('git', ['rev-parse', '--short', 'HEAD'], execOpts);
  return { committed: true, sha: sha.trim() };
}
