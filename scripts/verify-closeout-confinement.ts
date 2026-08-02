/**
 * Acceptance proof for the "nested Seatbelt reported as command-failure" bug
 * (`docs/projects/bugs.md`): run THIS repo's exact configured validation
 * commands through the real production closeout path — `runFullSuiteValidation`
 * wired with `productionFullSuiteProfileIO()` — and require every pass to be
 * green.
 *
 * The bug's acceptance criteria demand that the exact configured parallel
 * `npm test` passes REPEATEDLY under closeout confinement, "not only with a
 * manually substituted single-worker command". A sentence in a bug write-up
 * cannot discharge that; this script can, because it re-runs on demand.
 *
 * What it exercises that a plain `npm test` does not:
 *   - `npm test` is expanded by `strict-tags-v1` into the isolated → loopback →
 *     sandbox-integration shard sequence,
 *   - every shard is admitted by a real capability probe before dispatch,
 *   - the sandbox-integration shard runs under a Rune-owned broker, and its
 *     probe and execution share ONE broker owner,
 *   - each shard is launched inside a real Seatbelt profile.
 *
 * Usage:
 *   npm run verify:closeout-confinement            # 3 consecutive passes
 *   RUNE_CONFINEMENT_PASSES=1 npm run verify:closeout-confinement
 *
 * Exit 0 = every pass was green under production confinement.
 *
 * Requires macOS (Seatbelt) and a clean-enough worktree: the canonical tree is
 * captured with `git add -A` + `write-tree`, exactly as closeout does.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_ROOT } from '../src/config.js';
import { defaultRunGit } from '../src/jobs/sandbox-runtime.js';
import { runFullSuiteValidation } from '../src/jobs/work-run-gate-runtime.js';
import { sha256 } from '../src/jobs/full-suite-attestation.js';
import type { ValidationAdapter } from '../src/jobs/full-suite-attestation.js';
import type { ValidationCommandProfile } from '../src/intent/validation-profiles.js';

const PASSES = Number.parseInt(process.env['RUNE_CONFINEMENT_PASSES'] ?? '3', 10);
/** One pass runs the whole suite three times (one per shard) plus the observer. */
const PASS_TIMEOUT_MS = 45 * 60_000;

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
  const commands = rune.validationCommands ?? [];
  if (commands.length === 0) throw new Error('rune declares no validationCommands');
  return {
    validationCommands: commands,
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

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error('closeout confinement is Seatbelt/macOS-only; nothing to prove here');
    process.exit(1);
  }
  if (!Number.isInteger(PASSES) || PASSES < 1) {
    console.error(`RUNE_CONFINEMENT_PASSES must be a positive integer, got ${PASSES}`);
    process.exit(1);
  }

  const config = runeValidationConfig();
  console.log(`commands: ${config.validationCommands.join(' · ')}`);
  console.log(
    'adapters: ' +
      (config.validationAdapters
        .map((adapter) => `${adapter.command} [${adapter.profileSelection ?? 'single'}]`)
        .join(' · ') || 'none'),
  );
  console.log(`passes:   ${PASSES}\n`);

  for (let pass = 1; pass <= PASSES; pass += 1) {
    const startedAt = Date.now();
    const expectedTreeOid = await captureTree(PROJECT_ROOT);
    console.log(`── pass ${pass}/${PASSES} · tree ${expectedTreeOid.slice(0, 12)} ──`);

    // No `io` argument on purpose: that takes `defaultFullSuiteValidationIO()`,
    // the exact wiring closeout and the merge gate use in production — real
    // launcher, real trusted observer, real profile probe + broker. Injecting a
    // hand-built IO here would prove only that this script is wired correctly.
    const result = await runFullSuiteValidation({
      commands: config.validationCommands,
      commandProfiles: config.validationCommandProfiles,
      adapters: config.validationAdapters,
      worktree: PROJECT_ROOT,
      cwd: PROJECT_ROOT,
      validationCwd: '.',
      expectedTreeOid,
      fullTaskReviewHash: sha256(`closeout-confinement:${expectedTreeOid}`),
      timeoutMs: PASS_TIMEOUT_MS,
      // Closeout stops at the first red command; the merge gate runs them all.
      // Default to closeout fidelity, but allow the merge-gate shape so one red
      // shard cannot mask the state of the shards behind it while diagnosing.
      ...(process.env['RUNE_CONFINEMENT_CONTINUE'] === '1'
        ? { continueOnFailure: true }
        : {}),
    });

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const receipt = result.validationReceipt;
    for (const outcome of receipt.profileOutcomes ?? []) {
      console.log(
        `   ${outcome.profile.padEnd(20)} ${outcome.outcome.padEnd(20)} ` +
          `probe=${outcome.probe?.outcome ?? 'none'}` +
          (outcome.selector ? ` selector=${outcome.selector}` : ''),
      );
    }
    console.log(`   receipt=${receipt.outcome} ok=${result.ok} (${elapsed}s)\n`);

    if (!result.ok || receipt.outcome !== 'passed') {
      console.error(`FAILED on pass ${pass}: receipt ${receipt.outcome}`);
      for (const command of receipt.commands) {
        if (command.outcome !== 'passed') {
          console.error(
            `   ${command.command} → ${command.outcome} (coverage=${command.coverage})` +
              (command.discovered !== undefined
                ? ` discovered=${JSON.stringify(command.discovered)}`
                : '') +
              (command.completed !== undefined
                ? ` completed=${JSON.stringify(command.completed)}`
                : ''),
          );
        }
      }
      // Without the tail, a red pass is undiagnosable and the script is just a
      // slower `npm test`. `failed` already carries the first failing shard.
      if (!result.ok) {
        console.error(`\n--- ${result.command} ---`);
        console.error((result.result.outputHead ?? '').slice(0, 4_000));
        console.error('   …   ');
        console.error((result.result.outputTail ?? '').slice(-8_000));
      }
      process.exit(1);
    }
  }

  console.log(`OK — ${PASSES} consecutive green passes under production closeout confinement.`);
}

await main();
