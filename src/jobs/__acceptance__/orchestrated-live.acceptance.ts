#!/usr/bin/env tsx
/**
 * Project 14, Phase 8 — LIVE orchestrated-work acceptance harness.
 *
 * This is the stub-free proof the original Phase 8 closeout lacked: a single,
 * checked-in, self-verifying harness that drives the PRODUCTION
 * `orchestratedWorkApplier` end-to-end on a REAL task with LIVE model calls
 * (Opus 4.8 judgment roles + GPT-5.5 / Codex artifact roles), then verifies
 * real work landed — with ZERO human intervention. An agent `/work` run invokes
 * it and reads a pass/fail exit code; a human never merges or sets anything up.
 *
 * It runs against an EPHEMERAL git repo + an EPHEMERAL orchestrated-mode product
 * in an OS temp dir — no `policies/products.json` edit, no `.worktrees` of the
 * real repo touched. The temp product config is wired in via the
 * `PRODUCTS_CONFIG_FILE` / `WORKTREE_ROOT` env redirects (set BEFORE any
 * config-dependent import — hence the dynamic imports inside `main`). Teardown
 * removes the repo, its worktrees, and the temp product entry in a `finally`,
 * so a failed run leaves no residue.
 *
 * Stages (each fails loud, exits non-zero with diagnostics):
 *   1. Provider preflight   — `claude --model opus` completes AND
 *                             `probeCodexProvider` reports Codex available.
 *                             The regression guard for the 2026-06-10 silent
 *                             stall (resolved six roles, died at the first live
 *                             call with no diagnostic).
 *   2. Ephemeral fixture    — throwaway git repo seeded with one small real task
 *                             (an absent `sum` function + a spec + a missing
 *                             test) and a temp orchestrated-mode product.
 *   3. Drive the applier    — resolve dispatch (global OFF, per-product ON ⇒
 *                             orchestrated), run `orchestratedWorkApplier.apply()`
 *                             to its terminal event over the REAL path.
 *   4. Self-verify          — branch diff is non-empty and touches the target
 *                             file; the QA-authored test PASSES against the
 *                             coder's diff; the run reached branch-complete with
 *                             a well-formed handoff payload (orchestrated runs
 *                             never self-merge — spec req 17).
 *   5. Proof artifact       — write the event log + diffstat + asserted outcome
 *                             to docs/projects/14-product-team-agents/
 *                             live-acceptance-<run-id>.md.
 *
 * Usage:
 *   npm run acceptance:orchestrated
 *   (or: npx tsx --env-file-if-exists=.env.local \
 *          src/jobs/__acceptance__/orchestrated-live.acceptance.ts)
 *
 * Exit 0 = every assertion passed on the throwaway repo (then discarded).
 * Exit non-zero = a stage failed; the diagnostic names the resolved model id
 * and the executor/assertion error.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Fixture content — one small REAL task: implement an absent `sum` function.
// ---------------------------------------------------------------------------

const PRODUCT = 'accept-live';
const PROJECT_SLUG = 'live-accept-sum';
const TARGET_FILE = 'impl/sum.mjs';
const TEST_FILE = 'impl/sum.test.mjs';
// Tuple (`as const`) so TEST_COMMAND[0] narrows to 'node' under
// noUncheckedIndexedAccess; the call site spreads the tail.
const TEST_COMMAND = ['node', TEST_FILE] as const;

/** The seed implementation: present but unimplemented, so the seeded test is
 *  red until the coder fills it in. */
const SEED_IMPL = `// Arithmetic helper for the orchestrated live-acceptance fixture.
// TODO: implement sum so that sum(a, b) returns a + b.
export function sum(a, b) {
  throw new Error('sum is not implemented');
}
`;

