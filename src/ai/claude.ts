import { spawn, execFileSync } from 'node:child_process';
import { appendFile, appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import config, { PROJECT_ROOT } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { getDateContext } from '../utils/time.js';
// Deliberate one-way dependency ai/ → vault/: learnings (user-authored
// corrections) and voice (style/tone source of truth) are both prepended
// transparently so each caller need not re-implement the read. If either
// module ever needs Claude help (e.g., dedup, summarization), extract a
// context/ layer to break the cycle.
import { buildLearningsPrompt } from '../vault/learnings.js';
import { buildVoicePromptSection } from '../vault/voice.js';
import { appendInteraction } from '../utils/observation-log.js';
// ai/ → intent/: runAgent resolves its model through the model selection policy.
// model-policy.ts is a leaf (node:fs + logger only) — no import cycle.
import { resolveModel, loadModelPolicy } from '../intent/model-policy.js';
import type { NotificationBus, OpKind } from '../transport/notification-bus.js';
import { registerOp, unregisterOp, isCancelled, setOpDetail } from '../transport/in-flight.js';
import { formatToolUse } from './tool-labels.js';

const log = createLogger('claude');

let _bus: NotificationBus | null = null;

/** Wire the notification bus into claude.ts so runAgent() can emit agent-event frames. */
export function setBus(bus: NotificationBus): void {
  _bus = bus;
}

function resolveClaudePath(): string {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  } catch {}
  const localBin = join(homedir(), '.local', 'bin', 'claude');
  if (existsSync(localBin)) return localBin;
  throw new Error('Claude CLI not found in PATH or ~/.local/bin. Install from https://claude.ai/download');
}

/** Resolved path to the Claude CLI binary. Exported for use by callers that
 *  spawn claude directly (e.g. work-runner) to keep binary resolution centralized. */
export const CLAUDE_BIN = resolveClaudePath();

/** Absolute path to Jarvis's project-local Claude settings (declares the
 *  single `jarvis-kb` MCP server). Passed to every spawn via
 *  `--mcp-config` + `--strict-mcp-config` so the CLI ignores the user's
 *  global `~/.claude/settings.json`. */
const PROJECT_SETTINGS_PATH = join(PROJECT_ROOT, '.claude', 'settings.json');

/** Args that pin a Claude CLI spawn to Jarvis's project-local MCP config.
 *  Exported so external spawners (work-runner) can apply the same isolation
 *  — without this the spawn would inherit every MCP server the user has
 *  globally registered (claude.ai Knowledge Base, Linear, Gmail, …), each
 *  adding ~7s of ToolSearch latency and remote round-trips. */
export function getProjectMcpArgs(): string[] {
  return ['--strict-mcp-config', '--mcp-config', PROJECT_SETTINGS_PATH];
}

/** Fail-fast assertion that the project-local Claude settings file is on
 *  disk before we start spawning. Called from `src/index.ts` startup so a
 *  missing file produces one clear error rather than per-call CLI failures
 *  across every chat / agent / cron invocation. */
export function assertProjectMcpConfig(): void {
  if (!existsSync(PROJECT_SETTINGS_PATH)) {
    throw new Error(
      `Missing ${PROJECT_SETTINGS_PATH}. Every Claude CLI spawn passes ` +
      `--mcp-config to this file; it must exist (it declares the jarvis-kb ` +
      `MCP server). Restore it from git or re-create with the jarvis-kb entry.`,
    );
  }
}

export interface ClaudeResult {
  text: string | null;
  error: string | null;
}

// Per-session queue to prevent concurrent CLI writes to the same session
const sessionLocks = new Map<string, Promise<unknown>>();

// Track which CLI sessions have been created (--session-id creates, --resume continues)
const createdSessions = new Set<string>();

/** Mark a session ID as already created in the CLI (used for restored sessions after restart) */
export function markSessionCreated(sessionId: string): void {
  createdSessions.add(sessionId);
}

