/**
 * Execution-agent primitive (project 14, Phase 8 — live execution binding).
 *
 * The production session behind the ARTIFACT roles (coder, QA test authoring):
 * a tool-using, worktree-scoped run that takes a role/task prompt plus the
 * policy-resolved model binding, drives the matching CLI executor inside the
 * run's sandboxed worktree with scoped credentials, and returns the work
 * product as a captured `git diff`.
 *
 * Capture is stage-then-diff (`git add -A` → `git diff HEAD`) so NEW files —
 * a routine part of a task's work product — appear in the diff alongside
 * tracked-file edits. Staging inside the throwaway worktree is safe: the
 * orchestrator's closeout commit stages `-A` anyway, and the worktree is never
 * the live repo.
 *
 * Executor dispatch branches on the binding's `format`:
 *   - `codex`  → `runCodex` (OpenAI executor; `workspace-write` sandbox)
 *   - `claude` → a Claude CLI spawn mirroring gen-eval-loop-runner's worktree
 *                spawn (project-MCP isolation, `--dangerously-skip-permissions`,
 *                `--model <alias>`, active-process registration for graceful
 *                shutdown)
 *
 * Every failure — spawn error, executor-reported error, git capture failure —
 * returns structured `{ok:false}` evidence; the primitive never throws into
 * the workflow. IO is injected (`spawnAgent` / `runGit` / `buildEnv`) so the
 * diff-capture contract runs on fixtures with no live model call.
 *
 * See docs/projects/14-product-team-agents/spec.md §Phase 8.
 */

import { spawn } from 'node:child_process';
import config from '../config.js';
import {
  CLAUDE_BIN,
  getProjectMcpArgs,
  registerActiveProcess,
  unregisterActiveProcess,
} from '../ai/claude.js';
import { runCodex } from '../ai/codex.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { buildSandboxEnv, DEFAULT_BASE_ENV_KEYS } from './credential-injector.js';
import {
  buildArtifactMcpConfig,
  type ArtifactMcpConfig,
} from './artifact-mcp.js';
import { defaultRunGit, type GitRunner } from './sandbox-runtime.js';
import {
  parseStreamJsonLine,
  redactSecrets,
  streamJsonToDisplay,
} from './work-run-transcript.js';
import type { DispatchProvider } from '../intent/dispatch.js';
import type { SandboxSpec } from '../intent/sandbox.js';
import { createLogger } from '../utils/logger.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';

const log = createLogger('execution-agent');
const NON_CREDENTIAL_ENV_KEYS = new Set<string>([
  ...DEFAULT_BASE_ENV_KEYS,
  'RUNE_VITEST_CACHE_DIR',
]);

function productCredentialValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => !NON_CREDENTIAL_ENV_KEYS.has(key) && value && value.length >= 4)
    .map(([, value]) => value!);
}

/** A policy-resolved (model, provider, format) triple for one role. Defined
 *  here (the executor boundary) and re-exported by team-task-deps.ts so the
 *  two modules share one shape without a circular value import. `provider` is
 *  the narrow `DispatchProvider` union — the reviewer-independence gate
 *  compares these values, so they must be the same type the workflow uses. */
export interface RoleModelBinding {
  /** Stable model alias from the policy registry (e.g. `opus`, `gpt-5.6-sol`). */
  alias: string;
  /** Provider family — what reviewer independence is measured on. */
  provider: DispatchProvider;
  /** Which CLI executor runs this model. Widened only when a new executor is
   *  actually wired here (gemini's compiler is a deferred stub — keeping it
   *  out of the union keeps an unwired format unrepresentable). */
  format: 'claude' | 'codex';
}

/** What one executor spawn returns: collected output text plus an error
 *  channel (`null` = clean run). Mirrors `CodexResult`'s text/error shape. */
export interface SpawnAgentResult {
  output: string;
  error: string | null;
}

export type ExecutionAgentStreamEvent =
  | { kind: 'activity'; data?: Record<string, never> }
  | { kind: 'output'; data: { line: string } };

