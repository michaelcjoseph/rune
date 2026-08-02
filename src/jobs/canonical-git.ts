/**
 * Git boundary for product-influenced canonical review capture.
 *
 * Unlike ordinary Rune-owned Git operations, canonical staging can consult
 * product-controlled attributes and repository config. Run it with the same
 * credential-stripped environment and macOS network denial as validation so a
 * clean/process filter or diff driver cannot inherit Rune secrets or exfiltrate.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import type { GitRunner } from './sandbox-runtime.js';
import {
  CANONICAL_CHANGED_PATHS_MAX,
  isGitObjectId,
  type CanonicalReviewState,
} from '../intent/team-task-workflow.js';
import { DEFAULT_BASE_ENV_KEYS, getBaseEnv } from './credential-injector.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import { redactSecrets } from './work-run-transcript.js';
import { verifyInheritedValidationConfinement } from './validation-sandbox-broker.js';

const execFileAsync = promisify(execFile);
const NETWORK_DENY_PROFILE = [
  '(version 1)',
  '(allow default)',
  '(deny network-outbound)',
  '(deny network-inbound)',
].join('');

export const defaultRunCanonicalGit: GitRunner = async (args, opts) => {
  const cwd = opts?.cwd;
  if (!cwd) throw new Error('canonical Git requires a worktree cwd');
  const env: NodeJS.ProcessEnv = {
    ...getBaseEnv(DEFAULT_BASE_ENV_KEYS),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  await rejectExternalGitDrivers(cwd, env);
  const gitArgs = [
    '-c',
    'core.fsmonitor=false',
    '-c',
    'credential.helper=',
    ...args,
  ];
  // A nested helper may reuse the shard's already-applied Seatbelt only when
  // the live enclosing broker verifies its socket/nonce/profile tuple. The
  // legacy compatible-mode marker is diagnostic and grants no authority.
  const inheritedConfinement = process.platform === 'darwin' &&
    await verifyInheritedValidationConfinement('sandbox-integration');
  const useSeatbelt = process.platform === 'darwin' && !inheritedConfinement;
  const bin = useSeatbelt ? '/usr/bin/sandbox-exec' : 'git';
  const spawnArgs = useSeatbelt
    ? ['-p', NETWORK_DENY_PROFILE, 'git', ...gitArgs]
    : gitArgs;
  const result = await execFileAsync(bin, spawnArgs, {
    cwd,
    env,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

async function rejectExternalGitDrivers(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    const result = await execFileAsync(
      'git',
      [
        '-c',
        'core.fsmonitor=false',
        'config',
        '--name-only',
        '--get-regexp',
        '^(filter\\..*\\.(clean|process)|diff\\..*\\.(command|textconv))$',
      ],
      { cwd, env, timeout: 30_000 },
    );
    const keys = result.stdout.trim();
    if (keys !== '') {
      throw new Error(`canonical Git refuses external repository drivers: ${keys}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException & { code?: number }).code === 1) return;
    throw err;
  }
}

export function scrubCanonicalReviewDiff(diff: string): string {
  return redactSecrets(scrubAbsolutePaths(scrubPathsInText(diff)));
}

export function normalizeCanonicalReviewDiff(diff: string): string {
  return scrubCanonicalReviewDiff(diff).replace(/\r\n?/g, '\n').trim();
}

export function canonicalReviewDiffHash(diff: string): string {
  return createHash('sha256').update(normalizeCanonicalReviewDiff(diff)).digest('hex');
}

/** Re-exported so callers of `captureCanonicalReviewState` need only this
 * module. The shape is declared once, next to the workflow contract it feeds
 * (`intent/team-task-workflow`); duplicating it here let the two drift apart
 * without a compiler error. */
export type { CanonicalReviewState };

/** Re-exported for the same reason as `CanonicalReviewState`: the shape is
 * declared once beside the workflow contract, and callers of this module need
 * only this import. */
export { isGitObjectId };

async function resolveTreeOid(
  runGit: GitRunner,
  cwd: string,
  treeish: string,
): Promise<string> {
  if (!isGitObjectId(treeish)) {
    throw new Error('canonical Git received a malformed tree OID');
  }
  const resolved = (
    await runGit(['rev-parse', '--verify', `${treeish}^{tree}`], { cwd })
  ).stdout.trim();
  if (!isGitObjectId(resolved)) {
    throw new Error('canonical Git could not verify the tree OID');
  }
  return resolved;
}

