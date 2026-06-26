/**
 * Dispatch runtime — the orchestration adapter for Layer 5 multi-model
 * dispatch. Project 08-intent-layer Phase 6 A5.2.
 *
 * `dispatchToExecutor(handoff, opts)` is the seam the gen-eval-loop (A7)
 * and adjudication paths reach for when they want to actually run a
 * `DispatchHandoff` on a Claude or Codex executor. It:
 *
 * 1. Branches by `handoff.target` and spawns the right executor —
 *    `runAgent` for Claude, `runCodex` for Codex. The Claude target uses
 *    Rune's `.claude/agents/<name>.md` directly (the CLI knows the
 *    agent); the Codex target inlines the compiled-to-Codex agent
 *    document since Codex doesn't know Rune's agents dir.
 * 2. Maps the executor's `{text, error}` result into a `DispatchResult`
 *    (`completed` / `failed`+`failureReason`).
 * 3. Calls `recordDispatch` to build the `DispatchLogEntry`.
 * 4. Appends the entry to `logs/dispatch-log.jsonl` (JSONL, mkdir on
 *    first write).
 * 5. Returns the outcome.
 *
 * Sandbox seam: callers running against a product worktree must pass
 * `opts.env` built via `buildSandboxEnv` (see `RunCodexOpts.env`'s
 * JSDoc) — the default inherits the full `process.env`, which is safe
 * only for in-Rune dispatches.
 *
 * Model determination: `opts.model` overrides the per-target default
 * (`sonnet` for Claude, `codex` for Codex). When A6 registers Codex in
 * the model-selection policy, callers will resolve via `resolveModel`
 * and pass the resolved alias here.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Layer 5"), test-plan.md (§13)}.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import config, { PROJECT_ROOT } from '../config.js';
import { runAgent } from '../ai/claude.js';
import { probeCodexProvider, runCodex, type CodexSandboxMode } from '../ai/codex.js';
import { compileToCodex, parseClaudeAgent, type NeutralAgentDef } from '../intent/agent-def.js';
import {
  recordDispatch,
  type DispatchHandoff,
  type DispatchLogEntry,
  type DispatchProvider,
  type DispatchResult,
  type DispatchTarget,
} from '../intent/dispatch.js';
import { VALID_SLUG } from '../intent/sandbox.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('dispatch-runtime');

/** Maximum characters of executor `failureReason` written to the dispatch
 *  log. Bounds the JSONL line size so a verbose stderr never crosses the
 *  POSIX `PIPE_BUF` atomic-append boundary (~4 KB) — concurrent dispatches
 *  stay non-corrupting on shared `appendFileSync`. */
const FAILURE_REASON_MAX = 500;

/** Per-target default model. Overridden by `opts.model`.
 *
 *  TODO(A6): wire through `resolveModel` from `src/intent/model-policy.ts`
 *  once Codex is registered in `policies/model-policy.json`. Today these
 *  placeholders are also a logged-vs-resolved-model gap on the Claude
 *  path: `runAgent` resolves the agent's model internally, but
 *  `dispatchToExecutor` records the placeholder. The fix lands when A6
 *  resolves the model up-front and threads the resolved alias both into
 *  the spawn and into the log entry. */
const DEFAULT_MODEL: Record<DispatchTarget, string> = {
  claude: 'sonnet',
  codex: 'codex',
};

/** Deterministic target → provider mapping. */
const PROVIDER_OF: Record<DispatchTarget, DispatchProvider> = {
  claude: 'anthropic',
  codex: 'openai',
};

/** Default loader for the neutral agent definition. Reads
 *  `<PROJECT_ROOT>/.claude/agents/<name>.md` and parses it via
 *  `parseClaudeAgent`. Validates the agent name against `VALID_SLUG`
 *  before constructing the path — a name like `../../etc/passwd` would
 *  otherwise resolve outside the agents directory and read arbitrary
 *  files. Callers (tests, future cache layer) can inject
 *  `opts.loadNeutralAgent` to bypass the filesystem read.
 *
 *  Synchronous `readFileSync` is acceptable here because the call is
 *  bounded (once per dispatch). Callers that dispatch in a tight loop
 *  should inject a caching loader via `opts.loadNeutralAgent`. */
function defaultLoadNeutralAgent(name: string): NeutralAgentDef {
  if (!VALID_SLUG.test(name)) {
    throw new Error(
      `defaultLoadNeutralAgent: invalid agent name '${name}' — must match the slug pattern`,
    );
  }
  const path = join(PROJECT_ROOT, '.claude', 'agents', `${name}.md`);
  const raw = readFileSync(path, 'utf8');
  return parseClaudeAgent(raw);
}

/** Truncate a failure reason for the dispatch log without losing the head
 *  of the message (where the most diagnostic content typically sits). */
function truncateFailureReason(reason: string): string {
  if (reason.length <= FAILURE_REASON_MAX) return reason;
  return `${reason.slice(0, FAILURE_REASON_MAX)}…[truncated]`;
}

