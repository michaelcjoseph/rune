// @module-tag validation-sandbox-integration
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
 * Most validation commands are injected for deterministic gate tests; focused
 * integration cases use the real bounded launcher and trusted observer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { PROJECT_ROOT } from '../config.js';

const execFileAsync = promisify(execFile);
import {
  defaultRunGit,
  removeVitestCache,
  vitestCacheDirFor,
  type GitRunner,
} from './sandbox-runtime.js';
import {
  runGate,
  collectTaskChangedPaths,
  taskChangesRequireFullValidation,
  runValidationCommandArgv,
  runProfiledVitestSelection,
  runTrustedVitestObserver,
  runValidationCommands,
  runFullSuiteValidation,
  MAX_VALIDATION_OUTPUT_HEAD_CHARS,
  MAX_VALIDATION_OUTPUT_TAIL_CHARS,
  type FullSuiteValidationIO,
  type GateRuntimeOpts,
  type GateRuntimeIO,
  type ValidationCommandResult,
} from './work-run-gate-runtime.js';
import { diagnoseRelatedTestResult } from './related-test-diagnostic.js';
import {
  requestValidationSandboxProbe,
  type ValidationSandboxBroker,
} from './validation-sandbox-broker.js';
import { createConfinementCapability } from '../utils/validation-confinement.js';
import { enclosedByValidationBroker } from './validation-broker-test-stub.js';
import {
  RELATED_TEST_ARGUMENT_MAX_CHARS,
  RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS,
  RELATED_TEST_SELECTED_PATHS_MAX,
} from '../intent/related-test-diagnostic.js';

/** A stand-in broker carrying a REAL launcher capability, so a test double
 *  still satisfies the same grant check production callers must pass. */
function fakeBroker(
  socketPath: string,
  stop: () => Promise<void>,
): ValidationSandboxBroker {
  return {
    socketPath,
    capability: createConfinementCapability('sandbox-broker', socketPath),
    attestationNonce: 'test-attestation-nonce',
    profile: 'sandbox-integration',
    stop,
  };
}

