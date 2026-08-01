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
import {
  getCancellation,
  registerOp,
  unregisterOp,
} from '../transport/in-flight.js';
import type { OperationCancellation } from '../cancellation.js';
import { verifyConfinementCapability } from '../utils/validation-confinement.js';
import { scrubPathsInText } from '../ai/tool-labels.js';
import { buildSandboxEnv, DEFAULT_BASE_ENV_KEYS } from './credential-injector.js';
import {
  buildArtifactMcpConfig,
  type ArtifactMcpConfig,
} from './artifact-mcp.js';
import type { GitRunner } from './sandbox-runtime.js';
import { defaultRunCanonicalGit } from './canonical-git.js';
import {
  parseStreamJsonLine,
  redactSecrets,
  streamJsonToDisplay,
} from './work-run-transcript.js';
import type { DispatchProvider } from '../intent/dispatch.js';
import type { SandboxSpec } from '../intent/sandbox.js';
import { createLogger } from '../utils/logger.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import {
  sanitizeExecutionDiagnostic,
  type ArtifactAttemptEvidence,
  type ExecutionAttempt,
  type ExecutionCheckpoint,
  type ExecutionFailure,
  type ExecutionFailureStage,
} from '../intent/execution-failure.js';

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
  /** Provider frames in arrival order. Optional for injected legacy seams. */
  messages?: NormalizedExecutionMessage[];
  /** Present for a stage that requires one machine-readable terminal artifact. */
  terminalArtifact?: TerminalArtifactResult;
  cancellation?: OperationCancellation;
  /** Structured adapter outcome. Legacy injected seams may omit these; their
   * errors are conservatively treated as retryable provider failures. */
  failureStage?: Extract<ExecutionFailureStage, 'environment' | 'spawn' | 'timeout' | 'cancellation' | 'provider' | 'executor-exit'>;
  retryable?: boolean;
}

export type NormalizedExecutionMessageKind =
  | 'assistant'
  | 'result'
  | 'lifecycle'
  | 'raw';

export interface NormalizedExecutionMessage {
  sequence: number;
  provider: DispatchProvider;
  kind: NormalizedExecutionMessageKind;
  text?: string;
  terminal?: boolean;
  afterTerminal?: boolean;
}

export interface TerminalArtifactResult {
  provider: DispatchProvider;
  artifactKind: 'coder-self-review';
  status: ArtifactAttemptEvidence['status'];
  progressCount: number;
  candidateCount: number;
  diagnostic: string;
  /** Transient parser input. Never copy this field into durable evidence. */
  artifact?: string;
}

export type ExecutionAgentStreamEvent =
  | { kind: 'activity'; data?: Record<string, unknown> }
  | { kind: 'output'; data: { line: string } };

/** Injectable IO seam — tests fake the spawn and env, keep real git. */
export interface ExecutionAgentIO {
  spawnAgent: (args: {
    prompt: string;
    systemPrompt?: string;
    model: RoleModelBinding;
    role: ExecutionAgentOpts['role'];
    product: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    workflowStage?: string;
    emit?: (event: ExecutionAgentStreamEvent) => void;
    artifactMcp?: ArtifactMcpConfig;
  }) => Promise<SpawnAgentResult>;
  runGit: GitRunner;
  buildEnv: (sandbox: SandboxSpec, opts: { productsConfigPath: string }) => NodeJS.ProcessEnv;
  buildArtifactMcp: (
    sandbox: SandboxSpec,
    opts: { productsConfigPath: string; executor?: 'claude' | 'codex' },
  ) => Promise<ArtifactMcpConfig | null> | ArtifactMcpConfig | null;
  onActivity?: (event: ExecutionAgentStreamEvent) => void;
  delay: (ms: number) => Promise<void>;
  random: () => number;
  cancellationDuringBackoff?: () => OperationCancellation | undefined;
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
  /** Durable attribution supplied by the task workflow. */
  taskId?: string;
  workflowStage?: string;
  /** Exact checkpoint already persisted by the workflow before this call. */
  checkpoint?: ExecutionCheckpoint;
}

export type ExecutionAgentResult =
  | {
      ok: true;
      diff: string;
      output: string;
      messages?: NormalizedExecutionMessage[];
      terminalArtifact?: TerminalArtifactResult;
    }
  | { ok: false; failure: ExecutionFailure; cancellation?: OperationCancellation };

