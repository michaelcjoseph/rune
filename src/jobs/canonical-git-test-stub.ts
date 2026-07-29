/**
 * Shared canonical-Git stub for team-task workflow tests.
 *
 * Since coder self-review became a worktree-editing pass, every workflow test
 * has to satisfy the same canonical sequence — `add -A` → `write-tree` (before
 * and after the pass) → `diff HEAD` (+ `--name-only`) — and each suite was
 * hand-rolling the identical four-branch runner.
 *
 * The tree id is derived from the *current* diff on purpose: a self-review that
 * edits the worktree changes the diff and therefore the tree, which is exactly
 * the signal `confirmed` (tree unchanged) / `revised` (tree changed)
 * enforcement reads. Tests pass a getter rather than a value so the stub
 * observes edits made after it was built.
 *
 * Test-only; nothing in the runtime path imports this.
 */

import type { GitRunner } from './sandbox-runtime.js';

export function stubCanonicalGit(
  currentDiff: () => string,
  changedPath: string,
): GitRunner {
  return async (args) => {
    if (args.includes('write-tree')) {
      return { stdout: `tree:${currentDiff()}\n`, stderr: '' };
    }
    if (args.includes('--name-only')) return { stdout: `${changedPath}\n`, stderr: '' };
    if (args.includes('diff')) return { stdout: currentDiff(), stderr: '' };
    return { stdout: '', stderr: '' };
  };
}
