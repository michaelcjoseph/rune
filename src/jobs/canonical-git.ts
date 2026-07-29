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
  type CanonicalReviewState,
} from '../intent/team-task-workflow.js';
import { DEFAULT_BASE_ENV_KEYS, getBaseEnv } from './credential-injector.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import { redactSecrets } from './work-run-transcript.js';

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
  const bin = process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : 'git';
  const spawnArgs = process.platform === 'darwin'
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

/** Stage and capture the one canonical review surface used both before
 * judgment roles and after mechanical validation. */
export async function captureCanonicalReviewState(
  runGit: GitRunner,
  cwd: string,
): Promise<CanonicalReviewState> {
  await runGit(['add', '-A'], { cwd });
  const [diffResult, pathsResult] = await Promise.all([
    runGit(['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD'], { cwd }),
    runGit(
      ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--name-only', 'HEAD'],
      { cwd },
    ),
  ]);
  return {
    diff: scrubCanonicalReviewDiff(diffResult.stdout),
    hash: canonicalReviewDiffHash(diffResult.stdout),
    changedPaths: pathsResult.stdout
      .split(/\r?\n/)
      .map((path) => scrubAbsolutePaths(scrubPathsInText(path.trim())))
      .filter(Boolean)
      .slice(0, CANONICAL_CHANGED_PATHS_MAX),
  };
}