describe('strict profiled Vitest selection', () => {
  it('probes and runs stable shards while brokering only sandbox integration', async () => {
    const stop = vi.fn(async () => {});
    const runCommandArgv = vi.fn<typeof runValidationCommandArgv>(async () => ({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputTail: '',
    }));
    const probeProfile = vi.fn(async (profile: 'isolated' | 'loopback' | 'sandbox-integration') => ({
      profile,
      definitionFingerprint: 'a'.repeat(64),
      confinementOwner: profile === 'sandbox-integration'
        ? 'sandbox-broker' as const
        : 'validation-launcher' as const,
      outcome: 'passed' as const,
      startedAt: '2026-07-31T12:00:00.000Z',
      completedAt: '2026-07-31T12:00:01.000Z',
    }));

    const result = await runProfiledVitestSelection({
      command: 'npx vitest related',
      argv: ['npx', 'vitest', 'related', '--run', 'src/example.ts'],
      cwd: '/tmp/product',
      timeoutMs: 1_000,
      runCommandArgv,
      probeProfile,
      startSandboxBroker: async () => fakeBroker('/tmp/broker.sock', stop),
    });

    expect(result).toEqual({ ok: true });
    expect(probeProfile.mock.calls.map(([profile]) => profile)).toEqual([
      'isolated', 'loopback', 'sandbox-integration',
    ]);
    expect(runCommandArgv.mock.calls.map(([argv]) => argv.at(-1))).toEqual([
      '--tags-filter=!validation-loopback && !validation-sandbox-integration',
      '--tags-filter=validation-loopback && !validation-sandbox-integration',
      '--tags-filter=validation-sandbox-integration && !validation-loopback',
    ]);
    expect(runCommandArgv.mock.calls.map((call) => call[4])).toEqual([
      { profile: 'isolated' },
      { profile: 'loopback' },
      {
        profile: 'sandbox-integration',
        sandboxBrokerSocket: '/tmp/broker.sock',
        sandboxBrokerCapability: expect.objectContaining({ owner: 'sandbox-broker' }),
        sandboxBrokerAttestation: 'test-attestation-nonce',
      },
    ]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('classifies an unavailable profile before launching its shard', async () => {
    const runCommandArgv = vi.fn();
    const result = await runProfiledVitestSelection({
      command: 'npx vitest related',
      argv: ['npx', 'vitest', 'related', '--run', 'src/example.ts'],
      cwd: '/tmp/product',
      timeoutMs: 1_000,
      runCommandArgv,
      probeProfile: async (profile: 'isolated' | 'loopback' | 'sandbox-integration') => ({
        profile,
        definitionFingerprint: 'a'.repeat(64),
        confinementOwner: 'validation-launcher',
        outcome: 'unavailable',
        failureClass: 'profile-unavailable',
        startedAt: '2026-07-31T12:00:00.000Z',
        completedAt: '2026-07-31T12:00:01.000Z',
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      result: { failureClass: 'profile-unavailable', profile: 'isolated' },
    });
    expect(runCommandArgv).not.toHaveBeenCalled();
  });
});

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

    const result = await runGate(gateOpts(), io);

    expect(result).toMatchObject({
      ok: false,
      reason: 'tests-red',
      validationReceipt: {
        outcome: 'failed',
        commands: [{ command: 'npm test', outcome: 'failed', coverage: 'unsupported' }],
      },
    });

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

  it('returns validation-cancelled and never authorizes merge after a cancelled command', async () => {
    const result = await runGate(gateOpts(), gateIO({
      exitCode: null,
      timedOut: false,
      cancelled: true,
      outputTail: '',
    }));

    expect(result).toMatchObject({
      ok: false,
      reason: 'validation-cancelled',
      validationReceipt: {
        outcome: 'cancelled',
        commands: [{
          command: 'npm test',
          outcome: 'cancelled',
          coverage: 'unsupported',
        }],
      },
    });
  });

  it('prioritizes a later cancellation over an earlier red command', async () => {
    let cancelled = false;
    const runValidationCommand = vi.fn(async (command: string) => {
      if (command === 'npm run build') {
        return { exitCode: 1, timedOut: false, cancelled: false, outputTail: '' };
      }
      cancelled = true;
      return { exitCode: 0, timedOut: false, cancelled: false, outputTail: '' };
    });

    const result = await runGate(gateOpts({
      validationCommands: ['npm run build', 'npm test'],
      cancelled: () => cancelled,
    }), {
      runGit: defaultRunGit,
      runValidationCommand,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'validation-cancelled',
      validationReceipt: {
        outcome: 'cancelled',
        commands: [
          { command: 'npm run build', outcome: 'failed' },
          { command: 'npm test', outcome: 'cancelled' },
        ],
      },
    });
  });

  it('even a GREEN gate does NOT merge: the gate only decides — the merge is the finalizer\'s post-gate step', async () => {
    const before = baseState();
    const io = gateIO({ exitCode: 0, timedOut: false, outputTail: '' });

    const result = await runGate(gateOpts(), io);

    expect(result).toMatchObject({
      ok: true,
      validationReceipt: {
        outcome: 'passed',
        commands: [{ command: 'npm test', outcome: 'passed', coverage: 'unsupported' }],
      },
    });

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

  it('always executes every configured command and returns a compact merge-gate receipt even when one command is red', async () => {
    const runValidationCommand = vi.fn(
      async (command: string): Promise<ValidationCommandResult> => ({
        exitCode: command === 'npm run build' ? 1 : 0,
        timedOut: false,
        outputHead: `private head from ${repoPath}`,
        outputTail: `TELEGRAM_BOT_TOKEN=never-persist ${repoPath}`,
        diagnosticArtifacts: [],
      }),
    );

    const result = await runGate(
      gateOpts({ validationCommands: ['npm run build', 'npm test'] }),
      { runGit: defaultRunGit, runValidationCommand },
    );
    const projected = result as unknown as {
      ok: boolean;
      reason?: string;
      validationReceipt?: {
        outcome: string;
        commands: Array<{ command: string; outcome: string; coverage: string }>;
      };
    };

    expect(result).toMatchObject({ ok: false, reason: 'tests-red' });
    expect(runValidationCommand.mock.calls.map(([command]) => command)).toEqual([
      'npm run build',
      'npm test',
    ]);
    expect(projected.validationReceipt).toMatchObject({
      version: 2,
      treeOid: expect.stringMatching(/^[0-9a-f]{40}$/),
      fullTaskReviewHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      completedAt: expect.any(String),
      commandFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      configurationFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      dependencyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      outcome: 'failed',
      commands: [
        { command: 'npm run build', outcome: 'failed', coverage: 'unsupported' },
        { command: 'npm test', outcome: 'passed', coverage: 'unsupported' },
      ],
    });
    const serialized = JSON.stringify(projected.validationReceipt);
    expect(serialized).not.toContain(repoPath);
    expect(serialized).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(serialized.length).toBeLessThan(8_000);
  });

  it('fails closed when a mapped command exits zero without canonical reporter evidence', async () => {
    git(repoPath, 'checkout', '-q', BRANCH);
    writeFileSync(join(repoPath, 'package.json'), JSON.stringify({
      name: 'gate-fixture',
      private: true,
      scripts: { test: 'vitest run' },
    }));
    git(repoPath, 'add', 'package.json');
    git(repoPath, 'commit', '-q', '-m', 'add mapped validation command');
    git(repoPath, 'checkout', '-q', BASE);
    const runValidationCommand = vi.fn(async () => ({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputTail: '',
    }));

    const result = await runGate(gateOpts({
      validationAdapters: [{ command: 'npm test', runner: 'vitest' }],
    }), { runGit: defaultRunGit, runValidationCommand });

    expect(result).toMatchObject({
      ok: false,
      reason: 'tests-red',
      validationReceipt: {
        outcome: 'failed',
        commands: [{ command: 'npm test', outcome: 'passed', coverage: 'invalid' }],
      },
    });
  });

  // Launches its own `sandbox-exec` rather than going through the broker, so
  // macOS refuses it (exit 71) when an enclosing Rune launcher already owns
  // this shard's Seatbelt. Bare runs exercise it fully; see
  // `enclosedByValidationBroker`.
  it.runIf(!enclosedByValidationBroker())('uses the production isolated observer for mapped merge-gate coverage', async () => {
    git(repoPath, 'checkout', '-q', BRANCH);
    writeFileSync(join(repoPath, '.gitignore'), 'node_modules\n');
    writeFileSync(join(repoPath, 'package.json'), JSON.stringify({
      name: 'real-gate-attestation-fixture',
      private: true,
      scripts: { test: 'vitest run' },
    }));
    writeFileSync(join(repoPath, 'package-lock.json'), JSON.stringify({
      name: 'real-gate-attestation-fixture',
      lockfileVersion: 3,
    }));
    writeFileSync(join(repoPath, 'vitest.config.cjs'), [
      "if (process.env.RUNE_VITEST_ATTESTATION_CAPABILITY !== undefined) throw new Error('secret leaked');",
      "if (process.env.RUNE_VITEST_ATTESTATION_FILE !== undefined) throw new Error('path leaked');",
      'module.exports = {};',
      '',
    ].join('\n'));
    writeFileSync(join(repoPath, 'gate.test.js'), [
      "import { expect, it } from 'vitest';",
      "it('runs without attestation credentials', () => {",
      "  expect(process.env.RUNE_VITEST_ATTESTATION_CAPABILITY).toBeUndefined();",
      "  expect(process.env.RUNE_VITEST_ATTESTATION_FILE).toBeUndefined();",
      '});',
      '',
    ].join('\n'));
    git(repoPath, 'add', '-A');
    git(repoPath, 'commit', '-q', '-m', 'add real mapped validation');
    git(repoPath, 'checkout', '-q', BASE);

    const result = await (async () => {
      vi.stubEnv(
        'PATH',
        `${join(PROJECT_ROOT, 'node_modules', '.bin')}:${process.env['PATH'] ?? ''}`,
      );
      try {
        return await runGate(gateOpts({
          validationAdapters: [{ command: 'npm test', runner: 'vitest' }],
          commandTimeoutMs: 30_000,
        }));
      } finally {
        vi.unstubAllEnvs();
      }
    })();

    expect(result).toMatchObject({
      ok: true,
      validationReceipt: {
        outcome: 'passed',
        commands: [{
          command: 'npm test',
          outcome: 'passed',
          coverage: 'complete',
          discovered: { tests: 1 },
          completed: { tests: 1, passed: 1 },
        }],
      },
    });
    expect(existsSync(integrationWorktree)).toBe(false);
  }, 30_000);

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

    expect(result).toMatchObject({
      ok: true,
      validationReceipt: {
        outcome: 'passed',
        commands: [{ command: 'npm test', outcome: 'passed', coverage: 'unsupported' }],
      },
    });
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
    30_000,
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

  // Regression coverage for the "profiled closeout launcher reports a nested
  // Seatbelt failure as an ordinary command failure" bug: the merge gate's
  // OWN default validation launcher (no injected `io.runValidationCommand`)
  // must wire the real `probeProfile`/`startSandboxBroker` pair into
  // `runFullSuiteValidation`, exactly as the task-closeout call site does.
  // Before the fix this call site omitted both hooks, so a sandbox-integration
  // shard ran without a broker grant and without confinement admission ever
  // being proven for real.
  // Launches its own `sandbox-exec` rather than going through the broker, so
  // macOS refuses it (exit 71) when an enclosing Rune launcher already owns
  // this shard's Seatbelt. Bare runs exercise it fully; see
  // `enclosedByValidationBroker`.
  it.runIf(process.platform === 'darwin' && !enclosedByValidationBroker())(
    "the merge gate's default launcher grants its sandbox-integration shard a live broker",
    async () => {
      // The compact merge-gate receipt refuses to durably record a configured
      // command containing an absolute host path, so (like every real product
      // `validationCommands` entry) this must be a bare npm script name, not
      // an absolute interpreter+script argv.
      writeFileSync(join(repoPath, 'package.json'), JSON.stringify({
        name: 'gate-sandbox-broker-fixture',
        private: true,
        scripts: { test: 'node probe.cjs' },
      }));
      writeFileSync(
        join(repoPath, 'probe.cjs'),
        [
          'const socket = process.env.RUNE_VALIDATION_SANDBOX_BROKER_SOCKET;',
          'const nonce = process.env.RUNE_VALIDATION_CONFINEMENT_ATTESTATION;',
          'process.exit(socket && nonce ? 0 : 1);',
          '',
        ].join('\n'),
      );
      git(repoPath, 'add', '-A');
      git(repoPath, 'commit', '-q', '-m', 'add sandbox-broker probe fixture');
      const command = 'npm test';

      // No `io` argument: this exercises `runGate`'s own default validation
      // launcher (`defaultGateRuntimeIO`), not a test-injected command runner.
      // Before the fix, this call site omitted `probeProfile`/`startSandboxBroker`
      // so the sandbox-integration shard ran with no live broker grant and the
      // probe script above would see undefined env vars and exit 1.
      const result = await runGate(gateOpts({
        validationCommands: [command],
        validationCommandProfiles: [{ command, profile: 'sandbox-integration' }],
      }));

      expect(result.ok).toBe(true);
      expect(result.validationReceipt).toMatchObject({
        outcome: 'passed',
        commands: [{ command, outcome: 'passed' }],
      });
    },
    30_000,
  );
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

  // Skipped when an enclosing Rune broker already owns this shard's Seatbelt:
  // creating a second OS sandbox is precisely the nested-ownership mistake this
  // bug forbids, so the test that proves it must not commit it. Bare runs
  // (`npx vitest run`) own no outer profile and do the real reproduction.
  it.runIf(process.platform === 'darwin' && !enclosedByValidationBroker())(
    'classifies a REAL nested sandbox_apply launch rejection as profile-unavailable',
    async () => {
      // Reproduce the production failure at the OS level instead of asserting
      // on a hand-written string: run the launcher from inside an outer
      // Seatbelt that denies all networking, and ask it for the `loopback`
      // profile. macOS refuses an inner profile that WIDENS the outer one
      // (`sandbox_apply: Operation not permitted`), which is exactly what the
      // Project 24 closeout hit and misfiled as `command-failed`.
      const driver = join(tmpRoot, 'nested-profile-driver.mjs');
      writeFileSync(driver, [
        `const { runValidationCommandArgv } = await import(${JSON.stringify(
          pathToFileURL(join(PROJECT_ROOT, 'src', 'jobs', 'work-run-gate-runtime.ts')).href,
        )});`,
        'const result = await runValidationCommandArgv(',
        `  [${JSON.stringify(process.execPath)}, '-e', 'process.exit(0)'],`,
        `  ${JSON.stringify(tmpRoot)},`,
        '  20_000,',
        '  undefined,',
        "  { profile: 'loopback' },",
        ');',
        'console.log(`RESULT:${JSON.stringify({',
        '  exitCode: result.exitCode,',
        '  failureClass: result.failureClass,',
        '  profile: result.profile,',
        '})}`);',
        '',
      ].join('\n'), 'utf8');

      const outer = await execFileAsync(
        '/usr/bin/sandbox-exec',
        [
          '-p',
          '(version 1)(allow default)(deny network-outbound)(deny network-inbound)',
          process.execPath,
          '--import',
          join(PROJECT_ROOT, 'scripts', 'register-ts.mjs'),
          driver,
        ],
        { cwd: PROJECT_ROOT, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
      );

      const reported = /RESULT:(\{.*\})/.exec(outer.stdout);
      expect(reported?.[1]).toBeDefined();
      expect(JSON.parse(reported![1]!)).toMatchObject({
        failureClass: 'profile-unavailable',
        profile: 'loopback',
      });
    },
    90_000,
  );

  it.runIf(process.platform === 'darwin')(
    'refuses to let product output forge a profile-unavailable operational hold',
    async () => {
      // The launcher's own marker proves Seatbelt applied, so a test printing
      // the exact OS rejection line stays an ordinary `command-failed` and
      // keeps consuming the bounded repair flow it is supposed to.
      const result = await runValidationCommandArgv(
        [
          process.execPath,
          '-e',
          "console.error('sandbox-exec: sandbox_apply: Operation not permitted');process.exit(1)",
        ],
        tmpRoot,
        5_000,
        undefined,
        { profile: 'sandbox-integration' },
      );

      expect(result).toMatchObject({
        exitCode: 1,
        timedOut: false,
        profile: 'sandbox-integration',
      });
      expect(result.failureClass).toBeUndefined();
    },
  );

  // Launches its own `sandbox-exec` rather than going through the broker, so
  // macOS refuses it (exit 71) when an enclosing Rune launcher already owns
  // this shard's Seatbelt. Bare runs exercise it fully; see
  // `enclosedByValidationBroker`.
  it.runIf(!enclosedByValidationBroker())('keeps an ordinary profiled assertion failure as command-failed evidence', async () => {
    const result = await runValidationCommandArgv(
      [process.execPath, '-e', "console.error('AssertionError: expected 1 to be 2');process.exit(1)"],
      tmpRoot,
      5_000,
      undefined,
      { profile: 'isolated' },
    );

    expect(result).toMatchObject({ exitCode: 1, timedOut: false, profile: 'isolated' });
    expect(result.failureClass).toBeUndefined();
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
    const inheritedBroker = process.env['RUNE_VALIDATION_SANDBOX_BROKER_SOCKET'];
    if (inheritedBroker !== undefined) {
      const result = await requestValidationSandboxProbe(inheritedBroker, {
        version: 1,
        scenario: 'loopback-allowed-external-denied',
        candidateProfile: [
          '(version 1)',
          '(allow default)',
          '(deny network-outbound)',
          '(deny network-inbound)',
          '(allow network-inbound (local ip "localhost:*"))',
          '(allow network-outbound (remote ip "localhost:*"))',
        ].join(''),
      });
      expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
      return;
    }
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

  it.runIf(process.platform === 'darwin')(
    'carves a default-layout validation worktree out of a denied trust root',
    async () => {
      // Mirrors the production layout — `WORKTREE_ROOT` defaults to
      // `<PROJECT_ROOT>/.worktrees`, so a worktree sits INSIDE the denied trust
      // root and the nested allow has to beat the outer deny. The roots here are
      // temp dirs rather than PROJECT_ROOT itself: the trusted observer runs
      // this suite from a materialized reviewed tree that is read-only, so
      // writing into the real repo passes in a worktree and fails the
      // authoritative manifest. That the real default nests under PROJECT_ROOT
      // is pinned separately, filesystem-free, in `src/config.test.ts`.
      const trustRoot = mkdtempSync(join(tmpdir(), 'validation-trust-root-'));
      const worktreesDir = join(trustRoot, '.worktrees');
      mkdirSync(worktreesDir, { recursive: true });
      const worktree = mkdtempSync(join(worktreesDir, 'validation-write-probe-'));
      try {
        const result = await runValidationCommandArgv([
          process.execPath,
          '-e',
          "require('node:fs').writeFileSync('build-artifact.txt','ok')",
        ], worktree, 5_000, undefined, {
          deniedWriteRoots: [trustRoot],
          allowedWriteRoots: [worktree],
        });

        expect(result).toMatchObject({ exitCode: 0, timedOut: false });
        expect(readFileSync(join(worktree, 'build-artifact.txt'), 'utf8')).toBe('ok');
      } finally {
        rmSync(trustRoot, { recursive: true, force: true });
      }
    },
  );

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

  it('reaps descendants left behind by a normally exiting validation leader', async () => {
    const pidFile = join(tmpRoot, 'green-grandchild.pid');
    const parent = join(tmpRoot, 'green-parent.cjs');
    writeFileSync(parent, [
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      `const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});`,
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));`,
      'process.exit(0);',
    ].join('\n'));

    const result = await runValidationCommandArgv(
      [process.execPath, parent],
      tmpRoot,
      30_000,
    );

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    let state = '';
    try {
      state = execFileSync('ps', ['-p', String(pid), '-o', 'state='], { encoding: 'utf8' }).trim();
    } catch {
      // ps exits non-zero once the reaped process has disappeared entirely.
    }
    expect(state === '' || state.startsWith('Z')).toBe(true);
  }, 15_000);

  it.runIf(process.platform === 'darwin')(
    'detects and reaps a detached new-session descendant by its private launch nonce',
    async () => {
      const pidFile = join(tmpRoot, 'escaped-child.pid');
      const childScript = join(tmpRoot, 'escaped-child.cjs');
      const parentScript = join(tmpRoot, 'escaped-parent.cjs');
      writeFileSync(childScript, [
        "const fs=require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        'setInterval(()=>{}, 1000);',
        '',
      ].join('\n'));
      writeFileSync(parentScript, [
        "const {spawn}=require('node:child_process');",
        `spawn(process.execPath,[${JSON.stringify(childScript)}],{detached:true,stdio:'ignore'}).unref();`,
        'setTimeout(()=>process.exit(0), 100);',
        '',
      ].join('\n'));

      const result = await runValidationCommandArgv(
        [process.execPath, parentScript],
        tmpRoot,
        5_000,
      );

      expect(result).toMatchObject({ exitCode: 0, timedOut: false });
      const escapedPid = Number(readFileSync(pidFile, 'utf8'));
      let state = '';
      try {
        state = execFileSync('ps', ['-p', String(escapedPid), '-o', 'state='], {
          encoding: 'utf8',
        }).trim();
      } catch {
        // The escaped process was fully reaped.
      }
      expect(state === '' || state.startsWith('Z')).toBe(true);
    },
  );

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

  it('reaps the validation process group when live cancellation is observed', async () => {
    const startedAt = Date.now();
    let cancelled = false;
    const trigger = setTimeout(() => {
      cancelled = true;
    }, 150);
    try {
      const result = await runValidationCommandArgv(
        [process.execPath, '-e', 'setInterval(()=>{},1000)'],
        tmpRoot,
        30_000,
        undefined,
        { cancelled: () => cancelled },
      );

      expect(result).toMatchObject({
        timedOut: false,
        cancelled: true,
      });
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      clearTimeout(trigger);
    }
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

describe('runFullSuiteValidation — canonical attestation launcher', () => {
  const completeManifest = (tests = 7) => ({
    version: 1 as const,
    runner: 'vitest' as const,
    completedNormally: true,
    collectionErrors: 0,
    discovered: { suites: 3, tests },
    completed: {
      suites: 3,
      tests,
      passed: Math.max(0, tests - 2),
      failed: 0,
      skipped: tests > 0 ? 1 : 0,
      todo: tests > 1 ? 1 : 0,
      cancelled: 0,
    },
  });

  function prepareAttestationFixture(): { expectedTreeOid: string } {
    writeFileSync(join(repoPath, 'package.json'), JSON.stringify({
      name: 'attestation-fixture',
      scripts: { test: 'vitest run' },
    }));
    writeFileSync(join(repoPath, 'package-lock.json'), JSON.stringify({
      name: 'attestation-fixture',
      lockfileVersion: 3,
    }));
    writeFileSync(join(repoPath, 'vitest.config.ts'), 'export default {};\n');
    git(repoPath, 'add', '-A');
    return { expectedTreeOid: git(repoPath, 'write-tree') };
  }

  function opts(expectedTreeOid: string) {
    return {
      commands: ['npm test'],
      adapters: [{ command: 'npm test', runner: 'vitest' as const }],
      worktree: repoPath,
      cwd: repoPath,
      validationCwd: '.',
      expectedTreeOid,
      fullTaskReviewHash: 'a'.repeat(64),
      timeoutMs: 30_000,
      diagnosticDir: join(tmpRoot, 'validation-diagnostics'),
    };
  }

  function ioReturning(
    result: ValidationCommandResult,
    runGit: GitRunner = defaultRunGit,
  ): FullSuiteValidationIO & { runCommand: ReturnType<typeof vi.fn> } {
    return {
      runGit,
      runCommand: vi.fn(async () => result),
      runTrustedVitestObserver: vi.fn(async () => result),
      // These seams stub the launcher itself, so there is no real profile to
      // admit. Saying so explicitly is what distinguishes them from a
      // production call site that forgot `productionFullSuiteProfileIO()`.
      trustedProfileAdmission: true,
    };
  }

  it('keeps private reporter material on the trusted observer call only', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const io = ioReturning({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputHead: '',
      outputTail: '',
      vitestManifest: {
        ...completeManifest(1),
        completed: {
          suites: 3,
          tests: 1,
          passed: 1,
          failed: 0,
          skipped: 0,
          todo: 0,
          cancelled: 0,
        },
      },
    });

    const result = await runFullSuiteValidation(opts(expectedTreeOid), io);
    expect(result).toMatchObject({
      ok: true,
      coverageComplete: true,
      validationReceipt: {
        outcome: 'passed',
        commands: [{
          command: 'npm test',
          outcome: 'passed',
          coverage: 'complete',
          discovered: { tests: 1 },
          completed: { tests: 1, passed: 1 },
        }],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PROJECT_ROOT);
    expect(serialized).not.toContain('vitest-attestation-reporter.mjs');
    expect(io.runCommand.mock.calls[0]?.[5]).not.toHaveProperty('vitestAttestation');
    expect((io.runTrustedVitestObserver as ReturnType<typeof vi.fn>).mock.calls[0]?.[3])
      .toHaveProperty('vitestAttestation.capability');
  });

  it.runIf(process.platform === 'darwin')(
    'prevents escaped product config from mutating the boot-anchored trust root',
    async () => {
      const inheritedBroker = process.env['RUNE_VALIDATION_SANDBOX_BROKER_SOCKET'];
      if (inheritedBroker !== undefined) {
        const result = await requestValidationSandboxProbe(inheritedBroker, {
          version: 1,
          scenario: 'private-write-denied',
          candidateProfile: '(version 1)(allow default)(deny file-write*)',
        });
        expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
        return;
      }
      const sentinel = join(PROJECT_ROOT, `.rune-attestation-sentinel-${process.pid}`);
      writeFileSync(sentinel, 'trusted\n', { mode: 0o600 });
      try {
        writeFileSync(join(repoPath, '.gitignore'), 'node_modules\n');
        writeFileSync(join(repoPath, 'package.json'), JSON.stringify({
          name: 'runtime-tamper-adversary',
          private: true,
          scripts: { test: 'vitest run' },
        }));
        writeFileSync(join(repoPath, 'package-lock.json'), JSON.stringify({
          name: 'runtime-tamper-adversary',
          lockfileVersion: 3,
        }));
        writeFileSync(
          join(repoPath, 'vitest.config.cjs'),
          [
            "const escapedProcess = require.constructor('return process')();",
            "const fs = escapedProcess.getBuiltinModule('node:fs');",
            `try { fs.appendFileSync(${JSON.stringify(sentinel)}, 'tampered\\n'); } catch {}`,
            'module.exports = {};',
            '',
          ].join('\n'),
        );
        writeFileSync(
          join(repoPath, 'attested.test.js'),
          "import { it } from 'vitest'; it('passes', () => {});\n",
        );
        symlinkSync(join(PROJECT_ROOT, 'node_modules'), join(repoPath, 'node_modules'), 'dir');
        git(repoPath, 'add', '-A');
        const expectedTreeOid = git(repoPath, 'write-tree');

        const result = await runFullSuiteValidation(opts(expectedTreeOid));

        expect(result).toMatchObject({ ok: true, coverageComplete: true });
        expect(readFileSync(sentinel, 'utf8')).toBe('trusted\n');
      } finally {
        rmSync(sentinel, { force: true });
      }
    },
    30_000,
  );

  it('fails closed when product config imports the trusted reporter as a signing oracle', async () => {
    writeFileSync(join(repoPath, '.gitignore'), 'node_modules\n');
    writeFileSync(join(repoPath, 'package.json'), JSON.stringify({
      name: 'reporter-import-adversary',
      private: true,
      scripts: { test: 'vitest run' },
    }));
    writeFileSync(join(repoPath, 'package-lock.json'), JSON.stringify({
      name: 'reporter-import-adversary',
      lockfileVersion: 3,
    }));
    const reporterUrl = pathToFileURL(
      join(PROJECT_ROOT, 'scripts', 'vitest-attestation-reporter.mjs'),
    ).href;
    writeFileSync(
      join(repoPath, 'vitest.config.mjs'),
      [
        `import Reporter from ${JSON.stringify(reporterUrl)};`,
        'const reporter = new Reporter();',
        "if ('output' in reporter || 'capability' in reporter) throw new Error('public signing material');",
        'export default {};',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(repoPath, 'attested.test.js'),
      "import { it } from 'vitest'; it('passes', () => {});\n",
    );
    symlinkSync(join(PROJECT_ROOT, 'node_modules'), join(repoPath, 'node_modules'), 'dir');
    git(repoPath, 'add', '-A');
    const expectedTreeOid = git(repoPath, 'write-tree');

    const Reporter = (await import(reporterUrl)).default as new () => object;
    const importedReporter = new Reporter();
    expect('output' in importedReporter).toBe(false);
    expect('capability' in importedReporter).toBe(false);

    // This is a signing-policy case, not another OS-launcher integration test.
    // The adjacent end-to-end case owns the real nested Vitest launch; inject
    // the configured-command rejection here so full-shard concurrency cannot
    // turn the policy assertion into an unrelated nested-run timeout.
    const io = ioReturning({
      exitCode: 1,
      timedOut: false,
      cancelled: false,
      outputHead: '',
      outputTail: 'product config could not acquire trusted reporter signing material',
    });
    const result = await runFullSuiteValidation(opts(expectedTreeOid), io);

    expect(result).toMatchObject({
      ok: false,
      coverageComplete: false,
      validationReceipt: {
        outcome: 'failed',
        commands: [{ coverage: 'invalid' }],
      },
    });
    expect(result.attestations).toEqual([]);
    expect(io.runCommand).toHaveBeenCalledOnce();
  });

  // Launches its own `sandbox-exec` rather than going through the broker, so
  // macOS refuses it (exit 71) when an enclosing Rune launcher already owns
  // this shard's Seatbelt. Bare runs exercise it fully; see
  // `enclosedByValidationBroker`.
  it.runIf(!enclosedByValidationBroker())('observes a clean materialization of the reviewed tree, excluding ignored tests', async () => {
    writeFileSync(join(repoPath, '.gitignore'), 'node_modules\nignored.test.js\n');
    writeFileSync(join(repoPath, 'package.json'), JSON.stringify({
      name: 'reviewed-tree-observer-fixture',
      private: true,
      scripts: { test: 'vitest run' },
    }));
    writeFileSync(join(repoPath, 'package-lock.json'), JSON.stringify({
      name: 'reviewed-tree-observer-fixture',
      lockfileVersion: 3,
    }));
    writeFileSync(join(repoPath, 'tracked.test.js'),
      "import { it } from 'vitest'; it('tracked', () => {});\n");
    symlinkSync(join(PROJECT_ROOT, 'node_modules'), join(repoPath, 'node_modules'), 'dir');
    git(repoPath, 'add', '-A');
    const expectedTreeOid = git(repoPath, 'write-tree');
    writeFileSync(join(repoPath, 'ignored.test.js'),
      "import { it } from 'vitest'; it('ignored failure', () => { throw new Error('ignored'); });\n");

    const result = await runFullSuiteValidation(opts(expectedTreeOid), {
      runGit: defaultRunGit,
      trustedProfileAdmission: true,
      runCommand: vi.fn(async () => ({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        outputTail: '',
      })),
      runTrustedVitestObserver,
    });

    expect(result).toMatchObject({
      ok: true,
      validationReceipt: {
        commands: [{
          coverage: 'complete',
          discovered: { tests: 1 },
          completed: { tests: 1, passed: 1 },
        }],
      },
    });
  });

  it('binds exact configured argv and private reporter evidence to the reviewed tree', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const io = ioReturning({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputHead: '',
      outputTail: `private output at ${repoPath}`,
      diagnosticArtifacts: [],
      vitestManifest: completeManifest(),
    });

    const result = await runFullSuiteValidation(opts(expectedTreeOid), io);

    expect(result).toMatchObject({
      ok: true,
      coverageComplete: true,
      validationReceipt: {
        outcome: 'passed',
        commands: [{ command: 'npm test', outcome: 'passed', coverage: 'complete' }],
      },
      receipts: [{
        command: 'npm test',
        treeOid: expectedTreeOid,
        outcome: 'passed',
        coverage: 'complete',
        discovered: { suites: 3, tests: 7 },
      }],
    });
    expect(io.runCommand).toHaveBeenCalledWith(
      'npm test',
      ['npm', 'test'],
      repoPath,
      30_000,
      join(tmpRoot, 'validation-diagnostics'),
      {
        deniedWriteRoots: [PROJECT_ROOT],
        allowedWriteRoots: [repoPath],
        profile: 'isolated',
      },
    );
    const durable = JSON.stringify(result);
    expect(durable).not.toContain(repoPath);
    expect(durable).not.toContain('reporterPath');
    expect(durable).not.toContain('outputPath');
    expect(durable).not.toContain('private output');
  });

  it('rejects npm lifecycle hooks as a canonical full Vitest invocation', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    writeFileSync(join(repoPath, 'package.json'), JSON.stringify({
      name: 'attestation-fixture',
      scripts: {
        pretest: 'node mutate-tests.js',
        test: 'vitest run',
        posttest: 'node restore-tests.js',
      },
    }));
    git(repoPath, 'add', '-A');
    const hookedTree = git(repoPath, 'write-tree');
    const io = ioReturning({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputTail: '',
      vitestManifest: completeManifest(),
    });

    const result = await runFullSuiteValidation(opts(hookedTree), io);

    expect(result).toMatchObject({
      ok: false,
      coverageComplete: false,
      validationReceipt: {
        commands: [{ command: 'npm test', coverage: 'invalid' }],
      },
    });
    expect(io.runCommand).toHaveBeenCalledWith(
      'npm test',
      ['npm', 'test'],
      repoPath,
      30_000,
      join(tmpRoot, 'validation-diagnostics'),
      {
        deniedWriteRoots: [PROJECT_ROOT],
        allowedWriteRoots: [repoPath],
        profile: 'isolated',
      },
    );
    expect(expectedTreeOid).not.toBe(hookedTree);
  });

  it.each([
    ['missing manifest', undefined],
    ['partial manifest', {
      ...completeManifest(),
      discovered: { suites: 3, tests: 7 },
      completed: { suites: 2, tests: 6, passed: 4, failed: 0, skipped: 1, todo: 1, cancelled: 0 },
    }],
  ])('rejects a green exit with %s', async (_label, vitestManifest) => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const io = ioReturning({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputTail: '',
      ...(vitestManifest !== undefined ? { vitestManifest } : {}),
    });

    const result = await runFullSuiteValidation(opts(expectedTreeOid), io);

    expect(result).toMatchObject({
      ok: false,
      coverageComplete: false,
      validationReceipt: {
        commands: [{ command: 'npm test', coverage: 'invalid' }],
      },
    });
    expect(result.attestations).toEqual([]);
  });

  it('rejects post-run canonical tree drift', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const io: FullSuiteValidationIO = {
      runGit: defaultRunGit,
      trustedProfileAdmission: true,
      runCommand: vi.fn(async () => {
        writeFileSync(join(repoPath, 'generated-after-validation.txt'), 'drift\n');
        return {
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          outputTail: '',
          vitestManifest: completeManifest(),
        };
      }),
    };

    const result = await runFullSuiteValidation(opts(expectedTreeOid), io);

    expect(result).toMatchObject({
      ok: false,
      command: 'canonical validation identity',
      coverageComplete: false,
      validationReceipt: { outcome: 'drifted' },
    });
    expect(result.attestations).toEqual([]);
  });

  it('rejects a cwd that is not the contained resolution of validationCwd', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const outside = join(tmpRoot, 'wrong-validation-cwd');
    mkdirSync(outside);
    const io = ioReturning({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputTail: '',
      vitestManifest: completeManifest(),
    });

    const result = await runFullSuiteValidation({
      ...opts(expectedTreeOid),
      cwd: outside,
    }, io);

    expect(result).toMatchObject({
      ok: false,
      command: 'canonical validation identity',
      validationReceipt: { outcome: 'drifted', commands: [] },
    });
    expect(io.runCommand).not.toHaveBeenCalled();
  });

  it('rejects a stale reviewed tree before executing validation', async () => {
    prepareAttestationFixture();
    const io = ioReturning({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputTail: '',
      vitestManifest: completeManifest(),
    });

    const result = await runFullSuiteValidation(opts('f'.repeat(40)), io);

    expect(result).toMatchObject({
      ok: false,
      command: 'canonical validation identity',
      validationReceipt: { outcome: 'drifted', commands: [] },
    });
    expect(io.runCommand).not.toHaveBeenCalled();
  });

  it('turns private reporter setup failure into a bounded red result', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const io = {
      ...ioReturning({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        outputTail: '',
        vitestManifest: completeManifest(),
      }),
      createVitestManifestDir: () => {
        throw new Error(`private setup at ${repoPath}`);
      },
    };

    const result = await runFullSuiteValidation(opts(expectedTreeOid), io);

    expect(result).toMatchObject({
      ok: false,
      result: {
        exitCode: 0,
        outputTail: expect.stringContaining('trusted Vitest reporter setup failed'),
      },
    });
    expect(io.runCommand).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(repoPath);
  });

  it('runs the exact configured command when the isolated observer rejects', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputTail: 'configured command passed',
      vitestManifest: completeManifest(),
    }));
    const runTrustedVitestObserver = vi.fn(async () => {
      throw new Error(`observer rejected at ${repoPath}`);
    });

    const result = await runFullSuiteValidation(
      opts(expectedTreeOid),
      { runGit: defaultRunGit, runCommand, runTrustedVitestObserver, trustedProfileAdmission: true },
    );

    expect(result).toMatchObject({
      ok: false,
      result: {
        exitCode: 0,
        outputTail: expect.stringContaining('trusted Vitest observer runner failed'),
      },
      validationReceipt: {
        commands: [{ outcome: 'passed', coverage: 'invalid' }],
      },
    });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(repoPath);
  });

  it('rejects a validation cwd whose reviewed-tree symlink resolves to the live worktree', async () => {
    const liveCwd = join(repoPath, 'live-cwd');
    mkdirSync(liveCwd);
    writeFileSync(join(liveCwd, 'package.json'), JSON.stringify({
      scripts: { test: 'vitest run' },
    }));
    symlinkSync(liveCwd, join(repoPath, 'test-cwd'), 'dir');
    git(repoPath, 'add', '-A');
    const expectedTreeOid = git(repoPath, 'write-tree');
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputTail: '',
    }));

    const result = await runFullSuiteValidation({
      ...opts(expectedTreeOid),
      cwd: realpathSync(join(repoPath, 'test-cwd')),
      validationCwd: 'test-cwd',
    }, {
      runGit: defaultRunGit,
      trustedProfileAdmission: true,
      runCommand,
      runTrustedVitestObserver,
    });

    expect(result).toMatchObject({
      ok: false,
      result: {
        exitCode: 0,
        outputTail: expect.stringContaining('trusted Vitest reporter setup failed'),
      },
      validationReceipt: {
        commands: [{ outcome: 'passed', coverage: 'invalid' }],
      },
    });
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it('continues all merge-gate commands after a rejected command runner', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const runCommand = vi.fn(async (command: string) => {
      if (command === 'npm run build') {
        throw new Error(`spawn failed at ${repoPath}`);
      }
      return {
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        outputTail: '',
        vitestManifest: completeManifest(),
      };
    });

    const result = await runFullSuiteValidation({
      ...opts(expectedTreeOid),
      commands: ['npm run build', 'npm test'],
      continueOnFailure: true,
    }, {
      runGit: defaultRunGit,
      trustedProfileAdmission: true,
      runCommand,
      runTrustedVitestObserver: vi.fn(async () => ({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        outputTail: '',
        vitestManifest: completeManifest(),
      })),
    });

    expect(runCommand.mock.calls.map(([command]) => command)).toEqual([
      'npm run build',
      'npm test',
    ]);
    expect(result).toMatchObject({
      ok: false,
      validationReceipt: {
        outcome: 'failed',
        commands: [
          { command: 'npm run build', outcome: 'failed', coverage: 'unsupported' },
          {
            command: 'npm test',
            outcome: 'passed',
            coverage: 'complete',
            discovered: { suites: 3, tests: 7 },
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain(repoPath);
  });

  it('stops launching merge-gate commands after cancellation even in all-command mode', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const runCommand = vi.fn(async () => ({
      exitCode: null,
      timedOut: false,
      cancelled: true,
      outputTail: '',
    }));

    const result = await runFullSuiteValidation({
      ...opts(expectedTreeOid),
      commands: ['npm run build', 'npm test'],
      continueOnFailure: true,
    }, { runGit: defaultRunGit, runCommand, trustedProfileAdmission: true });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      validationReceipt: {
        outcome: 'cancelled',
        commands: [{
          command: 'npm run build',
          outcome: 'cancelled',
          coverage: 'unsupported',
        }],
      },
    });
  });

  it('rejects cancellation that arrives during post-run identity capture', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    let cancelled = false;
    let gitCalls = 0;
    const runGit: GitRunner = async (args, options) => {
      const result = await defaultRunGit(args, options);
      gitCalls += 1;
      // captureValidationTree performs three probes before and three after the
      // child. Flip only as the final post-run identity probe settles.
      if (gitCalls === 6) cancelled = true;
      return result;
    };
    const io = ioReturning({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputTail: '',
      vitestManifest: completeManifest(),
    }, runGit);

    const result = await runFullSuiteValidation({
      ...opts(expectedTreeOid),
      cancelled: () => cancelled,
    }, io);

    expect(io.runCommand).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      result: { cancelled: true },
      validationReceipt: {
        outcome: 'cancelled',
        commands: [{
          command: 'npm test',
          outcome: 'cancelled',
          coverage: 'invalid',
        }],
      },
    });
    expect(result.attestations).toEqual([]);
  });

  it('rejects trusted reporter implementation drift', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const reporterPath = join(tmpRoot, 'trusted-reporter.mjs');
    writeFileSync(reporterPath, 'export default class Reporter {}\\n');
    const io: FullSuiteValidationIO = {
      runGit: defaultRunGit,
      trustedVitestReporterPath: reporterPath,
      trustedProfileAdmission: true,
      runCommand: vi.fn(async () => {
        writeFileSync(reporterPath, 'export default class ChangedReporter {}\\n');
        return {
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          outputTail: '',
          vitestManifest: completeManifest(),
        };
      }),
    };

    const result = await runFullSuiteValidation(opts(expectedTreeOid), io);

    expect(result).toMatchObject({
      ok: false,
      command: 'canonical validation identity',
      validationReceipt: { outcome: 'drifted' },
    });
  });

  it('preserves reconciled failed-test counts as complete red gate evidence', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const failedManifest = {
      ...completeManifest(),
      completed: {
        suites: 3,
        tests: 7,
        passed: 4,
        failed: 1,
        skipped: 1,
        todo: 1,
        cancelled: 0,
      },
    };
    const io = ioReturning({
      exitCode: 1,
      timedOut: false,
      cancelled: false,
      outputTail: '',
      vitestManifest: failedManifest,
    });

    const result = await runFullSuiteValidation(opts(expectedTreeOid), io);

    expect(result).toMatchObject({
      ok: false,
      validationReceipt: {
        outcome: 'failed',
        commands: [{
          command: 'npm test',
          outcome: 'failed',
          coverage: 'complete',
          discovered: { suites: 3, tests: 7 },
          completed: { tests: 7, failed: 1 },
        }],
      },
    });
    expect(result.attestations).toEqual([]);
  });

  it('runs the isolated observer after a red configured command and retains its red counts', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const failedManifest = {
      ...completeManifest(),
      completed: {
        suites: 3,
        tests: 7,
        passed: 4,
        failed: 1,
        skipped: 1,
        todo: 1,
        cancelled: 0,
      },
    };
    const runCommand = vi.fn(async () => ({
      exitCode: 1,
      timedOut: false,
      cancelled: false,
      outputTail: 'configured command failed',
    }));
    const runTrustedVitestObserver = vi.fn(async () => ({
      exitCode: 1,
      timedOut: false,
      cancelled: false,
      outputTail: '',
      vitestManifest: failedManifest,
    }));

    const result = await runFullSuiteValidation(
      opts(expectedTreeOid),
      { runGit: defaultRunGit, runCommand, runTrustedVitestObserver, trustedProfileAdmission: true },
    );

    expect(runTrustedVitestObserver).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      result: { exitCode: 1 },
      validationReceipt: {
        commands: [{
          outcome: 'failed',
          coverage: 'complete',
          completed: { tests: 7, failed: 1 },
        }],
      },
    });
  });

  it('keeps green execution separate from complete red observer coverage', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const redManifest = {
      ...completeManifest(),
      completed: {
        suites: 3,
        tests: 7,
        passed: 4,
        failed: 1,
        skipped: 1,
        todo: 1,
        cancelled: 0,
      },
    };
    const result = await runFullSuiteValidation(opts(expectedTreeOid), {
      runGit: defaultRunGit,
      trustedProfileAdmission: true,
      runCommand: vi.fn(async () => ({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        outputTail: '',
      })),
      runTrustedVitestObserver: vi.fn(async () => ({
        exitCode: 1,
        timedOut: false,
        cancelled: false,
        outputTail: '',
        vitestManifest: redManifest,
      })),
    });

    expect(result).toMatchObject({
      ok: false,
      validationReceipt: {
        commands: [{ outcome: 'failed', coverage: 'complete', completed: { failed: 1 } }],
      },
    });
    // The observer's reporter cannot name the failing tests, so the operator
    // gets a pointer to the tool that can. Without it a red manifest behind a
    // green command is undiagnosable — which is how 10 tree-only failures went
    // unidentified while blocking every full-suite receipt.
    expect(result.ok ? '' : result.result.outputTail)
      .toContain('npm run diagnose:reviewed-tree');
  });

  it('keeps red execution separate from complete green observer coverage', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const result = await runFullSuiteValidation(opts(expectedTreeOid), {
      runGit: defaultRunGit,
      trustedProfileAdmission: true,
      runCommand: vi.fn(async () => ({
        exitCode: 1,
        timedOut: false,
        cancelled: false,
        outputTail: 'configured command failed',
      })),
      runTrustedVitestObserver: vi.fn(async () => ({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        outputTail: '',
        vitestManifest: completeManifest(),
      })),
    });

    expect(result).toMatchObject({
      ok: false,
      result: { exitCode: 1 },
      validationReceipt: {
        commands: [{ outcome: 'failed', coverage: 'complete', completed: { failed: 0 } }],
      },
    });
  });

  it.each([
    ['configuration', 'vitest.config.ts', 'export default { test: { pool: "forks" } };\n'],
    ['dependency', 'package-lock.json', '{"name":"changed","lockfileVersion":3}\n'],
  ])('rejects %s fingerprint drift even when the Git tree seam is pinned', async (
    _label,
    file,
    contents,
  ) => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const pinnedTreeGit: GitRunner = vi.fn(async (args) => {
      if (args[0] === 'add') return { stdout: '', stderr: '' };
      return { stdout: `${expectedTreeOid}\n`, stderr: '' };
    });
    const io: FullSuiteValidationIO = {
      runGit: pinnedTreeGit,
      trustedProfileAdmission: true,
      runCommand: vi.fn(async () => {
        writeFileSync(join(repoPath, file), contents);
        return {
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          outputTail: '',
          vitestManifest: completeManifest(),
        };
      }),
    };

    const result = await runFullSuiteValidation(opts(expectedTreeOid), io);

    expect(result).toMatchObject({
      ok: false,
      command: 'canonical validation identity',
      validationReceipt: { outcome: 'drifted' },
    });
    expect(result.attestations).toEqual([]);
  });

  it.each([
    ['timeout', { exitCode: null, timedOut: true, cancelled: false }],
    ['cancellation', { exitCode: null, timedOut: false, cancelled: true }],
    ['missing executable', { exitCode: null, timedOut: false, cancelled: false }],
  ])('rejects a %s execution without manufacturing coverage', async (_label, execution) => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const io = ioReturning({
      ...execution,
      outputTail: '',
      vitestManifest: completeManifest(),
    });

    const result = await runFullSuiteValidation(opts(expectedTreeOid), io);

    expect(result).toMatchObject({ ok: false, coverageComplete: false });
    expect(result.attestations).toEqual([]);
  });

  it('accepts legitimate changed discovery counts as a new attestation without a fixed repository count', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    let tests = 7;
    const io: FullSuiteValidationIO = {
      runGit: defaultRunGit,
      trustedProfileAdmission: true,
      runCommand: vi.fn(async () => ({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        outputTail: '',
      })),
      runTrustedVitestObserver: vi.fn(async () => ({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        outputTail: '',
        vitestManifest: completeManifest(tests),
      })),
    };

    const first = await runFullSuiteValidation(opts(expectedTreeOid), io);
    tests = 11;
    const second = await runFullSuiteValidation(opts(expectedTreeOid), io);

    expect(first).toMatchObject({
      ok: true,
      receipts: [{ discovered: { tests: 7 }, completed: { tests: 7 } }],
    });
    expect(second).toMatchObject({
      ok: true,
      receipts: [{ discovered: { tests: 11 }, completed: { tests: 11 } }],
    });
  });

  it('binds reusable evidence to the complete configured command list', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const io: FullSuiteValidationIO = {
      runGit: defaultRunGit,
      trustedProfileAdmission: true,
      runCommand: vi.fn(async (command) => ({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        outputTail: '',
      })),
      runTrustedVitestObserver: vi.fn(async () => ({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        outputTail: '',
        vitestManifest: completeManifest(),
      })),
    };

    const result = await runFullSuiteValidation({
      ...opts(expectedTreeOid),
      commands: ['npm run build', 'npm test'],
      adapters: [{ command: 'npm test', runner: 'vitest' }],
    }, io);

    expect(result).toMatchObject({
      ok: true,
      coverageComplete: true,
      attestations: [{
        configuredArgv: [
          ['npm', 'run', 'build'],
          ['npm', 'test'],
        ],
        execution: { outcome: 'passed' },
        coverage: { status: 'complete' },
      }],
      receipts: [{ command: 'npm run build + npm test' }],
    });
  });

  it('preserves a green configured-command outcome when the isolated observer fails', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const runCommand = vi.fn(async () => ({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputTail: 'configured command passed',
    }));
    const runTrustedVitestObserver = vi.fn(async () => ({
      exitCode: 1,
      timedOut: false,
      cancelled: false,
      outputTail: 'observer rejected product configuration',
      vitestManifest: completeManifest(),
    }));

    const result = await runFullSuiteValidation(
      opts(expectedTreeOid),
      { runGit: defaultRunGit, runCommand, runTrustedVitestObserver, trustedProfileAdmission: true },
    );

    expect(result).toMatchObject({
      ok: false,
      result: {
        exitCode: 0,
        outputTail: expect.stringContaining('observer rejected product configuration'),
      },
      validationReceipt: {
        commands: [{ outcome: 'passed', coverage: 'invalid' }],
      },
    });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runTrustedVitestObserver).toHaveBeenCalledOnce();
    expect(result.attestations).toEqual([]);
  });

  it('retains a compact receipt for an all-unsupported green suite', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const result = await runFullSuiteValidation({
      ...opts(expectedTreeOid),
      commands: ['npm run build'],
      adapters: [],
    }, ioReturning({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputTail: '',
    }));

    expect(result).toMatchObject({
      ok: true,
      coverageComplete: false,
      receipts: [{
        command: 'npm run build',
        treeOid: expectedTreeOid,
        outcome: 'passed',
        coverage: 'unsupported',
      }],
      validationReceipt: {
        outcome: 'passed',
        commands: [{
          command: 'npm run build',
          outcome: 'passed',
          coverage: 'unsupported',
        }],
      },
    });
  });

  it('tracks mapped completion by the exact configured command despite argv whitespace normalization', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const command = 'npm   test';
    const io = ioReturning({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputTail: '',
      vitestManifest: completeManifest(),
    });

    const result = await runFullSuiteValidation({
      ...opts(expectedTreeOid),
      commands: [command],
      adapters: [{ command, runner: 'vitest' }],
    }, io);

    expect(result).toMatchObject({
      ok: true,
      coverageComplete: true,
      attestations: [{ configuredArgv: [['npm', 'test']] }],
    });
  });

  it('uses one sandbox broker for both admission and execution of a strict shard', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const stop = vi.fn(async () => {});
    const broker = fakeBroker('/tmp/full-suite-broker.sock', stop);
    const startSandboxBroker = vi.fn(async () => broker);
    const probeProfile = vi.fn(async (
      profile: 'isolated' | 'loopback' | 'sandbox-integration',
      _cwd: string,
      _timeoutMs: number,
      enclosing?: ValidationSandboxBroker,
    ) => ({
      profile,
      definitionFingerprint: 'a'.repeat(64),
      confinementOwner: profile === 'sandbox-integration'
        ? 'sandbox-broker' as const
        : 'validation-launcher' as const,
      outcome: 'passed' as const,
      startedAt: '2026-08-01T12:00:00.000Z',
      completedAt: '2026-08-01T12:00:01.000Z',
      ...(enclosing === undefined ? {} : { enclosing }),
    }));
    const io = ioReturning({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputTail: '',
      vitestManifest: completeManifest(),
    });

    const result = await runFullSuiteValidation({
      ...opts(expectedTreeOid),
      commandProfiles: [{ command: 'npm test', profile: 'isolated' }],
      adapters: [{
        command: 'npm test',
        runner: 'vitest',
        profileSelection: 'strict-tags-v1',
      }],
    }, { ...io, probeProfile, startSandboxBroker });

    expect(result.ok).toBe(true);
    expect(probeProfile.mock.calls.map(([profile]) => profile)).toEqual([
      'isolated', 'loopback', 'sandbox-integration',
    ]);
    expect(probeProfile.mock.calls[2]?.[3]).toBe(broker);
    expect(startSandboxBroker).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    const sandboxOptions = io.runCommand.mock.calls[2]?.[5];
    expect(sandboxOptions).toMatchObject({
      profile: 'sandbox-integration',
      sandboxBrokerSocket: broker.socketPath,
      sandboxBrokerCapability: broker.capability,
      sandboxBrokerAttestation: broker.attestationNonce,
    });
  });

  it('fails closed before a sandbox shard when its broker cannot start', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const io = ioReturning({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputTail: '',
      vitestManifest: completeManifest(),
    });
    const probeProfile = vi.fn(async (profile: 'isolated' | 'loopback' | 'sandbox-integration') => ({
      profile,
      definitionFingerprint: 'b'.repeat(64),
      confinementOwner: 'validation-launcher' as const,
      outcome: 'passed' as const,
      startedAt: '2026-08-01T12:00:00.000Z',
      completedAt: '2026-08-01T12:00:01.000Z',
    }));

    const result = await runFullSuiteValidation({
      ...opts(expectedTreeOid),
      commandProfiles: [{ command: 'npm test', profile: 'isolated' }],
      adapters: [{
        command: 'npm test',
        runner: 'vitest',
        profileSelection: 'strict-tags-v1',
      }],
    }, {
      ...io,
      probeProfile,
      startSandboxBroker: async () => { throw new Error('Seatbelt unavailable'); },
    });

    expect(result).toMatchObject({
      ok: false,
      result: {
        failureClass: 'profile-unavailable',
        profile: 'sandbox-integration',
      },
      validationReceipt: {
        outcome: 'profile-unavailable',
        profileOutcomes: [
          { profile: 'isolated', outcome: 'passed' },
          { profile: 'loopback', outcome: 'passed' },
          {
            profile: 'sandbox-integration',
            outcome: 'profile-unavailable',
            probe: {
              confinementOwner: 'sandbox-broker',
              failureClass: 'profile-unavailable',
            },
          },
        ],
      },
    });
    expect(io.runCommand).toHaveBeenCalledTimes(2);
    expect(probeProfile).toHaveBeenCalledTimes(2);
  });

  it('rejects partially wired production profile admission', async () => {
    const { expectedTreeOid } = prepareAttestationFixture();
    const io = ioReturning({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      outputTail: '',
      vitestManifest: completeManifest(),
    });

    const result = await runFullSuiteValidation(opts(expectedTreeOid), {
      ...io,
      probeProfile: async (profile) => ({
        profile,
        definitionFingerprint: 'c'.repeat(64),
        confinementOwner: 'validation-launcher',
        outcome: 'passed',
        startedAt: '2026-08-01T12:00:00.000Z',
        completedAt: '2026-08-01T12:00:01.000Z',
      }),
    } as FullSuiteValidationIO);

    expect(result).toMatchObject({
      ok: false,
      command: 'canonical validation identity',
      result: { outputTail: expect.stringContaining('profile admission wiring') },
    });
    expect(io.runCommand).not.toHaveBeenCalled();
  });
});
