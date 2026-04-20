import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import config, { PROJECT_ROOT } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { getDateContext } from '../utils/time.js';

const log = createLogger('claude');

function resolveClaudePath(): string {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  } catch {}
  const localBin = join(homedir(), '.local', 'bin', 'claude');
  if (existsSync(localBin)) return localBin;
  throw new Error('Claude CLI not found in PATH or ~/.local/bin. Install from https://claude.ai/download');
}

const CLAUDE_BIN = resolveClaudePath();

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

/** Kill all active Claude CLI child processes (for graceful shutdown) */
export function killActiveProcesses(): void {
  for (const child of activeProcesses) {
    child.kill('SIGTERM');
  }
}

function execClaude(args: string[], timeoutMs?: number): Promise<ClaudeResult> {
  const timeout = timeoutMs ?? config.CLAUDE_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: config.VAULT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    activeProcesses.add(child);

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeout);

    child.stdout.on('data', (data: Buffer) => {
      stdout += data;
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data;
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      activeProcesses.delete(child);
      if (signal === 'SIGTERM') {
        log.error('Claude CLI timed out', { args: args.slice(0, 3) });
        resolve({ text: null, error: `Claude timed out after ${timeout / 1000}s` });
      } else if (code !== 0) {
        const error = stderr.trim() || `Claude exited with code ${code}`;
        log.error('Claude CLI failed', { code, error, args: args.slice(0, 3) });
        resolve({ text: null, error });
      } else {
        resolve({ text: stdout.trim(), error: null });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      activeProcesses.delete(child);
      log.error('Claude CLI spawn error', { error: err.message, args: args.slice(0, 3) });
      resolve({ text: null, error: err.message });
    });
  });
}

function askClaudeSession(message: string, sessionId: string, model?: string, systemPrompt?: string, allowedTools?: string[]): Promise<ClaudeResult> {
  const previous = sessionLocks.get(sessionId) || Promise.resolve();
  const current = previous.then(async () => {
    const args = createdSessions.has(sessionId)
      ? ['-p', message, '--resume', sessionId]
      : ['-p', message, '--session-id', sessionId];
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    if (allowedTools && allowedTools.length > 0) args.push('--allowedTools', ...allowedTools);
    args.push('--model', model || config.DEFAULT_CHAT_MODEL);
    const result = await execClaude(args);
    if (!result.error) createdSessions.add(sessionId);
    return result;
  });
  sessionLocks.set(sessionId, current.catch(() => {}));
  return current;
}

/** Multi-turn conversation with session persistence */
export async function askClaude(message: string, sessionId: string, model?: string): Promise<ClaudeResult> {
  return askClaudeSession(message, sessionId, model);
}

/** Multi-turn conversation with session persistence and appended system prompt */
export async function askClaudeWithContext(message: string, sessionId: string, systemPrompt: string, model?: string, allowedTools?: string[]): Promise<ClaudeResult> {
  return askClaudeSession(message, sessionId, model, systemPrompt, allowedTools);
}

/** One-shot query with no session persistence */
export async function askClaudeOneShot(message: string, timeoutMs?: number): Promise<ClaudeResult> {
  const dateCtx = getDateContext();
  const args = ['-p', `${dateCtx}\n\n${message}`, '--no-session-persistence', '--model', config.ONESHOT_MODEL];
  return execClaude(args, timeoutMs);
}

interface AgentDef {
  prompt: string;
  tools: string[];
}

const agentDefCache = new Map<string, AgentDef>();

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
  const tools: string[] = [];
  const toolsMatch = frontmatter.match(/tools:\n((?:\s+-\s+\S+\n?)*)/);
  if (toolsMatch) {
    for (const line of toolsMatch[1]!.split('\n')) {
      const tool = line.match(/^\s+-\s+(\S+)/);
      if (tool) tools.push(tool[1]!);
    }
  }

  const def = { prompt: body, tools };
  agentDefCache.set(agentName, def);
  return def;
}

/** Prefix used on runAgent error messages when the agent file cannot be loaded. */
export const AGENT_NOT_FOUND_PREFIX = 'Agent not found:';

/** Run a named agent (defined in .claude/agents/) */
export async function runAgent(agentName: string, prompt: string, timeoutMs?: number): Promise<ClaudeResult> {
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
  const agentsJson = JSON.stringify({ [agentName]: { prompt: def.prompt } });
  const args = [
    '--agent', agentName,
    '--agents', agentsJson,
    '-p', `${dateCtx}\n\n${prompt}`,
    '--no-session-persistence',
    '--model', config.AGENT_MODEL,
  ];
  // Only restrict tools if the agent frontmatter declares them. Vault agents
  // (authored for standalone Claude Code use) may omit `tools:`, in which case
  // we let the CLI apply its defaults rather than passing an empty allowlist.
  if (def.tools.length > 0) {
    args.push('--allowedTools', ...def.tools);
  }
  log.info(`Running agent: ${agentName}`, { model: config.AGENT_MODEL });
  return execClaude(args, timeoutMs);
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

  return askClaude(prompt, sessionId, config.DEFAULT_CHAT_MODEL);
}
