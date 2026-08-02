/**
 * The hard merge gate's RUNTIME (project 15, P1.5) — the fact-gathering half of
 * the gate that `evaluateGate` (work-run-gate.ts) decides on.
 *
 * The pure decision lives in `evaluateGate`; gathering the facts it needs is
 * effectful and is this module's job:
 *
 *   - set up a THROWAWAY integration worktree checked out on the base branch
 *     (never the product's real `baseBranch` checkout / local `main`),
 *   - dry-run-merge the feature branch into it to probe for a conflict,
 *   - run the product's `validationCommands` in that integration worktree
 *     (each bounded by `WORK_RUN_GATE_COMMAND_TIMEOUT_MS`),
 *   - fold in the pre-gathered structural facts (tasksRemaining, concurrent-run
 *     lock state),
 *   - tear the integration worktree down,
 *   - and hand the assembled `GateFacts` to `evaluateGate`.
 *
 * THE CORE INVARIANT (spec req 13, test-plan §6 "test before mutating main"):
 * everything the gate touches happens in the integration worktree, so a RED gate
 * result leaves the product repo's `baseBranch` ref AND working tree
 * byte-for-byte unchanged. The actual `git merge` that lands the work onto the
 * base branch happens in `work-run-finalizer.ts` ONLY AFTER this gate returns
 * `{ ok: true }`.
 *
 * Fail-closed: a product with no `validationCommands` never reaches the
 * integration-worktree validation run — `evaluateGate` returns
 * `missing-validation-command` (req 16).
 *
 * `work-run-gate-runtime.test.ts` pins the integration-worktree and
 * base-branch invariants with real Git fixtures.
 */