/** Clean up session tracking state when a session is deleted */
export function cleanupSession(sessionId: string): void {
  sessionLocks.delete(sessionId);
  createdSessions.delete(sessionId);
}

const activeProcesses = new Set<ReturnType<typeof spawn>>();

/** Register an external child process in the active-processes set for graceful-shutdown tracking. */
export function registerActiveProcess(child: ReturnType<typeof spawn>): void {
  activeProcesses.add(child);
}

/** Remove an external child process from the active-processes set when it exits. */
export function unregisterActiveProcess(child: ReturnType<typeof spawn>): void {
  activeProcesses.delete(child);
}

/** Kill all active Claude CLI child processes (for graceful shutdown) */
export function killActiveProcesses(): void {
  for (const child of activeProcesses) {
    child.kill('SIGTERM');
  }
}

/** Wait for all active Claude CLI child processes to exit, up to `timeoutMs`.
 *  Paired with killActiveProcesses(): call this after sending SIGTERM so the
 *  parent doesn't exit while children are mid-write. */
export async function waitForActiveProcesses(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (activeProcesses.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

export interface OpMeta {
  kind: OpKind;
  label: string;
  agentName?: string;
  userId?: number;
}

/** A spawn-scope override for a single Claude CLI run. By default an agent runs
 *  with `cwd: VAULT_DIR` and only `WORKSPACE_DIR` added as a writable dir. A
 *  write-scoped run (e.g. project-setup-writer scaffolding into a TARGET product
 *  repo — see src/intent/scaffold-target.ts) overrides the cwd and adds the
 *  target repo via `--add-dir` so the agent has real write access there. */
export interface AgentWriteScope {
  /** Working directory the child runs in (overrides the default vault cwd). */
  cwd: string;
  /** Directories to expose to the agent via `--add-dir` (in addition to WORKSPACE_DIR). */
  writableDirs: string[];
}

/** Append a single stream-json event line (envelope) to logs/claude-stream.jsonl.
 *  Best-effort + async: a log-write failure must not surface to the caller, and
 *  the fs write must not block the stdout `data` handler (which fires per line
 *  during streaming and would otherwise stall the event loop on every event). */
function appendStreamLogLine(line: string): void {
  // Fire-and-forget. Errors swallowed by design — if logs/ is unwritable we
  // continue serving requests rather than crash the chat turn.
  appendFile(config.CLAUDE_STREAM_LOG, line + '\n', () => { /* ignore */ });
}

const STREAM_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/** Rotate logs/claude-stream.jsonl if it has grown past 10 MB. Renames the
 *  current file to claude-stream.jsonl.old (overwriting any previous one).
 *  Idempotent — safe to call once at startup. Best-effort: missing file or
 *  rename error is logged and ignored. */
export function rotateStreamLogIfLarge(): void {
  const path = config.CLAUDE_STREAM_LOG;
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return; // file doesn't exist yet — nothing to rotate.
  }
  if (size < STREAM_LOG_MAX_BYTES) return;
  try {
    renameSync(path, path + '.old');
    log.info('Rotated claude-stream.jsonl', { sizeMb: (size / 1024 / 1024).toFixed(1) });
  } catch (err) {
    log.warn('Failed to rotate claude-stream.jsonl', { error: (err as Error).message });
  }
}

interface StreamState {
  finalText: string;
  resultText: string | null;
}

/** Parse one stream-json event from the CLI's stdout. Side-effects:
 *  - calls setOpDetail(opId, …) for each tool_use content block
 *  - appends the envelope to logs/claude-stream.jsonl
 *  - accumulates assistant text + result into `state`
 *  Unknown event types are still logged. */
function handleStreamEvent(raw: string, opId: string | null, opMeta: OpMeta | undefined, state: StreamState): void {
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return; // not JSON — ignore (claude prints occasional non-JSON banners)
  }
  appendStreamLogLine(JSON.stringify({
    ts: new Date().toISOString(),
    opId,
    ...(opMeta?.agentName ? { agent: opMeta.agentName } : {}),
    event,
  }));
  if (!event || typeof event !== 'object') return;
  const e = event as Record<string, unknown>;
  const type = e['type'];

  if (type === 'assistant') {
    const message = e['message'];
    if (message && typeof message === 'object') {
      const content = (message as Record<string, unknown>)['content'];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b['type'] === 'tool_use' && opId) {
            const name = typeof b['name'] === 'string' ? b['name'] : 'tool';
            setOpDetail(opId, formatToolUse(name, b['input']));
          } else if (b['type'] === 'text' && typeof b['text'] === 'string') {
            // Fallback accumulator — only used if the final `result` event
            // doesn't arrive (e.g. on early exit).
            state.finalText += b['text'];
          }
        }
      }
    }
  } else if (type === 'result' && typeof e['result'] === 'string') {
    state.resultText = e['result'] as string;
  }
}