/** Injectable IO seam — tests fake the spawn and env, keep real git. */
export interface ExecutionAgentIO {
  spawnAgent: (args: {
    prompt: string;
    systemPrompt?: string;
    model: RoleModelBinding;
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    emit?: (event: ExecutionAgentStreamEvent) => void;
    artifactMcp?: ArtifactMcpConfig;
  }) => Promise<SpawnAgentResult>;
  runGit: GitRunner;
  buildEnv: (sandbox: SandboxSpec, opts: { productsConfigPath: string }) => NodeJS.ProcessEnv;
  buildArtifactMcp: (
    sandbox: SandboxSpec,
    opts: { productsConfigPath: string },
  ) => Promise<ArtifactMcpConfig | null> | ArtifactMcpConfig | null;
  onActivity?: (event: ExecutionAgentStreamEvent) => void;
}

export interface ExecutionAgentOpts {
  /** The role/task instruction for the executor. */
  prompt: string;
  /** System-channel authority text (the role's SOUL charter + framing). For
   *  the claude executor this rides `--append-system-prompt` so it carries
   *  real system authority; the codex CLI has no system channel, so there it
   *  is prepended above the prompt (documented degradation). */
  systemPrompt?: string;
  /** The run's sandbox — `worktree` is the session's cwd and only writable area. */
  sandbox: SandboxSpec;
  /** The policy-resolved model binding for the invoking role. */
  model: RoleModelBinding;
  /** Role at this executor boundary. Artifact MCP is authorized only for QA
   * and coder; tech-lead repair uses the executor without that capability. */
  role: 'qa' | 'coder' | 'tech-lead';
  /** `policies/products.json` path for scoped-credential env construction. */
  productsConfigPath: string;
  /** Per-session budget; defaults to the shared Claude CLI timeout. */
  timeoutMs?: number;
  /** Optional activity stream for orchestrated-run observability/heartbeat. */
  emit?: (event: ExecutionAgentStreamEvent) => void;
}

export type ExecutionAgentResult =
  | { ok: true; diff: string; output: string }
  | { ok: false; error: string };

const defaultIo: ExecutionAgentIO = {
  spawnAgent: defaultSpawnAgent,
  runGit: defaultRunGit,
  buildEnv: buildSandboxEnv,
  buildArtifactMcp: buildArtifactMcpConfig,
};

/**
 * Run one artifact-role session and capture its work product as a git diff.
 * Never throws — every failure path returns `{ok:false, error}` so the
 * team-task workflow surfaces structured `failed` evidence instead of an
 * unhandled rejection.
 */
export async function runExecutionAgent(
  opts: ExecutionAgentOpts,
  io: Partial<ExecutionAgentIO> = {},
): Promise<ExecutionAgentResult> {
  const { spawnAgent, runGit, buildEnv, buildArtifactMcp, onActivity } = {
    ...defaultIo,
    ...io,
  };
  const cwd = opts.sandbox.worktree;
  const timeoutMs = opts.timeoutMs ?? config.CLAUDE_TIMEOUT_MS;
  const emit = composeActivityEmit(opts.emit, onActivity);

  let artifactMcp: ArtifactMcpConfig | null = null;
  let credentialValues: string[] = [];
  try {
    // Resolve the required MCP before other product configuration so every
    // configured-policy/setup failure uses the structured registration error.
    try {
      artifactMcp = opts.role === 'qa' || opts.role === 'coder'
        ? await buildArtifactMcp(opts.sandbox, { productsConfigPath: opts.productsConfigPath })
        : null;
    } catch (err) {
      return {
        ok: false,
        error: `rune-kb not registered: ${sanitize((err as Error).message)}`,
      };
    }
    const env = buildEnv(opts.sandbox, { productsConfigPath: opts.productsConfigPath });
    credentialValues = productCredentialValues(env);
    const { output, error } = await spawnAgent({
      prompt: opts.prompt,
      ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      model: opts.model,
      cwd,
      env,
      timeoutMs,
      ...(artifactMcp !== null ? { artifactMcp } : {}),
      ...(emit !== undefined ? { emit } : {}),
    });
    if (error !== null) {
      return { ok: false, error: sanitize(error, credentialValues) };
    }
    // Stage-then-diff so new files are part of the captured work product.
    await runGit(['add', '-A'], { cwd });
    const { stdout } = await runGit(['diff', 'HEAD'], { cwd });
    // Defense-in-depth: a credential a misbehaving tool call wrote into the
    // worktree must not propagate upstream through TaskEvidence, and host-
    // absolute paths must not leave the process toward external providers —
    // mirror the work-run pipeline's diffstat scrubbing.
    return {
      ok: true,
      diff: redactSecrets(scrubPathsInText(stdout), credentialValues),
      output: sanitize(output, credentialValues),
    };
  } catch (err) {
    return { ok: false, error: sanitize((err as Error).message, credentialValues) };
  } finally {
    if (artifactMcp !== null) {
      try {
        await artifactMcp.stop();
      } catch (err) {
        log.warn('failed to stop artifact MCP broker', { error: (err as Error).message });
      }
    }
  }
}