const defaultIo: ExecutionAgentIO = {
  spawnAgent: defaultSpawnAgent,
  // Every Git-visible snapshot stages product-controlled files. Use the
  // credential-stripped, driver-rejecting boundary from the first snapshot,
  // not only for the later reviewer capture.
  runGit: defaultRunCanonicalGit,
  buildEnv: buildSandboxEnv,
  buildArtifactMcp: buildArtifactMcpConfig,
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/**
 * Run one artifact-role session and capture its work product as a git diff.
 * Never throws — every failure path returns `{ok:false, failure}` so the
 * team-task workflow surfaces structured `failed` evidence instead of an
 * unhandled rejection.
 */
export async function runExecutionAgent(
  opts: ExecutionAgentOpts,
  io: Partial<ExecutionAgentIO> = {},
): Promise<ExecutionAgentResult> {
  const {
    spawnAgent, runGit, buildEnv, buildArtifactMcp, onActivity,
    delay, random, cancellationDuringBackoff,
  } = {
    ...defaultIo,
    ...io,
  };
  const cwd = opts.sandbox.worktree;
  const timeoutMs = opts.timeoutMs ?? config.CLAUDE_TIMEOUT_MS;
  const emit = composeActivityEmit(opts.emit, onActivity);

  let credentialValues: string[] = [];
  const checkpoint: ExecutionCheckpoint = opts.checkpoint ?? {
    taskId: opts.taskId ?? opts.sandbox.project,
    role: opts.role,
    provider: opts.model.provider,
    format: opts.model.format,
    model: opts.model.alias,
    workflowStage: opts.workflowStage ?? opts.role,
    checkpointedAt: new Date().toISOString(),
  };
  const attempts: ExecutionAttempt[] = [];
  const recordAttempt = (
    attempt: number,
    startedAt: string,
    stage: ExecutionFailureStage,
    diagnostic: unknown,
    retryable: boolean,
    cleanupDiagnostic?: unknown,
  ): void => {
    const record = attemptRecord(
      attempt,
      startedAt,
      stage,
      diagnostic,
      retryable,
      credentialValues,
      cleanupDiagnostic,
    );
    const priorIndex = attempts.findIndex((item) => item.attempt === attempt);
    if (priorIndex >= 0) attempts[priorIndex] = record;
    else attempts.push(record);
    emit?.({ kind: 'activity', data: {
      event: 'execution-attempt-failed',
      attempt,
      role: opts.role,
      failureStage: stage,
      retryable,
      line: `execution attempt ${attempt} failed at ${stage}: ${record.diagnostic}`,
    } });
  };

  const failed = (
    stage: ExecutionFailureStage,
    diagnostic: unknown,
    retryable: boolean,
    disposition: ExecutionFailure['retryDisposition'],
    cancellation?: OperationCancellation,
  ): ExecutionAgentResult => {
    const failure: ExecutionFailure = {
      ...checkpoint,
      failureStage: stage,
      diagnostic: sanitizeExecutionDiagnostic(diagnostic, credentialValues),
      retryable,
      attempts: [...attempts],
      retryDisposition: disposition,
      ...(cancellation !== undefined ? { cancellation } : {}),
    };
    return { ok: false, failure, ...(cancellation !== undefined ? { cancellation } : {}) };
  };
  const finishAttempt = (
    attempt: number,
    startedAt: string,
    stage: ExecutionFailureStage,
    diagnostic: unknown,
    retryable: boolean,
    disposition: ExecutionFailure['retryDisposition'],
    cancellation?: OperationCancellation,
    cleanupDiagnostic?: unknown,
  ): ExecutionAgentResult => {
    recordAttempt(
      attempt,
      startedAt,
      stage,
      diagnostic,
      retryable,
      cleanupDiagnostic,
    );
    return failed(stage, diagnostic, retryable, disposition, cancellation);
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const startedAt = new Date().toISOString();
    let beforeTree: string;
    try {
      beforeTree = await snapshotTree(runGit, cwd);
    } catch (err) {
      return finishAttempt(attempt, startedAt, 'git-stage', err, false, 'not-eligible');
    }

    let artifactMcp: ArtifactMcpConfig | null = null;
    let spawnResult: SpawnAgentResult;
    let artifactStopError: unknown;
    try {
      try {
        artifactMcp = opts.role === 'qa' || opts.role === 'coder'
          ? await buildArtifactMcp(opts.sandbox, {
              productsConfigPath: opts.productsConfigPath,
              executor: opts.model.format,
            })
          : null;
        if (
          artifactMcp !== null &&
          !verifyConfinementCapability(artifactMcp.confinementCapability, {
            owner: 'artifact-launcher',
            profilePath: artifactMcp.sandboxProfilePath,
          })
        ) {
          throw new Error('artifact launcher returned an unverified confinement capability');
        }
      } catch (err) {
        return finishAttempt(
          attempt,
          startedAt,
          'artifact-mcp',
          `rune-kb not registered: ${sanitizeExecutionDiagnostic(err)}`,
          false,
          'not-eligible',
        );
      }

      let env: NodeJS.ProcessEnv;
      try {
        env = buildEnv(opts.sandbox, { productsConfigPath: opts.productsConfigPath });
        credentialValues = productCredentialValues(env);
      } catch (err) {
        return finishAttempt(attempt, startedAt, 'environment', err, false, 'not-eligible');
      }

      try {
        spawnResult = await spawnAgent({
          prompt: opts.prompt,
          ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
          model: opts.model,
          role: opts.role,
          product: opts.sandbox.product,
          cwd,
          env,
          timeoutMs,
          workflowStage: opts.workflowStage,
          ...(artifactMcp !== null ? { artifactMcp } : {}),
          ...(emit !== undefined ? { emit } : {}),
        });
      } catch (err) {
        spawnResult = { output: '', error: sanitizeExecutionDiagnostic(err), failureStage: 'spawn', retryable: true };
      }
    } finally {
      if (artifactMcp !== null) {
        try {
          await artifactMcp.stop();
        } catch (err) {
          artifactStopError = err;
          log.warn('failed to stop artifact MCP broker', { error: sanitizeExecutionDiagnostic(err) });
        }
      }
    }

    if (spawnResult.error !== null) {
      const stage = spawnResult.failureStage ?? (spawnResult.cancellation ? 'cancellation' : 'provider');
      const retryable = spawnResult.retryable ?? spawnResult.cancellation === undefined;
      // Cleanup is a secondary diagnostic. It prevents a retry because the
      // attempt environment did not close cleanly, but never replaces the
      // child's original terminal cause.
      if (artifactStopError !== undefined) {
        return finishAttempt(
          attempt,
          startedAt,
          stage,
          spawnResult.error,
          false,
          'not-eligible',
          spawnResult.cancellation,
          `artifact MCP cleanup failed: ${sanitizeExecutionDiagnostic(artifactStopError)}`,
        );
      }
      if (!retryable || spawnResult.cancellation !== undefined) {
        return finishAttempt(
          attempt,
          startedAt,
          stage,
          spawnResult.error,
          false,
          spawnResult.cancellation ? 'cancelled' : 'not-eligible',
          spawnResult.cancellation,
        );
      }
      recordAttempt(attempt, startedAt, stage, spawnResult.error, true);

      let afterTree: string;
      try {
        afterTree = await snapshotTree(runGit, cwd);
      } catch (err) {
        return finishAttempt(attempt, startedAt, 'git-diff', err, false, 'not-eligible');
      }
      if (beforeTree !== afterTree) {
        return failed(stage, spawnResult.error, true, 'worktree-changed');
      }
      if (attempt === 2) return failed(stage, spawnResult.error, true, 'exhausted');

      emit?.({ kind: 'activity', data: {
        event: 'execution-retry', attempt, nextAttempt: attempt + 1, role: opts.role,
        failureStage: stage,
        line: `execution attempt ${attempt} failed at ${stage}; retrying with a fresh process`,
      } });
      const backoffMs = 1_000 + Math.floor(Math.max(0, Math.min(0.999, random())) * 1_001);
      for (let waited = 0; waited < backoffMs; waited += 100) {
        const cancellation = cancellationDuringBackoff?.();
        if (cancellation !== undefined) {
          return failed('cancellation', 'cancelled during execution retry backoff', false, 'cancelled', cancellation);
        }
        await delay(Math.min(100, backoffMs - waited));
      }
      continue;
    }

    if (artifactStopError !== undefined) {
      const cleanupDiagnostic = `artifact MCP cleanup failed: ${sanitizeExecutionDiagnostic(artifactStopError)}`;
      return finishAttempt(
        attempt,
        startedAt,
        'artifact-mcp',
        cleanupDiagnostic,
        false,
        'not-eligible',
      );
    }

    if (
      opts.workflowStage === 'coder-self-review' &&
      spawnResult.terminalArtifact === undefined
    ) {
      const text = sanitize(spawnResult.output, credentialValues);
      const messages: NormalizedExecutionMessage[] = opts.model.format === 'claude'
        ? [{
            sequence: 1,
            provider: opts.model.provider,
            kind: 'result',
            text,
            terminal: true,
          }]
        : [{
            sequence: 1,
            provider: opts.model.provider,
            kind: 'assistant',
            text,
          }, {
            sequence: 2,
            provider: opts.model.provider,
            kind: 'lifecycle',
            terminal: true,
          }];
      spawnResult = {
        ...spawnResult,
        output: '',
        messages,
        terminalArtifact: extractCoderSelfReviewArtifact(
          messages,
          opts.model.provider,
          opts.model.format,
        ),
      };
    }

    try {
      await runGit(['add', '-A'], { cwd });
    } catch (err) {
      return finishAttempt(attempt, startedAt, 'git-stage', err, false, 'not-eligible');
    }
    let stdout: string;
    try {
      stdout = (await runGit(
        ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD'],
        { cwd },
      )).stdout;
    } catch (err) {
      return finishAttempt(attempt, startedAt, 'git-diff', err, false, 'not-eligible');
    }
    return {
      ok: true,
      diff: redactSecrets(scrubPathsInText(stdout), credentialValues),
      output: sanitize(spawnResult.output, credentialValues),
      ...(spawnResult.messages !== undefined
        ? { messages: spawnResult.messages.map((message) => ({ ...message })) }
        : {}),
      ...(spawnResult.terminalArtifact !== undefined
        ? { terminalArtifact: { ...spawnResult.terminalArtifact } }
        : {}),
    };
  }

  return failed('orchestration-adjacent', 'execution attempt loop exhausted unexpectedly', false, 'exhausted');
}

function attemptRecord(
  attempt: number,
  startedAt: string,
  failureStage: ExecutionFailureStage,
  diagnostic: unknown,
  retryable: boolean,
  exactValues: readonly string[],
  cleanupDiagnostic?: unknown,
): ExecutionAttempt {
  return {
    attempt,
    startedAt,
    endedAt: new Date().toISOString(),
    failureStage,
    diagnostic: sanitizeExecutionDiagnostic(diagnostic, exactValues),
    retryable,
    ...(cleanupDiagnostic === undefined
      ? {}
      : { cleanupDiagnostic: sanitizeExecutionDiagnostic(cleanupDiagnostic, exactValues) }),
  };
}

/**
 * Snapshot the Git-visible worktree state used by the retry safety gate.
 * `git add -A` + `write-tree` intentionally excludes ignored files and Git
 * metadata: executor work product must live in the repository's visible tree.
 */
async function snapshotTree(runGit: GitRunner, cwd: string): Promise<string> {
  await runGit(['add', '-A'], { cwd });
  return (await runGit(['write-tree'], { cwd })).stdout.trim();
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

const CODER_SELF_REVIEW_FENCE =
  /^\s*```coder-self-review[ \t]*\r?\n[\s\S]*?\r?\n```[ \t]*\s*$/;
const CODER_SELF_REVIEW_TAG = /```coder-self-review\b/;
const TERMINAL_ARTIFACT_COUNT_MAX = 10_000;

function coderSelfReviewTagCount(text: string): number {
  return text.match(/```coder-self-review\b/g)?.length ?? 0;
}