function execClaude(args: string[], timeoutMs?: number, opMeta?: OpMeta, writeScope?: AgentWriteScope): Promise<ClaudeResult> {
  const timeout = timeoutMs ?? config.CLAUDE_TIMEOUT_MS;
  // Stream-json is opt-in for user-visible ops only. Classifier ops (resolver
  // Haiku calls) bypass it because their callers expect a single JSON blob on
  // stdout, and the path is latency-sensitive. `one-shot` IS included — its
  // callers (askClaudeOneShot, /ask, review:* routing) read the final text
  // through ClaudeResult.text, which still resolves correctly via the stream's
  // `result` event (or the text-block fallback on early exit).
  const streaming = !!opMeta && opMeta.kind !== 'classifier';
  const baseArgs = [
    '--dangerously-skip-permissions',
    ...getProjectMcpArgs(),
    ...(config.WORKSPACE_DIR ? ['--add-dir', config.WORKSPACE_DIR] : []),
    // A write-scoped run adds its target dirs so the agent can write there
    // (default cwd is the vault, which is otherwise its only writable root).
    ...(writeScope ? writeScope.writableDirs.flatMap((d) => ['--add-dir', d]) : []),
  ];
  const streamArgs = streaming
    ? ['--output-format', 'stream-json', '--verbose']
    : [];
  const fullArgs = [...baseArgs, ...streamArgs, ...args];

  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, fullArgs, {
      cwd: writeScope?.cwd ?? config.VAULT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Expose PROJECT_ROOT so agents that shell out can locate the Jarvis
      // repo (cwd is the vault). Needed for the intent-scan cron-dogfood
      // agent, which runs `npm run intent-scan` from the project root.
      env: {
        ...process.env,
        JARVIS_PROJECT_ROOT: PROJECT_ROOT,
        ...(config.WORKSPACE_DIR ? { JARVIS_WORKSPACE_DIR: config.WORKSPACE_DIR } : {}),
      },
    });

    activeProcesses.add(child);

    // Register an in-flight op so this spawn surfaces to TG/webview with
    // elapsed time + cancel button. Default userId to the single TG user.
    let opId: string | null = null;
    if (opMeta) {
      const op = registerOp({
        kind: opMeta.kind,
        label: opMeta.label,
        ...(opMeta.agentName ? { agentName: opMeta.agentName } : {}),
        userId: opMeta.userId ?? config.TELEGRAM_USER_ID,
        child,
      });
      opId = op.opId;
    }

    // In non-streaming mode `stdout` is the result text. In streaming mode the
    // result comes from `streamState.resultText` and `stdout` is only used for
    // the timeout-tail log message, so we keep a small rolling tail instead of
    // an unbounded buffer (avoids holding 100s of KB for long agent runs).
    const STREAM_STDOUT_TAIL_BYTES = 1500;
    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    const streamState: StreamState = { finalText: '', resultText: null };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeout);

    child.stdout.on('data', (data: Buffer) => {
      if (streaming) {
        // Rolling tail — only the last STREAM_STDOUT_TAIL_BYTES bytes are kept
        // for the timeout error path. The structured result comes from the
        // parsed stream events below.
        stdout = (stdout + data.toString('utf8')).slice(-STREAM_STDOUT_TAIL_BYTES);
        // Mirrors the line-buffering pattern from work-runner.streamProcess:
        // bytes can split JSON lines mid-token, so accumulate the remainder.
        lineBuf += data.toString('utf8');
        let nl: number;
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          if (line.trim()) handleStreamEvent(line, opId, opMeta, streamState);
        }
      } else {
        stdout += data;
      }
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data;
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      activeProcesses.delete(child);
      // Flush any trailing partial line as a best-effort parse.
      if (streaming && lineBuf.trim()) {
        handleStreamEvent(lineBuf, opId, opMeta, streamState);
        lineBuf = '';
      }
      // Claude CLI installs a SIGTERM handler that exits cleanly with code 143
      // (POSIX convention: 128 + SIGTERM=15), so Node reports `{code: 143,
      // signal: null}` — not `{code: null, signal: 'SIGTERM'}`. Treat both as
      // timeouts so the TG summary stays readable.
      const timedOut = signal === 'SIGTERM' || code === 143;
      const successText = streaming
        ? (streamState.resultText ?? streamState.finalText)
        : stdout;
      if (opId !== null && isCancelled(opId)) {
        unregisterOp(opId, 'cancelled', 'Cancelled by user');
        resolve({ text: null, error: 'Cancelled by user' });
      } else if (timedOut) {
        const tail = (s: string) => s.slice(-500).trim();
        log.error('Claude CLI timed out', {
          args: args.slice(0, 3),
          code,
          signal,
          stdoutTail: tail(stdout) || null,
          stderrTail: tail(stderr) || null,
        });
        const error = `Claude timed out after ${timeout / 1000}s`;
        if (opId) unregisterOp(opId, 'error', error);
        resolve({ text: null, error });
      } else if (code !== 0) {
        const error = stderr.trim() || `Claude exited with code ${code}`;
        log.error('Claude CLI failed', { code, error, args: args.slice(0, 3) });
        if (opId) unregisterOp(opId, 'error', error);
        resolve({ text: null, error });
      } else {
        if (opId) unregisterOp(opId, 'success');
        resolve({ text: successText.trim(), error: null });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      activeProcesses.delete(child);
      if (opId) unregisterOp(opId, 'error', err.message);
      log.error('Claude CLI spawn error', { error: err.message, args: args.slice(0, 3) });
      resolve({ text: null, error: err.message });
    });
  });
}

