/**
 * Git-free enumeration of this repository's source files, for tests that scan
 * the tree.
 *
 * `git ls-files` is the obvious way to do this and the wrong one: the trusted
 * Vitest observer runs the suite against a `checkout-index` materialization of
 * the reviewed tree, which has **no `.git`** and no repository ancestor. A test
 * that shells out to git in the ambient cwd therefore passes in the worktree and
 * throws under the observer — a divergence that turns the authoritative
 * full-suite manifest red while `npm test` is green.
 *
 * Walking directories is also strictly stronger for "no offender exists"
 * assertions: it sees untracked files too, so a scratch file carrying a banned
 * string is caught rather than skipped.
 *
 * Test-only; nothing in the runtime path imports this.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { PROJECT_ROOT } from '../config.js';

/** Directories that never contain reviewable source. */
const PRUNED = new Set(['node_modules', '.git']);

function walk(absoluteDir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(absoluteDir);
  } catch {
    return; // absent root (e.g. a directory that does not exist in this tree)
  }
  for (const entry of entries) {
    // Dot-directories are tooling state (`.rune`, `.worktrees`, `.claude`), and
    // most are gitignored, so they differ between the worktree and the
    // materialized tree. Never scan them.
    if (entry.startsWith('.') || PRUNED.has(entry)) continue;
    const path = join(absoluteDir, entry);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      continue; // raced or broken symlink
    }
    if (isDirectory) walk(path, out);
    else out.push(path);
  }
}

/**
 * Absolute paths of every file under `roots` (repo-relative directory names),
 * pruned as described above. Missing roots are skipped rather than throwing, so
 * the same call works in a tree that does not carry every directory.
 */
export function repoFiles(roots: readonly string[], base = PROJECT_ROOT): string[] {
  const out: string[] = [];
  for (const root of roots) walk(join(base, root), out);
  return out;
}

/** As `repoFiles`, but repo-relative — the form assertions read best in. */
export function repoRelativeFiles(roots: readonly string[], base = PROJECT_ROOT): string[] {
  return repoFiles(roots, base).map((path) => relative(base, path));
}