function terminalArtifactTagCount(
  messages: readonly NormalizedExecutionMessage[],
): number {
  return messages.reduce(
    (count, message) => count + (
      typeof message.text === 'string'
        ? coderSelfReviewTagCount(message.text)
        : 0
    ),
    0,
  );
}

function terminalArtifactProgressCount(
  messages: readonly NormalizedExecutionMessage[],
): number {
  return messages.filter((message) =>
    message.kind === 'assistant' &&
    typeof message.text === 'string' &&
    coderSelfReviewTagCount(message.text) === 0).length;
}

/**
 * Select the one provider-terminal artifact without using "last fence" or
 * aggregate-output heuristics. The returned artifact is transient parser
 * input; callers persist only the bounded counts/status/diagnostic.
 */
export function extractCoderSelfReviewArtifact(
  messages: readonly NormalizedExecutionMessage[],
  provider: DispatchProvider,
  format: RoleModelBinding['format'],
): TerminalArtifactResult {
  const meaningful = messages.filter((message) =>
    message.kind === 'assistant' || message.kind === 'result' || message.kind === 'raw');
  const rejectedAfterTerminal = messages.some((message) => message.afterTerminal === true);
  const result = (
    status: TerminalArtifactResult['status'],
    diagnostic: string,
    candidateCount: number,
    progressCount: number,
    artifact?: string,
  ): TerminalArtifactResult => ({
    provider,
    artifactKind: 'coder-self-review',
    status,
    progressCount: Math.min(TERMINAL_ARTIFACT_COUNT_MAX, progressCount),
    candidateCount: Math.min(TERMINAL_ARTIFACT_COUNT_MAX, candidateCount),
    diagnostic: sanitizeExecutionDiagnostic(diagnostic),
    ...(artifact !== undefined ? { artifact } : {}),
  });

  if (rejectedAfterTerminal) {
    const candidateCount = terminalArtifactTagCount(meaningful);
    return result(
      'rejected',
      'provider emitted a message after terminal lifecycle completion',
      candidateCount,
      terminalArtifactProgressCount(meaningful),
    );
  }

  if (format === 'codex') {
    const terminalIndex = messages.findIndex((message) =>
      message.kind === 'lifecycle' && message.terminal === true);
    if (terminalIndex < 0) {
      const candidateCount = terminalArtifactTagCount(meaningful);
      return result(
        candidateCount > 0 ? 'non-final' : 'missing',
        'Codex stream did not complete with a terminal lifecycle event',
        candidateCount,
        terminalArtifactProgressCount(meaningful),
      );
    }
    const beforeTerminal = messages.slice(0, terminalIndex);
    const assistants = beforeTerminal
      .filter((message) => message.kind === 'assistant' && typeof message.text === 'string');
    const terminal = assistants.at(-1);
    const candidateCount = terminalArtifactTagCount(beforeTerminal);
    const progressCount = terminalArtifactProgressCount(beforeTerminal);
    if (terminal === undefined) {
      return result('missing', 'Codex terminal lifecycle had no completed agent message', 0, progressCount);
    }
    const terminalTagged = CODER_SELF_REVIEW_TAG.test(terminal.text!);
    if (candidateCount > 1) {
      return result(
        'ambiguous',
        'Codex stream contained multiple coder-self-review candidates',
        candidateCount,
        progressCount,
      );
    }
    if (!terminalTagged) {
      return result(
        candidateCount === 1 ? 'non-final' : 'malformed',
        candidateCount === 1
          ? 'coder-self-review candidate was not the final completed agent message'
          : 'final completed Codex agent message was not one complete coder-self-review fence',
        candidateCount,
        progressCount,
      );
    }
    if (!CODER_SELF_REVIEW_FENCE.test(terminal.text!)) {
      return result(
        'malformed',
        'final completed Codex agent message was not one complete coder-self-review fence',
        candidateCount,
        progressCount,
      );
    }
    return result(
      'captured',
      'captured final completed Codex agent message',
      1,
      progressCount,
      terminal.text,
    );
  }

  const terminalResults = messages.filter((message) =>
    message.kind === 'result' && message.terminal === true && typeof message.text === 'string');
  if (terminalResults.length !== 1) {
    const candidateCount = terminalArtifactTagCount(meaningful);
    return result(
      terminalResults.length > 1 ? 'ambiguous' : (candidateCount > 0 ? 'non-final' : 'missing'),
      terminalResults.length > 1
        ? 'Claude stream contained multiple terminal result frames'
        : 'Claude stream did not contain an explicit terminal result frame',
      candidateCount,
      terminalArtifactProgressCount(meaningful),
    );
  }
  const terminal = terminalResults[0]!;
  const terminalIndex = messages.indexOf(terminal);
  const prior = messages.slice(0, terminalIndex);
  const immediatelyPriorAssistant = prior.at(-1);
  const duplicateAssistant =
    immediatelyPriorAssistant?.kind === 'assistant' &&
    immediatelyPriorAssistant.text === terminal.text
      ? immediatelyPriorAssistant
      : undefined;
  const considered = prior.filter((message) => message !== duplicateAssistant);
  const earlierCandidateCount = terminalArtifactTagCount(considered);
  const terminalTagCount = coderSelfReviewTagCount(terminal.text!);
  const terminalTagged = terminalTagCount > 0;
  const candidateCount = earlierCandidateCount + terminalTagCount;
  const progressCount = terminalArtifactProgressCount(considered);
  if (candidateCount > 1) {
    return result(
      'ambiguous',
      'Claude stream contained multiple coder-self-review candidates',
      candidateCount,
      progressCount,
    );
  }
  if (!terminalTagged) {
    return result(
      earlierCandidateCount === 1 ? 'non-final' : 'malformed',
      earlierCandidateCount === 1
        ? 'coder-self-review candidate preceded the explicit Claude result'
        : 'explicit Claude result was not one complete coder-self-review fence',
      candidateCount,
      progressCount,
    );
  }
  if (!CODER_SELF_REVIEW_FENCE.test(terminal.text!)) {
    return result(
      'malformed',
      'explicit Claude result was not one complete coder-self-review fence',
      candidateCount,
      progressCount,
    );
  }
  return result(
    'captured',
    duplicateAssistant === undefined
      ? 'captured explicit Claude result'
      : 'captured explicit Claude result and suppressed its duplicate assistant frame',
    1,
    progressCount,
    terminal.text,
  );
}