function askClaudeSession(
  message: string,
  sessionId: string,
  model?: string,
  systemPrompt?: string,
  allowedTools?: string[],
  opLabel?: string,
  voice?: boolean,
): Promise<ClaudeResult> {
  const previous = sessionLocks.get(sessionId) || Promise.resolve();
  const current = previous.then(async () => {
    const args = createdSessions.has(sessionId)
      ? ['-p', message, '--resume', sessionId]
      : ['-p', message, '--session-id', sessionId];
    // Voice is appended to the system prompt so it persists across all turns in
    // the session without being repeated in every user message.
    const voiceBlock = voice ? buildVoicePromptSection() : '';
    const composedSystemPrompt = voiceBlock
      ? (systemPrompt ? `${systemPrompt}\n\n${voiceBlock}` : voiceBlock)
      : systemPrompt;
    if (composedSystemPrompt) args.push('--append-system-prompt', composedSystemPrompt);
    if (allowedTools && allowedTools.length > 0) args.push('--allowedTools', ...allowedTools);
    args.push('--model', model || config.DEFAULT_CHAT_MODEL);
    const opMeta: OpMeta | undefined = opLabel ? { kind: 'chat', label: opLabel } : undefined;
    const result = await execClaude(args, undefined, opMeta);
    if (!result.error) createdSessions.add(sessionId);
    return result;
  });
  sessionLocks.set(sessionId, current.catch(() => {}));
  return current;
}