import { execFile, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { defaultRunGit, removeVitestCache, vitestCacheDirFor, type GitRunner } from './sandbox-runtime.js';
// Import `GateResult` from the gate module (its canonical home), NOT the
// finalizer — the finalizer imports `runGate` from here once P1.5 lands, so
// pulling the type from the finalizer would form an import cycle.
import { evaluateGate, type GateFacts, type GateResult } from './work-run-gate.js';
import { registerActiveProcess, unregisterActiveProcess } from '../ai/claude.js';
import { createLogger } from '../utils/logger.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { redactSecrets } from './work-run-transcript.js';
import { DEFAULT_BASE_ENV_KEYS, getBaseEnv } from './credential-injector.js';
import config, { PROJECT_ROOT } from '../config.js';
import { resolveValidationCwd } from './task-validation.js';
import {
  verifyConfinementCapability,
  VALIDATION_COMPATIBLE_MODE_ENV,
  VALIDATION_COMPATIBLE_MODE_VALUE,
  VALIDATION_CONFINEMENT_ATTESTATION_ENV,
  VALIDATION_PROCESS_NONCE_ENV,
  VALIDATION_SANDBOX_BROKER_SOCKET_ENV,
  type ConfinementCapability,
} from '../utils/validation-confinement.js';
import {
  relatedTestInvocationSelectionFits,
  type RelatedTestStructuredError,
} from '../intent/related-test-diagnostic.js';
import { parseVitestRelatedReport } from './vitest-related-report.js';
import {
  buildGateValidationReceipt,
  captureTrustedVitestImplementation,
  captureValidationFingerprints,
  compactValidationReceipt,
  createVitestAttestationCapability,
  parseVitestManifest,
  readAuthenticatedVitestManifest,
  sanitizeValidationCommandIdentifier,
  sha256,
  validateFullSuiteAttestation,
  vitestLifecycleIsGreen,
  vitestLifecycleReconciles,
  type CompactValidationReceipt,
  type FullSuiteAttestation,
  type FullSuiteValidationResult,
  type GateValidationReceipt,
  type ValidationFingerprints,
  type ValidationBatchReceipt,
  type ValidationCoverageStatus,
  type ValidationAdapter,
  type VitestLifecycleManifest,
  type TrustedVitestImplementation,
  type ValidationProfileProbeEvidence,
} from './full-suite-attestation.js';
import { parseValidationCommand } from './task-validation.js';
import {
  requestValidationSandboxProbe,
  startValidationSandboxBroker,
  verifyInheritedValidationConfinement,
  type ValidationSandboxBroker,
} from './validation-sandbox-broker.js';
import {
  VALIDATION_PROFILES,
  planValidationProfiles,
  validationSelectorFor,
  type ValidationCommandProfile,
  type ValidationProfile,
  type ValidationProfilePlan,
} from '../intent/validation-profiles.js';
export type { FullSuiteValidationResult } from './full-suite-attestation.js';

const log = createLogger('work-run-gate-runtime');
const execFileAsync = promisify(execFile);

/**
 * Everything the gate runtime needs to gather facts. Structural facts that are
 * computed elsewhere (the work-product task tally, the per-product/per-base
 * concurrency lock) are passed in so this runtime owns only the
 * integration-worktree validation + conflict probe.
 */
export interface GateRuntimeOpts {
  product: string;
  /** The product repo whose `baseBranch` must stay byte-for-byte unchanged. */
  repoPath: string;
  /** The base branch the run would land on (e.g. `main`). */
  baseBranch: string;
  /** The feature/work branch (e.g. `rune-work/15-…`). */
  branch: string;
  /** Path for the throwaway integration worktree — created here, torn down here,
   *  never the product's real base-branch checkout. */
  integrationWorktree: string;
  /** Product `validationCommands` from policies/products.json. Empty/absent →
   *  fail-closed `missing-validation-command`. */
  validationCommands: string[];
  validationCommandProfiles?: ValidationCommandProfile[];
  /** Exact command-to-runner mappings used for structured suite coverage. */
  validationAdapters?: ValidationAdapter[];
  /** Optional repository-relative command directory, revalidated inside the
   * throwaway integration worktree before the hard gate executes commands. */
  validationCwd?: string;
  /** Original tasks still unchecked (computed from the work product). */
  tasksRemaining: number;
  /** Another run owns the same product / base branch right now (lock state). */
  concurrentRun: boolean;
  /** Per-command budget (WORK_RUN_GATE_COMMAND_TIMEOUT_MS). */
  commandTimeoutMs: number;
  /** Durable per-run directory for timeout output and sanitized Node reports. */
  validationArtifactsDir?: string;
  /** Live run cancellation; a cancelled gate must never proceed to merge. */
  cancelled?: () => boolean;
}

/** Result of one validation command run in the integration worktree. */
/**
 * Rolling cap on the captured stdout+stderr tail of a validation command.
 * Keep-the-end semantics: the failing assertion is at the end of a test run's
 * output, and a chatty suite must not bloat logs/ artifacts (same magnitude as
 * TREE_STATE_DIFF_MAX_CHARS in orchestrated-work-runner.ts).
 */
export const MAX_VALIDATION_OUTPUT_TAIL_CHARS = 20_000;
/** Keep-the-start companion to the rolling tail for startup failures. */
export const MAX_VALIDATION_OUTPUT_HEAD_CHARS = 20_000;

/** Give Node time to flush its diagnostic report before normal process reaping. */
const VALIDATION_DIAGNOSTIC_REPORT_GRACE_MS = 1_000;

/**
 * After the child's `exit`, wait at most this long for `close` (stream flush)
 * before finishing with whatever tail was captured. Without this, a grandchild
 * inheriting the piped fds (e.g. a test-spawned daemon) would hold `close`
 * hostage until the full command timeout and flip a passing run to a false
 * `timedOut` — the same wedge work-runner.ts guards with REAP_FORCE_DONE_MS.
 */
const VALIDATION_STDIO_DRAIN_MS = 10_000;

/**
 * Private descriptor on which the `sandbox-exec` preamble reports that Seatbelt
 * applied. It exists to keep the `profile-unavailable` classification out of
 * reach of product-controlled stdout/stderr: the marker is written before the
 * product command is `exec`ed, so product code can only ever add the marker
 * (weakening the verdict to `command-failed`), never remove it.
 */
const PROFILE_APPLIED_FD = 3;

function validationNetworkRules(profile: ValidationProfile): string[] {
  const base = ['(deny network-outbound)', '(deny network-inbound)'];
  if (profile !== 'loopback') return base;
  return [
    ...base,
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
  ];
}

function seatbeltString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function validationSandboxProfile(
  profile: ValidationProfile,
  deniedWriteRoots: readonly string[] = [],
  allowedWriteRoots: readonly string[] = [],
  sandboxBrokerSocket?: string,
): string {
  const roots = new Set<string>();
  for (const root of deniedWriteRoots) {
    try {
      roots.add(resolve(root));
      roots.add(realpathSync(root));
    } catch {
      roots.add(resolve(root));
    }
  }
  const allowedRoots = new Set<string>();
  for (const root of allowedWriteRoots) {
    try {
      allowedRoots.add(resolve(root));
      allowedRoots.add(realpathSync(root));
    } catch {
      allowedRoots.add(resolve(root));
    }
  }
  return [
    '(version 1)',
    '(allow default)',
    ...validationNetworkRules(profile),
    ...(profile === 'sandbox-integration' && sandboxBrokerSocket !== undefined
      ? [`(allow network-outbound (remote unix-socket (path "${seatbeltString(sandboxBrokerSocket)}")))`]
      : []),
    ...[...roots].flatMap((root) => [
      `(deny file-write* (literal "${seatbeltString(root)}"))`,
      `(deny file-write* (subpath "${seatbeltString(root)}"))`,
    ]),
    ...[...allowedRoots].flatMap((root) => [
      `(allow file-write* (literal "${seatbeltString(root)}"))`,
      `(allow file-write* (subpath "${seatbeltString(root)}"))`,
    ]),
  ].join('');
}

function buildValidationEnv(
  cwd: string,
  reportOptions = '',
  initialDepth = '1',
  sandboxBrokerSocket?: string,
  sandboxBrokerAttestation?: string,
): NodeJS.ProcessEnv {
  // Shell basics + launchd-safe PATH via the same allowlist filter the
  // sandboxed-agent env uses — one key list, no drift between the two.
  const env: NodeJS.ProcessEnv = { ...getBaseEnv(DEFAULT_BASE_ENV_KEYS) };
  if (reportOptions) {
    env.NODE_OPTIONS = reportOptions;
    env.RUNE_VALIDATION_REPORT_NODE_OPTIONS = reportOptions;
    env.RUNE_VALIDATION_ORIGINAL_NODE_OPTIONS = '';
    env.RUNE_VALIDATION_REPORT_DEPTH = initialDepth;
  }
  env.RUNE_VITEST_CACHE_DIR = vitestCacheDirFor(cwd);
  if (sandboxBrokerSocket !== undefined) {
    env[VALIDATION_SANDBOX_BROKER_SOCKET_ENV] = sandboxBrokerSocket;
  }
  if (sandboxBrokerAttestation !== undefined) {
    env[VALIDATION_CONFINEMENT_ATTESTATION_ENV] = sandboxBrokerAttestation;
  }
  return env;
}

export interface ValidationCommandResult {
  /** Process exit code, or null if it was killed (e.g. on timeout). */
  exitCode: number | null;
  /** The command exceeded `commandTimeoutMs` and its process tree was reaped. */
  timedOut: boolean;
  /** Merged stdout+stderr rolling tail (arrival order), capped at
   *  MAX_VALIDATION_OUTPUT_TAIL_CHARS. Empty string when no output. */
  outputTail: string;
  /** Merged stdout+stderr beginning, capped at MAX_VALIDATION_OUTPUT_HEAD_CHARS. */
  outputHead?: string;
  /** Basenames of durable timeout artifacts written under the requested dir. */
  diagnosticArtifacts?: string[];
  /** Errors admitted from Vitest's JSON reporter. Never inferred from console
   * output; absent when the structured report was unavailable or malformed. */
  structuredErrors?: RelatedTestStructuredError[];
  /** Total report errors before the retained-entry cap. */
  structuredErrorsTotal?: number;
  /** True only when no report entry or field was truncated. */
  structuredErrorsComplete?: boolean;
  /** Bounded lifecycle manifest emitted by Rune's trusted Vitest reporter. */
  vitestManifest?: VitestLifecycleManifest;
  /** Trusted launcher cancellation state; false/absent for ordinary exits. */
  cancelled?: boolean;
  /** Admission/probe failure that must be routed as an operational hold. */
  failureClass?: 'profile-unavailable';
  profile?: ValidationProfile;
}

export interface ValidationCommandArgvOptions {
  /** Deterministic capability profile selected before launch. */
  profile?: ValidationProfile;
  /** Only sandbox-integration may receive the Rune-owned fixed broker socket. */
  sandboxBrokerSocket?: string;
  /** In-memory capability proving the caller started that exact broker. */
  sandboxBrokerCapability?: ConfinementCapability;
  /** Broker-issued nonce handed to the child so it can prove its enclosure. */
  sandboxBrokerAttestation?: string;
  /** The command remains inside the launcher's outer Seatbelt and passes the
   * private marker to Rune-owned nested helpers. */
  compatibleFallback?: boolean;
  /** Execution-only private reporter injection. Neither path is persisted. */
  vitestAttestation?: {
    outputPath: string;
    capability: string;
    /** Captured before product execution and delivered over an anonymous pipe. */
    trustedImplementation?: TrustedVitestImplementation;
    profileSelector?: string;
  };
  /** Rune-owned source delivered through stdin instead of a mutable pathname. */
  trustedStdinSource?: string;
  /** Identity used only to isolate the Rune-owned observer's Vitest cache. */
  cacheCwd?: string;
  /** Trusted roots that product-controlled validation must never mutate. */
  deniedWriteRoots?: readonly string[];
  /** Product worktrees carved out of a broader denied trust root. */
  allowedWriteRoots?: readonly string[];
  /** Live cancellation observation used to reap the whole validation group. */
  cancelled?: () => boolean;
}

/**
 * Injected side-effects so the runtime is testable without the real `git` CLI
 * or arbitrary shell commands. Production wires `defaultRunGit` + a real
 * timeout-bounded, process-group-reaping command runner. A full optional
 * interface (mirroring `FinalizerEffects` / `SweepIO` etc.) — `runGate` defaults
 * to a concrete production `GateRuntimeIO` when `io` is omitted, rather than
 * defaulting field-by-field.
 *
 * The production `runValidationCommand` registers/unregisters each real child via
 * `registerActiveProcess`/`unregisterActiveProcess` (src/ai/claude.ts) — the
 * same contract `gen-eval-loop-runner` and `work-runner` honor — so a validation
 * command in flight during a graceful shutdown is reaped, not orphaned. On
 * timeout it reaps the command's process tree and returns `{ timedOut: true }`.
 *
 * SECURITY: `validationCommands` entries come from
 * `policies/products.json` and become EXECUTED shell commands here, so the spawn
 * MUST use `execFile`/`spawn` with an argv array and NEVER a shell string
 * (`exec`/`execSync` or `spawn(..., { shell: true })`). A shell spawn would turn
 * any metacharacter in a product's command (`;`, `&&`, `|`, `$(…)`, backticks,
 * redirects) into injection — and the approval pipeline can write
 * products.json at runtime, so this is not purely a hand-edited-config threat.
 * Commands are parsed to `[argv0, ...args]` and rejected at the parse boundary
 * when they cannot be represented safely.
 */
export interface GateRuntimeIO {
  runGit: GitRunner;
  /** Run one validation command in `cwd`, bounded by `timeoutMs`; on timeout the
   *  command's process tree is reaped and `{ timedOut: true }` returned. */
  runValidationCommand: (
    command: string,
    cwd: string,
    timeoutMs: number,
    diagnosticDir?: string,
  ) => Promise<ValidationCommandResult>;
}

function sanitizeDiagnosticText(raw: string): string {
  return redactSecrets(scrubAbsolutePaths(scrubPathsInText(raw)));
}

function persistTimeoutDiagnostics(opts: {
  command: string;
  outputHead: string;
  outputTail: string;
  rawReportDir?: string;
  diagnosticDir?: string;
  pid?: number;
}): string[] {
  const { diagnosticDir, rawReportDir } = opts;
  if (!diagnosticDir) return [];
  const artifacts: string[] = [];
  try {
    mkdirSync(diagnosticDir, { recursive: true });
    const outputName = `validation-timeout-${opts.pid ?? 'unknown'}.txt`;
    writeFileSync(join(diagnosticDir, outputName), sanitizeDiagnosticText(
      `command: ${opts.command}\n\n=== output head ===\n${opts.outputHead || '(no output captured)'}\n\n` +
      `=== output tail ===\n${opts.outputTail || '(no output captured)'}\n`,
    ), 'utf8');
    artifacts.push(outputName);

    if (rawReportDir) {
      for (const reportName of readdirSync(rawReportDir).filter((name) => name.endsWith('.json'))) {
        try {
          const report = JSON.parse(readFileSync(join(rawReportDir, reportName), 'utf8')) as Record<string, unknown>;
          // Node reports include the entire inherited environment. Never persist
          // credentials into the durable run artifact directory.
          delete report['environmentVariables'];
          const durableName = `validation-${basename(reportName)}`;
          writeFileSync(
            join(diagnosticDir, durableName),
            sanitizeDiagnosticText(JSON.stringify(report, null, 2)) + '\n',
            'utf8',
          );
          artifacts.push(durableName);
        } catch (err) {
          log.warn('validation diagnostic report could not be sanitized', {
            error: (err as Error).message,
          });
        }
      }
    }
  } catch (err) {
    log.warn('validation timeout artifact write failed', { error: (err as Error).message });
  }
  return artifacts;
}

/**
 * Production validation-command executor: spawn the command in `cwd` with NO
 * shell (argv array — injection-safe by construction; a `;`/`|`/`$()` in a
 * command becomes a literal argument, never a shell operator), bounded by
 * `timeoutMs`. The child is spawned `detached` into its own process group and a
 * timeout reaps the WHOLE group (SIGTERM → SIGKILL after the reap grace) so a
 * command that forks (e.g. `npm` → `node`) can't outlive its budget. Registered
 * with the active-process registry so a graceful Rune shutdown reaps it too.
 */
export async function runValidationCommandArgv(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  diagnosticDir?: string,
  options: ValidationCommandArgvOptions = {},
): Promise<ValidationCommandResult> {
  const unavailable = (reason: string): ValidationCommandResult => ({
    exitCode: null,
    timedOut: false,
    cancelled: false,
    outputHead: '',
    outputTail: reason,
    failureClass: 'profile-unavailable',
    profile: options.profile ?? 'sandbox-integration',
  });
  // An in-process broker grant must be the launcher-created capability object
  // bound to this exact socket — a caller-supplied path alone is not proof.
  if (
    options.sandboxBrokerSocket !== undefined &&
    !verifyConfinementCapability(options.sandboxBrokerCapability, {
      owner: 'sandbox-broker',
      profilePath: options.sandboxBrokerSocket,
    })
  ) {
    return unavailable('sandbox-integration broker grant is not a launcher capability');
  }
  const inheritedBrokerSocket = options.sandboxBrokerSocket === undefined
    ? process.env[VALIDATION_SANDBOX_BROKER_SOCKET_ENV]
    : undefined;
  let inheritedOuterConfinement = false;
  if (inheritedBrokerSocket !== undefined) {
    // Bypassing the inner Seatbelt requires the LIVE broker that encloses this
    // process to confirm the nonce it minted, for the exact profile it owns.
    // Both environment variables together are only a claim; the broker's
    // answer is the proof, so a stale or forged pair authorizes nothing.
    const attestation = process.env[VALIDATION_CONFINEMENT_ATTESTATION_ENV];
    if (attestation === undefined || attestation === '') {
      return unavailable('inherited validation confinement is missing its launcher capability');
    }
    // Reuse the enclosing Seatbelt ONLY when the live broker confirms it owns
    // exactly the profile THIS call asked for. A `sandbox-integration` outer
    // profile grants one extra exception (reachability to the broker's Unix
    // socket), so accepting it for an `isolated` request would silently run
    // that command under weaker rules than it declared.
    //
    // A mismatch is NOT fatal: it just forfeits the bypass, and the launch
    // below applies its own profile as usual. That is the safe direction —
    // narrowing nests fine on macOS, and a widening profile is rejected by
    // `sandbox_apply` and typed as `profile-unavailable` further down. Failing
    // closed here instead would deny a narrower nested profile that the OS
    // would happily have applied.
    inheritedOuterConfinement = await verifyInheritedValidationConfinement(
      options.profile ?? 'sandbox-integration',
      process.env,
    );
  }
  return await new Promise<ValidationCommandResult>((resolve) => {
    const [bin, ...args] = argv;
    if (!bin) {
      // An empty command can't pass — treat as a non-zero (red) result.
      resolve({ exitCode: 1, timedOut: false, outputHead: '', outputTail: '', diagnosticArtifacts: [] });
      return;
    }
    const command = argv.map((arg) => JSON.stringify(arg)).join(' ');
    let vitestReportDir: string | undefined;
    let vitestReportPath: string | undefined;
    const captureVitestJson =
      /^(?:npx)(?:\.cmd)?$/.test(basename(bin)) &&
      args[0] === 'vitest' &&
      args[1] === 'related';
    if (captureVitestJson) {
      try {
        vitestReportDir = mkdtempSync(join(tmpdir(), 'rune-vitest-related-'));
        vitestReportPath = join(vitestReportDir, 'report.json');
      } catch (err) {
        log.warn('validation Vitest report directory creation failed', {
          error: (err as Error).message,
        });
      }
    }
    const commandArgs = vitestReportPath === undefined
      ? args
      : [...args, '--reporter=json', `--outputFile=${vitestReportPath}`];
    let rawReportDir: string | undefined;
    try {
      if (diagnosticDir) rawReportDir = mkdtempSync(join(tmpdir(), 'rune-validation-report-'));
    } catch (err) {
      log.warn('validation diagnostic temp directory creation failed', { error: (err as Error).message });
    }
    const reportBootstrap = join(PROJECT_ROOT, 'scripts', 'validation-report-bootstrap.cjs');
    const reportOptions = rawReportDir
      ? `--report-on-signal --report-signal=SIGUSR2 --report-directory=${JSON.stringify(rawReportDir)} --require=${JSON.stringify(reportBootstrap)}`
      : '';
    // npm/npx should pass diagnostics to its direct runner; a direct node/test
    // command is itself the runner and strips the options before its workers.
    const initialReportDepth = /^(?:npm|npx)(?:\.cmd)?$/.test(basename(bin)) ? '0' : '1';
    // `compatibleFallback` marks the NEW child but does not weaken its launch:
    // the fallback itself still receives the normal outer Seatbelt. The legacy
    // marker is diagnostic only — a broker-verified attestation
    // (`inheritedOuterConfinement`) is the sole authorization for skipping the
    // inner sandbox.
    const appliesOuterProfile = process.platform === 'darwin' && !inheritedOuterConfinement;
    // Launcher-owned proof that Seatbelt really applied to THIS launch.
    // `sandbox-exec` reaches the preamble only after `sandbox_apply` succeeds,
    // so the marker lands on a private descriptor before any product code runs
    // and cannot be withheld by it afterwards. Product output on stdout/stderr
    // therefore can never manufacture a `profile-unavailable` classification —
    // the only way the marker is missing is a genuine launch failure.
    const profileAppliedNonce = createVitestAttestationCapability();
    const spawnBin = appliesOuterProfile ? '/usr/bin/sandbox-exec' : bin;
    const spawnArgs = appliesOuterProfile
      ? [
          '-p',
          validationSandboxProfile(
            options.profile ?? 'loopback',
            options.deniedWriteRoots,
            options.allowedWriteRoots,
            options.sandboxBrokerSocket,
          ),
          '/bin/sh',
          '-c',
          // stderr is silenced BEFORE `>&N` is attempted, so a descriptor that
          // is somehow closed cannot inject shell noise into captured product
          // output. `exec` keeps the pid — the process-group reaping below and
          // the detached-descendant sweep are unaffected by the preamble.
          `printf %s "$1" 2>/dev/null >&${PROFILE_APPLIED_FD}; shift; exec "$@"`,
          'rune-validation-launcher',
          profileAppliedNonce,
          bin,
          ...commandArgs,
        ]
      : commandArgs;
    const env = buildValidationEnv(
      options.cacheCwd ?? cwd,
      reportOptions,
      initialReportDepth,
      options.sandboxBrokerSocket ?? inheritedBrokerSocket,
      options.sandboxBrokerAttestation ??
        (inheritedBrokerSocket !== undefined
          ? process.env[VALIDATION_CONFINEMENT_ATTESTATION_ENV]
          : undefined),
    );
    // An inherited helper remains part of the top-level launcher's process
    // tree. Keep its anonymous nonce so the owner can find even a setsid(2)
    // escape after the complete profile shard exits; the nested helper cannot
    // inspect the host process table from inside Seatbelt.
    // Keyed off being INSIDE an enclosing launcher's tree, not off whether this
    // call reused its profile: a nested call that applies its own narrower
    // profile is still that launcher's descendant, and reusing its nonce is
    // what lets the owner find a setsid(2) escape after the shard exits.
    const validationProcessNonce = inheritedBrokerSocket !== undefined
      ? process.env[VALIDATION_PROCESS_NONCE_ENV] ?? createVitestAttestationCapability()
      : createVitestAttestationCapability();
    env[VALIDATION_PROCESS_NONCE_ENV] = validationProcessNonce;
    if (options.compatibleFallback === true) {
      env[VALIDATION_COMPATIBLE_MODE_ENV] = VALIDATION_COMPATIBLE_MODE_VALUE;
    }
    const child = spawn(spawnBin, spawnArgs, {
      cwd,
      stdio: [
        options.trustedStdinSource === undefined ? 'ignore' : 'pipe',
        'pipe',
        'pipe',
        // Opened only when this launch owns an outer profile, so a child that
        // was never wrapped sees exactly the descriptors it saw before.
        ...(appliesOuterProfile ? ['pipe' as const] : []),
      ],
      detached: true,
      // Validation runs product-controlled code. Pass shell/toolchain basics,
      // never Rune or integration secrets; Seatbelt also denies non-localhost
      // network so a test cannot exfiltrate even a secret read from disk.
      env,
    });
    if (options.trustedStdinSource !== undefined) {
      // The observer may exit or be cancelled before the bounded source has
      // drained. Its child result remains the fail-closed signal; EPIPE must
      // never become an unhandled stream error in Rune's shared process.
      child.stdin?.on('error', () => {});
      child.stdin?.end(options.trustedStdinSource);
    }
    registerActiveProcess(child, process.platform !== 'win32');

    // A launch that applied no outer profile has no `sandbox_apply` step that
    // could have been rejected, so it starts already "proven".
    let profileApplied = !appliesOuterProfile;
    if (appliesOuterProfile) {
      const markerStream = child.stdio[PROFILE_APPLIED_FD];
      let markerRaw = '';
      markerStream?.on('data', (chunk: Buffer | string) => {
        // Descendants inherit this descriptor. Bound what we read: only the
        // launcher's own nonce counts, and writing it can only move the verdict
        // toward `command-failed`, never toward an operational hold.
        if (markerRaw.length > 4 * profileAppliedNonce.length) return;
        markerRaw += String(chunk);
        if (markerRaw.includes(profileAppliedNonce)) profileApplied = true;
      });
      markerStream?.on('error', () => {});
    }

    // Merged stdout+stderr head + tail in arrival order, both bounded as they
    // stream so a chatty suite can't grow memory unbounded.
    let outputHead = '';
    let outputTail = '';
    const capture = (chunk: string): void => {
      if (outputHead.length < MAX_VALIDATION_OUTPUT_HEAD_CHARS) {
        outputHead += chunk.slice(0, MAX_VALIDATION_OUTPUT_HEAD_CHARS - outputHead.length);
      }
      outputTail = (outputTail + chunk).slice(-MAX_VALIDATION_OUTPUT_TAIL_CHARS);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let reapPollTimer: NodeJS.Timeout | undefined;
    let diagnosticTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let diagnosticGracePending = false;
    let timeoutReapComplete = true;
    let normalReapPending = false;
    let reapConfirmed = true;
    // The enclosing launcher owns the escaped-descendant sweep for its WHOLE
    // shard, and a child inside Seatbelt cannot read the host process table
    // anyway — so skip it for every inherited launch, not only for one that
    // reused the outer profile. Running it anyway costs two bounded `/bin/ps`
    // calls per command that can only ever come back unconfirmed.
    let escapedDescendantsChecked = inheritedBrokerSocket !== undefined;
    let escapedDescendantReapPending = false;
    let deferredFinish: { code: number | null } | undefined;
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal); // negative pid → the whole process group
      } catch {
        /* group already gone */
      }
    };
    const groupAlive = (): boolean => {
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const confirmGroupGone = (done: () => void): void => {
      const deadline = Date.now() + Math.min(1_000, config.WORK_RUN_REAP_GRACE_MS);
      const poll = (): void => {
        if (!groupAlive()) {
          done();
          return;
        }
        if (Date.now() >= deadline) {
          reapConfirmed = false;
          capture('\nvalidation process group remained alive after SIGKILL\n');
          done();
          return;
        }
        reapPollTimer = setTimeout(poll, 25);
        reapPollTimer.unref();
      };
      poll();
    };
    const reapEscapedDescendants = async (): Promise<boolean> => {
      if (process.platform !== 'darwin') return true;
      const matchingPids = async (): Promise<number[]> => {
        const { stdout: raw } = await execFileAsync('/bin/ps', ['eww', '-axo', 'pid=,command='], {
          encoding: 'utf8',
          timeout: 1_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        return raw
          .split('\n')
          .filter((line) => line.includes(validationProcessNonce))
          .map((line) => Number.parseInt(line.trim(), 10))
          .filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
      };
      try {
        for (const pid of await matchingPids()) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The escaped process exited between the scan and signal.
          }
        }
        return (await matchingPids()).length === 0;
      } catch {
        return false;
      }
    };
    // unref'd so a validation command in flight during a graceful Rune
    // shutdown can't hold the process alive for the full timeout window.
    const timer = setTimeout(() => {
      timedOut = true;
      const reap = (): void => {
        diagnosticGracePending = false;
        timeoutReapComplete = false;
        killGroup('SIGTERM');
        killTimer = setTimeout(() => {
          killGroup('SIGKILL');
          confirmGroupGone(() => {
            timeoutReapComplete = true;
            if (deferredFinish) finish(deferredFinish.code);
          });
        }, config.WORK_RUN_REAP_GRACE_MS);
      };
      if (rawReportDir) {
        diagnosticGracePending = true;
        killGroup('SIGUSR2');
        diagnosticTimer = setTimeout(reap, VALIDATION_DIAGNOSTIC_REPORT_GRACE_MS);
      } else {
        reap();
      }
    }, timeoutMs);
    timer.unref();
    const cancellationTimer = options.cancelled === undefined
      ? undefined
      : setInterval(() => {
          if (settled || timedOut || cancelled || options.cancelled?.() !== true) return;
          cancelled = true;
          clearTimeout(timer);
          timeoutReapComplete = false;
          killGroup('SIGTERM');
          killTimer = setTimeout(() => {
            killGroup('SIGKILL');
            confirmGroupGone(() => {
              timeoutReapComplete = true;
              if (deferredFinish) finish(deferredFinish.code);
            });
          }, config.WORK_RUN_REAP_GRACE_MS);
          killTimer.unref();
        }, 100);
    cancellationTimer?.unref();

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      if (diagnosticGracePending) {
        deferredFinish = { code: exitCode };
        return;
      }
      if ((timedOut || cancelled) && !timeoutReapComplete) {
        deferredFinish = { code: exitCode };
        return;
      }
      if (normalReapPending) {
        deferredFinish = { code: exitCode };
        return;
      }
      if (escapedDescendantReapPending) {
        deferredFinish = { code: exitCode };
        return;
      }
      if (!escapedDescendantsChecked) {
        escapedDescendantsChecked = true;
        escapedDescendantReapPending = true;
        void reapEscapedDescendants()
          .then((confirmed) => {
            if (!confirmed) {
              reapConfirmed = false;
              capture('\nvalidation escaped-descendant reaping could not be confirmed\n');
            }
          })
          .catch(() => {
            reapConfirmed = false;
            capture('\nvalidation escaped-descendant reaping could not be confirmed\n');
          })
          .finally(() => {
            escapedDescendantReapPending = false;
            const deferred = deferredFinish;
            deferredFinish = undefined;
            finish(deferred?.code ?? exitCode);
          });
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (cancellationTimer) clearInterval(cancellationTimer);
      if (killTimer && timeoutReapComplete) clearTimeout(killTimer);
      if (diagnosticTimer) clearTimeout(diagnosticTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (reapPollTimer) clearTimeout(reapPollTimer);
      unregisterActiveProcess(child);
      const diagnosticArtifacts = timedOut
        ? persistTimeoutDiagnostics({ command, outputHead, outputTail, rawReportDir, diagnosticDir, pid: child.pid })
        : [];
      if (rawReportDir) rmSync(rawReportDir, { recursive: true, force: true });
      const structuredReport = vitestReportPath === undefined
        ? undefined
        : parseVitestRelatedReport(vitestReportPath, cwd);
      const vitestManifest = options.vitestAttestation === undefined
        ? undefined
        : readAuthenticatedVitestManifest(
            options.vitestAttestation.outputPath,
            options.vitestAttestation.capability,
          );
      if (vitestReportDir) rmSync(vitestReportDir, { recursive: true, force: true });
      // Only a launch that actually tried to apply a profile — and whose
      // launcher-owned marker never arrived, proving `sandbox_apply` rejected
      // it before any product code ran — may be reclassified. An inherited or
      // unprofiled launch, or one whose profile demonstrably applied, keeps a
      // nonzero exit as an ordinary `command-failed` for the repair flow.
      const profileLaunchRejected =
        appliesOuterProfile &&
        options.profile !== undefined &&
        !profileApplied &&
        exitCode !== null &&
        exitCode !== 0 &&
        !timedOut &&
        !cancelled &&
        [outputHead, outputTail].some((output) => output
          .split(/\r?\n/)
          .some((line) =>
            /^(?:sandbox-exec:\s*)?sandbox_apply(?:\([^\r\n)]*\))?:\s*Operation not permitted\s*$/i
              .test(line.trim()),
          ));
      resolve({
        exitCode: reapConfirmed ? exitCode : 1,
        timedOut,
        outputHead,
        outputTail,
        diagnosticArtifacts,
        ...(structuredReport !== undefined ? {
          structuredErrors: structuredReport.errors,
          structuredErrorsTotal: structuredReport.total,
          structuredErrorsComplete: structuredReport.complete,
        } : {}),
        ...(vitestManifest !== undefined ? { vitestManifest } : {}),
        cancelled,
        ...(options.profile !== undefined ? { profile: options.profile } : {}),
        ...(profileLaunchRejected ? { failureClass: 'profile-unavailable' as const } : {}),
      });
    };
    // A green/non-timeout leader is not enough: product tests may leave
    // descendants behind. Quiesce its process group before evidence is read or
    // the post-run Git identity is captured. The verified index is also the
    // closeout commit source, so a detached escapee cannot enter the commit.
    child.on('exit', (code) => {
      if (!timedOut && !cancelled && groupAlive()) {
        normalReapPending = true;
        killGroup('SIGTERM');
        killTimer = setTimeout(() => {
          killGroup('SIGKILL');
          confirmGroupGone(() => {
            normalReapPending = false;
            const deferred = deferredFinish;
            deferredFinish = undefined;
            finish(deferred?.code ?? code);
          });
        }, config.WORK_RUN_REAP_GRACE_MS);
        killTimer.unref();
        return;
      }
      // `close` is load-bearing: it fires only after both piped streams end, so
      // the captured tail is complete. Bound a pipe-holding edge case even when
      // the group has already disappeared.
      drainTimer = setTimeout(() => finish(code), VALIDATION_STDIO_DRAIN_MS);
      drainTimer.unref();
    });
    child.on('close', (code) => {
      if (normalReapPending && !groupAlive()) {
        normalReapPending = false;
        if (killTimer) clearTimeout(killTimer);
      }
      finish(code);
    });
    child.on('error', () => finish(null));
  });
}

function defaultRunValidationCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  diagnosticDir?: string,
): Promise<ValidationCommandResult> {
  return runValidationCommandArgv(command.trim().split(/\s+/).filter(Boolean), cwd, timeoutMs, diagnosticDir);
}

export type ValidationCommandListResult =
  | { ok: true }
  | {
      ok: false;
      command: string;
      /** Structured argv when the caller constructed the command directly. */
      argv?: readonly string[];
      result: ValidationCommandResult;
    };

export interface FullSuiteValidationOpts {
  commands: readonly string[];
  adapters: readonly ValidationAdapter[];
  commandProfiles?: readonly ValidationCommandProfile[];
  /** Worktree root whose canonical staged tree is attested. */
  worktree: string;
  /** Already boundary-validated command cwd. */
  cwd: string;
  /** Worktree-relative durable label for cwd. */
  validationCwd: string;
  expectedTreeOid: string;
  fullTaskReviewHash: string;
  timeoutMs: number;
  diagnosticDir?: string;
  /** Merge-gate mode executes every command even after one turns red. */
  continueOnFailure?: boolean;
  /** Correlated orchestration cancellation observed around command completion. */
  cancelled?: () => boolean;
}

interface FullSuiteValidationIOBase {
  runGit: GitRunner;
  /** Trusted test seam; production always uses Rune's checked-in reporter. */
  trustedVitestReporterPath?: string;
  /** Trusted test seam for manifest temp-directory setup failures. */
  createVitestManifestDir?: () => string;
  runCommand: (
    command: string,
    argv: readonly string[],
    cwd: string,
    timeoutMs: number,
    diagnosticDir: string | undefined,
    options: ValidationCommandArgvOptions,
  ) => Promise<ValidationCommandResult>;
  /** Production-only isolated lifecycle observer. Test seams may return a
   * manifest directly from `runCommand` instead. */
  runTrustedVitestObserver?: (
    cwd: string,
    timeoutMs: number,
    diagnosticDir: string | undefined,
    options: ValidationCommandArgvOptions,
  ) => Promise<ValidationCommandResult>;
}

