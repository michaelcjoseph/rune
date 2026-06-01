/**
 * Work-run forensics export (project 11, Phase 3 — "Branch & forensic
 * retention").
 *
 * When a run terminates, `apply()` exports a reconstructable evidence bundle to
 * the per-run dir BEFORE the worktree is destroyed (the worktree is the only
 * place the run branch + uncommitted tree live):
 *
 *   logs/work-runs/<id>/
 *     bundle.git          # `git bundle create` of the run branch
 *     diffstat.txt        # git diff --stat baseSha..branch
 *     status.txt          # git status --porcelain
 *     diff.patch          # working-tree diff (uncommitted, unstaged)
 *     diff-staged.patch   # staged diff
 *     untracked.tar       # non-clean runs only — tarball of untracked files
 *
 * All git invocations go through the injected `GitRunner` seam (the same one
 * `createWorktree`/`computeWorkProduct` take), so the suite never shells out to
 * real git. The text artifacts are captured from `runGit` stdout and written by
 * this module; `bundle.git` and `untracked.tar` are produced by the subprocess
 * the command spawns (git / tar), which writes the file at the given path.
 *
 * Implemented in Phase 3; wired into `work-runner.apply()` via the
 * `runForensics` runtime-deps seam (the `exportForensics` callback of
 * `finalizeWorkRun`), which runs best-effort before the terminal event.
 */

import { execFile as execFileCb } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';
import { redactSecrets } from './work-run-transcript.js';
import type { GitRunner } from './sandbox-runtime.js';

const log = createLogger('work-run-forensics');

/** A minimal valid (empty) tar archive: two 512-byte zero blocks are the
 *  end-of-archive marker, which `tar` reads as an empty archive. Used for the
 *  no-untracked-files case so the export needs no `tar` subprocess. */
const EMPTY_TAR = Buffer.alloc(1024);

export interface ExportForensicsOpts {
  /** Injected git runner — same seam as createWorktree/computeWorkProduct. */
  runGit: GitRunner;
  /** Worktree directory: cwd for every git command and the bundle source. */
  worktree: string;
  /** Per-run output directory (`logs/work-runs/<id>/`). Created if absent. */
  outDir: string;
  /** Captured base sha; diffstat range is `baseSha..branch`. */
  baseSha: string;
  /** The run branch — bundled into `bundle.git`. */
  branch: string;
  /** True when the tree had tracked changes or untracked files. Gates the
   *  `untracked.tar` export (clean runs skip it). */
  nonClean: boolean;
}

export interface ForensicsResult {
  /** Absolute path of the per-run forensics directory (`outDir`). */
  forensicsPath: string;
  /** Basenames of the artifacts actually written, for the run record / logging. */
  files: string[];
}

/** Capture a git command's stdout to a file in `outDir`. Returns the basename
 *  written. A git failure for one artifact is logged and skipped (best-effort),
 *  not propagated — partial forensics beat none. */
async function captureToFile(
  runGit: GitRunner,
  cwd: string,
  outDir: string,
  basename: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await runGit(args, { cwd });
    // Best-effort secret/token redaction before the content hits disk —
    // diff.patch / diff-staged.patch carry the run's full file diffs, which can
    // include a credential the agent wrote to a file. Mirrors the transcript
    // sink's write-time redaction (work-run-transcript.ts).
    writeFileSync(join(outDir, basename), redactSecrets(stdout), 'utf8');
    return basename;
  } catch (err) {
    log.warn('work-run-forensics: artifact capture failed', { basename, error: (err as Error).message });
    return null;
  }
}

/**
 * Export the forensic evidence bundle for a terminated run into `outDir`.
 * Best-effort by contract: the caller (`apply()`'s `exportForensics` callback)
 * swallows a rejection so a forensics failure never denies the terminal event,
 * and each artifact is captured independently so one git failure doesn't lose
 * the rest. Returns the artifacts written so the run record can reference them.
 */