/** Multi-turn conversation with session persistence. Pass `opLabel` to surface
 *  the call as a cancellable in-flight op (tracker message on TG, pill on
 *  webview); omit for background/non-interactive callers. Pass `voice: true`
 *  for callers that produce prose the user reads (see src/vault/voice.ts). */
export async function askClaude(message: string, sessionId: string, model?: string, opLabel?: string, voice?: boolean): Promise<ClaudeResult> {
  return askClaudeSession(message, sessionId, model, undefined, undefined, opLabel, voice);
}

/** Options for `askClaudeWithContext`. Bag-shaped because this entry point
 *  carries the most knobs (model, tools, op-label, voice) — positional made
 *  call sites pass `undefined, undefined` to reach the trailing flags. */
export interface AskClaudeWithContextOpts {
  /** Override the default chat model (`config.DEFAULT_CHAT_MODEL`). */
  model?: string;
  /** Restrict the CLI tool allowlist. Omit to use Claude's defaults. */
  allowedTools?: string[];
  /** Friendly label for the in-flight op tracker (TG message, webview pill).
   *  Omit for background/non-interactive callers. */
  opLabel?: string;
  /** Prepend the user's writing voice (see src/vault/voice.ts). Set for callers
   *  that produce prose the user reads; leave unset for structured output. */
  voice?: boolean;
}

/** Multi-turn conversation with session persistence and appended system prompt. */
export async function askClaudeWithContext(
  message: string,
  sessionId: string,
  systemPrompt: string,
  opts: AskClaudeWithContextOpts = {},
): Promise<ClaudeResult> {
  return askClaudeSession(message, sessionId, opts.model, systemPrompt, opts.allowedTools, opts.opLabel, opts.voice);
}

/** One-shot query with no session persistence. Pass `opLabel` to surface as a
 *  cancellable in-flight op; omit for background callers (nightly, cron,
 *  meeting/book extraction) so they don't spam tracker messages. Pass
 *  `voice: true` for callers that produce prose the user reads. */
export async function askClaudeOneShot(message: string, timeoutMs?: number, opLabel?: string, voice?: boolean): Promise<ClaudeResult> {
  const dateCtx = getDateContext();
  const args = ['-p', `${dateCtx}\n\n${message}`, '--no-session-persistence', '--model', config.ONESHOT_MODEL];
  // Voice goes via --append-system-prompt (same channel as askClaudeSession), not
  // the -p user payload, so it carries system-prompt authority and stays out of
  // the args.slice(0, 3) error-log window.
  if (voice) {
    const voiceBlock = buildVoicePromptSection();
    if (voiceBlock) args.push('--append-system-prompt', voiceBlock);
  }
  const opMeta: OpMeta | undefined = opLabel ? { kind: 'one-shot', label: opLabel } : undefined;
  return execClaude(args, timeoutMs, opMeta);
}

/** Thin Haiku one-shot wrapper — no session, no date-context prefix, short
 *  default timeout. Used by the resolver for structured JSON classification
 *  and by the intent-scan for grouping repeated user intents. Callers are
 *  responsible for parsing any response; this function only spawns the CLI.
 *  The short default timeout is right for callers on the latency-sensitive
 *  path (e.g. the resolver); offline callers (e.g. the weekly scan) may pass
 *  a larger explicit `timeoutMs`. */
export async function askHaikuOneShot(prompt: string, timeoutMs?: number): Promise<ClaudeResult> {
  const args = ['-p', prompt, '--no-session-persistence', '--model', config.CLASSIFIER_MODEL];
  return execClaude(args, timeoutMs ?? config.CLASSIFIER_TIMEOUT_MS, { kind: 'classifier', label: 'classifier' });
}


