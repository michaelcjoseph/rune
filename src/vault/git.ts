import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('git');

const execFile = promisify(execFileCb);

const execOpts = {
  cwd: config.VAULT_DIR,
  timeout: 15_000,
};

// The vault is a content repo with a strictly linear history on `main`. It must
// never accumulate commits on a stray branch — see the pkms CLAUDE.md "Git
// Discipline" rule and the 2026-05-30 feat/planning-recovery cleanup, where a
// branch silently absorbed 4 days of automation commits. Every vault commit goes
// through gitCommitAndPush, so the branch guard lives here at the single chokepoint.
const MAIN_BRANCH = 'main';

async function currentBranch(): Promise<string> {
  const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], execOpts);
  return stdout.trim();
}

// Returns true if the vault is on `main` (or was successfully switched back to it).
// Returns false if we could not confirm/restore main, in which case the caller
// must NOT commit — committing to the wrong branch is the exact failure we guard against.
async function ensureOnMain(): Promise<boolean> {
  let branch: string;
  try {
    branch = await currentBranch();
  } catch (err) {
    log.error('Git branch check failed; refusing to commit', { error: (err as Error).message });
    return false;
  }

  if (branch === MAIN_BRANCH) return true;

  // Self-heal: switch back to main before committing. Uncommitted working-tree
  // changes carry over to main on checkout. Logged loudly so the stray branch
  // (and any commits already orphaned on it) gets human attention.
  log.error('Vault is on a non-main branch; switching to main before commit', { branch });
  try {
    await execFile('git', ['checkout', MAIN_BRANCH], execOpts);
    return true;
  } catch (err) {
    log.error('Failed to switch vault to main; refusing to commit', {
      branch,
      error: (err as Error).message,
    });
    return false;
  }
}

/** Strict commit+push: THROWS on any failure (not-on-main, commit, push).
 *  For callers that must surface a non-durable write to the user instead of
 *  reporting a phantom success — e.g. the log_idea / log_conversation MCP
 *  tools (project 16). Returns 'nothing-to-commit' as a benign outcome (no
 *  push attempted — matches the long-standing gitCommitAndPush behavior). */
export async function gitCommitAndPushOrThrow(message: string): Promise<'pushed' | 'nothing-to-commit'> {
  if (!(await ensureOnMain())) {
    throw new Error('vault is not on main; refusing to commit');
  }

  try {
    await execFile('git', ['add', '-A'], execOpts);
    await execFile('git', ['commit', '-m', message], execOpts);
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr || '';
    if (stderr.includes('nothing to commit')) return 'nothing-to-commit';
    throw new Error(`git commit failed: ${(err as Error).message}`);
  }

  try {
    await execFile('git', ['push'], execOpts);
  } catch (err) {
    throw new Error(`git push failed: ${(err as Error).message}`);
  }
  return 'pushed';
}

/** Best-effort commit+push: failures are logged, never thrown. The default
 *  for background jobs where a git hiccup must not break the pipeline. */
export async function gitCommitAndPush(message: string): Promise<void> {
  try {
    await gitCommitAndPushOrThrow(message);
  } catch (err) {
    log.error('Git commit/push error', { error: (err as Error).message });
  }
}
