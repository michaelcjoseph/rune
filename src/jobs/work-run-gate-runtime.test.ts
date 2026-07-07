/**
 * Project 15 P1.5 — "test before mutating main" suite for the gate RUNTIME
 * (`runGate`, src/jobs/work-run-gate-runtime.ts). test-plan.md §6 "Gate checks
 * run in an integration worktree (or on the branch); a red result leaves local
 * `main` byte-for-byte unchanged".
 *
 * Unlike the pure-decision (`evaluateGate`) and finalizer state-machine suites,
 * these use a REAL temp git repo: the whole point is to prove that running the
 * gate's checks NEVER mutates the product repo's base-branch ref or working
 * tree. That invariant can only be shown against real git, not spies.
 *
 * Written TEST-FIRST: `runGate` is a `notImplemented` scaffold, so every test
 * here is RED until the P1.5 impl lands. Expected failure: the `notImplemented`
 * throw (the `await` rejects) — never a module-resolution / syntax error. The
 * validation COMMAND is injected (deterministic, no npm dependency); git is
 * real so the byte-for-byte main-unchanged proof is meaningful.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRunGit } from './sandbox-runtime.js';
import {
  runGate,
  runValidationCommands,
  MAX_VALIDATION_OUTPUT_TAIL_CHARS,
  type GateRuntimeOpts,
  type GateRuntimeIO,
  type ValidationCommandResult,
} from './work-run-gate-runtime.js';

let repoPath: string;
let integrationWorktree: string;
let tmpRoot: string;
const BASE = 'main';
const BRANCH = 'rune-work/feature';
const TRACKED_FILE = 'app.txt';

/** Run a git subcommand synchronously in `cwd`, returning trimmed stdout. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // Deterministic identity so commits succeed without a global gitconfig.
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

/** A byte-for-byte snapshot of the product repo's base-branch state. */
function baseState(): {
  baseSha: string;
  headSha: string;
  /** Current checkout — must stay on `main`: catches an impl that does a stray
   *  `git checkout` in the product repo instead of the integration worktree. */
  currentBranch: string;
  porcelain: string;
  workingFile: string;
} {
  return {
    baseSha: git(repoPath, 'rev-parse', BASE),
    // headSha is a branch-switch guard: after setup HEAD === BASE, so any
    // internal checkout that moves HEAD would diverge it from baseSha.
    headSha: git(repoPath, 'rev-parse', 'HEAD'),
    currentBranch: git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'),
    porcelain: git(repoPath, 'status', '--porcelain'),
    workingFile: readFileSync(join(repoPath, TRACKED_FILE), 'utf8'),
  };
}

function gateOpts(over: Partial<GateRuntimeOpts> = {}): GateRuntimeOpts {
  return {
    product: 'rune',
    repoPath,
    baseBranch: BASE,
    branch: BRANCH,
    integrationWorktree,
    validationCommands: ['npm test'],
    tasksRemaining: 0,
    concurrentRun: false,
    commandTimeoutMs: 600_000,
    ...over,
  };
}