function emitBufferedSelfReview(
  messages: readonly NormalizedExecutionMessage[],
  artifact: TerminalArtifactResult,
  emit: ((event: ExecutionAgentStreamEvent) => void) | undefined,
): string {
  const progress: string[] = [];
  for (const message of messages) {
    if (
      message.kind === 'assistant' &&
      typeof message.text === 'string' &&
      !CODER_SELF_REVIEW_TAG.test(message.text)
    ) {
      progress.push(message.text);
      for (const line of message.text.split('\n')) {
        if (line) emit?.({ kind: 'output', data: { line } });
      }
    }
  }
  emit?.({
    kind: 'activity',
    data: {
      event: 'terminal-artifact',
      artifactKind: artifact.artifactKind,
      status: artifact.status,
      provider: artifact.provider,
      progressCount: artifact.progressCount,
      candidateCount: artifact.candidateCount,
      diagnostic: artifact.diagnostic,
      line: `coder-self-review artifact ${artifact.status}: ${artifact.diagnostic}`,
    },
  });
  return progress.join('\n').trim();
}

async function defaultSpawnAgent(args: {
  prompt: string;
  systemPrompt?: string;
  model: RoleModelBinding;
  role: ExecutionAgentOpts['role'];
  product: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  workflowStage?: string;
  emit?: (event: ExecutionAgentStreamEvent) => void;
  artifactMcp?: ArtifactMcpConfig;
}): Promise<SpawnAgentResult> {
  const credentialValues = productCredentialValues(args.env);
  const { format } = args.model;
  const env = artifactEnvForExecutor(args.env, args.artifactMcp, format);
  if (format === 'codex') {
    // The codex CLI takes a single prompt — no system channel. The SOUL text
    // is prepended so the role charter still leads the context.
    const codexPrompt = args.systemPrompt
      ? `${args.systemPrompt}\n\n${args.prompt}`
      : args.prompt;
    let streamedOutput = '';
    let sawCodexEvent = false;
    let terminalSeen = false;
    const messages: NormalizedExecutionMessage[] = [];
    const handleCodexEvent = (event: Record<string, unknown>): void => {
      sawCodexEvent = true;
      const afterTerminal = terminalSeen;
      const line = codexEventToDisplay(event, credentialValues);
      const terminal = event['type'] === 'turn.completed' ||
        event['type'] === 'turn.failed' ||
        event['type'] === 'turn.cancelled';
      const kind: NormalizedExecutionMessageKind =
        event['type'] === 'item.completed' &&
        isRecord(event['item']) &&
        event['item']['type'] === 'agent_message'
          ? 'assistant'
          : event['type'] === 'raw'
            ? 'raw'
            : 'lifecycle';
      messages.push({
        sequence: messages.length + 1,
        provider: args.model.provider,
        kind,
        ...(line !== null ? { text: line } : {}),
        ...(terminal ? { terminal: true } : {}),
        ...(afterTerminal ? { afterTerminal: true } : {}),
      });
      if (terminal) terminalSeen = true;

      if (args.workflowStage === 'coder-self-review' && line !== null) return;
      if (line === null) {
        args.emit?.({ kind: 'activity' });
        return;
      }
      streamedOutput += `${line}\n`;
      args.emit?.({ kind: 'output', data: { line } });
    };
    const codexOpts = args.artifactMcp
      ? {
          cwd: args.cwd,
          model: args.model.alias,
          externallySandboxed: true as const,
          sandboxProfilePath: args.artifactMcp.sandboxProfilePath,
          confinementCapability: args.artifactMcp.confinementCapability,
          timeoutMs: args.timeoutMs,
          opLabel: `team:${args.role}`,
          opKind: 'agent' as const,
          agentName: args.role,
          product: args.product,
          // Scoped credentials only — never the default process.env spread (see
          // RunCodexOpts.env: sandboxed callers MUST pass a built env).
          env,
          configOverrides: args.artifactMcp.codexConfigOverrides,
          ignoreUserConfig: true,
          onEvent: handleCodexEvent,
        }
      : {
          cwd: args.cwd,
          model: args.model.alias,
          sandboxMode: 'workspace-write' as const,
          timeoutMs: args.timeoutMs,
          opLabel: `team:${args.role}`,
          opKind: 'agent' as const,
          agentName: args.role,
          product: args.product,
          // Scoped credentials only — never the default process.env spread (see
          // RunCodexOpts.env: sandboxed callers MUST pass a built env).
          env,
          onEvent: handleCodexEvent,
        };
    const result = await runCodex(codexPrompt, codexOpts);
    if (
      args.workflowStage !== 'coder-self-review' &&
      !sawCodexEvent &&
      typeof result.text === 'string' &&
      result.text.trim() !== ''
    ) {
      const text = sanitize(result.text, credentialValues);
      messages.push({
        sequence: 1,
        provider: args.model.provider,
        kind: 'assistant',
        text,
      }, {
        sequence: 2,
        provider: args.model.provider,
        kind: 'lifecycle',
        terminal: true,
      });
    }
    const terminalArtifact = args.workflowStage === 'coder-self-review'
      ? extractCoderSelfReviewArtifact(messages, args.model.provider, args.model.format)
      : undefined;
    const output = terminalArtifact === undefined
      ? streamedOutput.trim() || (sawCodexEvent ? '' : sanitize(result.text ?? '', credentialValues))
      : emitBufferedSelfReview(messages, terminalArtifact, args.emit);
    const codexFailure = result.error === null || result.cancellation !== undefined
      ? undefined
      : classifyAdapterFailure(result.error, result.failureKind ?? 'provider');
    return {
      output,
      error: result.error === null ? null : sanitize(result.error, credentialValues),
      messages,
      ...(terminalArtifact !== undefined ? { terminalArtifact } : {}),
      ...(result.cancellation !== undefined ? { cancellation: result.cancellation } : {}),
      ...(result.error !== null ? {
        failureStage: result.cancellation !== undefined
          ? 'cancellation' as const
          : codexFailure?.stage ?? 'provider' as const,
        retryable: result.cancellation === undefined && (codexFailure?.retryable ?? true),
      } : {}),
    };
  }
  return spawnClaudeAgent(args);
}