const SPEC_MD = `# live-accept-sum — Spec

A deliberately tiny, real task that proves the orchestrated product-team loop
drives a real diff with live models.

## Goal

Implement the \`sum(a, b)\` function exported from \`${TARGET_FILE}\` so it returns
the arithmetic sum of its two numeric arguments. The function currently throws
\`'sum is not implemented'\`.

## Contract

- \`sum(2, 3)\` returns \`5\`.
- \`sum(-1, 1)\` returns \`0\`.
- The function takes exactly two numbers and returns their sum. No side effects.

## Test

A QA-authored test lives at \`${TEST_FILE}\`. It imports \`sum\` from
\`./sum.mjs\`, asserts the contract above, and calls \`process.exit(1)\` on any
failure / \`process.exit(0)\` on success, so \`${TEST_COMMAND.join(' ')}\` is a
self-contained pass/fail check with no test framework or dependencies.

## Assumptions

- Pure ES module (\`.mjs\`), Node-runnable with no install step.
`;

const TASKS_MD = `# live-accept-sum — Tasks

- [ ] Implement the \`sum(a, b)\` function in \`${TARGET_FILE}\` so it returns the arithmetic sum of its two numeric arguments, and ensure a QA test at \`${TEST_FILE}\` imports \`sum\` and verifies \`sum(2, 3) === 5\` and \`sum(-1, 1) === 0\`, exiting non-zero on failure (\`process.exit(1)\`) and zero on success (\`process.exit(0)\`).
`;

/** context.md must carry the five CONTEXT_SECTIONS or the closeout curator's
 *  section-preservation gate rejects the update. */
const CONTEXT_MD = `# Project Context

## Current State
\`${TARGET_FILE}\` exports a \`sum\` stub that throws \`'sum is not implemented'\`.
No test exists yet.

## Key Decisions
Pure ES module, no test framework — a hand-rolled assertion script keeps the
fixture dependency-free and fast.

## Interfaces & Contracts
\`sum(a: number, b: number): number\` returns \`a + b\`. \`${TEST_COMMAND.join(' ')}\`
exits 0 on pass, non-zero on fail.

## Known Risks
The implementation must not change the export name or signature; downstream test
imports \`{ sum }\` from \`./sum.mjs\`.

## Next Task Handoff
Implement \`sum\` and land the QA test green.
`;

// ---------------------------------------------------------------------------
// Small process helper — run a command, capture stdio, hard timeout.
// ---------------------------------------------------------------------------

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Minimal env for the harness's own git/node spawns — Jarvis secrets
 *  (TELEGRAM_BOT_TOKEN, VAULT_DIR, …) have no business in a fixture git
 *  commit or the dependency-free test runner. The live role spawns inside
 *  apply() get their scoped env from the production credential-injector, not
 *  this map. */
const MINIMAL_ENV: NodeJS.ProcessEnv = {
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
  ...(process.env['LANG'] ? { LANG: process.env['LANG'] } : {}),
};

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function log(stage: string, msg: string): void {
  // Standalone CLI harness (its own process, not the daemon) — raw terminal
  // output is the intended surface, not the structured logger.
  // eslint-disable-next-line no-console
  console.log(`[acceptance] ${stage}: ${msg}`);
}

class AcceptanceError extends Error {}

// ---------------------------------------------------------------------------
// Stage 1 — provider preflight (fail loud, never the silent stall)
// ---------------------------------------------------------------------------

async function preflight(): Promise<void> {
  log('preflight', 'probing claude --model opus + codex availability');

  // Claude side: a live one-shot must return a completion. We mirror the
  // execution-agent's spawn shape (skip-permissions, --model, -p) minus MCP.
  // Spawned directly (not via registerActiveProcess) because this is a
  // standalone process, not the daemon — a hung probe is bounded by the 90s
  // timeout, and there is no shared shutdown path that could orphan it. The
  // Claude CLI needs the inherited env to resolve its own auth, so this one
  // spawn keeps process.env (unlike the git/node spawns, which use MINIMAL_ENV).
  const { CLAUDE_BIN } = await import('../../ai/claude.js');
  const claudeRes = await run(
    CLAUDE_BIN,
    ['--dangerously-skip-permissions', '--model', 'opus', '-p', 'Reply with exactly: OK'],
    { timeoutMs: 90_000 },
  );
  if (claudeRes.code !== 0 || claudeRes.stdout.trim() === '') {
    throw new AcceptanceError(
      `claude --model opus unreachable (resolved model id: opus). ` +
        `exit=${claudeRes.code} timedOut=${claudeRes.timedOut} ` +
        `stderr=${claudeRes.stderr.trim().slice(-500) || '<empty>'}`,
    );
  }
  log('preflight', `claude opus OK (reply: ${claudeRes.stdout.trim().slice(0, 40)})`);

  // Codex side: the production probe (binary present AND logged in).
  const { probeCodexProvider } = await import('../../ai/codex.js');
  const codex = await probeCodexProvider();
  if (!codex.available) {
    throw new AcceptanceError(
      `codex exec -m gpt-5.5 unavailable (resolved model id: gpt-5.5). reason: ${codex.reason}`,
    );
  }
  log('preflight', 'codex available (binary present + logged in)');
}

