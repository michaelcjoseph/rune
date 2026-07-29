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
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import { defaultRunGit, removeVitestCache, vitestCacheDirFor } from './sandbox-runtime.js';
import {
  runGate,
  collectTaskChangedPaths,
  taskChangesRequireFullValidation,
  runValidationCommandArgv,
  runValidationCommands,
  MAX_VALIDATION_OUTPUT_HEAD_CHARS,
  MAX_VALIDATION_OUTPUT_TAIL_CHARS,
  type GateRuntimeOpts,
  type GateRuntimeIO,
  type ValidationCommandResult,
} from './work-run-gate-runtime.js';
import { diagnoseRelatedTestResult } from './related-test-diagnostic.js';
import {
  RELATED_TEST_ARGUMENT_MAX_CHARS,
  RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS,
  RELATED_TEST_SELECTED_PATHS_MAX,
} from '../intent/related-test-diagnostic.js';

let repoPath: string;
let integrationWorktree: string;
let tmpRoot: string;
const BASE = 'main';
const BRANCH = 'rune-work/feature';
const TRACKED_FILE = 'app.txt';

function fakeNpxWritingReport(name: string, reportExpression: string): string {
  const executable = join(tmpRoot, name, 'npx');
  mkdirSync(join(tmpRoot, name), { recursive: true });
  writeFileSync(executable, [
    `#!${process.execPath}`,
    "const fs=require('node:fs');",
    "const arg=process.argv.find((value)=>value.startsWith('--outputFile='));",
    "if(!arg)throw new Error('missing private report path');",
    `const report=${reportExpression};`,
    "fs.writeFileSync(arg.slice('--outputFile='.length),typeof report==='string'?report:JSON.stringify(report));",
    "process.exit(1);",
    '',
  ].join('\n'));
  chmodSync(executable, 0o755);
  return executable;
}

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
    const cache = vitestCacheDirFor(integrationWorktree);
    mkdirSync(cache, { recursive: true });

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
    expect(existsSync(cache)).toBe(false);
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
    const diagnosticsDir = join(tmpRoot, 'durable-run', 'validation-diagnostics');

    // RED now: notImplemented. GREEN when the impl runs each validation command
    // with cwd === the integration worktree (never the product repo's base
    // checkout), so a command that writes files can't dirty local `main`.
    await runGate(gateOpts({ validationArtifactsDir: diagnosticsDir }), io);

    expect(runValidationCommand).toHaveBeenCalled();
    for (const [, cwd] of runValidationCommand.mock.calls) {
      expect(cwd).toBe(integrationWorktree);
      expect(cwd).not.toBe(repoPath);
    }
    expect(runValidationCommand).toHaveBeenCalledWith(
      'npm test',
      integrationWorktree,
      600_000,
      diagnosticsDir,
    );
    // cwd-routing is the path most likely to leak a dirty-`main` side effect —
    // assert the product repo is still byte-for-byte unchanged here too.
    expect(baseState()).toEqual(before);
    expect(existsSync(integrationWorktree)).toBe(false);
  });

  it('runs final gate commands from integrationWorktree/validationCwd', async () => {
    git(repoPath, 'checkout', '-q', BRANCH);
    mkdirSync(join(repoPath, 'harness'));
    writeFileSync(join(repoPath, 'harness', 'pyproject.toml'), '[project]\nname="fixture"\n');
    git(repoPath, 'add', 'harness/pyproject.toml');
    git(repoPath, 'commit', '-q', '-m', 'add validation harness');
    git(repoPath, 'checkout', '-q', BASE);
    const runValidationCommand = vi.fn(async () => ({
      exitCode: 0,
      timedOut: false,
      outputTail: '',
    }));

    const result = await runGate(
      gateOpts({ validationCwd: 'harness' }),
      { runGit: defaultRunGit, runValidationCommand },
    );

    expect(result).toEqual({ ok: true });
    expect(runValidationCommand).toHaveBeenCalledWith(
      'npm test',
      join(integrationWorktree, 'harness'),
      600_000,
      undefined,
    );
    expect(existsSync(integrationWorktree)).toBe(false);
  });

  it.each(['missing-harness', '../outside'])(
    'fails closed without running commands when final gate validationCwd is invalid: %s',
    async (validationCwd) => {
      const runValidationCommand = vi.fn(async () => ({
        exitCode: 0,
        timedOut: false,
        outputTail: '',
      }));

      const result = await runGate(
        gateOpts({ validationCwd }),
        { runGit: defaultRunGit, runValidationCommand },
      );

      expect(result).toEqual({ ok: false, reason: 'tests-red' });
      expect(runValidationCommand).not.toHaveBeenCalled();
      expect(existsSync(integrationWorktree)).toBe(false);
    },
  );

  it('fails closed when final gate validationCwd is a symlink escaping the integration worktree', async () => {
    const outside = join(tmpRoot, 'outside-harness');
    mkdirSync(outside);
    git(repoPath, 'checkout', '-q', BRANCH);
    symlinkSync(outside, join(repoPath, 'harness'), 'dir');
    git(repoPath, 'add', 'harness');
    git(repoPath, 'commit', '-q', '-m', 'add escaping harness link');
    git(repoPath, 'checkout', '-q', BASE);
    const runValidationCommand = vi.fn(async () => ({
      exitCode: 0,
      timedOut: false,
      outputTail: '',
    }));

    const result = await runGate(
      gateOpts({ validationCwd: 'harness' }),
      { runGit: defaultRunGit, runValidationCommand },
    );

    expect(result).toEqual({ ok: false, reason: 'tests-red' });
    expect(runValidationCommand).not.toHaveBeenCalled();
    expect(existsSync(integrationWorktree)).toBe(false);
  });
});

