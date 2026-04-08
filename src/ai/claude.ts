import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import config from '../config.js';
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

interface ClaudeResult {
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

function execClaude(args: string[]): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: config.VAULT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, config.CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', (data: Buffer) => {
      stdout += data;
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data;
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGTERM') {
        log.error('Claude CLI timed out', { args: args.slice(0, 3) });
        resolve({ text: null, error: `Claude timed out after ${config.CLAUDE_TIMEOUT_MS / 1000}s` });
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
      log.error('Claude CLI spawn error', { error: err.message, args: args.slice(0, 3) });
      resolve({ text: null, error: err.message });
    });
  });
}

/** Multi-turn conversation with session persistence */
export async function askClaude(message: string, sessionId: string, model?: string): Promise<ClaudeResult> {
  // Queue requests per session to avoid concurrent writes
  const previous = sessionLocks.get(sessionId) || Promise.resolve();
  const current = previous.then(async () => {
    const args = createdSessions.has(sessionId)
      ? ['-p', message, '--resume', sessionId, '--model', model || config.DEFAULT_CHAT_MODEL]
      : ['-p', message, '--session-id', sessionId, '--model', model || config.DEFAULT_CHAT_MODEL];
    const result = await execClaude(args);
    if (!result.error) createdSessions.add(sessionId);
    return result;
  });
  sessionLocks.set(sessionId, current.catch(() => {}));
  return current;
}

/** One-shot query with no session persistence */
export async function askClaudeOneShot(message: string): Promise<ClaudeResult> {
  const dateCtx = getDateContext();
  const args = ['-p', `${dateCtx}\n\n${message}`, '--no-session-persistence', '--model', config.ONESHOT_MODEL];
  return execClaude(args);
}

/** Run a named agent (defined in .claude/agents/) */
export async function runAgent(agentName: string, prompt: string): Promise<ClaudeResult> {
  const dateCtx = getDateContext();
  const args = ['--agent', agentName, '-p', `${dateCtx}\n\n${prompt}`, '--no-session-persistence', '--model', config.AGENT_MODEL];
  log.info(`Running agent: ${agentName}`, { model: config.AGENT_MODEL });
  return execClaude(args);
}

/** Summarize a session for journal logging */
export async function summarizeSession(sessionId: string): Promise<ClaudeResult> {
  const prompt = `Summarize our conversation so far in this exact format (nothing else, no markdown fences):
Topic: <brief topic in 5-10 words>
Prompt: <the user's original question/request>
Discussion: <2-4 sentence summary of what was discussed>
Conclusion: <what was decided, learned, or resolved>`;

  return askClaude(prompt, sessionId, config.DEFAULT_CHAT_MODEL);
}