// ---------------------------------------------------------------------------
// Stage 2 — ephemeral fixture repo + temp product
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  repoPath: string;
  worktreeRoot: string;
  productsConfigPath: string;
  verifyDir: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'p14-live-accept-'));
  const repoPath = join(root, 'demo-repo');
  const worktreeRoot = join(root, 'worktrees');
  const verifyDir = join(root, 'verify');
  const productsConfigPath = join(root, 'products.json');
  const credentialsPath = join(root, 'no-credentials.env');

  // Seed the repo files.
  mkdirSync(join(repoPath, 'impl'), { recursive: true });
  const projectDir = join(repoPath, 'docs', 'projects', PROJECT_SLUG);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(repoPath, TARGET_FILE), SEED_IMPL);
  writeFileSync(join(projectDir, 'spec.md'), SPEC_MD);
  writeFileSync(join(projectDir, 'tasks.md'), TASKS_MD);
  writeFileSync(join(projectDir, 'context.md'), CONTEXT_MD);
  writeFileSync(join(repoPath, '.gitignore'), 'node_modules/\n');
  writeFileSync(credentialsPath, '');

  // The temp products.json — an orchestrated-mode product pointed at the repo.
  // No credentials (empty file → readCredentials returns {}); no egress.
  writeFileSync(
    productsConfigPath,
    JSON.stringify(
      {
        [PRODUCT]: {
          _comment:
            'Ephemeral project-14 live-acceptance product. Lives only in this temp dir.',
          repoPath,
          baseBranch: 'main',
          orchestratedMode: true,
          credentialsFile: credentialsPath,
          egressAllowlist: [],
          validationCommands: [TEST_COMMAND.join(' ')],
        },
      },
      null,
      2,
    ),
  );

  // git init + initial commit on `main`. MINIMAL_ENV keeps Jarvis secrets out
  // of the fixture's git environment.
  const git = (args: string[]) =>
    run('git', args, { cwd: repoPath, timeoutMs: 30_000, env: MINIMAL_ENV });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'acceptance@jarvis.local']);
  await git(['config', 'user.name', 'Jarvis Acceptance']);
  await git(['add', '-A']);
  const commit = await git(['commit', '-q', '-m', 'seed: live-accept-sum fixture']);
  if (commit.code !== 0) {
    throw new AcceptanceError(`fixture git commit failed: ${commit.stderr.trim()}`);
  }

  log('fixture', `seeded throwaway repo at ${repoPath}`);
  return { root, repoPath, worktreeRoot, productsConfigPath, verifyDir };
}

// ---------------------------------------------------------------------------
// Stage 3 — drive the production applier end-to-end
// ---------------------------------------------------------------------------

interface DriveResult {
  events: Array<Record<string, unknown>>;
  terminal: Record<string, unknown> | null;
}