/** Real git IO + an injected validation runner so the suite is deterministic. */
function gateIO(commandResult: ValidationCommandResult): GateRuntimeIO {
  return {
    runGit: defaultRunGit,
    runValidationCommand: vi.fn(
      async (): Promise<ValidationCommandResult> => commandResult,
    ),
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rune-gate-runtime-test-'));
  repoPath = join(tmpRoot, 'repo');
  integrationWorktree = join(tmpRoot, 'integration-wt');

  // A product repo on `main` with one commit, plus a feature branch that adds a
  // second commit. The gate must merge cleanly in the integration worktree
  // WITHOUT touching this repo's `main`.
  execFileSync('git', ['init', '-q', '-b', BASE, repoPath]);
  writeFileSync(join(repoPath, TRACKED_FILE), 'base-line\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-q', '-m', 'base commit');

  git(repoPath, 'checkout', '-q', '-b', BRANCH);
  writeFileSync(join(repoPath, TRACKED_FILE), 'base-line\nfeature-line\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-q', '-m', 'feature commit');

  // Leave the repo checked out on `main` (the autonomous-run invariant).
  git(repoPath, 'checkout', '-q', BASE);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('runGate — test before mutating main (P1.5)', () => {
  it('a RED gate (validation fails) leaves the base-branch ref AND working tree byte-for-byte unchanged', async () => {
    const before = baseState();
    const io = gateIO({ exitCode: 1, timedOut: false, outputTail: '' });

    // RED now: runGate throws notImplemented. GREEN when the impl runs the
    // failing validation in the integration worktree and returns tests-red.
    const result = await runGate(gateOpts(), io);

    expect(result).toEqual({ ok: false, reason: 'tests-red' });

    // The core invariant: a red gate never mutated local `main`. `toEqual`'s
    // diff already names exactly which field (baseSha / currentBranch /
    // porcelain / workingFile) drifted on failure.
    expect(baseState()).toEqual(before);
    // The throwaway integration worktree is torn down inside runGate (finally),
    // even on the red path — no leaked worktree. (A distinct invariant, not
    // covered by the base-state snapshot above.)
    expect(existsSync(integrationWorktree)).toBe(false);
  });

  it('even a GREEN gate does NOT merge: the gate only decides — the merge is the finalizer\'s post-gate step', async () => {
    const before = baseState();
    const io = gateIO({ exitCode: 0, timedOut: false, outputTail: '' });

    // RED now: notImplemented. GREEN when the impl validates in the integration
    // worktree, finds everything clean, and returns { ok: true } — having
    // touched the integration worktree only, never the product repo's `main`.
    const result = await runGate(gateOpts(), io);

    expect(result).toEqual({ ok: true });

    // The gate is a decision, not a mutation: `main` is untouched even on pass.
    // (The actual `git merge` happens in work-run-finalizer.ts AFTER this.)
    expect(baseState()).toEqual(before);
    expect(existsSync(integrationWorktree)).toBe(false);
  });

  it('runs validation in the integration worktree, not the product repo checkout', async () => {
    // Explicit params so `.mock.calls` is typed `[command, cwd, timeoutMs][]`.
    const runValidationCommand = vi.fn(
      async (
        _command: string,
        _cwd: string,
        _timeoutMs: number,
      ): Promise<ValidationCommandResult> => ({ exitCode: 0, timedOut: false, outputTail: '' }),
    );
    const io: GateRuntimeIO = { runGit: defaultRunGit, runValidationCommand };

    const before = baseState();

    // RED now: notImplemented. GREEN when the impl runs each validation command
    // with cwd === the integration worktree (never the product repo's base
    // checkout), so a command that writes files can't dirty local `main`.
    await runGate(gateOpts(), io);

    expect(runValidationCommand).toHaveBeenCalled();
    for (const [, cwd] of runValidationCommand.mock.calls) {
      expect(cwd).toBe(integrationWorktree);
      expect(cwd).not.toBe(repoPath);
    }
    // cwd-routing is the path most likely to leak a dirty-`main` side effect —
    // assert the product repo is still byte-for-byte unchanged here too.
    expect(baseState()).toEqual(before);
    expect(existsSync(integrationWorktree)).toBe(false);
  });
});

describe('runValidationCommands', () => {
  it('passes when every command exits 0', async () => {
    await expect(runValidationCommands([
      'node -e process.exit(0)',
      'node -e process.exit(0)',
    ], tmpRoot, 1_000)).resolves.toEqual({ ok: true });
  });

  it('fails when any command exits nonzero', async () => {
    await expect(runValidationCommands([
      'node -e process.exit(0)',
      'node -e process.exit(7)',
    ], tmpRoot, 1_000)).resolves.toMatchObject({
      ok: false,
      command: 'node -e process.exit(7)',
      result: { exitCode: 7, timedOut: false },
    });
  });

  it('fails when any command times out', async () => {
    await expect(runValidationCommands([
      'node -e setTimeout(()=>{},1000)',
    ], tmpRoot, 20)).resolves.toMatchObject({
      ok: false,
      command: 'node -e setTimeout(()=>{},1000)',
      result: { timedOut: true },
    });
  });

  // Command strings are split on whitespace (argv-array spawn, no shell), so
  // the `-e` payloads below deliberately contain no spaces.
  it("captures the failing command's stdout and stderr in outputTail", async () => {
    const command = 'node -e console.error("ERR-MARKER");console.log("OUT-MARKER");process.exit(7)';
    const listResult = await runValidationCommands([command], tmpRoot, 5_000);
    expect(listResult).toMatchObject({
      ok: false,
      command,
      result: { exitCode: 7, timedOut: false },
    });
    if (listResult.ok) throw new Error('expected a failed validation');
    expect(listResult.result.outputTail).toContain('ERR-MARKER');
    expect(listResult.result.outputTail).toContain('OUT-MARKER');
  });

  it('bounds outputTail to MAX_VALIDATION_OUTPUT_TAIL_CHARS keeping the end', async () => {
    const command = 'node -e process.stdout.write("x".repeat(30000)+"TAIL-END");process.exit(1)';
    const listResult = await runValidationCommands([command], tmpRoot, 5_000);
    if (listResult.ok) throw new Error('expected a failed validation');
    expect(listResult.result.outputTail.length).toBe(MAX_VALIDATION_OUTPUT_TAIL_CHARS);
    expect(listResult.result.outputTail.endsWith('TAIL-END')).toBe(true);
  });

  it('a timed-out command still captures the partial output tail', async () => {
    const command = 'node -e process.stdout.write("EARLY-MARKER");setTimeout(()=>{},120000)';
    const listResult = await runValidationCommands([command], tmpRoot, 1_000);
    if (listResult.ok) throw new Error('expected a failed validation');
    expect(listResult.result.timedOut).toBe(true);
    expect(listResult.result.outputTail).toContain('EARLY-MARKER');
  });
});
