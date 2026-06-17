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
 *   4. Self-verify          — both providers streamed attributed activity;
 *                             supervision heartbeat advanced; a clean run merged
 *                             and pushed through the gated finalizer; a red gate
 *                             held branch-complete without mutating main.
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

const CLEAN_PRODUCT = 'accept-live-clean';
const GATE_FAIL_PRODUCT = 'accept-live-gate-fail';
const PROJECT_SLUG = 'live-accept-sum';
const TARGET_FILE = 'impl/sum.mjs';
const TEST_FILE = 'impl/sum.test.mjs';
// Tuple (`as const`) so TEST_COMMAND[0] narrows to 'node' under
// noUncheckedIndexedAccess; the call site spreads the tail.
const TEST_COMMAND = ['node', TEST_FILE] as const;
const MIN_STREAM_EVENTS_PER_PROVIDER = 1;
const APPLY_TERMINAL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

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
  remotePath: string;
  worktreeRoot: string;
  productsConfigPath: string;
  product: string;
  seedSha: string;
}

async function makeFixture(args: {
  label: string;
  product: string;
  validationCommands: string[];
}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), `p14-live-accept-${args.label}-`));
  const repoPath = join(root, 'demo-repo');
  const remotePath = join(root, 'origin.git');
  const worktreeRoot = join(root, 'worktrees');
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
        [args.product]: {
          _comment:
            'Ephemeral project-14 live-acceptance product. Lives only in this temp dir.',
          repoPath,
          baseBranch: 'main',
          orchestratedMode: true,
          credentialsFile: credentialsPath,
          egressAllowlist: [],
          validationCommands: args.validationCommands,
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
  const seedShaResult = await git(['rev-parse', 'HEAD']);
  if (seedShaResult.code !== 0) {
    throw new AcceptanceError(`fixture seed rev-parse failed: ${seedShaResult.stderr.trim()}`);
  }
  const seedSha = seedShaResult.stdout.trim();

  const initRemote = await run('git', ['init', '--bare', '-q', remotePath], {
    timeoutMs: 30_000,
    env: MINIMAL_ENV,
  });
  if (initRemote.code !== 0) {
    throw new AcceptanceError(`fixture bare remote init failed: ${initRemote.stderr.trim()}`);
  }
  const addRemote = await git(['remote', 'add', 'origin', remotePath]);
  if (addRemote.code !== 0) {
    throw new AcceptanceError(`fixture git remote add failed: ${addRemote.stderr.trim()}`);
  }
  const pushSeed = await git(['push', '-u', 'origin', 'main']);
  if (pushSeed.code !== 0) {
    throw new AcceptanceError(`fixture seed push failed: ${pushSeed.stderr.trim()}`);
  }

  log('fixture', `seeded throwaway repo at ${repoPath} with local bare remote ${remotePath}`);
  return {
    root,
    repoPath,
    remotePath,
    worktreeRoot,
    productsConfigPath,
    product: args.product,
    seedSha,
  };
}

// ---------------------------------------------------------------------------
// Stage 3 — drive the production applier end-to-end
// ---------------------------------------------------------------------------

interface DriveResult {
  events: Array<Record<string, unknown>>;
  terminal: Record<string, unknown> | null;
  runId: string;
  createdAt: string;
}