async function driveApplier(fixture: Fixture): Promise<DriveResult> {
  // Dispatch resolution: global default OFF, per-product opt-in ON ⇒ orchestrated.
  const { resolveWorkDispatch, readDispatchModeInput } = await import('../work-dispatch.js');
  const dispatch = resolveWorkDispatch(
    readDispatchModeInput({
      product: PRODUCT,
      productsConfigPath: fixture.productsConfigPath,
      globalEnabled: false,
    }),
  );
  if (dispatch.mode !== 'orchestrated' || dispatch.kind !== 'orchestrated-work') {
    throw new AcceptanceError(
      `dispatch did not resolve orchestrated for a per-product opt-in: ` +
        `${JSON.stringify(dispatch)}`,
    );
  }
  log('dispatch', `resolved mode=orchestrated kind=${dispatch.kind} (global OFF, product ON)`);

  const { orchestratedWorkApplier } = await import('../orchestrated-work-runner.js');
  const { NotificationBus } = await import('../../transport/notification-bus.js');
  type Descriptor = Parameters<typeof orchestratedWorkApplier.apply>[0];
  type Ctx = Parameters<typeof orchestratedWorkApplier.apply>[1];

  const payload = { projectSlug: PROJECT_SLUG, product: PRODUCT };
  // NOTE: we deliberately do NOT call `orchestratedWorkApplier.validate()`. That
  // guard resolves the project under the JARVIS PROJECT_ROOT (its `findProjectDir`
  // base), but this fixture's project lives only in the ephemeral temp repo — so
  // validate() would always reject it. validate() is the daemon's public-entry
  // guard (slug shape + in-repo project + concurrency caps); a standalone harness
  // driving the applier directly against a throwaway repo doesn't need it, and
  // apply()'s own failure paths surface any real misconfiguration as a terminal
  // `failed` event.
  const descriptor: Descriptor = {
    id: randomUUID(),
    kind: 'orchestrated-work',
    source: 'cli',
    target: { type: 'orchestrated-work', ref: PROJECT_SLUG },
    preview: { summary: `live acceptance: orchestrated-work on ${PROJECT_SLUG}` },
    payload,
    createdAt: new Date().toISOString(),
    status: 'running',
  };
  log('apply', `run id ${descriptor.id} — driving orchestratedWorkApplier.apply()`);

  const ctx: Ctx = { bus: new NotificationBus(), cancel: () => false };
  const events: Array<Record<string, unknown>> = [];
  let terminal: Record<string, unknown> | null = null;
  for await (const event of orchestratedWorkApplier.apply(descriptor, ctx)) {
    const e = event as unknown as Record<string, unknown>;
    events.push(e);
    log('event', JSON.stringify(e));
    if (e.kind === 'completed' || e.kind === 'failed') terminal = e;
  }
  return { events, terminal };
}

// ---------------------------------------------------------------------------
// Stage 4 — self-verify real work (replaces the operator merge)
// ---------------------------------------------------------------------------

interface VerifyResult {
  branch: string;
  diffstat: string;
  touchedTarget: boolean;
  testPassed: boolean;
}