/** Executor stderr / error text can carry host-absolute paths and (in the
 *  worst case) credential-shaped strings; scrub both before the message flows
 *  upstream into TaskEvidence → mutation events → user surfaces. */
function sanitize(text: string, exactValues: readonly string[] = []): string {
  return redactSecrets(scrubAbsolutePaths(scrubPathsInText(text)), exactValues);
}

function composeActivityEmit(
  runEmit: ExecutionAgentOpts['emit'],
  ioEmit: ExecutionAgentIO['onActivity'],
): ExecutionAgentOpts['emit'] {
  if (runEmit === undefined && ioEmit === undefined) return undefined;
  return (event) => {
    if (runEmit !== undefined) runEmit(event);
    if (ioEmit !== undefined) ioEmit(event);
  };
}

// ---------------------------------------------------------------------------
// Production spawn — dispatch by executor format
// ---------------------------------------------------------------------------

async function defaultSpawnAgent(args: {
  prompt: string;
  systemPrompt?: string;
  model: RoleModelBinding;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  emit?: (event: ExecutionAgentStreamEvent) => void;
  artifactMcp?: ArtifactMcpConfig;
}): Promise<SpawnAgentResult> {
  const credentialValues = productCredentialValues(args.env);
  const { format } = args.model;
  if (format === 'codex') {
    // The codex CLI takes a single prompt — no system channel. The SOUL text
    // is prepended so the role charter still leads the context.
    const codexPrompt = args.systemPrompt
      ? `${args.systemPrompt}\n\n${args.prompt}`
      : args.prompt;
    let streamedOutput = '';
    let sawCodexEvent = false;
    const result = await runCodex(codexPrompt, {
      cwd: args.cwd,
      model: args.model.alias,
      sandboxMode: 'workspace-write',
      timeoutMs: args.timeoutMs,
      // Scoped credentials only — never the default process.env spread (see
      // RunCodexOpts.env: sandboxed callers MUST pass a built env).
      env: args.env,
      ...(args.artifactMcp
        ? {
            configOverrides: args.artifactMcp.codexConfigOverrides,
            ignoreUserConfig: true,
            sandboxProfilePath: args.artifactMcp.sandboxProfilePath,
          }
        : {}),
      onEvent: (event) => {
        sawCodexEvent = true;
        const line = codexEventToDisplay(event, credentialValues);
        if (line === null) {
          args.emit?.({ kind: 'activity' });
          return;
        }
        streamedOutput += `${line}\n`;
        args.emit?.({ kind: 'output', data: { line } });
      },
    });
    const output = streamedOutput.trim() || (sawCodexEvent ? '' : sanitize(result.text ?? '', credentialValues));
    return { output, error: result.error === null ? null : sanitize(result.error, credentialValues) };
  }
  return spawnClaudeAgent(args);
}

function codexEventToDisplay(event: Record<string, unknown>, exactValues: readonly string[]): string | null {
  if (event['type'] === 'raw' && typeof event['line'] === 'string') {
    return cleanCodexText(event['line'], exactValues);
  }

  if (event['type'] !== 'item.completed' || !isRecord(event['item'])) {
    return null;
  }

  const item = event['item'];
  if (item['type'] !== 'agent_message' || typeof item['text'] !== 'string') {
    return null;
  }

  return cleanCodexText(item['text'], exactValues);
}

function cleanCodexText(text: string, exactValues: readonly string[]): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : redactSecrets(scrubPathsInText(trimmed), exactValues);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Claude CLI spawn against the worktree — mirrors gen-eval-loop-runner's
 *  worktree spawn (MCP isolation, skip-permissions, sandbox env), plus the
 *  `--model` pin from the policy resolution and a hard timeout. */
