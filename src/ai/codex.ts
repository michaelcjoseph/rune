/**
 * Codex CLI wrapper — the spawn primitive for the OpenAI Codex executor.
 * Project 08-intent-layer Phase 6 A5.1: enables Layer 5 (multi-model dispatch)
 * to drive `codex exec` as a peer to `runAgent`/Claude.
 *
 * This module is intentionally lean. It mirrors the spawn surface of
 * `src/ai/claude.ts` — binary resolution, child spawn, timeout, graceful-
 * shutdown registration — and exposes optional stdout/JSONL stream callbacks.
 * User-facing op tracking and prompt-prepending (learnings, voice, date
 * context) belong in the dispatch adapter (A5.2, `dispatchToExecutor`) or in
 * callers that want them; the wrapper itself is the minimum a dispatcher needs.
 *
 * Graceful shutdown: each spawn registers with the `activeProcesses` set in
 * `src/ai/claude.ts` via `registerActiveProcess`/`unregisterActiveProcess`,
 * so `killActiveProcesses()` reaches both Claude and Codex children on
 * SIGTERM. Keeping one registry avoids drifting two parallel sets.
 *
 * See spec.md §"Layer 5 — Multi-model dispatch", tasks.md Phase 6 A5.1.
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import config, { PROJECT_ROOT } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { redactSecrets } from '../utils/redact-secrets.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import {
  registerActiveProcess,
  signalActiveProcess,
  unregisterActiveProcess,
} from './claude.js';
import { scrubPathsInText } from './tool-labels.js';
import {
  getCancellation,
  registerOp,
  unregisterOp,
} from '../transport/in-flight.js';
import type { OperationCancellation } from '../cancellation.js';
import type { OpKind } from '../transport/notification-bus.js';
import {
  runBoundedProcess,
  type AiExecutorProbeResult,
  type BoundedProcessResult,
} from './bounded-process.js';

const log = createLogger('codex');

const HOMEBREW_FALLBACK = '/opt/homebrew/bin/codex';
const PROBE_STDERR_MAX_CHARS = 500;
export const CODEX_PROBE_RUNTIME_ROOT = join(PROJECT_ROOT, '.rune', 'codex-preflight');

/** A bounded diagnostic may cross into a run transcript, unlike raw CLI output. */
function safeProbeStderr(stderr: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = redactSecrets(
    scrubAbsolutePaths(scrubPathsInText(stderr))
      .replace(/\/(?:Users|home|private|var|tmp)\/[A-Za-z0-9_./-]+/g, '<host-path>'),
    Object.values(env).filter((item): item is string => typeof item === 'string'),
  )
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, PROBE_STDERR_MAX_CHARS);
  return value || undefined;
}

/** Resolve the path to the `codex` binary — `which codex` first, then a
 *  Homebrew default (the canonical install path on Apple Silicon macOS).
 *  Throws with a clear message when neither is found.
 *
 *  Note: this throws on miss rather than returning null because the
 *  resolved path is the only useful thing to return on success and the
 *  caller (A5.3's availability probe) wants the diagnostic message in the
 *  error path. Use `isCodexAvailable()` for a boolean check. */
export function resolveCodexPath(): string {
  try {
    const path = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim();
    if (path) return path;
  } catch {
    // fall through to the homebrew fallback
  }
  if (existsSync(HOMEBREW_FALLBACK)) return HOMEBREW_FALLBACK;
  throw new Error(
    `Codex CLI not found in PATH or ${HOMEBREW_FALLBACK}. ` +
      `Install from https://github.com/openai/codex or via Homebrew.`,
  );
}

/** Lazily-resolved path to the Codex CLI binary. The first `runCodex` call
 *  resolves the path; subsequent calls reuse it. Lazy (vs. CLAUDE_BIN's
 *  module-load fail-fast) because Codex is the optional second executor —
 *  Rune must boot and serve Claude-backed features on machines without
 *  Codex installed. A5.3's provider-availability probe (`isCodexAvailable`)
 *  also depends on this being non-throwing at import time. */
let _codexBin: string | null = null;

export function getCodexBin(): string {
  if (_codexBin === null) _codexBin = resolveCodexPath();
  return _codexBin;
}