function requireTreeOid(treeOid: string): string {
  if (!isGitObjectId(treeOid)) {
    throw new Error('canonical Git received a malformed tree OID');
  }
  return treeOid;
}

/** Capture the clean, durable tree from which one task begins. The caller must
 * persist this record before allowing QA or coder mutation. */
export async function captureCleanTaskBaseTree(
  runGit: GitRunner,
  cwd: string,
): Promise<string> {
  const status = await runGit(
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd },
  );
  if (status.stdout.trim() !== '') {
    throw new Error('task-base capture requires a clean worktree');
  }
  await runGit(['add', '-A'], { cwd });
  // `resolveTreeOid` rejects a malformed OID on entry, so no pre-check here.
  const written = (await runGit(['write-tree'], { cwd })).stdout.trim();
  return resolveTreeOid(runGit, cwd, written);
}

/** Verify an already-durable task base (for restart recovery) without deriving
 * a new baseline from the possibly mutated worktree. */
export async function verifyTaskBaseTree(
  runGit: GitRunner,
  cwd: string,
  treeOid: string,
): Promise<string> {
  return resolveTreeOid(runGit, cwd, treeOid);
}

/** Resolve a closeout commit to its authoritative tree for legacy-cursor
 * recovery. */
export async function treeForCommit(
  runGit: GitRunner,
  cwd: string,
  commitOid: string,
): Promise<string> {
  if (!isGitObjectId(commitOid)) {
    throw new Error('canonical Git received a malformed commit OID');
  }
  return resolveTreeOid(runGit, cwd, commitOid);
}

/** Stage the worktree and resolve the base/current tree pair every full-task
 * capture compares. The task base was verified before the cursor was persisted
 * and `write-tree` is itself authoritative for the current tree, so this only
 * re-asserts object-id syntax — which is also what prevents either value from
 * being parsed as a Git option in the diff argv below. */
async function stageFullTaskTrees(
  runGit: GitRunner,
  cwd: string,
  taskBaseTree: string,
): Promise<{ baseTree: string; currentTree: string }> {
  const baseTree = requireTreeOid(taskBaseTree);
  await runGit(['add', '-A'], { cwd });
  const currentTree = requireTreeOid(
    (await runGit(['write-tree'], { cwd })).stdout.trim(),
  );
  return { baseTree, currentTree };
}

function fullTaskDiffArgs(
  baseTree: string,
  currentTree: string,
  ...extra: string[]
): string[] {
  return [
    '--no-pager',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    ...extra,
    baseTree,
    currentTree,
  ];
}

/** Stage and capture the one full-task review surface used both before
 * judgment roles and after mechanical validation. */
export async function captureCanonicalReviewState(
  runGit: GitRunner,
  cwd: string,
  taskBaseTree: string,
): Promise<CanonicalReviewState> {
  const { baseTree, currentTree } = await stageFullTaskTrees(runGit, cwd, taskBaseTree);
  const [diffResult, pathsResult] = await Promise.all([
    runGit(fullTaskDiffArgs(baseTree, currentTree), { cwd }),
    runGit(fullTaskDiffArgs(baseTree, currentTree, '--name-only'), { cwd }),
  ]);
  return {
    diff: scrubCanonicalReviewDiff(diffResult.stdout),
    hash: canonicalReviewDiffHash(diffResult.stdout),
    baseTree,
    currentTree,
    changedPaths: canonicalChangedPaths(pathsResult.stdout),
  };
}

/** Capture only full-task changed paths for mechanical-test selection. The
 * authoritative diff/hash/tree comparison still happens after validation. */
export async function captureCanonicalChangedPaths(
  runGit: GitRunner,
  cwd: string,
  taskBaseTree: string,
): Promise<string[]> {
  const { baseTree, currentTree } = await stageFullTaskTrees(runGit, cwd, taskBaseTree);
  const paths = await runGit(
    fullTaskDiffArgs(baseTree, currentTree, '--name-only'),
    { cwd },
  );
  return canonicalChangedPaths(paths.stdout);
}

function canonicalChangedPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((path) => scrubAbsolutePaths(scrubPathsInText(path.trim())))
    .filter(Boolean)
    .slice(0, CANONICAL_CHANGED_PATHS_MAX);
}
