import { spawn } from 'node:child_process';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('claude');

interface ClaudeResult {
  text: string | null;
  error: string | null;
}

// Per-session queue to prevent concurrent CLI writes to the same session
const sessionLocks = new Map<string, Promise<unknown>>();

function execClaude(args: string[]): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd: config.VAULT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: process.env['PATH'] },
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
        resolve({ text: null, error: `Claude timed out after ${config.CLAUDE_TIMEOUT_MS / 1000}s` });
      } else if (code !== 0) {
        resolve({ text: null, error: stderr.trim() || `Claude exited with code ${code}` });
      } else {
        resolve({ text: stdout.trim(), error: null });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ text: null, error: err.message });
    });
  });
}

/** Multi-turn conversation with session persistence */
export async function askClaude(message: string, sessionId: string): Promise<ClaudeResult> {
  const args = ['-p', message, '--session-id', sessionId];

  // Queue requests per session to avoid concurrent writes
  const previous = sessionLocks.get(sessionId) || Promise.resolve();
  const current = previous.then(() => execClaude(args));
  sessionLocks.set(sessionId, current.catch(() => {}));
  return current;
}

/** One-shot query with no session persistence */
export async function askClaudeOneShot(message: string): Promise<ClaudeResult> {
  const args = ['-p', message, '--no-session-persistence'];
  return execClaude(args);
}

/** Run a named agent (defined in .claude/agents/) */
export async function runAgent(agentName: string, prompt: string): Promise<ClaudeResult> {
  const args = ['--agent', agentName, '-p', prompt, '--no-session-persistence'];
  log.info(`Running agent: ${agentName}`);
  return execClaude(args);
}

/** Summarize a session for journal logging */
export async function summarizeSession(sessionId: string): Promise<ClaudeResult> {
  const prompt = `Summarize our conversation so far in this exact format (nothing else, no markdown fences):
Topic: <brief topic in 5-10 words>
Prompt: <the user's original question/request>
Discussion: <2-4 sentence summary of what was discussed>
Conclusion: <what was decided, learned, or resolved>`;

  return askClaude(prompt, sessionId);
}
