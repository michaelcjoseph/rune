/**
 * Codex CLI wrapper — the spawn primitive for the OpenAI Codex executor.
 * Project 08-intent-layer Phase 6 A5.1: enables Layer 5 (multi-model dispatch)
 * to drive `codex exec` as a peer to `runAgent`/Claude.
 *
 * This module is intentionally lean. It mirrors the spawn surface of
 * `src/ai/claude.ts` — binary resolution, child spawn, timeout, graceful-
 * shutdown registration — but skips the user-facing op-tracker, streaming
 * JSON parsing, and prompt-prepending (learnings, voice, date context).
 * Those wrap-around layers belong in the dispatch adapter (A5.2,
 * `dispatchToExecutor`) or in callers that want them; the wrapper itself
 * is the minimum a dispatcher needs.
 *
 * Graceful shutdown: each spawn registers with the `activeProcesses` set in
 * `src/ai/claude.ts` via `registerActiveProcess`/`unregisterActiveProcess`,
 * so `killActiveProcesses()` reaches both Claude and Codex children on
 * SIGTERM. Keeping one registry avoids drifting two parallel sets.
 *
 * See spec.md §"Layer 5 — Multi-model dispatch", tasks.md Phase 6 A5.1.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import config, { PROJECT_ROOT } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { registerActiveProcess, unregisterActiveProcess } from './claude.js';

const log = createLogger('codex');

const HOMEBREW_FALLBACK = '/opt/homebrew/bin/codex';

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
 *  Jarvis must boot and serve Claude-backed features on machines without
 *  Codex installed. A5.3's provider-availability probe (`isCodexAvailable`)
 *  also depends on this being non-throwing at import time. */
let _codexBin: string | null = null;

export function getCodexBin(): string {
  if (_codexBin === null) _codexBin = resolveCodexPath();
  return _codexBin;
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
    let resolved = false;
    const finish = (value: boolean): void => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    try {
      // stderr: 'ignore' rather than 'pipe' — the probe doesn't read stderr,
      // and an open-but-unread stderr pipe can deadlock the child if it
      // writes enough diagnostic output to fill the OS pipe buffer.
      const child = spawn(bin, ['login', 'status'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(false);
      }, LOGIN_PROBE_TIMEOUT_MS);
      child.stdout.on('data', (data: Buffer) => {
        stdout += data;
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // Start-anchored so "Not logged in" (the logged-out case) doesn't
        // false-positive against "Logged in" (the substring it contains).
        finish(code === 0 && /^Logged in/i.test(stdout.trim()));
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

/** Codex sandbox policy — passed via `-s` to `codex exec`. The Codex CLI
 *  accepts these three values; `workspace-write` is the default in
 *  `runCodex` callers that don't override. */
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface RunCodexOpts {
  /** Working directory for the child process. Defaults to `PROJECT_ROOT`. */
  cwd?: string;
  /** Model alias passed via `-m` (e.g. `o4-mini`). When omitted, the Codex
   *  CLI uses whatever its config.toml resolves. */
  model?: string;
  /** Sandbox policy passed via `-s`. When omitted, the Codex CLI defaults
   *  apply. The dispatcher (A5.2) is expected to set this explicitly for
   *  product-repo runs. */
  sandboxMode?: CodexSandboxMode;
  /** Overall timeout in ms; defaults to `config.CLAUDE_TIMEOUT_MS` so the
   *  two executors share one operational budget. */
  timeoutMs?: number;
  /** Environment for the child process. When set, replaces the default
   *  full `process.env` spread.
   *
   *  **Sandbox callers MUST pass an env**: A5.2's `dispatchToExecutor`
   *  drives runs against product worktrees and must supply
   *  `buildSandboxEnv(sandbox, …)` from `src/jobs/credential-injector.ts`,
   *  not rely on the default — the default leaks every Jarvis secret
   *  (TELEGRAM_BOT_TOKEN, JARVIS_HTTP_SECRET, …) into the product child,
   *  violating the credential-isolation invariant the sandbox layer
   *  enforces. Non-sandboxed callers (internal Jarvis dispatches) keep
   *  the default. */
  env?: NodeJS.ProcessEnv;
}

export interface CodexResult {
  /** Standard output collected from the child, or null on spawn error. */
  text: string | null;
  /** Stderr text (when exit code is non-zero), a synthetic error message
   *  on timeout or spawn-error, or null on success. */
  error: string | null;
  /** Process exit code when the child closed cleanly; undefined when the
   *  process never produced one (spawn error, timeout-killed). */
  exitCode?: number;
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
  const timeout = opts.timeoutMs ?? config.CLAUDE_TIMEOUT_MS;
  const cwd = opts.cwd ?? PROJECT_ROOT;

  const args: string[] = ['exec', '--ephemeral', '--skip-git-repo-check'];
  if (opts.model) args.push('-m', opts.model);
  if (opts.sandboxMode) args.push('-s', opts.sandboxMode);
  // Prompt is the final positional arg — matches the CLI's documented usage.
  args.push(prompt);

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result: CodexResult): void => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    const child = spawn(getCodexBin(), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Default inherits env so OPENAI_API_KEY, CODEX_HOME, etc. reach the
      // child. Sandbox callers must pass an explicit `opts.env` built via
      // `buildSandboxEnv` — see the JSDoc on `RunCodexOpts.env`.
      env: opts.env ?? { ...process.env },
    });

    registerActiveProcess(child);

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      log.warn('codex exec timed out; sending SIGTERM', { timeoutMs: timeout });
      child.kill('SIGTERM');
      // The timeout-killed close handler below resolves the promise with a
      // timeout error; this only signals the child.
    }, timeout);

    // `stdio: ['ignore', 'pipe', 'pipe']` guarantees these streams exist —
    // no optional chaining; matches claude.ts and surfaces stdio config
    // mistakes loudly instead of silently dropping output.
    child.stdout.on('data', (data: Buffer) => {
      stdout += data;
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data;
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      unregisterActiveProcess(child);
      log.error('codex spawn error', { error: err.message });
      finish({ text: null, error: err.message });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      unregisterActiveProcess(child);

      // Treat both signal=SIGTERM and code=143 (POSIX 128+SIGTERM) as the
      // timeout outcome — mirrors the Claude wrapper's convention so the
      // two executors report timeouts the same way.
      const timedOut = signal === 'SIGTERM' || code === 143;
      if (timedOut) {
        finish({
          text: stdout || null,
          error: `codex exec timed out after ${timeout}ms`,
        });
        return;
      }

      if (code === 0) {
        // Trim trailing newlines for parity with Claude's wrapper — callers
        // that compare against expected strings won't trip on a stray `\n`.
        finish({ text: stdout.trim(), error: null, exitCode: 0 });
        return;
      }

      // Non-zero exit: surface stderr verbatim when present, otherwise the
      // canonical "exited with code N" message. Match Claude's pattern.
      const error = stderr.trim() || `codex exec exited with code ${code}`;
      finish({ text: stdout || null, error, exitCode: code ?? undefined });
    });
  });
}
