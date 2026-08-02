/**
 * Show WHICH tests fail inside the trusted observer's materialized reviewed
 * tree.
 *
 * Rune's closeout runs the suite twice per shard: the configured command in the
 * real worktree, and a trusted observer against a checkout of the reviewed git
 * tree. The observer's manifest is the authoritative evidence, but its reporter
 * records counts ONLY — never test names, paths, or output — because it is
 * injected into product-controlled Vitest, where those strings are unbounded and
 * attacker-influenced. That is the right production posture, and it is also why
 * a red observer run is undiagnosable: the receipt can say "9 failed" and
 * nothing more.
 *
 * This script closes that gap outside the trust boundary. It materializes the
 * tree with the SAME `materializeReviewedTree` production uses, then runs each
 * shard there through the SAME `runValidationCommandArgv` with the observer's
 * own options — stripped environment, cold Vitest cache, real Seatbelt, denied
 * writes to the tree — but with an ordinary reporter, so failures print.
 *
 * Fidelity caveat: this runs `npx vitest run`, which loads `vitest.config.cjs`
 * directly, whereas the observer loads a sanitized extraction of it. Everything
 * affecting collection (`include`/`exclude`/`setupFiles`/`tags`/`strictTags`)
 * survives that sanitizer, so the collected set should match — but do not assume
 * it. Trust the names only when this script's failure count matches the
 * `completed.failed` that `npm run verify:closeout-confinement` reports.
 *
 * Usage:
 *   npm run diagnose:reviewed-tree                    # every shard
 *   RUNE_DIAGNOSE_PROFILE=sandbox-integration npm run diagnose:reviewed-tree
 *   RUNE_DIAGNOSE_FILES='src/a.test.ts src/b.test.ts' npm run diagnose:reviewed-tree
 *
 * A whole-shard run captures only a bounded head and tail of the child's
 * output, which is enough for the failing test NAMES but usually truncates the
 * assertion detail. Re-run with `RUNE_DIAGNOSE_FILES` to narrow to those files;
 * the output then fits and the errors are shown in full.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_ROOT } from '../src/config.js';
import { defaultRunGit } from '../src/jobs/sandbox-runtime.js';
import {
  materializeReviewedTree,
  runValidationCommandArgv,
  type ValidationCommandResult,
} from '../src/jobs/work-run-gate-runtime.js';
import {
  startValidationSandboxBroker,
  type ValidationSandboxBroker,
} from '../src/jobs/validation-sandbox-broker.js';
import { planValidationProfiles } from '../src/intent/validation-profiles.js';
import { parseValidationCommand } from '../src/jobs/task-validation.js';
import type { ValidationAdapter } from '../src/jobs/full-suite-attestation.js';
import type { ValidationCommandProfile } from '../src/intent/validation-profiles.js';

const SHARD_TIMEOUT_MS = 20 * 60_000;

interface RuneProductConfig {
  validationCommands?: string[];
  validationCommandProfiles?: ValidationCommandProfile[];
  validationAdapters?: ValidationAdapter[];
}

function runeValidationConfig(): Required<RuneProductConfig> {
  const raw = readFileSync(join(PROJECT_ROOT, 'policies', 'products.json'), 'utf8');
  const parsed = JSON.parse(raw) as Record<string, RuneProductConfig>;
  const rune = parsed['rune'];
  if (rune === undefined) throw new Error('policies/products.json has no `rune` product');
  return {
    validationCommands: rune.validationCommands ?? [],
    validationCommandProfiles: rune.validationCommandProfiles ?? [],
    validationAdapters: rune.validationAdapters ?? [],
  };
}

/** Same three steps `captureValidationTree` performs inside the gate runtime. */
async function captureTree(worktree: string): Promise<string> {
  await defaultRunGit(['add', '-A'], { cwd: worktree });
  const tree = (await defaultRunGit(['write-tree'], { cwd: worktree })).stdout.trim();
  const verified = (
    await defaultRunGit(['rev-parse', '--verify', `${tree}^{tree}`], { cwd: worktree })
  ).stdout.trim();
  if (verified !== tree) throw new Error('canonical tree could not be verified');
  return tree;
}

/** The child has no TTY-independent way to disable colour (its environment is
 *  built by the launcher), so strip escapes before matching anything. */