async function verify(fixture: Fixture, drive: DriveResult): Promise<VerifyResult> {
  const { terminal } = drive;
  if (!terminal) {
    throw new AcceptanceError('applier ended without a terminal event');
  }

  // (d) terminal outcome — orchestrated runs never self-merge (spec req 17):
  // the well-formed success terminal is `completed` + `held:true` (branch-complete,
  // holding for the Project 15 finalizer) with a real branch + >=1 task recorded.
  // Reaching branch-complete is ONLY possible if every task's reviewer/objection
  // gate passed (the orchestrator renders any gate failure as `failed`), so this
  // is the transitive proof of assertion (c) "reviewer verdict is a structured pass".
  const data = (terminal.data ?? {}) as Record<string, unknown>;
  if (terminal.kind !== 'completed') {
    throw new AcceptanceError(
      `terminal was '${terminal.kind}', expected 'completed' (branch-complete/held). ` +
        `reason: ${String(data.reason ?? '<none>')}`,
    );
  }
  const branch = typeof data.branch === 'string' ? data.branch : '';
  const taskCount = typeof data.taskCount === 'number' ? data.taskCount : 0;
  const outcomeOk = data.held === true && branch !== '' && taskCount >= 1;
  if (!outcomeOk) {
    throw new AcceptanceError(
      `terminal completed but the handoff payload is not well-formed branch-complete: ` +
        `${JSON.stringify(data)}`,
    );
  }
  log('verify', `terminal: branch-complete held branch=${branch} tasks=${taskCount}`);

  const git = (args: string[]) =>
    run('git', args, { cwd: fixture.repoPath, timeoutMs: 30_000, env: MINIMAL_ENV });

  // (a) the branch diff is non-empty and touches the seeded target file.
  const diffNames = await git(['diff', '--name-only', `main..${branch}`]);
  if (diffNames.code !== 0) {
    throw new AcceptanceError(`git diff main..${branch} failed: ${diffNames.stderr.trim()}`);
  }
  const changed = diffNames.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (changed.length === 0) {
    throw new AcceptanceError(`branch ${branch} has an empty diff against main — no real work`);
  }
  const touchedTarget = changed.includes(TARGET_FILE);
  if (!touchedTarget) {
    throw new AcceptanceError(
      `branch diff does not touch the target ${TARGET_FILE}. changed: ${changed.join(', ')}`,
    );
  }
  const diffstat = (await git(['diff', '--stat', `main..${branch}`])).stdout.trim();
  log('verify', `branch diff touches ${TARGET_FILE}; ${changed.length} file(s) changed`);

  // (b) the QA-authored test PASSES against the coder's diff. Check the branch
  // out in a throwaway worktree and run the temp repo's test command there.
  const addWt = await git(['worktree', 'add', '--detach', fixture.verifyDir, branch]);
  if (addWt.code !== 0) {
    throw new AcceptanceError(`could not check out ${branch} for verification: ${addWt.stderr.trim()}`);
  }
  if (!existsSync(join(fixture.verifyDir, TEST_FILE))) {
    throw new AcceptanceError(
      `the QA test ${TEST_FILE} does not exist on ${branch} — no test was authored`,
    );
  }
  const test = await run(TEST_COMMAND[0], [...TEST_COMMAND.slice(1)], {
    cwd: fixture.verifyDir,
    timeoutMs: 30_000,
    env: MINIMAL_ENV,
  });
  const testPassed = test.code === 0;
  if (!testPassed) {
    throw new AcceptanceError(
      `QA test failed against the coder's diff: ${TEST_COMMAND.join(' ')} ` +
        `exit=${test.code} stdout=${test.stdout.trim().slice(-300)} ` +
        `stderr=${test.stderr.trim().slice(-300)}`,
    );
  }
  log('verify', `QA test PASSES against the coder's diff (${TEST_COMMAND.join(' ')})`);

  return { branch, diffstat, touchedTarget, testPassed };
}

// ---------------------------------------------------------------------------
// Stage 5 — durable proof artifact
// ---------------------------------------------------------------------------