export interface AgentDef {
  prompt: string;
  tools: string[];
  /** Claude model override for this agent (e.g. 'sonnet', 'haiku'). When set,
   *  takes precedence over config.AGENT_MODEL so individual agents can opt into
   *  a lighter or more instruction-following model without a global setting change. */
  model?: string;
  /** One-line agent description from frontmatter. Used by the skill registry
   *  to give the resolver a compact label for each routable skill. */
  description?: string;
  /** Optional cron expression (5- or 6-field). When set, the scheduler registers
   *  a job that calls runAgent(name, cron_args ?? '') at each tick. */
  cron?: string;
  /** Prompt string passed as the second arg to runAgent when cron fires. */
  cronArgs?: string;
  /** When true, the agent's stdout is posted to Telegram; otherwise log-only. */
  cronChat?: boolean;
  /** Natural-language trigger phrases used by the resolver to classify free-form
   *  TG messages onto this agent. */
  triggers?: string[];
}

const agentDefCache = new Map<string, AgentDef>();

/** Evict all cached agent defs. Call on scheduler restart so frontmatter edits
 *  (new cron, changed triggers, etc.) take effect without a full process restart. */
export function clearAgentDefCache(): void {
  agentDefCache.clear();
}

/** Load an agent definition from .claude/agents/<name>.md, parsing frontmatter and body.
 *  Jarvis's own .claude/agents/ is checked first (generic, public, versioned with code);
 *  the vault's .claude/agents/ is the fallback (user-owned, private, may contain
 *  personal references like family names, employer, project codenames). */
export function loadAgentDef(agentName: string): AgentDef {
  const cached = agentDefCache.get(agentName);
  if (cached) return cached;

  const jarvisPath = join(PROJECT_ROOT, '.claude', 'agents', `${agentName}.md`);
  const vaultPath = join(config.VAULT_DIR, '.claude', 'agents', `${agentName}.md`);

  let raw: string;
  let filePath: string;
  try {
    raw = readFileSync(jarvisPath, 'utf8');
    filePath = jarvisPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // Fall back to vault. If this also throws ENOENT, runAgent's caller will
    // surface it as "Agent not found: <name>".
    raw = readFileSync(vaultPath, 'utf8');
    filePath = vaultPath;
  }

  // Split frontmatter (between --- markers) from body
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`Agent file ${filePath} has no valid frontmatter`);

  const frontmatter = match[1]!;
  const body = match[2]!.trim();

  // Parse tools from frontmatter (simple YAML list extraction)
  const tools = parseYamlListField(frontmatter, 'tools');
  const triggers = parseYamlListField(frontmatter, 'triggers');

  const model = parseYamlScalarField(frontmatter, 'model');
  const description = parseYamlScalarField(frontmatter, 'description');
  const cron = parseYamlScalarField(frontmatter, 'cron');
  const cronArgs = parseYamlScalarField(frontmatter, 'cron_args');
  const cronChatRaw = parseYamlScalarField(frontmatter, 'cron_chat')?.toLowerCase();
  const cronChat = cronChatRaw === 'true' ? true : cronChatRaw === 'false' ? false : undefined;

  const def: AgentDef = {
    prompt: body,
    tools,
    ...(model !== undefined ? { model } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(cron !== undefined ? { cron } : {}),
    ...(cronArgs !== undefined ? { cronArgs } : {}),
    ...(cronChat !== undefined ? { cronChat } : {}),
    ...(triggers.length > 0 ? { triggers } : {}),
  };
  agentDefCache.set(agentName, def);
  return def;
}

/** Extract a single-line scalar value from a YAML frontmatter string.
 *  Supports: `key: value`, `key: "value"`, `key: 'value'`. Returns undefined
 *  if the field is absent. Values are trimmed. Only looks at line-leading keys
 *  (not nested). Good enough for Jarvis's flat frontmatter schema. */