export interface DispatchToExecutorOpts {
  /** Override the model the executor uses. When omitted, falls back to
   *  the per-target default (`sonnet` for Claude, `codex` for Codex). */
  model?: string;
  /** Working directory for the executor child (Codex only — Claude's
   *  runAgent currently controls its own cwd). */
  cwd?: string;
  /** Environment for the executor child (Codex only). Sandbox callers
   *  must supply `buildSandboxEnv(...)`; the default inherits
   *  `process.env`, which is safe only for in-Rune dispatches. */
  env?: NodeJS.ProcessEnv;
  /** Codex sandbox policy passed via `-s`. Ignored for Claude target. */
  sandboxMode?: CodexSandboxMode;
  /** Overall timeout for the executor spawn (Codex only — Claude's
   *  runAgent has its own timeout default). */
  timeoutMs?: number;
  /** Path to the dispatch log. Defaults to `config.DISPATCH_LOG_FILE`. */
  logFile?: string;
  /** Inject the neutral agent loader for tests. Default reads from
   *  `<PROJECT_ROOT>/.claude/agents/<name>.md`. */
  loadNeutralAgent?: (name: string) => NeutralAgentDef;
}

export interface DispatchOutcome {
  /** The structured dispatch result (the input to `recordDispatch`). */
  result: DispatchResult;
  /** The log entry that was appended to the dispatch log. */
  logEntry: DispatchLogEntry;
  /** The executor's output text — null whenever `result.status === 'failed'`.
   *  Codex can return partial stdout alongside a non-zero exit; this field is
   *  nulled in that case so callers can rely on the invariant
   *  "text is null iff status is failed" without re-checking `result.status`. */
  text: string | null;
  /** The executor's error message on failure; null on success. */
  error: string | null;
}

/** Assemble the prompt body shared by both targets — the structured
 *  handoff is laid out as labeled sections so the executor receives
 *  every piece of context as a named field, never reconstructing intent
 *  by compaction (the Layer 5 invariant). */
function formatPrompt(handoff: DispatchHandoff): string {
  return [
    `# Project: ${handoff.product}/${handoff.project}`,
    '',
    '## Objective',
    '',
    handoff.objective,
    '',
    '## Context',
    '',
    handoff.context,
  ].join('\n');
}

/** Append a single JSONL line to `logFile`, creating the parent directory
 *  on first write. Failures are logged and swallowed — the dispatch
 *  outcome is the source of truth, not the log file. */
function appendDispatchLog(logFile: string, entry: DispatchLogEntry): void {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    log.error('appendDispatchLog failed', {
      logFile,
      error: (err as Error).message,
    });
  }
}

/**
 * Dispatch a handoff to its executor. See module-level JSDoc for flow.
 */
export async function dispatchToExecutor(
  handoff: DispatchHandoff,
  opts: DispatchToExecutorOpts = {},
): Promise<DispatchOutcome> {
  const target = handoff.target;
  const provider = PROVIDER_OF[target];
  const model = opts.model ?? DEFAULT_MODEL[target];
  const logFile = opts.logFile ?? config.DISPATCH_LOG_FILE;

  log.info('Dispatching to executor', {
    target,
    agent: handoff.agent,
    product: handoff.product,
    project: handoff.project,
    model,
  });

  let text: string | null = null;
  let error: string | null = null;

  // Trust-boundary advisory: when dispatching to Codex, the caller is
  // responsible for ensuring `handoff.context` carries no vault-sourced
  // personal content. Runtime enforcement (an explicit opt-in flag) is
  // deferred; surface a warning so an unintended path is observable in
  // logs. See `DispatchHandoff.context`'s JSDoc.
  if (target === 'codex') {
    log.warn('Codex dispatch — caller is responsible for the OpenAI trust boundary on handoff.context', {
      agent: handoff.agent,
      product: handoff.product,
      project: handoff.project,
    });
  }

  if (target === 'claude') {
    const prompt = formatPrompt(handoff);
    const { text: agentText, error: agentError } = await runAgent(handoff.agent, prompt);
    text = agentText;
    error = agentError;
  } else {
    // Provider-availability gate (A5.3) — short-circuit before agent load or
    // spawn when Codex is absent or unauthenticated. Returns a failed
    // DispatchResult so the merge contract's null-adjudication path applies
    // cleanly (cross-model review never sees a Codex run that never happened).
    const probe = await probeCodexProvider();
    if (!probe.available) {
      error = `codex executor unavailable: ${probe.reason}`;
      log.warn('Codex dispatch skipped — provider unavailable', { reason: probe.reason });
    } else {
      // Codex target — inline the compiled neutral agent doc since Codex
      // doesn't know Rune's agents dir. `runCodex` reads each option with
      // `?? default`, so plain undefined fields are equivalent to absent
      // ones (no need for conditional spreads).
      const loader = opts.loadNeutralAgent ?? defaultLoadNeutralAgent;
      const neutralDef = loader(handoff.agent);
      const compiledAgent = compileToCodex(neutralDef);
      const prompt = `${compiledAgent}\n---\n\n${formatPrompt(handoff)}`;
      const codexResult = await runCodex(prompt, {
        cwd: opts.cwd,
        env: opts.env,
        sandboxMode: opts.sandboxMode,
        timeoutMs: opts.timeoutMs,
        model: opts.model,
      });
      text = codexResult.text;
      error = codexResult.error;
    }
  }

  let result: DispatchResult;
  if (error || text === null) {
    const rawReason = error ?? 'executor returned empty output';
    result = {
      model,
      provider,
      status: 'failed',
      failureReason: truncateFailureReason(rawReason),
    };
    // Enforce the "text is null iff failed" invariant — Codex can return
    // partial stdout alongside a non-zero exit; downstream callers shouldn't
    // need to re-check `result.status` before reading `text`.
    text = null;
  } else {
    result = { model, provider, status: 'completed' };
  }

  const logEntry = recordDispatch(handoff, result);
  appendDispatchLog(logFile, logEntry);

  return { result, logEntry, text, error };
}