async function driveApplier(fixture: Fixture): Promise<DriveResult> {
  process.env['PRODUCTS_CONFIG_FILE'] = fixture.productsConfigPath;
  process.env['WORKTREE_ROOT'] = fixture.worktreeRoot;
  // Keep the global default OFF — the per-product opt-in must do the routing.
  process.env['ORCHESTRATED_WORK_ENABLED'] = 'false';

  // Dispatch resolution: global default OFF, per-product opt-in ON ⇒ orchestrated.
  const { resolveWorkDispatch, readDispatchModeInput } = await import('../work-dispatch.js');
  const dispatch = resolveWorkDispatch(
    readDispatchModeInput({
      product: fixture.product,
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
  const { createMutation, registerApplier, setMutationBus } = await import('../../transport/mutations.js');
  type Descriptor = Parameters<typeof orchestratedWorkApplier.apply>[0];

  const payload = { projectSlug: PROJECT_SLUG, product: fixture.product };
  log('apply', `creating orchestrated-work mutation for ${fixture.product}`);

  setMutationBus(new NotificationBus());
  const events: Array<Record<string, unknown>> = [];
  let terminal: Record<string, unknown> | null = null;
  let resolveTerminal: (() => void) | undefined;
  const terminalSeen = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AcceptanceError(`timed out waiting for terminal event for ${fixture.product}`));
    }, APPLY_TERMINAL_TIMEOUT_MS);
    timer.unref();
    resolveTerminal = () => {
      clearTimeout(timer);
      resolve();
    };
  });

  // The daemon's public validate() resolves projects under this Jarvis
  // checkout's PROJECT_ROOT. This harness intentionally points production
  // apply() at a throwaway product repo in /tmp, so validation is bypassed here
  // only; createMutation/startApply still own supervision, active-runs, and
  // terminal persistence for the run.
  registerApplier({
    ...orchestratedWorkApplier,
    validate: () => ({ ok: true as const }),
    async *apply(descriptor: Descriptor, ctx) {
      for await (const event of orchestratedWorkApplier.apply(descriptor, ctx)) {
        const e = event as unknown as Record<string, unknown>;
        events.push(e);
        log('event', JSON.stringify(e));
        if (e.kind === 'completed' || e.kind === 'failed') {
          terminal = e;
          resolveTerminal?.();
        }
        yield event;
      }
    },
  });

  const created = await createMutation('orchestrated-work', payload, 'cli');
  if (!created.ok) {
    throw new AcceptanceError(`createMutation failed: ${created.reason}`);
  }
  log('apply', `run id ${created.descriptor.id} — mutation pipeline started`);

  await terminalSeen;
  return {
    events,
    terminal,
    runId: created.descriptor.id,
    createdAt: created.descriptor.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Stage 4 — self-verify real work (replaces the operator merge)
// ---------------------------------------------------------------------------

interface VerifyResult {
  branch: string;
  diffstat: string;
  touchedTarget: boolean;
  testPassed: boolean;
  merged: boolean;
  branchDeleted: boolean;
  remotePushed: boolean;
}

interface GateHoldVerifyResult {
  branch: string;
  touchedTarget: boolean;
  baseUnchanged: boolean;
  gateHeldReason: string;
}

function streamEvents(drive: DriveResult): Array<Record<string, unknown>> {
  return drive.events.filter((event) => event.kind === 'activity' || event.kind === 'output');
}

function dataOf(event: Record<string, unknown>): Record<string, unknown> {
  const data = event.data;
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

function assertStreamObservability(drive: DriveResult, label: string): void {
  const events = streamEvents(drive);
  const attributed = events.filter((event) => {
    const data = dataOf(event);
    return (
      typeof data['role'] === 'string' &&
      typeof data['provider'] === 'string' &&
      typeof data['model'] === 'string'
    );
  });
  const counts = new Map<string, number>();
  for (const event of attributed) {
    const provider = String(dataOf(event)['provider']);
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }

  for (const provider of ['openai', 'anthropic']) {
    const count = counts.get(provider) ?? 0;
    if (count < MIN_STREAM_EVENTS_PER_PROVIDER) {
      throw new AcceptanceError(
        `${label}: expected at least ${MIN_STREAM_EVENTS_PER_PROVIDER} intermediate ` +
          `activity/output event(s) from provider '${provider}', got ${count}. ` +
          `streamed=${events.length} attributed=${attributed.length}`,
      );
    }
  }
  log(
    'verify',
    `${label}: streamed attributed events openai=${counts.get('openai') ?? 0} ` +
      `anthropic=${counts.get('anthropic') ?? 0}`,
  );
}

async function assertSupervisionHeartbeatAdvanced(drive: DriveResult, label: string): Promise<void> {
  const configModule = await import('../../config.js');
  const { readAllRuns } = await import('../supervision-store.js');
  const runs = readAllRuns(configModule.default.SUPERVISED_RUNS_FILE);
  const run = runs.find((entry) => entry.id === drive.runId);
  if (!run) {
    throw new AcceptanceError(
      `${label}: no supervised run record for ${drive.runId}; live acceptance must drive ` +
        `the orchestrated run through the mutation/supervision path, not only direct apply()`,
    );
  }
  if (run.lastOutputAt === undefined) {
    throw new AcceptanceError(
      `${label}: supervised run ${drive.runId} never recorded lastOutputAt from ` +
        'activity/output events',
    );
  }
  const createdAt = Date.parse(drive.createdAt);
  const lastHeartbeatAt = Date.parse(run.lastHeartbeatAt);
  const lastOutputAt = Date.parse(run.lastOutputAt);
  if (!Number.isFinite(lastHeartbeatAt) || lastHeartbeatAt <= createdAt) {
    throw new AcceptanceError(
      `${label}: lastHeartbeatAt did not advance during execution ` +
        `(createdAt=${drive.createdAt}, lastHeartbeatAt=${run.lastHeartbeatAt})`,
    );
  }
  if (!Number.isFinite(lastOutputAt) || lastOutputAt <= createdAt) {
    throw new AcceptanceError(
      `${label}: lastOutputAt did not advance during execution ` +
        `(createdAt=${drive.createdAt}, lastOutputAt=${run.lastOutputAt})`,
    );
  }
  log('verify', `${label}: supervision heartbeat advanced to ${run.lastHeartbeatAt}`);
}

async function verifyCleanMerged(fixture: Fixture, drive: DriveResult): Promise<VerifyResult> {
  const { terminal } = drive;
  if (!terminal) {
    throw new AcceptanceError('applier ended without a terminal event');
  }

  assertStreamObservability(drive, 'clean run');
  await assertSupervisionHeartbeatAdvanced(drive, 'clean run');

  // A clean run now lands through the Project 15 gated finalizer: completed
  // branch-complete, merged to the base branch, pushed to the local bare remote,
  // and the work branch deleted after the worktree is removed.
  const data = (terminal.data ?? {}) as Record<string, unknown>;
  if (terminal.kind !== 'completed') {
    throw new AcceptanceError(
      `terminal was '${terminal.kind}', expected 'completed' (branch-complete/merged). ` +
        `reason: ${String(data.reason ?? '<none>')}`,
    );
  }
  const branch = typeof data.branch === 'string' ? data.branch : '';
  const taskCount = typeof data.taskCount === 'number' ? data.taskCount : 0;
  const outcomeOk =
    data.outcome === 'branch-complete' &&
    data.merged === true &&
    data.branchDeleted === true &&
    branch !== '' &&
    taskCount >= 1;
  if (!outcomeOk) {
    throw new AcceptanceError(
      `terminal completed but the payload is not a well-formed merged branch-complete run: ` +
        `${JSON.stringify(data)}`,
    );
  }
  log('verify', `terminal: branch-complete merged branch=${branch} tasks=${taskCount}`);

  const git = (args: string[]) =>
    run('git', args, { cwd: fixture.repoPath, timeoutMs: 30_000, env: MINIMAL_ENV });

  const localMain = await git(['rev-parse', 'main']);
  if (localMain.code !== 0) {
    throw new AcceptanceError(`git rev-parse main failed: ${localMain.stderr.trim()}`);
  }
  const mainSha = localMain.stdout.trim();
  if (mainSha === fixture.seedSha) {
    throw new AcceptanceError(`clean run did not advance local main beyond seed ${fixture.seedSha}`);
  }

  const remoteMain = await run('git', ['--git-dir', fixture.remotePath, 'rev-parse', 'main'], {
    timeoutMs: 30_000,
    env: MINIMAL_ENV,
  });
  if (remoteMain.code !== 0) {
    throw new AcceptanceError(`git rev-parse remote main failed: ${remoteMain.stderr.trim()}`);
  }
  const remotePushed = remoteMain.stdout.trim() === mainSha;
  if (!remotePushed) {
    throw new AcceptanceError(
      `clean run merged locally but did not push main to origin ` +
        `(local=${mainSha}, remote=${remoteMain.stdout.trim()})`,
    );
  }

  const deletedBranch = await git(['rev-parse', '--verify', branch]);
  if (deletedBranch.code === 0) {
    throw new AcceptanceError(`clean run reported branchDeleted=true but ${branch} still exists`);
  }

  // (a) the merged base diff is non-empty and touches the seeded target file.
  const diffNames = await git(['diff', '--name-only', `${fixture.seedSha}..main`]);
  if (diffNames.code !== 0) {
    throw new AcceptanceError(`git diff ${fixture.seedSha}..main failed: ${diffNames.stderr.trim()}`);
  }
  const changed = diffNames.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (changed.length === 0) {
    throw new AcceptanceError('clean run has an empty merged diff against the seed — no real work');
  }
  const touchedTarget = changed.includes(TARGET_FILE);
  if (!touchedTarget) {
    throw new AcceptanceError(
      `merged diff does not touch the target ${TARGET_FILE}. changed: ${changed.join(', ')}`,
    );
  }
  const diffstat = (await git(['diff', '--stat', `${fixture.seedSha}..main`])).stdout.trim();
  log('verify', `branch diff touches ${TARGET_FILE}; ${changed.length} file(s) changed`);

  // (b) the QA-authored test PASSES against the merged base.
  if (!existsSync(join(fixture.repoPath, TEST_FILE))) {
    throw new AcceptanceError(
      `the QA test ${TEST_FILE} does not exist on merged main — no test was authored`,
    );
  }
  const test = await run(TEST_COMMAND[0], [...TEST_COMMAND.slice(1)], {
    cwd: fixture.repoPath,
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

  return {
    branch,
    diffstat,
    touchedTarget,
    testPassed,
    merged: true,
    branchDeleted: true,
    remotePushed,
  };
}

async function verifyGateHold(fixture: Fixture, drive: DriveResult): Promise<GateHoldVerifyResult> {
  const { terminal } = drive;
  if (!terminal) {
    throw new AcceptanceError('gate-fail applier ended without a terminal event');
  }

  assertStreamObservability(drive, 'gate-fail run');

  const data = (terminal.data ?? {}) as Record<string, unknown>;
  if (terminal.kind !== 'completed') {
    throw new AcceptanceError(
      `gate-fail terminal was '${terminal.kind}', expected completed branch-complete hold. ` +
        `reason: ${String(data.reason ?? '<none>')}`,
    );
  }
  const branch = typeof data.branch === 'string' ? data.branch : '';
  const gateHeldReason = typeof data.gateHeldReason === 'string' ? data.gateHeldReason : '';
  const holdOk =
    data.outcome === 'branch-complete' &&
    data.merged === false &&
    data.branchDeleted === false &&
    branch !== '' &&
    gateHeldReason !== '';
  if (!holdOk) {
    throw new AcceptanceError(
      `gate-fail run did not record a branch-complete hold with merge suppressed: ` +
        `${JSON.stringify(data)}`,
    );
  }

  const git = (args: string[]) =>
    run('git', args, { cwd: fixture.repoPath, timeoutMs: 30_000, env: MINIMAL_ENV });
  const localMain = await git(['rev-parse', 'main']);
  if (localMain.code !== 0) {
    throw new AcceptanceError(`gate-fail git rev-parse main failed: ${localMain.stderr.trim()}`);
  }
  const baseUnchanged = localMain.stdout.trim() === fixture.seedSha;
  if (!baseUnchanged) {
    throw new AcceptanceError(
      `gate-fail run mutated main despite a failed gate ` +
        `(seed=${fixture.seedSha}, main=${localMain.stdout.trim()})`,
    );
  }
  const branchExists = await git(['rev-parse', '--verify', branch]);
  if (branchExists.code !== 0) {
    throw new AcceptanceError(`gate-fail run did not retain held branch ${branch}`);
  }
  const diffNames = await git(['diff', '--name-only', `${fixture.seedSha}..${branch}`]);
  if (diffNames.code !== 0) {
    throw new AcceptanceError(`gate-fail git diff ${fixture.seedSha}..${branch} failed: ${diffNames.stderr.trim()}`);
  }
  const changed = diffNames.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const touchedTarget = changed.includes(TARGET_FILE);
  if (!touchedTarget) {
    throw new AcceptanceError(
      `gate-fail held branch does not contain the expected target diff. changed: ${changed.join(', ')}`,
    );
  }
  log('verify', `gate-fail run held branch=${branch} reason=${gateHeldReason}`);
  return { branch, touchedTarget, baseUnchanged, gateHeldReason };
}

// ---------------------------------------------------------------------------
// Stage 5 — durable proof artifact
// ---------------------------------------------------------------------------

async function emitProof(
  runId: string,
  drive: DriveResult,
  verifyResult: VerifyResult,
  gateHold: GateHoldVerifyResult,
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
**Result:** PASS — a live, non-stub orchestrated run drove a real task to a real diff.

This is the stub-free proof required by Phase 8 (spec.md §"Phase 8"): the
production \`orchestratedWorkApplier\` ran end-to-end against an ephemeral repo
with LIVE models (Opus 4.8 judgment roles, GPT-5.5/Codex artifact roles), and
the harness self-verified real work with zero human intervention.

## Asserted outcome

- **Terminal:** \`completed\` + \`outcome:"branch-complete"\` with
  \`merged:true\` + \`branchDeleted:true\` for the clean run.
- **Branch:** \`${verifyResult.branch}\`
- **Merged to local \`main\` and pushed to local bare \`origin\`:** ${verifyResult.merged && verifyResult.remotePushed ? 'yes' : 'NO'}
- **Work branch deleted after push:** ${verifyResult.branchDeleted ? 'yes' : 'NO'}
- **Diff touches target (\`${TARGET_FILE}\`):** ${verifyResult.touchedTarget ? 'yes' : 'NO'}
- **QA test passes against the coder's diff (\`${TEST_COMMAND.join(' ')}\`):** ${verifyResult.testPassed ? 'yes' : 'NO'}
- **Stream parity:** provider-attributed activity/output from both OpenAI and
  Anthropic was observed before terminal.
- **Heartbeat:** supervision \`lastHeartbeatAt\`/\`lastOutputAt\` advanced during
  the clean run.
- **Gate-fail hold:** branch \`${gateHold.branch}\` was retained, \`main\` stayed
  unchanged (${gateHold.baseUnchanged ? 'yes' : 'NO'}), the held diff touched
  \`${TARGET_FILE}\` (${gateHold.touchedTarget ? 'yes' : 'NO'}), and the terminal
  recorded gate hold reason \`${gateHold.gateHeldReason}\`.
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
  const fixtures: Fixture[] = [];
  try {
    const cleanFixture = await makeFixture({
      label: 'clean',
      product: CLEAN_PRODUCT,
      validationCommands: [TEST_COMMAND.join(' ')],
    });
    fixtures.push(cleanFixture);
    process.env['PRODUCTS_CONFIG_FILE'] = cleanFixture.productsConfigPath;
    process.env['WORKTREE_ROOT'] = cleanFixture.worktreeRoot;
    process.env['ORCHESTRATED_WORK_ENABLED'] = 'false';

    await preflight();

    const cleanDrive = await driveApplier(cleanFixture);
    const verifyResult = await verifyCleanMerged(cleanFixture, cleanDrive);

    const gateFailFixture = await makeFixture({
      label: 'gate-fail',
      product: GATE_FAIL_PRODUCT,
      validationCommands: ['node -e process.exit(1)'],
    });
    fixtures.push(gateFailFixture);
    const gateFailDrive = await driveApplier(gateFailFixture);
    const gateHold = await verifyGateHold(gateFailFixture, gateFailDrive);
    const proofPath = await emitProof(runId, cleanDrive, verifyResult, gateHold);

    log('done', `PASS — proof written to ${proofPath}`);
    // eslint-disable-next-line no-console
    console.log(`\n✅ LIVE ACCEPTANCE PASSED (run ${runId})`);
  } finally {
    for (const fixture of fixtures) {
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