function plainText(result: ValidationCommandResult): string {
  // eslint-disable-next-line no-control-regex
  return `${result.outputHead ?? ''}\n${result.outputTail ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Vitest prints `Tests  N failed | …`; pull N back out of the captured tail. */
function reportedFailureCount(text: string): number | undefined {
  const matches = [...text.matchAll(/^\s*Tests\s+(\d+)\s+failed/gm)];
  const last = matches.at(-1);
  return last === undefined ? undefined : Number.parseInt(last[1]!, 10);
}

function failingTestNames(text: string): string[] {
  return [...new Set(
    [...text.matchAll(/^\s*FAIL\s+(.+?)\s*$/gm)].map((match) => match[1]!.trim()),
  )];
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error('the observer is Seatbelt/macOS-only; nothing to reproduce here');
    process.exit(1);
  }
  const only = process.env['RUNE_DIAGNOSE_PROFILE'];
  const config = runeValidationConfig();
  const plan = planValidationProfiles({
    commands: config.validationCommands,
    commandProfiles: config.validationCommandProfiles,
    adapters: config.validationAdapters,
    parseCommand: parseValidationCommand,
  });
  // Only Vitest shards are worth reproducing; `npm run build` has no manifest.
  const shards = plan.shards.filter((shard) =>
    shard.selector !== undefined && (only === undefined || shard.profile === only));
  if (shards.length === 0) {
    console.error(`no Vitest shards matched${only ? ` profile ${only}` : ''}`);
    process.exit(1);
  }

  const expectedTreeOid = await captureTree(PROJECT_ROOT);
  console.log(`reviewed tree ${expectedTreeOid.slice(0, 12)} · ${shards.length} shard(s)\n`);

  const reviewed = await materializeReviewedTree(
    { worktree: PROJECT_ROOT, expectedTreeOid, validationCwd: '.' },
    defaultRunGit,
  );
  let totalFailures = 0;
  try {
    for (const shard of shards) {
      console.log(`── ${shard.profile} · ${shard.selector} ──`);
      let broker: ValidationSandboxBroker | undefined;
      try {
        if (shard.profile === 'sandbox-integration') {
          broker = await startValidationSandboxBroker();
        }
        const result = await runValidationCommandArgv(
          // `--pool=forks` and a single reporter mirror what the observer forces
          // (`run-trusted-vitest-attestation.mjs` sets `pool:'forks'` and replaces
          // the reporter list). Without this the config's `hanging-process`
          // reporter loads here but not there, and the loopback shard wedges —
          // an artifact of the diagnostic, not a real observer failure.
          ['npx', 'vitest', 'run', `--tags-filter=${shard.selector}`,
            '--pool=forks', '--reporter=default',
            ...(process.env['RUNE_DIAGNOSE_FILES'] ?? '').split(/\s+/).filter(Boolean)],
          reviewed.cwd,
          SHARD_TIMEOUT_MS,
          undefined,
          {
            profile: shard.profile,
            cacheCwd: reviewed.cwd,
            // Exactly what `runTrustedVitestObserver` passes: the reviewed tree
            // is read-only, which is itself a cause of observer-only failures.
            deniedWriteRoots: [PROJECT_ROOT, reviewed.cwd],
            ...(broker === undefined ? {} : {
              sandboxBrokerSocket: broker.socketPath,
              sandboxBrokerCapability: broker.capability,
              sandboxBrokerAttestation: broker.attestationNonce,
            }),
          },
        );
        const text = plainText(result);
        const reported = reportedFailureCount(text);
        const names = failingTestNames(text);
        totalFailures += reported ?? names.length;
        if (result.failureClass !== undefined) {
          console.log(`   failureClass=${result.failureClass} (shard never ran)`);
        }
        console.log(`   exit=${result.exitCode} reported failures=${reported ?? 'unknown'}`);
        for (const name of names) console.log(`   FAIL ${name}`);
        // Names alone rarely explain a tree-only failure, so always show the
        // raw tail on a red shard. A whole-shard run truncates the assertion
        // detail; re-run with RUNE_DIAGNOSE_FILES to narrow until it fits.
        if (result.exitCode !== 0) {
          console.log('   ── raw tail ──');
          console.log(text.slice(-12_000));
        }
        console.log('');
      } finally {
        await broker?.stop().catch(() => {});
      }
    }
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(reviewed.dir, { recursive: true, force: true });
  }

  console.log(
    totalFailures === 0
      ? 'OK — no failures in the materialized reviewed tree.'
      : `${totalFailures} failure(s) in the materialized reviewed tree. ` +
        'Cross-check against `completed.failed` from npm run verify:closeout-confinement.',
  );
  process.exit(totalFailures === 0 ? 0 : 1);
}

await main();