export interface FullSuiteProfileAdmissionIO {
  /** Production capability admission. Omitted test seams are already trusted. */
  probeProfile: (
    profile: ValidationProfile,
    cwd: string,
    timeoutMs: number,
    enclosing?: ValidationSandboxBroker,
  ) => Promise<ValidationProfileProbeEvidence>;
  startSandboxBroker: typeof startValidationSandboxBroker;
}

/**
 * Production admission is checked as an atomic pair at runtime. A test seam
 * that wants to run broker-free must say so with `trustedProfileAdmission`:
 * silence is treated as a forgotten `productionFullSuiteProfileIO()` spread,
 * because that omission — not a half-wired pair — is what let closeout and the
 * merge gate fabricate `passed` probes and run a sandbox-integration shard
 * unconfined. Opting out is a deliberate, greppable act.
 */
export interface FullSuiteValidationIO extends FullSuiteValidationIOBase {
  probeProfile?: FullSuiteProfileAdmissionIO['probeProfile'];
  startSandboxBroker?: FullSuiteProfileAdmissionIO['startSandboxBroker'];
  /** Explicit test-seam opt-out from production profile admission. */
  trustedProfileAdmission?: true;
}

const RUNE_CODE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VITEST_REPORTER_PATH = join(RUNE_CODE_ROOT, 'scripts', 'vitest-attestation-reporter.mjs');
const TRUSTED_VITEST_OBSERVER_PATH = join(
  RUNE_CODE_ROOT,
  'scripts',
  'run-trusted-vitest-attestation.mjs',
);
const TRUSTED_VITEST_CONFIG_EXTRACTOR_PATH = join(
  RUNE_CODE_ROOT,
  'scripts',
  'extract-vitest-config.mjs',
);
const BOOT_TRUSTED_VITEST_IMPLEMENTATION = captureTrustedVitestImplementation({
  reporterPath: VITEST_REPORTER_PATH,
  observerPath: TRUSTED_VITEST_OBSERVER_PATH,
  extractorPath: TRUSTED_VITEST_CONFIG_EXTRACTOR_PATH,
});

export function runTrustedVitestObserver(
  cwd: string,
  timeoutMs: number,
  diagnosticDir: string | undefined,
  options: ValidationCommandArgvOptions,
): Promise<ValidationCommandResult> {
  const attestation = options.vitestAttestation;
  if (
    attestation === undefined ||
    attestation.trustedImplementation === undefined
  ) {
    return Promise.resolve({
      exitCode: null,
      timedOut: false,
      cancelled: false,
      outputHead: '',
      outputTail: 'trusted Vitest observer source was unavailable',
    });
  }
  if (process.platform !== 'darwin') {
    return Promise.resolve({
      exitCode: 1,
      timedOut: false,
      cancelled: false,
      outputHead: '',
      outputTail: 'trusted Vitest observer requires macOS validation confinement',
    });
  }
  const trustedInput = {
    output: attestation.outputPath,
    capability: attestation.capability,
    reporterSource: attestation.trustedImplementation.reporterSource,
    extractorSource: attestation.trustedImplementation.extractorSource,
    ...(attestation.profileSelector !== undefined
      ? { selector: attestation.profileSelector }
      : {}),
  };
  const trustedStdinSource =
    `const __RUNE_TRUSTED_INPUT__ = Object.freeze(${JSON.stringify(trustedInput)});\n` +
    attestation.trustedImplementation.observerSource;
  return runValidationCommandArgv(
    [process.execPath, '--input-type=module', '-', cwd],
    cwd,
    timeoutMs,
    diagnosticDir,
    {
      ...options,
      trustedStdinSource,
      cacheCwd: cwd,
      deniedWriteRoots: [PROJECT_ROOT, cwd],
      vitestAttestation: {
        outputPath: attestation.outputPath,
        capability: attestation.capability,
      },
    },
  );
}
const VALIDATION_CONFIG_FILE_MAX_BYTES = 8 * 1024 * 1024;

async function captureValidationTree(runGit: GitRunner, worktree: string): Promise<string> {
  await runGit(['add', '-A'], { cwd: worktree });
  const tree = (await runGit(['write-tree'], { cwd: worktree })).stdout.trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(tree)) {
    throw new Error('validation tree capture returned a malformed object id');
  }
  const verified = (
    await runGit(['rev-parse', '--verify', `${tree}^{tree}`], { cwd: worktree })
  ).stdout.trim();
  if (verified !== tree) throw new Error('validation tree capture could not verify the object id');
  return tree;
}

function packageTestScriptIsFullVitest(cwd: string): boolean {
  try {
    const raw = readFileSync(resolve(cwd, 'package.json'), 'utf8');
    if (raw.length > VALIDATION_CONFIG_FILE_MAX_BYTES) return false;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const scripts = parsed['scripts'];
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return false;
    const scriptRecord = scripts as Record<string, unknown>;
    const test = scriptRecord['test'];
    const hasLifecycleHook = ['pretest', 'posttest'].some((name) =>
      typeof scriptRecord[name] === 'string' && scriptRecord[name].trim() !== '');
    return typeof test === 'string' &&
      exactArgv(test, ['vitest', 'run']) &&
      !hasLifecycleHook;
  } catch {
    return false;
  }
}

function exactArgv(command: string, expected: readonly string[]): boolean {
  const parsed = parseValidationCommand(command);
  return parsed.ok &&
    parsed.argv.length === expected.length &&
    parsed.argv.every((arg, index) => arg === expected[index]);
}

function isFullVitestInvocation(argv: readonly string[], cwd: string): boolean {
  if (
    argv.length === 3 &&
    argv[0] === 'npx' &&
    argv[1] === 'vitest' &&
    argv[2] === 'run'
  ) return true;
  if (
    (argv.length === 2 && argv[0] === 'npm' && argv[1] === 'test') ||
    (argv.length === 3 && argv[0] === 'npm' && argv[1] === 'run' && argv[2] === 'test')
  ) {
    return packageTestScriptIsFullVitest(cwd);
  }
  return false;
}