export interface CodexExecutorProbeOpts {
  binaryPath?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  model?: string;
  configOverrides?: string[];
  /** Existing outer Seatbelt profile, used for an artifact-MCP authentication
   * probe. Ordinary probes get a private sensitive-read-deny profile below. */
  sandboxProfilePath?: string;
}

type CodexProbeProcessResult =
  | { status: 'process'; result: BoundedProcessResult }
  | { status: 'probe-failure'; code: 'not-authenticated' | 'sandbox-unavailable' | 'sandbox-setup-failed' | 'cleanup-failed' };

function seatbeltLiteral(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function safeProbeEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'USER', 'LANG', 'LC_ALL', 'TERM', 'SHELL'] as const) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function codexAuthSource(env: NodeJS.ProcessEnv): string {
  const sourceHome = env['CODEX_HOME'] ?? join(env['HOME'] ?? homedir(), '.codex');
  return join(sourceHome, 'auth.json');
}

function createCodexProbeRuntime(): string {
  // Codex creates app-server helper binaries under CODEX_HOME but refuses to
  // place them in the OS temporary directory. Keep each runtime private and
  // short-lived under Rune's repo-owned cache root instead.
  mkdirSync(CODEX_PROBE_RUNTIME_ROOT, { recursive: true, mode: 0o700 });
  chmodSync(CODEX_PROBE_RUNTIME_ROOT, 0o700);
  const projectRoot = realpathSync(PROJECT_ROOT);
  const runtimeRoot = realpathSync(CODEX_PROBE_RUNTIME_ROOT);
  if (!runtimeRoot.startsWith(`${projectRoot}/`)) {
    throw new Error('Codex probe runtime root resolves outside the Rune repository');
  }
  return mkdtempSync(join(runtimeRoot, 'probe-'));
}