function artifactEnvForExecutor(
  baseEnv: NodeJS.ProcessEnv,
  artifactMcp: ArtifactMcpConfig | undefined,
  format: RoleModelBinding['format'],
): NodeJS.ProcessEnv {
  if (artifactMcp === undefined) return baseEnv;
  if (format === 'codex') {
    return {
      ...baseEnv,
      ...artifactMcp.runtimeEnv,
      ...(artifactMcp.codexEnv ?? {}),
    };
  }
  return {
    ...baseEnv,
    ...artifactMcp.runtimeEnv,
  };
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
  role: ExecutionAgentOpts['role'];
  product: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  workflowStage?: string;
  emit?: (event: ExecutionAgentStreamEvent) => void;
  artifactMcp?: ArtifactMcpConfig;
}): Promise<SpawnAgentResult> {
  return new Promise((resolve) => {
    const credentialValues = productCredentialValues(args.env);
    const messages: NormalizedExecutionMessage[] = [];
    let terminalSeen = false;
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
      const env = artifactEnvForExecutor(args.env, args.artifactMcp, args.model.format);
      child = spawn(
        command,
        commandArgs,
        {
          cwd: args.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        },
      );
    } catch (err) {
      finish({ output: '', error: (err as Error).message, failureStage: 'spawn', retryable: true });
      return;
    }

    registerActiveProcess(child);
    const op = registerOp({
      kind: 'agent',
      label: `team:${args.role}`,
      agentName: args.role,
      scope: args.product,
      userId: config.TELEGRAM_USER_ID,
      child,
    });
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
        if (redacted) {
          messages.push({
            sequence: messages.length + 1,
            provider: args.model.provider,
            kind: 'raw',
            text: redacted,
            ...(terminalSeen ? { afterTerminal: true } : {}),
          });
          if (args.workflowStage !== 'coder-self-review') stdout += `${redacted}\n`;
        }
        return;
      }
      const display = streamJsonToDisplay(envelope);
      const isTerminal = envelope.type === 'result';
      const kind: NormalizedExecutionMessageKind = envelope.type === 'assistant'
        ? 'assistant'
        : isTerminal
          ? 'result'
          : 'lifecycle';
      const redactedDisplay = display === null
        ? null
        : redactSecrets(display, credentialValues);
      messages.push({
        sequence: messages.length + 1,
        provider: args.model.provider,
        kind,
        ...(redactedDisplay !== null ? { text: redactedDisplay } : {}),
        ...(isTerminal ? { terminal: true } : {}),
        ...(terminalSeen ? { afterTerminal: true } : {}),
      });
      if (isTerminal) terminalSeen = true;
      if (display === null) {
        emitEvent({ kind: 'activity' });
        return;
      }
      if (args.workflowStage === 'coder-self-review') return;
      for (const displayLine of redactedDisplay!.split('\n')) {
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
      const cancellation = getCancellation(op.opId);
      const terminalArtifact = args.workflowStage === 'coder-self-review'
        ? extractCoderSelfReviewArtifact(messages, args.model.provider, args.model.format)
        : undefined;
      const finalOutput = terminalArtifact === undefined
        ? stdout
        : emitBufferedSelfReview(messages, terminalArtifact, args.emit);
      const evidence = {
        output: finalOutput,
        messages,
        ...(terminalArtifact !== undefined ? { terminalArtifact } : {}),
      };
      if (cancellation !== undefined) {
        unregisterOp(op.opId, 'cancelled', 'Cancelled by user');
        finish({ ...evidence, error: 'Cancelled by user', cancellation, failureStage: 'cancellation', retryable: false });
        return;
      }
      if (spawnError !== null) {
        const error = sanitize(spawnError, credentialValues);
        unregisterOp(op.opId, 'error', error);
        finish({ ...evidence, error, failureStage: 'spawn', retryable: true });
        return;
      }
      if (timedOut) {
        unregisterOp(op.opId, 'error', `execution agent timed out after ${args.timeoutMs}ms`);
        finish({ ...evidence, error: `execution agent timed out after ${args.timeoutMs}ms`, failureStage: 'timeout', retryable: true });
        return;
      }
      if (code === 0) {
        unregisterOp(op.opId, 'success');
        finish({ ...evidence, error: null });
        return;
      }
      const error = sanitize(
        stderr.trim() || `execution agent exited with code ${code}`,
        credentialValues,
      );
      const classified = classifyAdapterFailure(error, 'executor-exit');
      unregisterOp(op.opId, 'error', error);
      finish({ ...evidence, error, failureStage: classified.stage, retryable: classified.retryable });
    });
  });
}

function classifyAdapterFailure(
  diagnostic: string,
  fallback: Extract<ExecutionFailureStage, 'spawn' | 'timeout' | 'provider' | 'executor-exit'> = 'provider',
): {
  stage: Extract<ExecutionFailureStage, 'environment' | 'spawn' | 'timeout' | 'provider' | 'executor-exit'>;
  retryable: boolean;
} {
  if (/\b(?:unauthenticated|unauthorized|forbidden|authentication|log(?:ged)?\s*in|credential)\b/i.test(diagnostic)) {
    return { stage: 'provider', retryable: false };
  }
  if (/\b(?:sandbox(?:-exec)?|seatbelt|configuration|invalid config)\b/i.test(diagnostic)) {
    return { stage: 'environment', retryable: false };
  }
  return { stage: fallback, retryable: true };
}