function commandOutcome(result: ValidationCommandResult):
  ValidationBatchReceipt['commands'][number]['outcome'] {
  if (result.cancelled) return 'cancelled';
  if (result.timedOut) return 'timed-out';
  return result.exitCode === 0 ? 'passed' : 'failed';
}

function batchOutcome(
  commands: ValidationBatchReceipt['commands'],
  drifted: boolean,
): ValidationBatchReceipt['outcome'] {
  if (drifted) return 'drifted';
  if (commands.some((entry) => entry.outcome === 'cancelled')) return 'cancelled';
  if (commands.some((entry) => entry.outcome === 'timed-out')) return 'timed-out';
  if (commands.some((entry) =>
    entry.outcome === 'failed' || entry.coverage === 'invalid')) return 'failed';
  return 'passed';
}

function aggregateVitestManifests(
  manifests: readonly VitestLifecycleManifest[],
): VitestLifecycleManifest | undefined {
  if (manifests.length === 0) return undefined;
  const aggregate: VitestLifecycleManifest = {
    version: 1,
    runner: 'vitest',
    completedNormally: manifests.every((manifest) => manifest.completedNormally),
    collectionErrors: manifests.reduce(
      (total, manifest) => total + manifest.collectionErrors,
      0,
    ),
    discovered: { suites: 0, tests: 0 },
    completed: {
      suites: 0,
      tests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      todo: 0,
      cancelled: 0,
    },
  };
  for (const manifest of manifests) {
    aggregate.discovered.suites += manifest.discovered.suites;
    aggregate.discovered.tests += manifest.discovered.tests;
    for (const key of [
      'suites',
      'tests',
      'passed',
      'failed',
      'skipped',
      'todo',
      'cancelled',
    ] as const) {
      aggregate.completed[key] += manifest.completed[key];
    }
  }
  return parseVitestManifest(aggregate);
}

function defaultFullSuiteValidationIO(): FullSuiteValidationIO {
  return {
    runGit: defaultRunGit,
    runCommand: (_command, argv, cwd, timeoutMs, diagnosticDir, options) =>
      runValidationCommandArgv(argv, cwd, timeoutMs, diagnosticDir, options),
    runTrustedVitestObserver,
    ...productionFullSuiteProfileIO(),
  };
}

export function productionFullSuiteProfileIO(): FullSuiteProfileAdmissionIO {
  return {
    probeProfile: probeValidationProfile,
    startSandboxBroker: startValidationSandboxBroker,
  };
}

const PROFILE_PROBE_SOURCE: Record<ValidationProfile, string> = {
  isolated: `
    const net = require('node:net');
    const server = net.createServer();
    server.once('error', () => process.exit(0));
    server.listen(0, '127.0.0.1', () => { server.close(); process.exit(41); });
    setTimeout(() => process.exit(42), 1000).unref();
  `,
  loopback: `
    const net = require('node:net');
    const server = net.createServer((socket) => socket.end('ok'));
    server.once('error', () => process.exit(43));
    server.listen(0, '127.0.0.1', () => {
      const local = net.connect(server.address().port, '127.0.0.1');
      local.once('data', () => {
        local.destroy(); server.close();
        const external = net.connect(53, '1.1.1.1');
        external.once('connect', () => process.exit(44));
        external.once('error', () => process.exit(0));
        setTimeout(() => { external.destroy(); process.exit(0); }, 250).unref();
      });
      local.once('error', () => process.exit(45));
    });
    setTimeout(() => process.exit(46), 1500).unref();
  `,
  'sandbox-integration': `process.exit(process.platform === 'darwin' ? 0 : 47);`,
};

/** Grant fields a shard needs to prove it owns the broker it was handed. */
function brokerGrant(broker: ValidationSandboxBroker | undefined): {
  sandboxBrokerSocket?: string;
  sandboxBrokerCapability?: ConfinementCapability;
  sandboxBrokerAttestation?: string;
} {
  return broker === undefined ? {} : {
    sandboxBrokerSocket: broker.socketPath,
    sandboxBrokerCapability: broker.capability,
    sandboxBrokerAttestation: broker.attestationNonce,
  };
}

/**
 * Run `body` with the Rune-owned broker `profile` requires, if any. One broker
 * instance serves both the capability probe and the shard execution, and is
 * always stopped on the way out. `onUnavailable` owns the caller's own failure
 * shape, so each call site keeps its error formatting local.
 */
async function withValidationSandboxBroker<T>(
  profile: ValidationProfile | undefined,
  startBroker: () => Promise<ValidationSandboxBroker>,
  body: (broker: ValidationSandboxBroker | undefined) => Promise<T>,
  onUnavailable: () => T,
): Promise<T> {
  if (profile !== 'sandbox-integration') return await body(undefined);
  let broker: ValidationSandboxBroker | undefined;
  try {
    try {
      broker = await startBroker();
    } catch {
      return onUnavailable();
    }
    return await body(broker);
  } finally {
    await broker?.stop().catch(() => {});
  }
}

/** Prove the selected host capability before product-controlled dispatch.
 * An `enclosing` broker is reused rather than started and stopped again. */