function buildCodexProbeProfile(
  profilePath: string,
  runtimeDir: string,
  binaryPath: string,
  deniedReadRoots: readonly string[],
): void {
  const realBinary = realpathSync(binaryPath);
  writeFileSync(profilePath, [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath "${seatbeltLiteral(runtimeDir)}"))`,
    '(allow file-write* (subpath "/dev"))',
    ...[...new Set(deniedReadRoots)].map((path) =>
      `(deny file-read* (subpath "${seatbeltLiteral(path)}"))`),
    // The executable is copied into the private runtime before this profile
    // is generated, so only that probe-owned copy needs an explicit rule.
    `(allow file-read* (literal "${seatbeltLiteral(binaryPath)}"))`,
    `(allow file-read* (literal "${seatbeltLiteral(realBinary)}"))`,
    `(deny file-read* (literal "${seatbeltLiteral(profilePath)}"))`,
    // Codex's in-process app-server client uses loopback during startup. This
    // profile is only for the tool-free readiness probe; the artifact-role
    // profile retains its raw-localhost deny plus the explicit MCP relay.
  ].join('\n'), { mode: 0o600 });
}

async function boundedCodexProbe(
  args: string[],
  opts: CodexExecutorProbeOpts,
): Promise<CodexProbeProcessResult> {
  const binary = opts.binaryPath ?? getCodexBin();
  if (opts.sandboxProfilePath !== undefined) {
    const result = await runBoundedProcess(
      '/usr/bin/sandbox-exec',
      ['-f', opts.sandboxProfilePath, binary, ...args],
      {
        cwd: opts.cwd,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
        register: registerActiveProcess,
        unregister: unregisterActiveProcess,
      },
    );
    return { status: 'process', result };
  }
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
    return { status: 'probe-failure', code: 'sandbox-unavailable' };
  }

  const authSource = codexAuthSource(opts.env);
  if (!existsSync(authSource) || !statSync(authSource).isFile()) {
    return { status: 'probe-failure', code: 'not-authenticated' };
  }
  const runtimeDir = createCodexProbeRuntime();
  const privateCodexHome = join(runtimeDir, 'codex-home');
  const privateBinary = join(runtimeDir, 'codex');
  const profilePath = join(runtimeDir, 'probe.sb');
  let processResult: BoundedProcessResult;
  try {
    mkdirSync(privateCodexHome, { mode: 0o700 });
    copyFileSync(authSource, join(privateCodexHome, 'auth.json'));
    chmodSync(join(privateCodexHome, 'auth.json'), 0o600);
    copyFileSync(realpathSync(binary), privateBinary);
    chmodSync(privateBinary, 0o700);
    const deniedReadRoots = [
      opts.env['HOME'],
      opts.env['CODEX_HOME'],
      homedir(),
      PROJECT_ROOT,
      config.VAULT_DIR,
    ].filter((path): path is string => typeof path === 'string' && path !== '' && path !== runtimeDir)
      .flatMap((path) => {
        try { return [path, realpathSync(path)]; } catch { return [path]; }
      })
      // The private runtime is deliberately repo-owned, so its ancestors
      // cannot be denied without also denying the probe's own cwd. This is
      // safe here because the probe exposes no model tools or MCP servers.
      .filter((path) => path !== runtimeDir && !runtimeDir.startsWith(`${path}/`));
    buildCodexProbeProfile(profilePath, runtimeDir, privateBinary, deniedReadRoots);
    const env = {
      ...safeProbeEnv(opts.env),
      HOME: runtimeDir,
      CODEX_HOME: privateCodexHome,
      TMPDIR: runtimeDir,
    };
    processResult = await runBoundedProcess(
      '/usr/bin/sandbox-exec',
      ['-f', profilePath, privateBinary, ...args],
      {
        cwd: runtimeDir,
        env,
        timeoutMs: opts.timeoutMs,
        register: registerActiveProcess,
        unregister: unregisterActiveProcess,
      },
    );
  } catch {
    try { rmSync(runtimeDir, { recursive: true, force: true }); }
    catch { return { status: 'probe-failure', code: 'cleanup-failed' }; }
    return { status: 'probe-failure', code: 'sandbox-setup-failed' };
  }
  try {
    rmSync(runtimeDir, { recursive: true, force: true });
  } catch {
    return { status: 'probe-failure', code: 'cleanup-failed' };
  }
  return { status: 'process', result: processResult };
}

function mapProbeProcessFailure(result: CodexProbeProcessResult): AiExecutorProbeResult | null {
  if (result.status === 'probe-failure') return { ok: false, code: result.code };
  if (result.result.status === 'timed-out') return { ok: false, code: 'timeout' };
  if (result.result.status === 'spawn-error') return { ok: false, code: 'spawn-failed' };
  return null;
}

/** Subscription-login probe. API keys are deliberately omitted by the private
 * runtime so a green result proves the same persisted Codex login that artifact
 * execution seeds into its isolated home. */
export async function probeCodexAuthentication(
  opts: CodexExecutorProbeOpts,
): Promise<AiExecutorProbeResult> {
  const result = await boundedCodexProbe(['login', 'status'], opts);
  const failure = mapProbeProcessFailure(result);
  if (failure !== null) return failure;
  if (result.status !== 'process' || result.result.status !== 'completed') {
    return { ok: false, code: 'invalid-response' };
  }
  if (result.result.exitCode !== 0) {
    const diagnostic = safeProbeStderr(result.result.stderr, opts.env);
    return { ok: false, code: 'not-authenticated', ...(diagnostic !== undefined ? { diagnostic } : {}) };
  }
  const loggedIn = [result.result.stdout, result.result.stderr]
    .some((stream) => /(?:^|\n)Logged in\b/im.test(stream));
  return loggedIn ? { ok: true } : { ok: false, code: 'not-authenticated' };
}

function validCodexCompletion(stdout: string): AiExecutorProbeResult {
  let sawMessage = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { ok: false, code: 'invalid-response' };
    }
    const item = parsed['item'];
    if (parsed['type'] !== 'item.completed' || item === null || typeof item !== 'object') continue;
    const itemType = (item as Record<string, unknown>)['type'];
    if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(String(itemType))) {
      return { ok: false, code: 'tool-attempt' };
    }
    if (itemType === 'agent_message' && (item as Record<string, unknown>)['text'] === 'OK') {
      sawMessage = true;
    }
  }
  return sawMessage ? { ok: true } : { ok: false, code: 'invalid-response' };
}

/** Exact-model Codex probe with execution features disabled and a private
 * sensitive-read-deny Seatbelt boundary as defense in depth. */
export async function probeCodexModelCall(
  opts: CodexExecutorProbeOpts & { model: string },
): Promise<AiExecutorProbeResult> {
  const args = [
    'exec', '--ephemeral', '--skip-git-repo-check',
    '-m', opts.model,
    '--dangerously-bypass-approvals-and-sandbox',
    '--json', '--strict-config', '--ignore-user-config', '--ignore-rules',
    '-c', 'mcp_servers={}',
    '-c', 'web_search="disabled"',
    '-c', 'hooks={}',
    '-c', 'features.apps=false',
    '-c', 'features.remote_plugin=false',
    '-c', 'features.shell_tool=false',
    '-c', 'features.unified_exec=false',
    '-c', 'features.multi_agent=false',
    '-c', 'features.computer_use=false',
    '-c', 'features.browser_use=false',
    '-c', 'shell_environment_policy.inherit="none"',
    ...(opts.configOverrides ?? []).flatMap((override) => ['-c', override]),
    'Reply with exactly OK. Do not use tools.',
  ];
  const result = await boundedCodexProbe(args, opts);
  const failure = mapProbeProcessFailure(result);
  if (failure !== null) return failure;
  if (result.status !== 'process' || result.result.status !== 'completed') {
    return { ok: false, code: 'invalid-response' };
  }
  if (result.result.exitCode !== 0) {
    const diagnostic = safeProbeStderr(result.result.stderr, opts.env);
    return { ok: false, code: 'nonzero-exit', ...(diagnostic !== undefined ? { diagnostic } : {}) };
  }
  return validCodexCompletion(result.result.stdout);
}

/** Returns `true` when the Codex CLI is resolvable. Non-throwing — used by
 *  the provider-availability probe (`probeCodexProvider`) and by callers
 *  that need to feature-gate Codex paths without trapping a thrown error. */
export function isCodexAvailable(): boolean {
  try {
    getCodexBin();
    return true;
  } catch {
    return false;
  }
}

/** Hard timeout for the login-status probe — long enough for cold CLI
 *  startup, short enough that a hung probe doesn't pin the dispatcher. */
const LOGIN_PROBE_TIMEOUT_MS = 10_000;

/** Spawns `codex login status` and returns true iff the CLI reports the
 *  session is authenticated. Non-throwing — any spawn error, non-zero exit,
 *  missing "Logged in" marker, or probe timeout resolves to `false`. Cheap
 *  to call (the CLI exits in milliseconds) but a 10s hard cap protects the
 *  caller from a hung probe blocking the dispatcher indefinitely. */
export async function isCodexLoggedIn(): Promise<boolean> {
  let bin: string;
  try {
    bin = getCodexBin();
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const finish = (value: boolean): void => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    try {
      // Both streams are piped and drained: the current Codex CLI prints the
      // "Logged in using ChatGPT" marker to STDERR (stdout empty), so reading
      // stdout alone false-negatives and fail-closes the orchestrated path.
      // Draining stderr (rather than 'ignore') also prevents the pipe-buffer
      // deadlock the old comment warned about — `login status` emits a single
      // short line, well under the OS buffer.
      const child = spawn(bin, ['login', 'status'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(false);
      }, LOGIN_PROBE_TIMEOUT_MS);
      child.stdout.on('data', (data: Buffer) => {
        stdout += data;
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data;
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // Start-anchored so "Not logged in" (the logged-out case) doesn't
        // false-positive against "Logged in" (the substring it contains).
        // Checked per-stream so a logged-out marker on one stream can't be
        // rescued by unrelated text on the other.
        const loggedIn =
          /^Logged in/i.test(stdout.trim()) || /^Logged in/i.test(stderr.trim());
        finish(code === 0 && loggedIn);
      });
    } catch {
      finish(false);
    }
  });
}

/** Discriminated availability result returned by `probeCodexProvider`. */
export type ProviderAvailability =
  | { available: true }
  | { available: false; reason: string };

/** Non-throwing combined probe — binary present AND session authenticated.
 *  The probe is the gatekeeper `dispatchToExecutor` consults before spawning
 *  a Codex run; an unavailable probe short-circuits with a failed
 *  `DispatchResult` so the merge contract's null-adjudication path applies
 *  cleanly. */
export async function probeCodexProvider(): Promise<ProviderAvailability> {
  if (!isCodexAvailable()) {
    return { available: false, reason: 'codex binary not found in PATH' };
  }
  if (!(await isCodexLoggedIn())) {
    return {
      available: false,
      reason: 'codex is installed but not logged in — run `codex login` to authenticate',
    };
  }
  return { available: true };
}

/** Codex sandbox policy — passed via `-s` to a fresh `codex exec`, or as a
 *  `sandbox_mode="<mode>"` config override to `codex exec resume`. */
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

interface RunCodexBaseOpts {
  /** Working directory for the child process. Defaults to `PROJECT_ROOT`. */
  cwd?: string;
  /** Model alias passed via `-m` (e.g. `o4-mini`). When omitted, the Codex
   *  CLI uses whatever its config.toml resolves. */
  model?: string;
  /** Overall timeout in ms; defaults to `config.CLAUDE_TIMEOUT_MS` so the
   *  two executors share one operational budget. */
  timeoutMs?: number;
  /** Environment for the child process. When set, replaces the default
   *  full `process.env` spread.
   *
   *  **Sandbox callers MUST pass an env**: A5.2's `dispatchToExecutor`
   *  drives runs against product worktrees and must supply
   *  `buildSandboxEnv(sandbox, …)` from `src/jobs/credential-injector.ts`,
   *  not rely on the default — the default leaks every Rune secret
   *  (TELEGRAM_BOT_TOKEN, RUNE_HTTP_SECRET, …) into the product child,
   *  violating the credential-isolation invariant the sandbox layer
   *  enforces. Non-sandboxed callers (internal Rune dispatches) keep
   *  the default. */
  env?: NodeJS.ProcessEnv;
  /** Optional raw stdout observer. Receives each stdout chunk as emitted by
   *  the child process, before the final collected `text` is trimmed. */
  onStdout?: (chunk: string) => void;
  /** Optional JSONL event observer. When set, `runCodex` requests
   *  `codex exec --json` and calls this once for each complete stdout line:
   *  parsed JSON objects are delivered as-is; malformed lines are delivered
   *  as a scrubbed raw fallback event instead of crashing the run. */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Keep the Codex thread on disk so a later call can resume it. Existing
   * callers remain ephemeral unless they explicitly opt in. */
  persistentSession?: boolean;
  /** Resume a previously-created persistent Codex thread. */
  resumeSessionId?: string;
  /** User-facing operation tracking for interactive chat calls. */
  opLabel?: string;
  /** Operation category for non-chat callers that share this executor. */
  opKind?: OpKind;
  /** Role/agent attribution for operation feeds. */
  agentName?: string;
  /** Optional product scope attached to the operation feed. */
  product?: string;
  /** Internal correlation for bounded sibling operations; never user-facing. */
  batchId?: string;
  /** Raw `-c key=value` overrides passed as separate argv values. Sandboxed
   * artifact callers use this to replace the complete `mcp_servers` table. */
  configOverrides?: string[];
  /** Skip `$CODEX_HOME/config.toml` for controlled automation. Project
   * configuration and explicit `-c` overrides still apply. */
  ignoreUserConfig?: boolean;
  /** Skip user and project exec-policy `.rules` files for controlled
   * automation. */
  ignoreRules?: boolean;
  /** Fail when Codex encounters an unknown configuration key. Controlled
   * automation uses this so security-critical overrides fail closed after CLI
   * upgrades instead of being silently ignored. */
  strictConfig?: boolean;
}

/** Sandbox authority is deliberately exclusive: Codex may apply its own
 * sandbox, or it may bypass sandboxing because the whole process tree is
 * already externally enclosed, but it may never do both. */
export type RunCodexOpts = RunCodexBaseOpts & (
  | {
      /** Sandbox policy passed via `-s` for fresh runs and `-c sandbox_mode=…`
       *  for resumed runs. */
      sandboxMode?: CodexSandboxMode;
      externallySandboxed?: false;
      sandboxProfilePath?: never;
    }
  | {
      /** Emit Codex's explicit external-sandbox bypass flag. */
      externallySandboxed: true;
      /** Required macOS Seatbelt profile that encloses the process tree. */
      sandboxProfilePath: string;
      sandboxMode?: never;
    }
);

export interface CodexResult {
  /** Standard output collected from the child, or null on spawn error. */
  text: string | null;
  /** Stderr text (when exit code is non-zero), a synthetic error message
   *  on timeout or spawn-error, or null on success. */
  error: string | null;
  /** Process exit code when the child closed cleanly; undefined when the
   *  process never produced one (spawn error, timeout-killed). */
  exitCode?: number;
  /** Durable process-level outcome for callers that must distinguish a
   * failed spawn, timeout, and ordinary non-zero executor exit. */
  failureKind?: 'spawn' | 'timeout' | 'executor-exit';
  /** Structured first-request cancellation captured before the operation is
   * unregistered. */
  cancellation?: OperationCancellation;
}

/**
 * Spawn `codex exec` with the given prompt and resolve when the child
 * closes. Collects stdout into `text`, stderr into `error` on a non-zero
 * exit, and returns a clear error string on timeout or spawn failure.
 *
 * The child is registered with `activeProcesses` via
 * `registerActiveProcess` for the duration of the run, so the global
 * `killActiveProcesses()` path reaches it on shutdown. Unregistration
 * fires on every terminal path (close, error, timeout) so the registry
 * stays drained.
 *
 * Always-on flags:
 * - `--ephemeral` — Codex's equivalent of Claude's `--no-session-persistence`.
 *   Each run is independent; the dispatcher decides what context to pass.
 * - `--skip-git-repo-check` — Codex normally refuses to run outside a git
 *   repo. The dispatcher targets product worktrees that are themselves git
 *   repos, but other callers (the dispatch log, tests) may run outside;
 *   skipping the check keeps the wrapper portable.
 */
export async function runCodex(
  prompt: string,
  opts: RunCodexOpts = {},
): Promise<CodexResult> {
  if (opts.externallySandboxed && opts.sandboxMode) {
    throw new Error('RunCodexOpts externallySandboxed and sandboxMode are mutually exclusive');
  }
  if (opts.externallySandboxed && !opts.sandboxProfilePath) {
    throw new Error('RunCodexOpts externallySandboxed requires sandboxProfilePath');
  }
  if (!opts.externallySandboxed && opts.sandboxProfilePath) {
    throw new Error('RunCodexOpts sandboxProfilePath requires externallySandboxed');
  }
  const timeout = opts.timeoutMs ?? config.CLAUDE_TIMEOUT_MS;
  const cwd = opts.cwd ?? PROJECT_ROOT;

  const args: string[] = ['exec'];
  if (opts.resumeSessionId) args.push('resume');
  if (!opts.persistentSession) args.push('--ephemeral');
  args.push('--skip-git-repo-check');
  if (opts.model) args.push('-m', opts.model);
  // `codex exec resume` does not accept `-s`, so explicitly reassert the
  // selected authority through its TOML config override instead.
  if (opts.sandboxMode && !opts.resumeSessionId) args.push('-s', opts.sandboxMode);
  if (opts.externallySandboxed) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  if (opts.onEvent) args.push('--json');
  if (opts.strictConfig) args.push('--strict-config');
  if (opts.ignoreUserConfig) args.push('--ignore-user-config');
  if (opts.ignoreRules) args.push('--ignore-rules');
  if (opts.sandboxMode && opts.resumeSessionId) {
    args.push('-c', `sandbox_mode=${JSON.stringify(opts.sandboxMode)}`);
  }
  for (const override of opts.configOverrides ?? []) args.push('-c', override);
  if (opts.resumeSessionId) args.push(opts.resumeSessionId);
  // Prompt is the final positional arg — matches the CLI's documented usage.
  args.push(prompt);

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result: CodexResult): void => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    const codexBin = getCodexBin();
    const command = opts.sandboxProfilePath ? '/usr/bin/sandbox-exec' : codexBin;
    const commandArgs = opts.sandboxProfilePath
      ? ['-f', opts.sandboxProfilePath, codexBin, ...args]
      : args;
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Allow correlated judgment cleanup to signal the complete CLI tree.
      detached: process.platform !== 'win32',
      // Default inherits env so OPENAI_API_KEY, CODEX_HOME, etc. reach the
      // child. Sandbox callers must pass an explicit `opts.env` built via
      // `buildSandboxEnv` — see the JSDoc on `RunCodexOpts.env`.
      env: opts.env ?? { ...process.env },
    });

    registerActiveProcess(child, process.platform !== 'win32');
    const op = opts.opLabel ? registerOp({
      kind: opts.opKind ?? 'chat',
      label: opts.opLabel,
      ...(opts.agentName ? { agentName: opts.agentName } : {}),
      ...(opts.product ? { scope: opts.product } : {}),
      userId: config.TELEGRAM_USER_ID,
      child,
      ...(opts.batchId ? { batchId: opts.batchId } : {}),
      ...(process.platform !== 'win32' ? { processGroup: true } : {}),
    }) : null;

    let stdout = '';
    let stderr = '';
    let stdoutLineBuffer = '';

    const emitStdoutChunk = (chunk: string): void => {
      stdout += chunk;
      if (opts.onStdout) {
        try {
          opts.onStdout(chunk);
        } catch (err) {
          log.warn('codex onStdout callback failed', { error: (err as Error).message });
        }
      }
      if (!opts.onEvent) return;
      stdoutLineBuffer += chunk;
      let newlineIndex = stdoutLineBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdoutLineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
        stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
        emitStdoutEventLine(line);
        newlineIndex = stdoutLineBuffer.indexOf('\n');
      }
    };

    const emitStdoutEventLine = (line: string): void => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('stdout JSONL line is not an object');
        }
        event = parsed as Record<string, unknown>;
      } catch {
        event = { type: 'raw', line: scrubPathsInText(line) };
      }
      try {
        opts.onEvent?.(event);
      } catch (err) {
        log.warn('codex onEvent callback failed', { error: (err as Error).message });
      }
    };

    const flushStdoutEventRemainder = (): void => {
      if (!opts.onEvent || stdoutLineBuffer === '') return;
      const line = stdoutLineBuffer.replace(/\r$/, '');
      stdoutLineBuffer = '';
      emitStdoutEventLine(line);
    };

    const timer = setTimeout(() => {
      log.warn('codex exec timed out; sending SIGTERM', { timeoutMs: timeout });
      signalActiveProcess(child, 'SIGTERM');
      // The timeout-killed close handler below resolves the promise with a
      // timeout error; this only signals the child.
    }, timeout);

    // `stdio: ['ignore', 'pipe', 'pipe']` guarantees these streams exist —
    // no optional chaining; matches claude.ts and surfaces stdio config
    // mistakes loudly instead of silently dropping output.
    child.stdout.on('data', (data: Buffer) => {
      emitStdoutChunk(data.toString('utf8'));
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data;
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      unregisterActiveProcess(child);
      const cancellation = op ? getCancellation(op.opId) : undefined;
      if (op) {
        unregisterOp(
          op.opId,
          cancellation !== undefined ? 'cancelled' : 'error',
          cancellation !== undefined ? 'Cancelled by user' : err.message,
        );
      }
      log.error('codex spawn error', { error: err.message });
      finish(cancellation !== undefined
        ? { text: null, error: 'Cancelled by user', cancellation }
        : { text: null, error: err.message, failureKind: 'spawn' });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      unregisterActiveProcess(child);
      flushStdoutEventRemainder();

      const cancellation = op ? getCancellation(op.opId) : undefined;
      if (op && cancellation !== undefined) {
        unregisterOp(op.opId, 'cancelled', 'Cancelled by user');
        finish({ text: null, error: 'Cancelled by user', cancellation });
        return;
      }

      // Treat both signal=SIGTERM and code=143 (POSIX 128+SIGTERM) as the
      // timeout outcome — mirrors the Claude wrapper's convention so the
      // two executors report timeouts the same way.
      const timedOut = signal === 'SIGTERM' || code === 143;
      if (timedOut) {
        if (op) unregisterOp(op.opId, 'error', `codex exec timed out after ${timeout}ms`);
        finish({
          text: stdout || null,
          error: `codex exec timed out after ${timeout}ms`,
          failureKind: 'timeout',
        });
        return;
      }

      if (code === 0) {
        if (op) unregisterOp(op.opId, 'success');
        // Trim trailing newlines for parity with Claude's wrapper — callers
        // that compare against expected strings won't trip on a stray `\n`.
        finish({ text: stdout.trim(), error: null, exitCode: 0 });
        return;
      }

      // Non-zero exit: surface stderr verbatim when present, otherwise the
      // canonical "exited with code N" message. Match Claude's pattern.
      const error = stderr.trim() || `codex exec exited with code ${code}`;
      if (op) unregisterOp(op.opId, 'error', error);
      finish({
        text: stdout || null,
        error,
        exitCode: code ?? undefined,
        failureKind: 'executor-exit',
      });
    });
  });
}