function parseYamlScalarField(frontmatter: string, key: string): string | undefined {
  const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escKey}:[ \\t]*(.*?)\\s*$`, 'm');
  const match = frontmatter.match(re);
  if (!match) return undefined;
  let raw = match[1]!.trim();
  if (raw.length === 0) return undefined;
  // Strip surrounding quotes first so `"x" # comment` is handled as well as `x # comment`.
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Strip trailing inline comment (YAML convention: ` #` starts a comment when
  // the `#` is preceded by whitespace). Only applied to unquoted values.
  const commentIdx = raw.search(/\s+#/);
  if (commentIdx !== -1) raw = raw.slice(0, commentIdx).trim();
  return raw;
}

/** Extract a YAML list field. Supports the block form:
 *    key:
 *      - foo
 *      - bar
 *  Returns [] if the field is absent or empty. Items are trimmed of quotes. */
function parseYamlListField(frontmatter: string, key: string): string[] {
  const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Accept zero-indent (`- item`) as well as indented (`  - item`) block lists.
  const re = new RegExp(`^${escKey}:\\n((?:[ \\t]*-\\s+.+\\n?)*)`, 'm');
  const match = frontmatter.match(re);
  if (!match) return [];
  const items: string[] = [];
  for (const line of match[1]!.split('\n')) {
    const itemMatch = line.match(/^[ \t]*-\s+(.+?)\s*$/);
    if (!itemMatch) continue;
    let item = itemMatch[1]!;
    if ((item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'"))) {
      item = item.slice(1, -1);
    }
    items.push(item);
  }
  return items;
}

/** Prefix used on runAgent error messages when the agent file cannot be loaded. */
export const AGENT_NOT_FOUND_PREFIX = 'Agent not found:';

/** Resolve the model for an agent run through the model selection policy (project 08).
 *  The agent's frontmatter `model:` is mapped onto the policy's explicit-pin precedence.
 *  When no policy file is present the resolver is skipped and the pre-policy default
 *  applies (`def.model ?? config.AGENT_MODEL`), so a missing policy never breaks a run; a
 *  present-but-malformed policy throws and the caller surfaces it as a run error. */
function resolveAgentModel(agentName: string, def: AgentDef): string {
  const policy = loadModelPolicy(config.MODEL_POLICY_FILE);
  if (!policy) return def.model ?? config.AGENT_MODEL;
  // capabilities: [] for now — agents do not yet declare capability tags in frontmatter
  // (the capability-tag vocabulary is a spec open question). Resolution therefore runs on
  // pin → role-default → global-fallback, which preserves every current agent's model.
  return resolveModel({ role: agentName, capabilities: [], pin: def.model }, policy).model;
}

/** Run a named agent (defined in .claude/agents/). Set `userVisible: false`
 *  for background callers (nightly, cron, scheduled jobs) so they don't send
 *  tracker messages while the user is asleep. Pass `voice: true` for agents
 *  that produce prose the user reads (kb-query, review-writer, etc.); leave
 *  unset for classifiers and JSON/structured agents so their output stays
 *  deterministic. */
export async function runAgent(agentName: string, prompt: string, timeoutMs?: number, userVisible = true, voice?: boolean, writeScope?: AgentWriteScope): Promise<ClaudeResult> {
  const dateCtx = getDateContext();
  let def: AgentDef;
  try {
    def = loadAgentDef(agentName);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = code === 'ENOENT'
      ? `${AGENT_NOT_FOUND_PREFIX} ${agentName}`
      : `Failed to load agent ${agentName}: ${(err as Error).message}`;
    log.error(message, { agentName });
    return { text: null, error: message };
  }
  let model: string;
  try {
    model = resolveAgentModel(agentName, def);
  } catch (err) {
    // A malformed model policy fails loudly as a run error rather than silently
    // defaulting — see resolveAgentModel / the model selection policy (project 08).
    const message = `Failed to resolve model for agent ${agentName}: ${(err as Error).message}`;
    log.error(message, { agentName });
    return { text: null, error: message };
  }
  const agentsJson = JSON.stringify({ [agentName]: { prompt: def.prompt } });
  // Both builders go through readVaultFile, which swallows read errors and
  // returns null — they each return '' on missing/empty. No try/catch needed.
  const learningsBlock = buildLearningsPrompt();
  const voiceBlock = voice ? buildVoicePromptSection() : '';
  // Prepend ordering: learnings → voice → dateCtx → workspace → prompt.
  // Learnings (user-authored corrections) come first so /learn guidance retains
  // recency-weight precedence over voice (a stable style baseline) when the
  // two would otherwise conflict.
  const args = [
    '--agent', agentName,
    '--agents', agentsJson,
    '-p', `${learningsBlock}${voiceBlock}${dateCtx}${config.WORKSPACE_DIR ? `\nWorkspace directory (read-only): ${config.WORKSPACE_DIR}` : ''}\n\n${prompt}`,
    '--no-session-persistence',
    '--model', model,
  ];
  // Only restrict tools if the agent frontmatter declares them. Vault agents
  // (authored for standalone Claude Code use) may omit `tools:`, in which case
  // we let the CLI apply its defaults rather than passing an empty allowlist.
  if (def.tools.length > 0) {
    args.push('--allowedTools', ...def.tools);
  }
  log.info(`Running agent: ${agentName}`, { model });
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const userId = config.TELEGRAM_USER_ID;
  _bus?.publish({ kind: 'agent-event', subKind: 'start', agent: agentName, runId, userId, startedAt });
  const opMeta: OpMeta | undefined = userVisible
    ? { kind: 'agent', label: agentName, agentName, userId }
    : undefined;
  const result = await execClaude(args, timeoutMs, opMeta, writeScope);
  const durationMs = Date.now() - t0;
  const status = result.error ? 'error' : 'success';
  _bus?.publish({ kind: 'agent-event', subKind: 'end', agent: agentName, runId, userId, startedAt, durationMs, status });
  const entry = JSON.stringify({ agent: agentName, startedAt, durationMs, status });
  try {
    appendFileSync(join(config.LOGS_DIR, 'agent-runs.jsonl'), entry + '\n');
  } catch {
    // Non-fatal — snapshot will just show empty recent runs
  }
  // Phase 6 B1.4 — also emit an InteractionLogRecord for the observation
  // loop's interaction sensor. Distinct from agent-runs.jsonl (which is the
  // snapshot/visualization source); the observation log is the loop's
  // sensor signal. Detail carries only structured metadata — agent name +
  // duration — never the prompt body.
  try {
    appendInteraction({
      ts: startedAt,
      kind: 'agent-call',
      outcome: status === 'success' ? 'success' : 'failure',
      detail: `agent=${agentName} dur=${durationMs}`,
    });
  } catch {
    // Non-fatal — observation logging is best-effort, same as agent-runs.jsonl
  }
  return result;
}

/** Summarize a session for journal logging */
export async function summarizeSession(sessionId: string): Promise<ClaudeResult> {
  const prompt = `Summarize our conversation so far in this exact format (nothing else, no markdown fences):
Topic: <brief topic in 5-10 words>
Prompt: <the user's original question/request>
Discussion: <2-4 sentence summary of what was discussed>
Conclusion: <what was decided, learned, or resolved>
KB-worthy: <yes or no>

KB-worthy means this conversation produced insights worth ingesting into the knowledge base. Answer yes if it produced a new insight, framework, mental model, factual information worth preserving, or explored a topic in depth. Answer no if it was purely operational, casual chat, or covered topics already well-documented.`;

  return askClaude(prompt, sessionId, config.DEFAULT_CHAT_MODEL, undefined, true);
}