export async function exportForensics(opts: ExportForensicsOpts): Promise<ForensicsResult> {
  const { runGit, worktree, outDir, baseSha, branch, nonClean } = opts;
  mkdirSync(outDir, { recursive: true });
  // `baseSha` is empty only on the degenerate classification-error path (no
  // captured base); fall back to HEAD so the range is an explicit, valid ref
  // pair rather than a silent `..branch` (which git resolves to HEAD anyway).
  const range = `${baseSha || 'HEAD'}..${branch}`;
  const files: string[] = [];

  // Text artifacts — captured from git stdout. The diffstat is over the commit
  // range; diff.patch is the uncommitted working-tree diff; diff-staged.patch
  // is the staged diff; status.txt is the porcelain tree state.
  const textArtifacts: Array<[string, string[]]> = [
    ['diffstat.txt', ['diff', '--stat', range]],
    ['status.txt', ['status', '--porcelain']],
    ['diff.patch', ['diff']],
    ['diff-staged.patch', ['diff', '--staged']],
  ];
  for (const [basename, args] of textArtifacts) {
    const written = await captureToFile(runGit, worktree, outDir, basename, args);
    if (written) files.push(written);
  }

  // bundle.git — `git bundle create` writes the file itself (the run branch,
  // reconstructable later via `git clone bundle.git`). Bundling over a live
  // worktree is fine: the branch ref is in the repo, not the working tree.
  try {
    await runGit(['bundle', 'create', join(outDir, 'bundle.git'), branch], { cwd: worktree });
    files.push('bundle.git');
  } catch (err) {
    log.warn('work-run-forensics: bundle failed', { branch, error: (err as Error).message });
  }

  // untracked.tar — only for non-clean runs (the uncommitted/untracked files
  // are the evidence a noop/dirty run leaves behind). With zero untracked
  // files, write an empty tar via fs (no subprocess); otherwise archive them
  // with `tar` rooted at the worktree.
  if (nonClean) {
    try {
      await exportUntrackedTar(runGit, worktree, join(outDir, 'untracked.tar'));
      files.push('untracked.tar');
    } catch (err) {
      log.warn('work-run-forensics: untracked tar failed', { error: (err as Error).message });
    }
  }

  return { forensicsPath: outDir, files };
}

/** Archive the worktree's untracked files into `tarPath`. Lists them via
 *  `git ls-files --others --exclude-standard`; an empty list yields an empty
 *  tar written directly (no subprocess), so the common no-untracked path needs
 *  no `tar` and stays deterministic. */
async function exportUntrackedTar(runGit: GitRunner, worktree: string, tarPath: string): Promise<void> {
  // `-z` → NUL-delimited output so filenames with spaces or embedded newlines
  // parse unambiguously (a plain `\n` split + trim corrupts such names).
  const { stdout } = await runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: worktree });
  const untracked = stdout.split('\0').filter(Boolean);
  if (untracked.length === 0) {
    writeFileSync(tarPath, EMPTY_TAR);
    return;
  }
  // `-C worktree` so the archive holds repo-relative paths; `--` terminates tar
  // options so a leading-dash untracked filename (e.g. `--checkpoint-action=…`,
  // a known tar argument-injection → RCE vector) is treated as a file, never a
  // flag. `execFile` (not a shell) already blocks metacharacter injection. The
  // 30s timeout caps a pathological tree. Not registered with
  // registerActiveProcess: the execFile pattern exposes no ChildProcess handle,
  // is timeout-bounded, and matches defaultRunGit's unregistered git spawns.
  // `promisify` is called here (not at module load) so a unit test that mocks
  // `node:child_process` without `execFile` can still import this module — only
  // the untracked-files path, which the test never reaches with a real spawn,
  // touches it.
  const execFile = promisify(execFileCb);
  await execFile('tar', ['-cf', tarPath, '-C', worktree, '--', ...untracked], { timeout: 30_000 });
}