export async function probeValidationProfile(
  profile: ValidationProfile,
  cwd: string,
  timeoutMs: number,
  enclosing?: ValidationSandboxBroker,
): Promise<ValidationProfileProbeEvidence> {
  const startedAt = new Date().toISOString();
  const definitionFingerprint = sha256(JSON.stringify({
    profile,
    definition: validationSandboxProfile(profile),
  }));
  if (process.platform !== 'darwin') {
    return {
      profile,
      definitionFingerprint,
      confinementOwner: profile === 'sandbox-integration' ? 'sandbox-broker' : 'validation-launcher',
      outcome: 'unavailable',
      failureClass: 'profile-unavailable',
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
  if (profile === 'sandbox-integration') {
    let owned: ValidationSandboxBroker | undefined;
    try {
      const broker = enclosing ?? (owned = await startValidationSandboxBroker());
      const response = await requestValidationSandboxProbe(broker.socketPath, {
        version: 1,
        scenario: 'profile-compiles',
        candidateProfile: '(version 1)(allow default)',
      });
      return {
        profile,
        definitionFingerprint,
        confinementOwner: 'sandbox-broker',
        outcome: response.ok ? 'passed' : 'unavailable',
        ...(response.ok ? {} : { failureClass: 'profile-unavailable' as const }),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } catch {
      return {
        profile,
        definitionFingerprint,
        confinementOwner: 'sandbox-broker',
        outcome: 'unavailable',
        failureClass: 'profile-unavailable',
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } finally {
      await owned?.stop().catch(() => {});
    }
  }
  const result = await runValidationCommandArgv(
    [process.execPath, '-e', PROFILE_PROBE_SOURCE[profile]],
    cwd,
    Math.min(timeoutMs, 3_000),
    undefined,
    { profile },
  );
  return {
    profile,
    definitionFingerprint,
    confinementOwner: 'validation-launcher',
    outcome: result.exitCode === 0 && !result.timedOut && !result.cancelled
      ? 'passed'
      : 'unavailable',
    ...(result.exitCode === 0 && !result.timedOut && !result.cancelled
      ? {}
      : { failureClass: 'profile-unavailable' as const }),
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

function validationIdentityFailure(message: string): FullSuiteValidationResult {
  return {
    ok: false,
    command: 'canonical validation identity',
    result: {
      exitCode: null,
      timedOut: false,
      outputHead: '',
      outputTail: message,
      cancelled: false,
    },
    attestations: [],
    receipts: [],
    coverageComplete: false,
    validationReceipt: { outcome: 'drifted', commands: [] },
  };
}

async function materializeReviewedTree(
  opts: FullSuiteValidationOpts,
  runGit: GitRunner,
): Promise<{ dir: string; cwd: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'rune-vitest-reviewed-tree-'));
  const index = join(dir, '.rune-index');
  const gitOptions = { cwd: opts.worktree, env: { GIT_INDEX_FILE: index } };
  try {
    await runGit(['read-tree', opts.expectedTreeOid], gitOptions);
    await runGit(['checkout-index', '--all', `--prefix=${dir}${sep}`], gitOptions);
    rmSync(index, { force: true });
    const nodeModules = realpathSync(join(PROJECT_ROOT, 'node_modules'));
    symlinkSync(nodeModules, join(dir, 'node_modules'), 'dir');
    const reviewedCwd = resolve(dir, opts.validationCwd);
    if (
      reviewedCwd !== dir &&
      !reviewedCwd.startsWith(`${dir}${sep}`)
    ) {
      throw new Error('reviewed validation cwd escaped its materialized tree');
    }
    const realDir = realpathSync(dir);
    const realCwd = realpathSync(reviewedCwd);
    if (
      realCwd !== realDir &&
      !realCwd.startsWith(`${realDir}${sep}`)
    ) {
      throw new Error('reviewed validation cwd symlink escaped its materialized tree');
    }
    return { dir: realDir, cwd: realCwd };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

interface FullSuiteCommandExecution {
  command: string;
  argv: string[];
  result: ValidationCommandResult;
  startedAt: string;
  completedAt: string;
  adapter: ValidationAdapter | undefined;
  eligible: boolean;
  profile: ValidationProfile;
  selector?: string;
}

async function executeFullSuiteCommand(args: {
  command: string;
  argv: string[];
  adapter: ValidationAdapter | undefined;
  eligible: boolean;
  profile: ValidationProfile;
  selector?: string;
  opts: FullSuiteValidationOpts;
  io: FullSuiteValidationIO;
  trustedImplementation: TrustedVitestImplementation;
  sandboxBroker?: ValidationSandboxBroker;
}): Promise<FullSuiteCommandExecution> {
  let manifestDir: string | undefined;
  let outputPath: string | undefined;
  let capability: string | undefined;
  let reviewedTree: { dir: string; cwd: string } | undefined;
  let observerFailure: string | undefined;
  if (args.eligible) {
    try {
      manifestDir = args.io.createVitestManifestDir?.() ??
        mkdtempSync(join(tmpdir(), 'rune-vitest-attestation-'));
      outputPath = join(manifestDir, 'manifest.json');
      capability = createVitestAttestationCapability();
      if (args.io.runTrustedVitestObserver === runTrustedVitestObserver) {
        reviewedTree = await materializeReviewedTree(args.opts, args.io.runGit);
      }
    } catch {
      observerFailure = 'trusted Vitest reporter setup failed';
    }
  }

  const startedAt = new Date().toISOString();
  let result: ValidationCommandResult;
  try {
    let observed: ValidationCommandResult | undefined;
    if (
      observerFailure === undefined &&
      args.eligible &&
      args.io.runTrustedVitestObserver !== undefined &&
      outputPath !== undefined &&
      capability !== undefined
    ) {
      try {
        observed = await args.io.runTrustedVitestObserver(
          reviewedTree?.cwd ?? args.opts.cwd,
          args.opts.timeoutMs,
          args.opts.diagnosticDir,
          {
            vitestAttestation: {
              outputPath,
              capability,
              trustedImplementation: args.trustedImplementation,
              ...(args.selector !== undefined
                ? { profileSelector: args.selector }
                : {}),
            },
            ...(args.opts.cancelled !== undefined ? { cancelled: args.opts.cancelled } : {}),
            profile: args.profile,
            ...brokerGrant(args.sandboxBroker),
          },
        );
      } catch {
        observerFailure = 'trusted Vitest observer runner failed';
      }
    }
    try {
      result = await args.io.runCommand(
        args.command,
        args.argv,
        args.opts.cwd,
        args.opts.timeoutMs,
        args.opts.diagnosticDir,
        {
          deniedWriteRoots: [PROJECT_ROOT],
          allowedWriteRoots: [args.opts.worktree],
          ...(args.opts.cancelled !== undefined ? { cancelled: args.opts.cancelled } : {}),
          profile: args.profile,
          ...brokerGrant(args.sandboxBroker),
        },
      );
    } catch {
      result = {
        exitCode: null,
        timedOut: false,
        cancelled: false,
        outputHead: '',
        outputTail: 'validation command runner failed',
      };
    }
    if (observerFailure !== undefined) {
      const { vitestManifest: _discardedUntrustedManifest, ...exactResult } = result;
      result = {
        ...exactResult,
        outputTail: [exactResult.outputTail, observerFailure].filter(Boolean).join('\n'),
      };
    } else {
      if (
        observed !== undefined &&
        !result.timedOut &&
        !result.cancelled
      ) {
        const observedManifest = parseVitestManifest(observed.vitestManifest);
        const observerEvidenceAdmissible =
          observedManifest !== undefined &&
            !observed.timedOut &&
            !observed.cancelled &&
            (
              observed.exitCode === 0 ||
              !vitestLifecycleIsGreen(observedManifest)
            );
        result = observerEvidenceAdmissible
          ? { ...result, vitestManifest: observedManifest }
          : {
              ...result,
              outputTail: [result.outputTail, observed.outputTail].filter(Boolean).join('\n'),
            };
      }
    }
    if (args.opts.cancelled?.() === true) {
      result = { ...result, cancelled: true };
    }
  } finally {
    // The command executor reads the manifest before it resolves.
    if (manifestDir !== undefined) {
      try {
        rmSync(manifestDir, { recursive: true, force: true });
      } catch {
        // The evidence has already been read; cleanup is best-effort.
      }
    }
    if (reviewedTree !== undefined) {
      try {
        rmSync(reviewedTree.dir, { recursive: true, force: true });
      } catch {
        // The observer has exited; cleanup is best-effort.
      }
    }
  }
  const completedMs = Date.now();
  return {
    command: args.command,
    argv: args.argv,
    result,
    startedAt,
    completedAt: new Date(completedMs).toISOString(),
    adapter: args.adapter,
    eligible: args.eligible,
    profile: args.profile,
    ...(args.selector !== undefined ? { selector: args.selector } : {}),
  };
}

/**
 * Execute the exact configured command list under Rune's validation launcher.
 * A mapped Vitest command receives the private lifecycle reporter only when its
 * invocation is demonstrably an unfiltered full run.
 */
export async function runFullSuiteValidation(
  opts: FullSuiteValidationOpts,
  io: FullSuiteValidationIO = defaultFullSuiteValidationIO(),
): Promise<FullSuiteValidationResult> {
  const adapters = new Map(opts.adapters.map((adapter) => [adapter.command, adapter]));
  let profilePlan: ValidationProfilePlan;
  try {
    profilePlan = planValidationProfiles({
      commands: opts.commands,
      commandProfiles: (opts.commandProfiles?.length ?? 0) > 0
        ? opts.commandProfiles!
        : opts.commands.map((command) => ({
        command,
        profile: 'isolated' as const,
      })),
      adapters: opts.adapters,
      parseCommand: parseValidationCommand,
    });
  } catch {
    return validationIdentityFailure('validation profile plan was invalid');
  }
  const hasProfileProbe = io.probeProfile !== undefined;
  const hasSandboxBroker = io.startSandboxBroker !== undefined;
  if (hasProfileProbe !== hasSandboxBroker) {
    return validationIdentityFailure('validation profile admission wiring was incomplete');
  }
  if (!hasProfileProbe && io.trustedProfileAdmission !== true) {
    // Both hooks absent AND no explicit opt-out: this is the original defect's
    // shape — a production caller that forgot `productionFullSuiteProfileIO()`.
    // Fail closed here rather than fabricating a `passed` probe for every
    // profile and running the sandbox-integration shard with no broker.
    return validationIdentityFailure('validation profile admission was not wired');
  }
  const reporterPath = io.trustedVitestReporterPath ?? VITEST_REPORTER_PATH;
  const resolvedValidationCwd = resolveValidationCwd(opts.worktree, opts.validationCwd);
  if (!resolvedValidationCwd.ok) {
    return validationIdentityFailure('validation cwd failed containment validation');
  }
  try {
    if (realpathSync(resolvedValidationCwd.cwd) !== realpathSync(opts.cwd)) {
      return validationIdentityFailure('validation cwd did not match the declared worktree location');
    }
  } catch {
    return validationIdentityFailure('validation cwd identity could not be resolved');
  }
  let beforeTree: string;
  let beforeFingerprints: ValidationFingerprints;
  let trustedImplementation: TrustedVitestImplementation;
  try {
    trustedImplementation = reporterPath === VITEST_REPORTER_PATH
      ? BOOT_TRUSTED_VITEST_IMPLEMENTATION
      : captureTrustedVitestImplementation({
          reporterPath,
          observerPath: TRUSTED_VITEST_OBSERVER_PATH,
          extractorPath: TRUSTED_VITEST_CONFIG_EXTRACTOR_PATH,
        });
    beforeTree = await captureValidationTree(io.runGit, opts.worktree);
    beforeFingerprints = captureValidationFingerprints(
      opts.cwd,
      opts.commands,
      opts.adapters,
      trustedImplementation,
      profilePlan,
    );
  } catch {
    return validationIdentityFailure('validation tree or fingerprint capture failed');
  }
  if (beforeTree !== opts.expectedTreeOid) {
    return validationIdentityFailure('validation tree did not match the reviewed tree');
  }
  const prelim: FullSuiteCommandExecution[] = [];
  let firstFailure: typeof prelim[number] | undefined;

  // Cache reusable per-profile admission across shards, but attribute evidence
  // per shard: a `sandbox-integration` shard re-probes against its OWN
  // short-lived broker, so a second such shard would otherwise overwrite the
  // key and hand the first shard's receipt the wrong probe. `shardProbes` stays
  // index-aligned with `prelim` (both are pushed once per iteration).
  const profileProbes = new Map<ValidationProfile, ValidationProfileProbeEvidence>();
  const shardProbes: ValidationProfileProbeEvidence[] = [];
  for (const shard of profilePlan.shards) {
    const command = shard.command;
    const unavailableProbe = (): ValidationProfileProbeEvidence => {
      const now = new Date().toISOString();
      return {
        profile: shard.profile,
        definitionFingerprint: profilePlan.definitionFingerprint,
        confinementOwner: shard.profile === 'sandbox-integration'
          ? 'sandbox-broker'
          : 'validation-launcher',
        outcome: 'unavailable',
        failureClass: 'profile-unavailable',
        startedAt: now,
        completedAt: now,
      };
    };
    const unavailableExecution = (): FullSuiteCommandExecution => {
      const now = new Date().toISOString();
      return {
        command,
        argv: shard.argv,
        result: {
          exitCode: null,
          timedOut: false,
          cancelled: false,
          outputHead: '',
          outputTail: `validation profile unavailable: ${shard.profile}`,
          failureClass: 'profile-unavailable',
          profile: shard.profile,
        },
        startedAt: now,
        completedAt: now,
        adapter: adapters.get(command),
        eligible: false,
        profile: shard.profile,
        ...(shard.selector !== undefined ? { selector: shard.selector } : {}),
      };
    };
    let shardProbe: ValidationProfileProbeEvidence | undefined;
    const runShard = async (
      sandboxBroker: ValidationSandboxBroker | undefined,
    ): Promise<FullSuiteCommandExecution> => {
      let probe = shard.profile === 'sandbox-integration' && sandboxBroker !== undefined
        ? undefined
        : profileProbes.get(shard.profile);
      if (probe === undefined) {
        if (io.probeProfile === undefined) {
          const now = new Date().toISOString();
          probe = {
            profile: shard.profile,
            definitionFingerprint: profilePlan.definitionFingerprint,
            confinementOwner: shard.profile === 'sandbox-integration'
              ? 'sandbox-broker'
              : 'validation-launcher',
            outcome: 'passed',
            startedAt: now,
            completedAt: now,
          };
        } else {
          try {
            probe = await io.probeProfile(
              shard.profile,
              opts.cwd,
              opts.timeoutMs,
              sandboxBroker,
            );
          } catch {
            probe = unavailableProbe();
          }
        }
        profileProbes.set(shard.profile, probe);
      }
      shardProbe = probe;
      if (probe.outcome !== 'passed') return unavailableExecution();
      if (opts.cancelled?.() === true) {
        const now = new Date().toISOString();
        return {
          command,
          argv: shard.argv,
          result: {
            exitCode: null,
            timedOut: false,
            cancelled: true,
            outputHead: '',
            outputTail: 'validation cancelled before command launch',
          },
          startedAt: now,
          completedAt: now,
          adapter: adapters.get(command),
          eligible: false,
          profile: shard.profile,
          ...(shard.selector !== undefined ? { selector: shard.selector } : {}),
        };
      }
      const parsed = parseValidationCommand(command);
      if (!parsed.ok) {
        return {
          command,
          argv: [],
          result: {
            exitCode: 1,
            timedOut: false,
            outputHead: '',
            outputTail: 'malformed configured validation command',
            cancelled: false,
          },
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          adapter: undefined,
          eligible: false,
          profile: shard.profile,
        };
      }
      const adapter = adapters.get(command);
      const eligible = adapter?.runner === 'vitest' && isFullVitestInvocation(parsed.argv, opts.cwd);
      return await executeFullSuiteCommand({
        command,
        argv: shard.argv,
        adapter,
        eligible,
        profile: shard.profile,
        ...(shard.selector !== undefined ? { selector: shard.selector } : {}),
        opts,
        io,
        trustedImplementation,
        ...(sandboxBroker !== undefined ? { sandboxBroker } : {}),
      });
    };
    const item = hasProfileProbe && shard.profile === 'sandbox-integration'
      ? await withValidationSandboxBroker(
          shard.profile,
          io.startSandboxBroker!,
          runShard,
          () => {
            const probe = unavailableProbe();
            profileProbes.set(shard.profile, probe);
            shardProbe = probe;
            return unavailableExecution();
          },
        )
      : await runShard(undefined);
    prelim.push(item);
    shardProbes.push(shardProbe ?? unavailableProbe());
    if (item.result.timedOut || item.result.cancelled || item.result.exitCode !== 0) {
      firstFailure ??= item;
      if (item.result.cancelled || !opts.continueOnFailure) break;
    }
  }

  let afterTree = '';
  let afterFingerprints: ValidationFingerprints | undefined;
  try {
    const afterTrustedImplementation = captureTrustedVitestImplementation({
      reporterPath,
      observerPath: TRUSTED_VITEST_OBSERVER_PATH,
      extractorPath: TRUSTED_VITEST_CONFIG_EXTRACTOR_PATH,
    });
    afterTree = await captureValidationTree(io.runGit, opts.worktree);
    afterFingerprints = captureValidationFingerprints(
      opts.cwd,
      opts.commands,
      opts.adapters,
      afterTrustedImplementation,
      profilePlan,
    );
  } catch {
    afterTree = 'invalid';
  }
  if (opts.cancelled?.() === true && prelim.length > 0) {
    const last = prelim[prelim.length - 1]!;
    if (last.result.cancelled !== true) {
      last.result = { ...last.result, cancelled: true };
      firstFailure ??= last;
    }
  }
  const drifted =
    beforeTree !== opts.expectedTreeOid ||
    afterTree !== beforeTree ||
    afterFingerprints === undefined ||
    JSON.stringify(afterFingerprints) !== JSON.stringify(beforeFingerprints);
  const attestations: FullSuiteAttestation[] = [];
  const receipts: CompactValidationReceipt[] = [];
  const completeMappedManifests = new Map<string, VitestLifecycleManifest[]>();
  const batchCommands: ValidationBatchReceipt['commands'] = [];
  let coverageFailure: {
    command: string;
    argv: string[];
    result: ValidationCommandResult;
  } | undefined;

  for (const item of prelim) {
    const manifest = parseVitestManifest(item.result.vitestManifest);
    const lifecycleCoverageComplete =
      item.eligible &&
      io.runTrustedVitestObserver !== undefined &&
      manifest !== undefined &&
      !item.result.timedOut &&
      !item.result.cancelled &&
      vitestLifecycleReconciles(manifest);
    const lifecycleGreen =
      lifecycleCoverageComplete &&
      manifest !== undefined &&
      vitestLifecycleIsGreen(manifest);
    const coverage: ValidationCoverageStatus =
      item.adapter === undefined ? 'unsupported'
      : lifecycleCoverageComplete ? 'complete'
      : 'invalid';
    if (coverage === 'complete' && manifest !== undefined) {
      const existing = completeMappedManifests.get(item.command) ?? [];
      existing.push(manifest);
      completeMappedManifests.set(item.command, existing);
    }
    if (
      item.adapter !== undefined &&
      (coverage === 'invalid' || !lifecycleGreen) &&
      coverageFailure === undefined
    ) {
      coverageFailure = {
        command: item.command,
        argv: item.argv,
        result: {
          ...item.result,
          ...(lifecycleCoverageComplete && !lifecycleGreen ? { exitCode: 1 } : {}),
          outputTail: [
            item.result.outputTail,
            lifecycleCoverageComplete && !lifecycleGreen
              ? 'trusted Vitest lifecycle evidence recorded a red run'
              : 'trusted Vitest lifecycle evidence was missing or incomplete',
          ].filter(Boolean).join('\n'),
        },
      };
    }
    batchCommands.push({
      command: sanitizeValidationCommandIdentifier(item.argv).slice(0, 1_000),
      outcome: lifecycleCoverageComplete && !lifecycleGreen
        ? 'failed'
        : commandOutcome(item.result),
      coverage,
      ...(coverage === 'complete' && manifest !== undefined
        ? {
            discovered: { ...manifest.discovered },
            completed: { ...manifest.completed },
          }
        : {}),
    });
  }

  const validationReceipt: ValidationBatchReceipt = {
    outcome: prelim.some((item) => item.result.failureClass === 'profile-unavailable')
      ? 'profile-unavailable'
      : batchOutcome(batchCommands, drifted),
    commands: batchCommands,
    profilePlan,
    profileOutcomes: prelim.map((item, index) => {
      const manifest = parseVitestManifest(item.result.vitestManifest);
      const probe = shardProbes[index]!;
      return {
        profile: item.profile,
        ...(item.selector !== undefined ? { selector: item.selector } : {}),
        outcome: item.result.failureClass === 'profile-unavailable'
          ? 'profile-unavailable' as const
          : commandOutcome(item.result),
        probe,
        ...(manifest !== undefined
          ? { discovered: manifest.discovered, completed: manifest.completed }
          : {}),
      };
    }),
  };
  const mappedCommands = opts.adapters.map((adapter) => adapter.command);
  const mappedCoverageComplete =
    mappedCommands.length > 0 &&
    mappedCommands.every((command) => {
      const expected = adapters.get(command)?.profileSelection === 'strict-tags-v1' ? 3 : 1;
      return completeMappedManifests.get(command)?.length === expected;
    });
  const aggregateManifest = mappedCoverageComplete
    ? aggregateVitestManifests(
        mappedCommands.flatMap((command) => completeMappedManifests.get(command)!),
      )
    : undefined;
  const coverageComplete = aggregateManifest !== undefined;
  const failed = drifted
    ? {
        command: 'canonical validation identity',
        argv: [],
        result: {
          exitCode: null,
          timedOut: false,
          outputHead: '',
          outputTail: 'validation tree or fingerprint drifted',
          cancelled: false,
        },
      }
    : firstFailure ?? coverageFailure;
  if (
    failed === undefined &&
    !drifted &&
    aggregateManifest !== undefined &&
    prelim.length === profilePlan.shards.length
  ) {
    const configuredArgv = prelim.map((item) => item.argv);
    const first = prelim[0]!;
    const last = prelim.at(-1)!;
    const candidate: FullSuiteAttestation = {
      version: 2,
      treeOid: beforeTree,
      fullTaskReviewHash: opts.fullTaskReviewHash,
      validationCwd: opts.validationCwd,
      configuredArgv,
      adapter: { runner: 'vitest', version: 1 },
      ...beforeFingerprints,
      startedAt: first.startedAt,
      completedAt: last.completedAt,
      durationMs: Math.max(
        0,
        Date.parse(last.completedAt) - Date.parse(first.startedAt),
      ),
      execution: {
        outcome: 'passed',
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      },
      coverage: { status: 'complete', manifest: aggregateManifest },
      profilePlan,
      profileOutcomes: validationReceipt.profileOutcomes ?? [],
    };
    const validated = validateFullSuiteAttestation(candidate, {
      treeOid: beforeTree,
      fullTaskReviewHash: opts.fullTaskReviewHash,
      validationCwd: opts.validationCwd,
      configuredArgv,
      ...beforeFingerprints,
      profilePlan,
    });
    if (validated.ok) {
      attestations.push(validated.attestation);
      receipts.push(compactValidationReceipt(validated.attestation));
    }
  }
  if (
    failed === undefined &&
    !drifted &&
    mappedCommands.length === 0 &&
    prelim.length === profilePlan.shards.length
  ) {
    receipts.push({
      version: 2,
      command: prelim
        .map((item) => sanitizeValidationCommandIdentifier(item.argv))
        .join(' + ')
        .slice(0, 1_000),
      treeOid: beforeTree,
      fullTaskReviewHash: opts.fullTaskReviewHash,
      outcome: 'passed',
      coverage: 'unsupported',
      completedAt: prelim.at(-1)?.completedAt ?? new Date().toISOString(),
      profilePlan,
      profileOutcomes: validationReceipt.profileOutcomes,
    });
  }
  const completedAt = prelim.at(-1)?.completedAt ?? new Date().toISOString();
  const gateValidationReceipt = drifted
    ? undefined
    : buildGateValidationReceipt({
        treeOid: beforeTree,
        fullTaskReviewHash: opts.fullTaskReviewHash,
        completedAt,
        fingerprints: beforeFingerprints,
        batch: validationReceipt,
      });
  if (failed !== undefined) {
    return {
      ok: false,
      command: failed.command,
      ...(failed.argv.length > 0 ? { argv: failed.argv } : {}),
      result: failed.result,
      attestations,
      receipts,
      coverageComplete: false,
      validationReceipt,
      ...(gateValidationReceipt !== undefined ? { gateValidationReceipt } : {}),
    };
  }
  return {
    ok: true,
    attestations,
    receipts,
    coverageComplete,
    validationReceipt,
    ...(gateValidationReceipt !== undefined ? { gateValidationReceipt } : {}),
  };
}

function parseGitPathList(raw: string): string[] {
  return raw
    .split('\0')
    .filter(Boolean)
    .map((path) => normalize(path).replaceAll('\\', '/').replace(/^\.\//, ''))
    .filter((path) => path !== '.' && !path.startsWith('../'));
}

/** Current task files: tracked changes against HEAD plus untracked files. */
export async function collectTaskChangedPaths(
  cwd: string,
  runGit: GitRunner = defaultRunGit,
): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    runGit(['diff', '--name-only', '-z', '--diff-filter=ACMRTUXB', 'HEAD', '--'], { cwd }),
    runGit(['ls-files', '--others', '--exclude-standard', '-z', '--'], { cwd }),
  ]);
  return [...new Set([
    ...parseGitPathList(tracked.stdout),
    ...parseGitPathList(untracked.stdout),
  ])];
}

/** Deletions and global runner/config files cannot be mapped safely by
 * `vitest related`; callers must fall back to product validation commands. */
export async function taskChangesRequireFullValidation(
  cwd: string,
  changedPaths: readonly string[],
  runGit: GitRunner = defaultRunGit,
): Promise<boolean> {
  const pathArgs = changedPaths.map((path) => path.startsWith('-') ? `./${path}` : path);
  const argv = ['npx', 'vitest', 'related', '--run', '--passWithNoTests', ...pathArgs];
  if (!relatedTestInvocationSelectionFits(pathArgs, argv)) return true;
  const deleted = await runGit(['diff', '--name-only', '-z', '--diff-filter=D', 'HEAD', '--'], { cwd });
  if (parseGitPathList(deleted.stdout).length > 0) return true;
  return changedPaths.some((path) => /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig(?:\..+)?\.json|(?:vitest|vite|next)\.config\.[^/]+|scripts\/register-ts\.mjs)$/.test(path));
}

/**
 * Run a product validation command list in `cwd`, stopping at the first failed
 * or timed-out command. An empty list is a pass for callers that intentionally
 * allow "no task-scoped checks"; the merge gate still fail-closes on missing
 * commands before it calls into this helper.
 */
export async function runValidationCommands(
  commands: readonly string[],
  cwd: string,
  timeoutMs: number,
  runValidationCommand: GateRuntimeIO['runValidationCommand'] = defaultRunValidationCommand,
  diagnosticDir?: string,
  profileContract?: {
    commandProfiles: readonly ValidationCommandProfile[];
    adapters?: readonly ValidationAdapter[];
  },
): Promise<ValidationCommandListResult> {
  let shards: Array<{
    command: string;
    argv: string[];
    profile: ValidationProfile | undefined;
    selector?: string;
  }>;
  if (profileContract !== undefined) {
    try {
      shards = planValidationProfiles({
        commands,
        commandProfiles: profileContract.commandProfiles,
        adapters: profileContract.adapters ?? [],
        parseCommand: parseValidationCommand,
      }).shards;
    } catch {
      return {
        ok: false,
        command: 'validation profile plan',
        result: {
          exitCode: null,
          timedOut: false,
          outputTail: 'validation profile plan was invalid',
          failureClass: 'profile-unavailable',
        },
      };
    }
  } else {
    shards = commands.map((command) => {
      const parsed = parseValidationCommand(command);
      return { command, argv: parsed.ok ? parsed.argv : [], profile: undefined };
    });
  }
  const usesRealLauncher = runValidationCommand === defaultRunValidationCommand;
  const probed = new Set<ValidationProfile>();
  for (const shard of shards) {
    const unavailable = (reason: string): ValidationCommandListResult => ({
      ok: false,
      command: shard.command,
      argv: shard.argv,
      result: {
        exitCode: null,
        timedOut: false,
        outputTail: reason,
        failureClass: 'profile-unavailable',
        ...(shard.profile !== undefined ? { profile: shard.profile } : {}),
      },
    });
    const failure = await withValidationSandboxBroker(
      usesRealLauncher ? shard.profile : undefined,
      startValidationSandboxBroker,
      async (broker): Promise<ValidationCommandListResult | undefined> => {
        if (shard.profile !== undefined && !probed.has(shard.profile)) {
          const probe = await probeValidationProfile(shard.profile, cwd, timeoutMs, broker);
          if (probe.outcome !== 'passed') {
            return unavailable(`validation profile unavailable: ${shard.profile}`);
          }
          probed.add(shard.profile);
        }
        const result = usesRealLauncher && shard.profile !== undefined
          ? await runValidationCommandArgv(shard.argv, cwd, timeoutMs, diagnosticDir, {
              profile: shard.profile,
              ...brokerGrant(broker),
            })
          : await runValidationCommand(shard.command, cwd, timeoutMs, diagnosticDir);
        if (result.timedOut || result.exitCode !== 0) {
          return { ok: false, command: shard.command, argv: shard.argv, result };
        }
        return undefined;
      },
      () => unavailable('validation sandbox-integration broker is unavailable'),
    );
    if (failure !== undefined) return failure;
  }
  return { ok: true };
}

/** Execute one Vitest file/source selection across every strict capability
 * profile. The source argv is preserved for every shard; only the deterministic
 * tag selector differs. */
export async function runProfiledVitestSelection(args: {
  command: string;
  argv: readonly string[];
  cwd: string;
  timeoutMs: number;
  diagnosticDir?: string;
  cancelled?: () => boolean;
  runCommandArgv?: typeof runValidationCommandArgv;
  probeProfile?: typeof probeValidationProfile;
  startSandboxBroker?: typeof startValidationSandboxBroker;
}): Promise<ValidationCommandListResult> {
  const runCommandArgv = args.runCommandArgv ?? runValidationCommandArgv;
  const probeProfile = args.probeProfile ?? probeValidationProfile;
  const startBroker = args.startSandboxBroker ?? startValidationSandboxBroker;
  for (const profile of VALIDATION_PROFILES) {
    const selector = validationSelectorFor(profile);
    const shardArgv = [...args.argv, `--tags-filter=${selector}`];
    const unavailable = (reason: string): ValidationCommandListResult => ({
      ok: false,
      command: args.command,
      argv: shardArgv,
      result: {
        exitCode: null,
        timedOut: false,
        cancelled: false,
        outputTail: reason,
        failureClass: 'profile-unavailable',
        profile,
      },
    });
    const failure = await withValidationSandboxBroker(
      profile,
      startBroker,
      async (broker): Promise<ValidationCommandListResult | undefined> => {
        const probe = await probeProfile(profile, args.cwd, args.timeoutMs, broker);
        if (probe.outcome !== 'passed') {
          return unavailable(`validation profile unavailable: ${profile}`);
        }
        if (args.cancelled?.() === true) {
          return {
            ok: false,
            command: args.command,
            argv: shardArgv,
            result: {
              exitCode: null,
              timedOut: false,
              cancelled: true,
              outputTail: 'validation cancelled before command launch',
              profile,
            },
          };
        }
        const result = await runCommandArgv(
          shardArgv,
          args.cwd,
          args.timeoutMs,
          args.diagnosticDir,
          {
            profile,
            ...(args.cancelled !== undefined ? { cancelled: args.cancelled } : {}),
            ...brokerGrant(broker),
          },
        );
        if (result.timedOut || result.cancelled || result.exitCode !== 0) {
          return { ok: false, command: args.command, argv: shardArgv, result };
        }
        return undefined;
      },
      () => unavailable('validation sandbox-integration broker is unavailable'),
    );
    if (failure !== undefined) return failure;
  }
  return { ok: true };
}

const defaultGateRuntimeIO = (): GateRuntimeIO => ({
  runGit: defaultRunGit,
  runValidationCommand: defaultRunValidationCommand,
});

/**
 * Gather the gate's facts in an integration worktree and decide via
 * `evaluateGate`. The product repo's `baseBranch` is never mutated here — a red
 * result leaves local `main` byte-for-byte unchanged (req 13).
 *
 * Flow: create a DETACHED integration worktree at `baseBranch`'s commit
 * (`--detach` avoids git's "branch already checked out" refusal since the
 * product repo has `baseBranch` checked out) → dry-merge the feature branch into
 * it to probe for a conflict → if clean, check the merged tree is clean and run
 * each validation command in the integration worktree → assemble `GateFacts` and
 * decide. The throwaway worktree is always torn down in `finally`, so a red gate
 * or a thrown git/validation error never leaks it.
 *
 * @precondition The caller MUST hold the per-product/per-base-branch merge lock
 * (`withBaseBranchLock`, work-run-merge-lock.ts) — two concurrent `runGate`s for
 * the same product would collide on the integration worktree path / base branch.
 * `runGate` does not acquire the lock itself; `concurrentRun` is a pre-gathered
 * fact, not the lock.
 */
export async function runGate(
  opts: GateRuntimeOpts,
  io: GateRuntimeIO = defaultGateRuntimeIO(),
): Promise<GateResult> {
  const { runGit, runValidationCommand } = io;
  const hasValidationCommands = opts.validationCommands.length > 0;

  // Create the throwaway integration worktree in DETACHED HEAD at baseBranch.
  // Inside the try so a partial `worktree add` failure still hits the finally
  // teardown (git can leave a half-initialized dir on some failures).
  let worktreeCreated = false;
  try {
    await runGit(['worktree', 'add', '--detach', opts.integrationWorktree, opts.baseBranch], {
      cwd: opts.repoPath,
    });
    worktreeCreated = true;

    let mergeConflict = false;
    let treeClean = true;
    let testsGreen = true;
    let validationTimedOut = false;
    let validationCancelled = false;
    let profileUnavailable = false;
    let validationReceipt: GateValidationReceipt | undefined;

    // Conflict probe: merge the feature branch into the detached integration
    // worktree. A conflict (or ANY merge error — fail-closed) → mergeConflict;
    // abort to leave the worktree clean for teardown. This NEVER touches the
    // product repo's real baseBranch checkout — the merge runs in the
    // integration worktree.
    try {
      await runGit(['merge', '--no-ff', '-m', 'work-run gate integration merge', opts.branch], {
        cwd: opts.integrationWorktree,
      });
    } catch (err) {
      mergeConflict = true;
      // Log the (scrubbed) git stderr so a non-conflict cause (e.g. a missing
      // branch ref) is diagnosable rather than silently labelled a conflict —
      // the gate still fails closed either way (no merge).
      log.warn('gate merge probe failed; treating as merge-conflict (fail-closed)', {
        product: opts.product,
        branch: opts.branch,
        error: redactSecrets(scrubAbsolutePaths((err as Error).message)),
      });
      await runGit(['merge', '--abort'], { cwd: opts.integrationWorktree }).catch(() => {
        /* nothing to abort / already clean */
      });
    }

    if (!mergeConflict) {
      // Tree must be clean after a committed merge (before validation runs, so
      // build artifacts can't dirty this check).
      const status = await runGit(['status', '--porcelain'], { cwd: opts.integrationWorktree });
      treeClean = status.stdout.trim() === '';

      if (!hasValidationCommands) {
        testsGreen = false;
      } else {
        const validationCwd = resolveValidationCwd(
          opts.integrationWorktree,
          opts.validationCwd,
        );
        if (!validationCwd.ok) {
          testsGreen = false;
        } else {
          // Run validation commands in the validated integration-worktree
          // subdirectory. A launcher rejection is red even when the child
          // process itself exited zero: malformed or missing canonical evidence
          // must never become a green merge-gate fact.
          const expectedTreeOid = await captureValidationTree(runGit, opts.integrationWorktree);
          const validation = await runFullSuiteValidation({
            commands: opts.validationCommands,
            ...((opts.validationCommandProfiles?.length ?? 0) > 0
              ? { commandProfiles: opts.validationCommandProfiles }
              : {}),
            adapters: opts.validationAdapters ?? [],
            worktree: opts.integrationWorktree,
            cwd: validationCwd.cwd,
            validationCwd: opts.validationCwd?.trim() || '.',
            expectedTreeOid,
            fullTaskReviewHash: sha256(`merge-gate:${expectedTreeOid}`),
            timeoutMs: opts.commandTimeoutMs,
            ...(opts.validationArtifactsDir !== undefined
              ? { diagnosticDir: opts.validationArtifactsDir }
              : {}),
            continueOnFailure: true,
            ...(opts.cancelled !== undefined ? { cancelled: opts.cancelled } : {}),
          }, {
            runGit,
            runCommand: (command, argv, cwd, timeoutMs, diagnosticDir, options) =>
              runValidationCommand === defaultRunValidationCommand
                ? runValidationCommandArgv(argv, cwd, timeoutMs, diagnosticDir, options)
                : runValidationCommand(command, cwd, timeoutMs, diagnosticDir),
            ...(runValidationCommand === defaultRunValidationCommand
              ? {
                  runTrustedVitestObserver,
                  ...productionFullSuiteProfileIO(),
                }
              // An injected command runner replaces the launcher outright, so
              // there is no real profile for admission to prove. Declare that
              // rather than leaving both hooks silently absent.
              : { trustedProfileAdmission: true as const }),
          });
          validationReceipt = validation.gateValidationReceipt;
          if (!validation.ok || validationReceipt === undefined) {
            validationTimedOut =
              validation.validationReceipt.outcome === 'timed-out';
            validationCancelled =
              validation.validationReceipt.outcome === 'cancelled';
            profileUnavailable =
              validation.validationReceipt.outcome === 'profile-unavailable';
            testsGreen = false;
          }
        }
      }
    }

    const facts: GateFacts = {
      hasValidationCommands,
      concurrentRun: opts.concurrentRun,
      tasksRemaining: opts.tasksRemaining,
      treeClean,
      testsGreen,
      validationTimedOut,
      validationCancelled,
      profileUnavailable,
      mergeConflict,
    };
    const verdict = evaluateGate(facts);
    return validationReceipt === undefined
      ? verdict
      : { ...verdict, validationReceipt };
  } finally {
    // Always tear down the throwaway worktree — best-effort, never throws out of
    // the finally (a teardown failure must not mask the gate result). Skip if
    // `worktree add` itself failed (nothing to remove).
    if (worktreeCreated) {
      await runGit(['worktree', 'remove', '--force', opts.integrationWorktree], {
        cwd: opts.repoPath,
      }).catch((err) => {
        log.warn('integration worktree teardown failed', {
          product: opts.product,
          error: redactSecrets(scrubAbsolutePaths((err as Error).message)),
        });
      });
    }
    removeVitestCache(opts.integrationWorktree);
  }
}