describe('runValidationCommands', () => {
  it('keeps an empty command list backward compatible for intentional legacy callers', async () => {
    const runValidationCommand = vi.fn();
    await expect(
      runValidationCommands([], tmpRoot, 1_000, runValidationCommand),
    ).resolves.toEqual({ ok: true });
    expect(runValidationCommand).not.toHaveBeenCalled();
  });

  it('collects modified and untracked task paths while excluding deletions', async () => {
    writeFileSync(join(repoPath, 'deleted.txt'), 'remove me\n');
    git(repoPath, 'add', 'deleted.txt');
    git(repoPath, 'commit', '-q', '-m', 'add deletable file');
    writeFileSync(join(repoPath, TRACKED_FILE), 'modified\n');
    writeFileSync(join(repoPath, 'new test.ts'), 'new\n');
    rmSync(join(repoPath, 'deleted.txt'));

    await expect(collectTaskChangedPaths(repoPath)).resolves.toEqual([
      TRACKED_FILE,
      'new test.ts',
    ]);
  });

  it('normalizes and deduplicates paths across tracked and untracked Git output', async () => {
    const runGit = vi.fn(async (args: string[]) => args[0] === 'diff'
      ? { stdout: './src/changed.ts\0src/changed.ts\0', stderr: '' }
      : { stdout: 'src/new test.ts\0src/changed.ts\0', stderr: '' });
    await expect(collectTaskChangedPaths(tmpRoot, runGit)).resolves.toEqual([
      'src/changed.ts',
      'src/new test.ts',
    ]);
  });

  it('falls back to full validation for deletions and global runner config changes', async () => {
    const deletionGit = vi.fn(async () => ({ stdout: 'src/removed.ts\0', stderr: '' }));
    await expect(taskChangesRequireFullValidation(tmpRoot, [], deletionGit)).resolves.toBe(true);
    const cleanGit = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await expect(taskChangesRequireFullValidation(tmpRoot, ['next.config.ts'], cleanGit)).resolves.toBe(true);
    await expect(taskChangesRequireFullValidation(tmpRoot, ['src/feature.ts'], cleanGit)).resolves.toBe(false);
  });

  it.each([
    {
      label: 'path-count limit',
      paths: Array.from(
        { length: RELATED_TEST_SELECTED_PATHS_MAX + 1 },
        (_, index) => `src/${index}.ts`,
      ),
    },
    {
      label: 'per-path length limit',
      paths: [`src/${'x'.repeat(RELATED_TEST_ARGUMENT_MAX_CHARS)}.ts`],
    },
    {
      label: 'selection total-length limit',
      paths: Array.from(
        {
          length:
            Math.floor(
              RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS /
                RELATED_TEST_ARGUMENT_MAX_CHARS,
            ) + 1,
        },
        (_, index) =>
          `${String(index).padStart(4, '0')}${'x'.repeat(
            RELATED_TEST_ARGUMENT_MAX_CHARS - 4,
          )}`,
      ),
    },
  ])('routes selections beyond the durable $label to full validation', async ({
    paths,
  }) => {
    const cleanGit = vi.fn(async () => ({ stdout: '', stderr: '' }));

    await expect(
      taskChangesRequireFullValidation(tmpRoot, paths, cleanGit),
    ).resolves.toBe(true);
  });

  it('accounts for fixed Vitest argv overhead before admitting a path-total boundary', async () => {
    const paths = Array.from(
      {
        length:
          RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS /
          RELATED_TEST_ARGUMENT_MAX_CHARS,
      },
      (_, index) =>
        `${String(index).padStart(4, '0')}${'x'.repeat(
          RELATED_TEST_ARGUMENT_MAX_CHARS - 4,
        )}`,
    );
    expect(paths.reduce((total, path) => total + path.length, 0))
      .toBe(RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS);
    const cleanGit = vi.fn(async () => ({ stdout: '', stderr: '' }));

    await expect(
      taskChangesRequireFullValidation(tmpRoot, paths, cleanGit),
    ).resolves.toBe(true);
  });

  it('accounts for the leading-dash safety prefix before admitting an item boundary', async () => {
    const path = `-${'x'.repeat(RELATED_TEST_ARGUMENT_MAX_CHARS - 1)}`;
    expect(path.length).toBe(RELATED_TEST_ARGUMENT_MAX_CHARS);
    const cleanGit = vi.fn(async () => ({ stdout: '', stderr: '' }));

    await expect(
      taskChangesRequireFullValidation(tmpRoot, [path], cleanGit),
    ).resolves.toBe(true);
  });

  it('passes unusual path arguments literally through the argv-safe runner', async () => {
    const marker = 'odd name;$(touch SHOULD_NOT_EXIST)';
    const result = await runValidationCommandArgv(
      [process.execPath, '-e', 'console.error(JSON.stringify(process.argv.slice(1)));process.exit(3)', marker],
      tmpRoot,
      5_000,
    );
    expect(result).toMatchObject({ exitCode: 3, timedOut: false });
    expect(result.outputTail).toContain(JSON.stringify(marker));
    expect(existsSync(join(tmpRoot, 'SHOULD_NOT_EXIST'))).toBe(false);
  });

  it('runs only the related test for a task diff while a full-suite command still runs both pairs', async () => {
    const fixture = join(tmpRoot, 'related-fixture');
    const src = join(fixture, 'src');
    mkdirSync(src, { recursive: true });
    symlinkSync(join(PROJECT_ROOT, 'node_modules'), join(fixture, 'node_modules'), 'dir');
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    writeFileSync(join(src, 'alpha.ts'), 'export const alpha = 1;\n');
    writeFileSync(join(src, 'beta.ts'), 'export const beta = 2;\n');
    writeFileSync(join(src, 'alpha.test.ts'), [
      "import { test, expect } from 'vitest';",
      "import { writeFileSync } from 'node:fs';",
      "import { alpha } from './alpha.js';",
      "test('alpha', () => { writeFileSync('alpha-ran', 'yes'); expect(alpha).toBe(1); });",
      '',
    ].join('\n'));
    writeFileSync(join(src, 'beta.test.ts'), [
      "import { test, expect } from 'vitest';",
      "import { writeFileSync } from 'node:fs';",
      "import { beta } from './beta.js';",
      "test('beta', () => { writeFileSync('beta-ran', 'yes'); expect(beta).toBe(2); });",
      '',
    ].join('\n'));

    const related = await runValidationCommandArgv(
      ['npx', 'vitest', 'related', '--run', '--passWithNoTests', 'src/alpha.ts'],
      fixture,
      30_000,
    );
    expect(related.exitCode).toBe(0);
    expect(existsSync(join(fixture, 'alpha-ran'))).toBe(true);
    expect(existsSync(join(fixture, 'beta-ran'))).toBe(false);
    rmSync(join(fixture, 'alpha-ran'));

    const full = await runValidationCommandArgv(['npx', 'vitest', '--run'], fixture, 30_000);
    expect(full.exitCode).toBe(0);
    expect(existsSync(join(fixture, 'alpha-ran'))).toBe(true);
    expect(existsSync(join(fixture, 'beta-ran'))).toBe(true);
  }, 60_000);

  it('isolates cache state across concurrent Vitest validations', async () => {
    const makeFixture = (name: string): string => {
      const fixture = join(tmpRoot, name);
      mkdirSync(fixture, { recursive: true });
      symlinkSync(join(PROJECT_ROOT, 'node_modules'), join(fixture, 'node_modules'), 'dir');
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
      writeFileSync(join(fixture, 'sample.test.ts'), [
        "import { test, expect } from 'vitest';",
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        `test(${JSON.stringify(name)}, () => {`,
        "  const cache = process.env.RUNE_VITEST_CACHE_DIR!;",
        "  mkdirSync(cache, { recursive: true });",
        `  writeFileSync(join(cache, ${JSON.stringify(`${name}.marker`)}), 'ok');`,
        "  expect(1).toBe(1);",
        "});",
        '',
      ].join('\n'));
      return fixture;
    };
    const first = makeFixture('concurrent-first');
    const second = makeFixture('concurrent-second');

    const [firstResult, secondResult] = await Promise.all([
      runValidationCommandArgv(['npx', 'vitest', '--run'], first, 30_000),
      runValidationCommandArgv(['npx', 'vitest', '--run'], second, 30_000),
    ]);

    expect(firstResult.exitCode).toBe(0);
    expect(secondResult.exitCode).toBe(0);
    expect(vitestCacheDirFor(first)).not.toBe(vitestCacheDirFor(second));
    expect(existsSync(vitestCacheDirFor(first))).toBe(true);
    expect(existsSync(vitestCacheDirFor(second))).toBe(true);
    removeVitestCache(first);
    removeVitestCache(second);
  }, 60_000);

  it('forces a validation-worktree-specific Vitest cache into the child environment', async () => {
    const command = 'node -e console.log(process.env.RUNE_VITEST_CACHE_DIR)';
    const result = await runValidationCommands([command], tmpRoot, 5_000);
    expect(result).toEqual({ ok: true });
    // A passing command does not expose output through the list result, so run
    // a controlled non-zero command to inspect the captured environment value.
    const inspect = await runValidationCommands([
      'node -e console.error(process.env.RUNE_VITEST_CACHE_DIR);process.exit(1)',
    ], tmpRoot, 5_000);
    if (inspect.ok) throw new Error('expected inspection command to fail');
    expect(inspect.result.outputTail).toContain(vitestCacheDirFor(tmpRoot));
  });

  it('does not expose Rune secrets to product-controlled validation code', async () => {
    vi.stubEnv('RUNE_HTTP_SECRET', 'arbitrary-secret-value-7491');
    try {
      const result = await runValidationCommandArgv([
        process.execPath,
        '-e',
        'console.error(String(process.env.RUNE_HTTP_SECRET));process.exit(1)',
      ], tmpRoot, 5_000);
      expect(result.outputTail).toContain('undefined');
      expect(result.outputTail).not.toContain('arbitrary-secret-value-7491');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('injects the private compatible-mode marker only for fallback while retaining credential stripping', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'parent-secret-must-not-cross');
    try {
      const inspect = [
        'console.error(JSON.stringify({',
        '  marker: process.env.RUNE_INTERNAL_VALIDATION_COMPATIBLE_MODE,',
        '  token: process.env.TELEGRAM_BOT_TOKEN,',
        '}));',
        'process.exit(1);',
      ].join('');
      const ordinary = await runValidationCommandArgv(
        [process.execPath, '-e', inspect],
        tmpRoot,
        5_000,
      );
      const fallback = await runValidationCommandArgv(
        [process.execPath, '-e', inspect],
        tmpRoot,
        5_000,
        undefined,
        { compatibleFallback: true },
      );

      expect(ordinary.outputTail).toContain('{}');
      expect(ordinary.outputTail).not.toContain('related-fallback-v1');
      expect(fallback.outputTail).toContain('"marker":"related-fallback-v1"');
      expect(fallback.outputTail).not.toContain('parent-secret-must-not-cross');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('admits structured failures only from the private Vitest JSON report', async () => {
    const report = {
      testResults: [{
        name: join(tmpRoot, 'src', 'server.test.ts'),
        status: 'failed',
        assertionResults: [{
          fullName: 'server starts a loopback fixture',
          status: 'failed',
          failureMessages: [
            'Error: listen EPERM: operation not permitted 127.0.0.1:43127',
          ],
        }],
      }],
    };
    const fakeNpx = fakeNpxWritingReport('structured-report', JSON.stringify(report));

    const result = await runValidationCommandArgv(
      [fakeNpx, 'vitest', 'related', '--run', 'src/server.ts'],
      tmpRoot,
      5_000,
    );

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      structuredErrorsTotal: 1,
      structuredErrorsComplete: true,
      structuredErrors: [{
        source: 'vitest-json',
        scope: 'assertion',
        file: 'src/server.test.ts',
        testName: 'server starts a loopback fixture',
        message: 'Error: listen EPERM: operation not permitted 127.0.0.1:43127',
      }],
    });
    expect(result.structuredErrors?.map((error) => error.message).join('\n'))
      .not.toContain('arbitrary console assertion text');
  });

  it.each([
    {
      label: 'oversized',
      reportExpression: `({
        testResults:[{
          name:'/validation-worktree/src/oversized.test.ts',
          status:'failed',
          message:'x'.repeat(8*1024*1024),
          assertionResults:[],
        }],
      })`,
    },
    {
      label: 'malformed',
      reportExpression: JSON.stringify('{not-json'),
    },
  ])('omits structured evidence for a $label Vitest report so classification fails closed', async ({
    label,
    reportExpression,
  }) => {
    const fakeNpx = fakeNpxWritingReport(`${label}-report`, reportExpression);
    const argv = [fakeNpx, 'vitest', 'related', '--run', 'src/feature.ts'];
    const result = await runValidationCommandArgv(argv, tmpRoot, 5_000);

    expect(result.structuredErrors).toBeUndefined();
    expect(result.structuredErrorsTotal).toBeUndefined();
    expect(result.structuredErrorsComplete).toBeUndefined();
    expect(diagnoseRelatedTestResult({
      selectedPaths: ['src/feature.ts'],
      argv,
      validationCwd: '.',
      result,
    }).state).toBe('related-test-failure');
  });

  it('bounds retained Vitest errors and records total/truncation metadata', async () => {
    const assertionCount = 1_000;
    const fakeNpx = fakeNpxWritingReport('many-errors-report', `({
      testResults:[{
        name:${JSON.stringify(join(tmpRoot, 'src', 'many.test.ts'))},
        status:'failed',
        assertionResults:Array.from({length:${assertionCount}},(_,index)=>({
          fullName:'failure '+index,
          status:'failed',
          failureMessages:['AssertionError: expected '+index+' to pass'],
        })),
      }],
    })`);
    const result = await runValidationCommandArgv(
      [fakeNpx, 'vitest', 'related', '--run', 'src/many.ts'],
      tmpRoot,
      5_000,
    );

    expect(result.structuredErrorsTotal).toBe(assertionCount);
    expect(result.structuredErrorsComplete).toBe(false);
    expect(result.structuredErrors?.length).toBeGreaterThan(0);
    expect(result.structuredErrors!.length).toBeLessThan(assertionCount);
  });

  it('bounds structured error fields and marks the retained report incomplete', async () => {
    const long = 'z'.repeat(20_000);
    const fakeNpx = fakeNpxWritingReport('long-fields-report', `({
      testResults:[{
        name:${JSON.stringify(join(tmpRoot, long + '.test.ts'))},
        status:'failed',
        assertionResults:[{
          fullName:${JSON.stringify(long)},
          status:'failed',
          failureMessages:[${JSON.stringify(long)}],
        }],
      }],
    })`);
    const result = await runValidationCommandArgv(
      [fakeNpx, 'vitest', 'related', '--run', 'src/long.ts'],
      tmpRoot,
      5_000,
    );
    const error = result.structuredErrors?.[0];

    expect(result.structuredErrorsTotal).toBe(1);
    expect(result.structuredErrorsComplete).toBe(false);
    expect(error).toBeDefined();
    expect(error!.file.length).toBeLessThan(long.length);
    expect(error!.testName?.length).toBeLessThan(long.length);
    expect(error!.message.length).toBeLessThan(long.length);
  });

  it('adds the Node runtime bin dir to the validation child PATH even when the inherited PATH omits it (launchd sparse-PATH fix)', async () => {
    // Simulate launchd's sparse PATH: no Node/npm/Homebrew bin dir present.
    vi.stubEnv('PATH', '/definitely/not/a/real/dir');
    try {
      const result = await runValidationCommandArgv([
        process.execPath,
        '-e',
        'console.error(process.env.PATH)',
      ], tmpRoot, 5_000);
      expect(result.exitCode).toBe(0);
      // buildToolchainPath prepends the running Node's own bin dir …
      expect(result.outputTail).toContain(dirname(process.execPath));
      // … while still keeping the (sparse) inherited PATH intact.
      expect(result.outputTail).toContain('/definitely/not/a/real/dir');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.runIf(process.platform === 'darwin')('allows localhost but denies external validation networking', async () => {
    const local = await runValidationCommandArgv([
      process.execPath,
      '-e',
      "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>s.close(()=>process.exit(0)));s.on('error',()=>process.exit(8))",
    ], tmpRoot, 5_000);
    expect(local.exitCode).toBe(0);

    const external = await runValidationCommandArgv([
      process.execPath,
      '-e',
      "const s=require('node:net').connect(80,'1.1.1.1');s.on('connect',()=>process.exit(9));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),500)",
    ], tmpRoot, 5_000);
    expect(external.exitCode).toBe(0);
  });

  it('strips diagnostic NODE_OPTIONS before a direct runner creates workers', async () => {
    const fixture = join(tmpRoot, 'worker-fixture');
    const diagnosticsDir = join(tmpRoot, 'worker-diagnostics');
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({
      scripts: { check: 'node worker.cjs' },
    }));
    writeFileSync(join(fixture, 'worker.cjs'), [
      "if ((process.env.NODE_OPTIONS || '').includes('report-on-signal')) process.exit(9);",
      "console.log('WORKER-CLEAN');",
    ].join('\n'));
    const result = await runValidationCommandArgv(
      ['npm', 'run', 'check'], fixture, 10_000, diagnosticsDir,
    );
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.outputTail).toContain('WORKER-CLEAN');
  });

  it('waits for SIGKILL escalation when a grandchild ignores SIGTERM', async () => {
    const pidFile = join(tmpRoot, 'grandchild.pid');
    const parent = join(tmpRoot, 'parent.cjs');
    writeFileSync(parent, [
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      `const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});`,
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));`,
      "process.on('SIGTERM',()=>process.exit(0));",
      'setInterval(()=>{},1000);',
    ].join('\n'));
    const result = await runValidationCommandArgv(
      // Leave startup headroom under the fully parallel suite so the parent
      // can plant the grandchild pid before Rune begins timeout reaping.
      [process.execPath, parent], tmpRoot, 500,
    );
    expect(result.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    let state = '';
    try {
      state = execFileSync('ps', ['-p', String(pid), '-o', 'state='], { encoding: 'utf8' }).trim();
    } catch {
      // ps exits non-zero once the reaped process has disappeared entirely.
    }
    expect(state === '' || state.startsWith('Z')).toBe(true);
  }, 15_000);

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

  it('bounds outputHead to MAX_VALIDATION_OUTPUT_HEAD_CHARS keeping the beginning', async () => {
    const command = 'node -e process.stdout.write("HEAD-START"+"x".repeat(30000));process.exit(1)';
    const listResult = await runValidationCommands([command], tmpRoot, 5_000);
    if (listResult.ok) throw new Error('expected a failed validation');
    expect(listResult.result.outputHead?.length).toBe(MAX_VALIDATION_OUTPUT_HEAD_CHARS);
    expect(listResult.result.outputHead?.startsWith('HEAD-START')).toBe(true);
  });

  it('a timed-out command still captures the partial output tail', async () => {
    const command = 'node -e process.stdout.write("EARLY-MARKER");setTimeout(()=>{},120000)';
    const listResult = await runValidationCommands([command], tmpRoot, 1_000);
    if (listResult.ok) throw new Error('expected a failed validation');
    expect(listResult.result.timedOut).toBe(true);
    expect(listResult.result.outputTail).toContain('EARLY-MARKER');
  });

  it('captures a durable diagnostic report before reaping a silent startup wedge', async () => {
    const diagnosticsDir = join(tmpRoot, 'validation-diagnostics');
    const command = 'node -e setTimeout(()=>{},120000)';
    process.env['RUNE_DIAGNOSTIC_TEST_SECRET'] = 'PLANTED-DIAGNOSTIC-SECRET';
    try {
      const listResult = await runValidationCommands(
        [command],
        tmpRoot,
        // Leave enough startup headroom under the fully parallel suite for
        // Node to install its report-on-signal handler before Rune times out.
        500,
        undefined,
        diagnosticsDir,
      );
      if (listResult.ok) throw new Error('expected a failed validation');

      expect(listResult.result.timedOut).toBe(true);
      expect(listResult.result.outputHead).toContain('Writing Node.js report');
      expect(listResult.result.outputTail).toContain('Node.js report completed');
      expect(listResult.result.diagnosticArtifacts?.length).toBeGreaterThan(0);

      const reportName = readdirSync(diagnosticsDir).find((name) => name.endsWith('.json'));
      expect(reportName).toBeDefined();
      const rawReport = readFileSync(join(diagnosticsDir, reportName!), 'utf8');
      const report = JSON.parse(rawReport) as Record<string, unknown>;
      expect(report['environmentVariables']).toBeUndefined();
      expect(rawReport).not.toContain('PLANTED-DIAGNOSTIC-SECRET');
      expect(report['javascriptStack']).toBeTruthy();
      expect(Array.isArray(report['libuv'])).toBe(true);
    } finally {
      delete process.env['RUNE_DIAGNOSTIC_TEST_SECRET'];
    }
  });
});