function spawnClaudeAgent(args: {
  prompt: string;
  systemPrompt?: string;
  model: RoleModelBinding;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  emit?: (event: ExecutionAgentStreamEvent) => void;
  artifactMcp?: ArtifactMcpConfig;
}): Promise<SpawnAgentResult> {
  return new Promise((resolve) => {
    const credentialValues = productCredentialValues(args.env);
    let resolved = false;
    const finish = (result: SpawnAgentResult): void => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      const claudeArgs = [
          // Sandboxed children must not inherit the user's global MCP servers.
          ...(args.artifactMcp?.claudeArgs ?? getProjectMcpArgs()),
          '--dangerously-skip-permissions',
          '--model',
          args.model.alias,
          // Two-channel authority boundary: the role SOUL rides the system
          // channel, not the user turn.
          ...(args.systemPrompt ? ['--append-system-prompt', args.systemPrompt] : []),
          '--output-format',
          'stream-json',
          '--verbose',
          '-p',
          args.prompt,
        ];
      const command = args.artifactMcp ? '/usr/bin/sandbox-exec' : CLAUDE_BIN;
      const commandArgs = args.artifactMcp
        ? ['-f', args.artifactMcp.sandboxProfilePath, CLAUDE_BIN, ...claudeArgs]
        : claudeArgs;
      child = spawn(
        command,
        commandArgs,
        { cwd: args.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: args.env },
      );
    } catch (err) {
      finish({ output: '', error: (err as Error).message });
      return;
    }

    registerActiveProcess(child);
    let stdout = '';
    let stdoutBuf = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      log.warn('execution agent timed out; sending SIGTERM', { timeoutMs: args.timeoutMs });
      child.kill('SIGTERM');
      // Escalate to SIGKILL after the reap grace so a SIGTERM-ignoring child
      // can't wedge the workflow and leak its active-process registration.
      killTimer = setTimeout(() => {
        log.warn('execution agent ignored SIGTERM; sending SIGKILL');
        child.kill('SIGKILL');
      }, config.WORK_RUN_REAP_GRACE_MS);
      killTimer.unref();
    }, args.timeoutMs);

    const emitEvent = (event: ExecutionAgentStreamEvent): void => {
      if (!args.emit) return;
      try {
        args.emit(event);
      } catch (err) {
        log.warn('execution agent stream callback failed', { error: (err as Error).message });
      }
    };

    const emitStdoutLine = (line: string): void => {
      if (!line.trim()) return;
      const envelope = parseStreamJsonLine(line);
      if (!envelope) {
        const redacted = redactSecrets(scrubPathsInText(line), credentialValues);
        if (redacted) stdout += `${redacted}\n`;
        return;
      }
      const display = streamJsonToDisplay(envelope);
      if (display === null) {
        emitEvent({ kind: 'activity' });
        return;
      }
      const redacted = redactSecrets(display, credentialValues);
      for (const displayLine of redacted.split('\n')) {
        if (!displayLine) continue;
        stdout += `${displayLine}\n`;
        emitEvent({ kind: 'output', data: { line: displayLine } });
      }
    };

    child.stdout!.on('data', (b: Buffer) => {
      stdoutBuf += b.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) emitStdoutLine(line);
    });
    // stderr is only diagnostic tail — cap it so a verbose run can't grow it
    // unbounded (the read itself keeps the pipe drained either way).
    child.stderr!.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString('utf8')).slice(-2000);
    });

    let spawnError: string | null = null;
    child.on('error', (err) => {
      spawnError = err.message;
    });
    // `close` always follows `error`, so one handler owns cleanup.
    child.on('close', (code) => {
      if (stdoutBuf.trim()) {
        emitStdoutLine(stdoutBuf);
        stdoutBuf = '';
      }
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      unregisterActiveProcess(child);
      if (spawnError !== null) {
        finish({ output: stdout, error: sanitize(spawnError, credentialValues) });
        return;
      }
      if (timedOut) {
        finish({ output: stdout, error: `execution agent timed out after ${args.timeoutMs}ms` });
        return;
      }
      if (code === 0) {
        finish({ output: stdout, error: null });
        return;
      }
      finish({
        output: stdout,
        error: sanitize(stderr.trim() || `execution agent exited with code ${code}`, credentialValues),
      });
    });
  });
}