async function emitProof(
  runId: string,
  drive: DriveResult,
  verifyResult: VerifyResult,
): Promise<string> {
  // Anchor on config's canonical PROJECT_ROOT rather than a fragile relative
  // walk from import.meta.url. config is already loaded by this point (apply()
  // ran), and PROJECT_ROOT is THIS checkout's root — where the proof persists.
  const { PROJECT_ROOT } = await import('../../config.js');
  const proofDir = join(PROJECT_ROOT, 'docs', 'projects', '14-product-team-agents');
  mkdirSync(proofDir, { recursive: true });
  const proofPath = join(proofDir, `live-acceptance-${runId}.md`);

  // Defense-in-depth: scrub host-absolute paths from everything that lands in
  // the committed artifact. The runner already scrubs `reason` fields, and the
  // fixture repo lives under an OS temp dir (no username on macOS), but the
  // diffstat/events go through the scrubber too so a future change can't leak.
  const { scrubAbsolutePaths } = await import('../../utils/sanitize-paths.js');

  const stamp = new Date().toISOString();
  const eventLines = drive.events.map((e) => `    ${JSON.stringify(e)}`).join('\n');
  const body = `# Project 14 — Live Orchestrated Acceptance Proof

**Run id:** \`${runId}\`
**Recorded:** ${stamp}
**Result:** PASS — a non-fixture orchestrated run drove a real task to a real diff.

This is the stub-free proof required by Phase 8 (spec.md §"Phase 8"): the
production \`orchestratedWorkApplier\` ran end-to-end against an ephemeral repo
with LIVE models (Opus 4.8 judgment roles, GPT-5.5/Codex artifact roles), and
the harness self-verified real work with zero human intervention.

## Asserted outcome

- **Terminal:** \`completed\` + \`held:true\` — branch-complete, holding for the
  Project 15 finalizer. Orchestrated runs never self-merge (spec req 17).
- **Branch:** \`${verifyResult.branch}\`
- **Diff touches target (\`${TARGET_FILE}\`):** ${verifyResult.touchedTarget ? 'yes' : 'NO'}
- **QA test passes against the coder's diff (\`${TEST_COMMAND.join(' ')}\`):** ${verifyResult.testPassed ? 'yes' : 'NO'}
- **Reviewer/objection gate:** passed (transitive — branch-complete is
  unreachable if any task's gate fails; a gate failure renders \`failed\`).

## Branch diffstat

\`\`\`
${verifyResult.diffstat || '<none>'}
\`\`\`

## Streamed mutation events

\`\`\`jsonl
${eventLines || '    <none>'}
\`\`\`

> The throwaway repo, its worktrees, and the temp product entry were created in
> an OS temp dir and removed on teardown — only this artifact persists in-repo.
`;
  writeFileSync(proofPath, scrubAbsolutePaths(body));
  return proofPath;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const runId = randomUUID().slice(0, 8);

  // Build the ephemeral fixture FIRST so we know the temp paths, then redirect
  // config at those paths BEFORE any config-dependent module is imported —
  // INCLUDING preflight, which imports ai/claude.js → config.js. config's
  // PRODUCTS_CONFIG_FILE / WORKTREE_ROOT are getters that read the env at access
  // time, so the redirect must already be in place when the first import lands.
  // Every config-reading import in this file is dynamic for exactly this reason.
  let fixture: Fixture | null = null;
  try {
    fixture = await makeFixture();
    process.env['PRODUCTS_CONFIG_FILE'] = fixture.productsConfigPath;
    process.env['WORKTREE_ROOT'] = fixture.worktreeRoot;
    // Keep the global default OFF — the per-product opt-in must do the routing.
    process.env['ORCHESTRATED_WORK_ENABLED'] = 'false';

    await preflight();

    const drive = await driveApplier(fixture);
    const verifyResult = await verify(fixture, drive);
    const proofPath = await emitProof(runId, drive, verifyResult);

    log('done', `PASS — proof written to ${proofPath}`);
    // eslint-disable-next-line no-console
    console.log(`\n✅ LIVE ACCEPTANCE PASSED (run ${runId})`);
  } finally {
    if (fixture) {
      // Release the verify worktree's git registration before the OS delete
      // (`remove --force` also handles the detached-HEAD checkout), then nuke
      // the whole temp root (repo + worktrees + temp product config). All
      // best-effort — the temp root is ephemeral, so a residual git record dies
      // with the repo regardless.
      try {
        await run('git', ['-C', fixture.repoPath, 'worktree', 'remove', '--force', fixture.verifyDir], {
          timeoutMs: 15_000,
          env: MINIMAL_ENV,
        });
      } catch {
        /* best-effort */
      }
      try {
        rmSync(fixture.root, { recursive: true, force: true });
        log('teardown', `removed temp root ${fixture.root}`);
      } catch (err) {
        log('teardown', `WARN could not remove ${fixture.root}: ${String(err)}`);
      }
    }
  }
}

main().catch((err) => {
  const msg = err instanceof AcceptanceError ? err.message : String(err?.stack ?? err);
  // eslint-disable-next-line no-console
  console.error(`\n❌ LIVE ACCEPTANCE FAILED: ${msg}`);
  process.exit(1);
});
