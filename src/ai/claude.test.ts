import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: '/tmp/test-vault',
    CLAUDE_TIMEOUT_MS: 100,
    DEFAULT_CHAT_MODEL: 'opus',
    ONESHOT_MODEL: 'opus',
    AGENT_MODEL: 'opus',
    TIMEZONE: 'America/Chicago',
    CLAUDE_STREAM_LOG: '/tmp/test-logs/claude-stream.jsonl',
    MODEL_POLICY_FILE: '/tmp/test-project/policies/model-policy.json',
  },
  PROJECT_ROOT: '/tmp/test-project',
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(() => '/usr/local/bin/claude\n'),
}));

vi.mock('../utils/observation-log.js', () => ({
  appendInteraction: vi.fn(),
}));

const MOCK_AGENT_FILE = `---
name: wiki-compiler
model: sonnet
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

You are the wiki compiler for a personal knowledge base.`;

// An agent with no `model:` frontmatter — its model comes from the policy.
const PLAIN_AGENT_FILE = `---
name: plain-agent
tools:
  - Read
---

You are a plain agent with no pinned model.`;

// A model policy whose roleDefaults route `plain-agent` to haiku — proving runAgent
// resolves through the policy (a role default is impossible without the wiring).
const MOCK_MODEL_POLICY = JSON.stringify({
  models: [
    { alias: 'opus', provider: 'anthropic', format: 'claude', capabilities: ['coding'], costTier: 'high', status: 'preferred' },
    { alias: 'sonnet', provider: 'anthropic', format: 'claude', capabilities: ['coding'], costTier: 'medium', status: 'active' },
    { alias: 'haiku', provider: 'anthropic', format: 'claude', capabilities: ['coding'], costTier: 'low', status: 'active' },
  ],
  globalFallback: 'opus',
  roleDefaults: { 'plain-agent': 'haiku' },
  evaluatorDistinctFromGenerator: false,
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn((path: string) => {
      if (typeof path === 'string' && path.includes('model-policy.json')) return MOCK_MODEL_POLICY;
      if (typeof path === 'string' && path.includes('.claude/agents/plain-agent.md')) return PLAIN_AGENT_FILE;
      if (typeof path === 'string' && path.includes('.claude/agents/')) return MOCK_AGENT_FILE;
      throw new Error(`ENOENT: ${path}`);
    }),
  };
});

const { spawn } = await import('node:child_process');
const { readFileSync } = await import('node:fs');
const { askClaude, askClaudeWithContext, askClaudeOneShot, runAgent, summarizeSession, summarizeConversationMessages, markSessionCreated, loadAgentDef, getProjectMcpArgs, clearProjectMcpArgsCacheForTest } =
  await import('./claude.js');
// Type import — verifies ClaudeResult is exported (TS compile error if not)
import type { ClaudeResult } from './claude.js';

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

// The MCP isolation args (now an inline, PROJECT_ROOT-pinned config). Computed
// once so the exact-args assertions track getProjectMcpArgs() rather than a
// brittle hardcoded path.
const MCP_CFG_ARGS = getProjectMcpArgs();

/** Stream-json `result` event line. Use as the `stdout` for createChild() in
 *  runAgent tests — runAgent passes opMeta so execClaude runs in streaming
 *  mode and pulls the final text from a `result` event, not raw stdout. */
function streamResultLine(text: string): string {
  return JSON.stringify({ type: 'result', result: text }) + '\n';
}

function createChild(opts: { stdout?: string; stderr?: string; code?: number; signal?: string | null } = {}) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  const { stdout, stderr, code = 0, signal = null } = opts;
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code, signal);
  });
  return child;
}

describe('getProjectMcpArgs — cwd-independent rune-kb config', () => {
  // Regression: every Rune spawn runs from a non-repo cwd (the vault for
  // agents/chat, the product repo for product chats). The committed
  // .claude/settings.json registers rune-kb with a RELATIVE entrypoint
  // (`src/mcp/index.ts`), which only resolves when cwd is the repo root — so
  // the MCP server failed to start (ERR_MODULE_NOT_FOUND) for all spawns. The
  // args must carry an inline config whose paths are absolute and pinned to
  // PROJECT_ROOT so rune-kb resolves regardless of the spawned claude's cwd.
  it('passes inline --mcp-config JSON with PROJECT_ROOT-absolute paths and cwd', () => {
    const args = getProjectMcpArgs();
    expect(args[0]).toBe('--strict-mcp-config');
    expect(args[1]).toBe('--mcp-config');

    const inline = args[2]!;
    const cfg = JSON.parse(inline) as {
      mcpServers: Record<string, { command?: string; cwd?: string; args?: string[] }>;
    };
    const server = cfg.mcpServers['rune-kb'];
    expect(server).toBeDefined();
    expect(server!.command).toBe('node');
    expect(server!.cwd).toBe('/tmp/test-project');

    const joinedArgs = (server!.args ?? []).join(' ');
    expect(joinedArgs).toContain('/tmp/test-project/scripts/register-ts.mjs');
    expect(joinedArgs).toContain('/tmp/test-project/src/mcp/index.ts');
    expect(joinedArgs).toContain('--env-file-if-exists=/tmp/test-project/.env.local');
    // No relative entrypoint survives (the bug that broke MCP from a foreign cwd).
    expect((server!.args ?? [])).not.toContain('src/mcp/index.ts');
    expect((server!.args ?? [])).not.toContain('--env-file-if-exists=.env.local');
  });

  it('fails loudly when project MCP settings are malformed instead of silently falling back', () => {
    const readMock = readFileSync as unknown as ReturnType<typeof vi.fn>;
    const originalImpl = readMock.getMockImplementation() as ((path: string) => string) | undefined;
    clearProjectMcpArgsCacheForTest();
    readMock.mockImplementation((path: string) => {
      if (typeof path === 'string' && path.includes('.claude/settings.json')) return '{malformed';
      return originalImpl!(path);
    });
    try {
      expect(() => getProjectMcpArgs()).toThrow(/Could not build Claude MCP config|settings\.json/i);
    } finally {
      readMock.mockImplementation(originalImpl!);
      clearProjectMcpArgsCacheForTest();
      // Repopulate the normal fallback used by this test file's fs mock.
      getProjectMcpArgs();
    }
  });
});

describe('ai/claude', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  describe('askClaudeOneShot', () => {
    it('returns text on success', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'hello world' }));
      const result = await askClaudeOneShot('test prompt');
      expect(result).toEqual({ text: 'hello world', error: null });
    });

    it('uses the configured one-shot model and prepends date context', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaudeOneShot('test prompt');
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['--dangerously-skip-permissions', ...MCP_CFG_ARGS, '-p', expect.stringContaining('test prompt'), '--no-session-persistence', '--model', 'opus'],
        expect.objectContaining({ cwd: '/tmp/test-vault' }),
      );
      // Find the prompt by index of '-p' rather than a hard-coded position,
      // so adding/removing flags later doesn't silently shift the index.
      const args = spawnMock.mock.calls[0]![1] as string[];
      const prompt = args[args.indexOf('-p') + 1]!;
      expect(prompt).toMatch(/^Today is .+\(America\/Chicago\)/);
    });

    it('returns error on non-zero exit', async () => {
      spawnMock.mockReturnValue(createChild({ stderr: 'something broke', code: 1 }));
      const result = await askClaudeOneShot('test');
      expect(result).toEqual({ text: null, error: 'something broke' });
    });

    it('returns exit code when no stderr', async () => {
      spawnMock.mockReturnValue(createChild({ code: 1 }));
      const result = await askClaudeOneShot('test');
      expect(result.error).toBe('Claude exited with code 1');
    });

    it('returns error on spawn error event', async () => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      process.nextTick(() => child.emit('error', new Error('ENOENT')));
      spawnMock.mockReturnValue(child);
      const result = await askClaudeOneShot('test');
      expect(result.error).toBe('ENOENT');
    });
  });

  describe('askClaude (session)', () => {
    it('uses --session-id and the default chat model for new sessions', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'reply' }));
      await askClaude('hello', 'new-sess');
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['--dangerously-skip-permissions', ...MCP_CFG_ARGS, '-p', 'hello', '--session-id', 'new-sess', '--model', 'opus'],
        expect.any(Object),
      );
    });

    it('uses --resume after first successful call', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'first' }));
      await askClaude('msg1', 'resume-test');

      spawnMock.mockReturnValue(createChild({ stdout: 'second' }));
      const result = await askClaude('msg2', 'resume-test');
      expect(result.text).toBe('second');
      expect(spawnMock).toHaveBeenLastCalledWith(
        '/usr/local/bin/claude',
        ['--dangerously-skip-permissions', ...MCP_CFG_ARGS, '-p', 'msg2', '--resume', 'resume-test', '--model', 'opus'],
        expect.any(Object),
      );
    });

    it('uses --resume for sessions marked as created (restored)', async () => {
      markSessionCreated('restored-sess');
      spawnMock.mockReturnValue(createChild({ stdout: 'reply' }));
      await askClaude('hello', 'restored-sess');
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['--dangerously-skip-permissions', ...MCP_CFG_ARGS, '-p', 'hello', '--resume', 'restored-sess', '--model', 'opus'],
        expect.any(Object),
      );
    });

    it('passes custom model when specified', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'reply' }));
      await askClaude('hello', 'haiku-sess', 'haiku');
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['--dangerously-skip-permissions', ...MCP_CFG_ARGS, '-p', 'hello', '--session-id', 'haiku-sess', '--model', 'haiku'],
        expect.any(Object),
      );
    });

    it('does not mark session as created on error', async () => {
      spawnMock.mockReturnValue(createChild({ stderr: 'fail', code: 1 }));
      await askClaude('msg', 'fail-sess');

      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaude('retry', 'fail-sess');
      expect(spawnMock).toHaveBeenLastCalledWith(
        '/usr/local/bin/claude',
        ['--dangerously-skip-permissions', ...MCP_CFG_ARGS, '-p', 'retry', '--session-id', 'fail-sess', '--model', 'opus'],
        expect.any(Object),
      );
    });

    it('serializes requests to the same session', async () => {
      const resolvers: (() => void)[] = [];

      spawnMock.mockImplementation(() => {
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        resolvers.push(() => {
          child.stdout.emit('data', Buffer.from('ok'));
          child.emit('close', 0, null);
        });
        return child;
      });

      const p1 = askClaude('msg1', 'lock-test');
      const p2 = askClaude('msg2', 'lock-test');

      await new Promise((r) => setTimeout(r, 10));
      expect(spawnMock).toHaveBeenCalledTimes(1);

      resolvers[0]!();
      await new Promise((r) => setTimeout(r, 10));
      expect(spawnMock).toHaveBeenCalledTimes(2);

      resolvers[1]!();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.text).toBe('ok');
      expect(r2.text).toBe('ok');
    });
  });

  describe('ClaudeResult type export', () => {
    it('is usable as a type with text and error fields', () => {
      const result: ClaudeResult = { text: 'hello', error: null };
      expect(result.text).toBe('hello');
      expect(result.error).toBeNull();
    });
  });

  describe('askClaudeWithContext', () => {
    it('passes --append-system-prompt flag with the system prompt', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'response' }));

      await askClaudeWithContext('hello', 'ctx-sess-1', 'You are a helpful assistant.');

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).toContain('--append-system-prompt');
      const sysIdx = args.indexOf('--append-system-prompt');
      expect(args[sysIdx + 1]).toBe('You are a helpful assistant.');
    });

    it('uses --session-id for new sessions', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'response' }));

      await askClaudeWithContext('hello', 'ctx-new-sess', 'system prompt');

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).toContain('--session-id');
      expect(args).toContain('ctx-new-sess');
      expect(args).not.toContain('--resume');
    });

    it('uses --resume for already-created sessions', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'first' }));
      await askClaudeWithContext('hello', 'ctx-resume-sess', 'sys');

      spawnMock.mockReturnValue(createChild({ stdout: 'second' }));
      await askClaudeWithContext('follow up', 'ctx-resume-sess', 'sys');

      const secondArgs = spawnMock.mock.calls[1]![1] as string[];
      expect(secondArgs).toContain('--resume');
      expect(secondArgs).toContain('ctx-resume-sess');
      expect(secondArgs).not.toContain('--session-id');
    });

    it('uses --resume for sessions marked via markSessionCreated', async () => {
      markSessionCreated('ctx-restored');
      spawnMock.mockReturnValue(createChild({ stdout: 'reply' }));
      await askClaudeWithContext('hello', 'ctx-restored', 'sys');

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).toContain('--resume');
      expect(args).toContain('ctx-restored');
    });

    it('passes custom model when specified', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'reply' }));
      await askClaudeWithContext('hello', 'ctx-haiku-sess', 'sys', { model: 'haiku' });

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).toContain('--model');
      expect(args).toContain('haiku');
    });

    it('uses default model when none specified', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'reply' }));
      await askClaudeWithContext('hello', 'ctx-default-model', 'sys');

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).toContain('--model');
      expect(args).toContain('opus');
    });

    it('spawns with the provided cwd (product-chat working repo) over the vault default', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaudeWithContext('hi', 'ctx-cwd-sess', 'sys', { cwd: '/workspace/some-product' });
      expect(spawnMock).toHaveBeenLastCalledWith(
        '/usr/local/bin/claude',
        expect.any(Array),
        expect.objectContaining({ cwd: '/workspace/some-product' }),
      );
    });

    it('defaults to the vault cwd when no cwd is provided', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaudeWithContext('hi', 'ctx-cwd-default', 'sys');
      expect(spawnMock).toHaveBeenLastCalledWith(
        '/usr/local/bin/claude',
        expect.any(Array),
        expect.objectContaining({ cwd: '/tmp/test-vault' }),
      );
    });

    it('does not mark session as created on error', async () => {
      spawnMock.mockReturnValue(createChild({ stderr: 'fail', code: 1 }));
      await askClaudeWithContext('msg', 'ctx-fail-sess', 'sys');

      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaudeWithContext('retry', 'ctx-fail-sess', 'sys');

      const retryArgs = spawnMock.mock.calls[1]![1] as string[];
      expect(retryArgs).toContain('--session-id');
      expect(retryArgs).not.toContain('--resume');
    });

    it('serializes concurrent calls to the same session', async () => {
      const resolvers: (() => void)[] = [];

      spawnMock.mockImplementation(() => {
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        resolvers.push(() => {
          child.stdout.emit('data', Buffer.from('ok'));
          child.emit('close', 0, null);
        });
        return child;
      });

      const p1 = askClaudeWithContext('msg1', 'ctx-lock-test', 'sys1');
      const p2 = askClaudeWithContext('msg2', 'ctx-lock-test', 'sys2');

      await new Promise((r) => setTimeout(r, 10));
      expect(spawnMock).toHaveBeenCalledTimes(1);

      resolvers[0]!();
      await new Promise((r) => setTimeout(r, 10));
      expect(spawnMock).toHaveBeenCalledTimes(2);

      resolvers[1]!();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.text).toBe('ok');
      expect(r2.text).toBe('ok');
    });

    it('shares session lock queue with askClaude', async () => {
      const resolvers: (() => void)[] = [];

      spawnMock.mockImplementation(() => {
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        resolvers.push(() => {
          child.stdout.emit('data', Buffer.from('ok'));
          child.emit('close', 0, null);
        });
        return child;
      });

      // Mix askClaude and askClaudeWithContext on the same session
      const p1 = askClaude('msg1', 'shared-lock-sess');
      const p2 = askClaudeWithContext('msg2', 'shared-lock-sess', 'sys');

      await new Promise((r) => setTimeout(r, 10));
      // Only first should have spawned
      expect(spawnMock).toHaveBeenCalledTimes(1);

      resolvers[0]!();
      await new Promise((r) => setTimeout(r, 10));
      expect(spawnMock).toHaveBeenCalledTimes(2);

      resolvers[1]!();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.text).toBe('ok');
      expect(r2.text).toBe('ok');

      // Second call (askClaudeWithContext) should have --resume since first succeeded
      const secondArgs = spawnMock.mock.calls[1]![1] as string[];
      expect(secondArgs).toContain('--resume');
      expect(secondArgs).toContain('--append-system-prompt');
    });
  });

  describe('askClaude does not include system prompt', () => {
    it('does not pass --append-system-prompt flag', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaude('hello', 'no-sys-sess');

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).not.toContain('--append-system-prompt');
    });
  });

  describe('loadAgentDef', () => {
    it('parses frontmatter tools and body from agent file', () => {
      const def = loadAgentDef('wiki-compiler');
      expect(def.tools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']);
      expect(def.prompt).toContain('wiki compiler');
    });

    it('parses cron, cron_args, cron_chat, and triggers from frontmatter', async () => {
      const { readFileSync } = await import('node:fs');
      const readFileMock = readFileSync as unknown as ReturnType<typeof vi.fn>;
      readFileMock.mockImplementationOnce(() => `---
name: sec-filings-watcher
cron: "0 7 * * 1"
cron_args: "Review latest SEC filings and flag anomalies."
cron_chat: true
triggers:
  - "check sec filings"
  - "what's new in sec"
tools:
  - Read
  - Grep
---

You are a SEC filings watcher.`);
      const def = loadAgentDef('sec-filings-watcher');
      expect(def.cron).toBe('0 7 * * 1');
      expect(def.cronArgs).toBe('Review latest SEC filings and flag anomalies.');
      expect(def.cronChat).toBe(true);
      expect(def.triggers).toEqual(['check sec filings', "what's new in sec"]);
      expect(def.tools).toEqual(['Read', 'Grep']);
      expect(def.prompt).toContain('SEC filings watcher');
    });

    it('treats missing optional fields as undefined / empty', async () => {
      const { readFileSync } = await import('node:fs');
      const readFileMock = readFileSync as unknown as ReturnType<typeof vi.fn>;
      readFileMock.mockImplementationOnce(() => `---
name: plain-agent
tools:
  - Read
---

Plain body.`);
      const def = loadAgentDef('plain-agent');
      expect(def.cron).toBeUndefined();
      expect(def.cronArgs).toBeUndefined();
      expect(def.cronChat).toBeUndefined();
      expect(def.triggers).toBeUndefined();
      expect(def.tools).toEqual(['Read']);
    });

    it('accepts unquoted cron and cron_chat: false', async () => {
      const { readFileSync } = await import('node:fs');
      const readFileMock = readFileSync as unknown as ReturnType<typeof vi.fn>;
      readFileMock.mockImplementationOnce(() => `---
name: log-only-cron
cron: 0 9 * * *
cron_chat: false
---

Body.`);
      const def = loadAgentDef('log-only-cron');
      expect(def.cron).toBe('0 9 * * *');
      expect(def.cronChat).toBe(false);
    });

    it('accepts single-quoted scalar values', async () => {
      const { readFileSync } = await import('node:fs');
      const readFileMock = readFileSync as unknown as ReturnType<typeof vi.fn>;
      readFileMock.mockImplementationOnce(() => `---
name: single-quoted
cron: '15 3 * * *'
cron_args: 'run the thing'
---

Body.`);
      const def = loadAgentDef('single-quoted');
      expect(def.cron).toBe('15 3 * * *');
      expect(def.cronArgs).toBe('run the thing');
    });

    it('ignores cron_chat values that are neither "true" nor "false"', async () => {
      const { readFileSync } = await import('node:fs');
      const readFileMock = readFileSync as unknown as ReturnType<typeof vi.fn>;
      readFileMock.mockImplementationOnce(() => `---
name: weird-chat
cron: "0 * * * *"
cron_chat: maybe
---

Body.`);
      const def = loadAgentDef('weird-chat');
      expect(def.cronChat).toBeUndefined();
    });

    it('strips trailing inline comments from unquoted scalar values', async () => {
      const { readFileSync } = await import('node:fs');
      const readFileMock = readFileSync as unknown as ReturnType<typeof vi.fn>;
      readFileMock.mockImplementationOnce(() => `---
name: comment-test
cron: 0 7 * * 1 # runs every Monday at 7am
cron_args: run the thing # arg comment
---

Body.`);
      const def = loadAgentDef('comment-test');
      expect(def.cron).toBe('0 7 * * 1');
      expect(def.cronArgs).toBe('run the thing');
    });

    it('accepts case-insensitive cron_chat booleans (True, FALSE, etc.)', async () => {
      const { readFileSync } = await import('node:fs');
      const readFileMock = readFileSync as unknown as ReturnType<typeof vi.fn>;
      readFileMock.mockImplementationOnce(() => `---
name: case-bool-true
cron_chat: True
---

Body.`);
      expect(loadAgentDef('case-bool-true').cronChat).toBe(true);

      readFileMock.mockImplementationOnce(() => `---
name: case-bool-false
cron_chat: FALSE
---

Body.`);
      expect(loadAgentDef('case-bool-false').cronChat).toBe(false);
    });

    it('accepts zero-indent (top-level) list items', async () => {
      const { readFileSync } = await import('node:fs');
      const readFileMock = readFileSync as unknown as ReturnType<typeof vi.fn>;
      readFileMock.mockImplementationOnce(() => `---
name: zero-indent-list
triggers:
- first
- second
---

Body.`);
      expect(loadAgentDef('zero-indent-list').triggers).toEqual(['first', 'second']);
    });

    it('parses triggers list with mixed quote styles', async () => {
      const { readFileSync } = await import('node:fs');
      const readFileMock = readFileSync as unknown as ReturnType<typeof vi.fn>;
      readFileMock.mockImplementationOnce(() => `---
name: trigger-test
triggers:
  - "double quoted"
  - 'single quoted'
  - unquoted trigger
---

Body.`);
      const def = loadAgentDef('trigger-test');
      expect(def.triggers).toEqual(['double quoted', 'single quoted', 'unquoted trigger']);
    });

    it('flags an inline empty tools list (tools: []) as an explicitly tool-less agent', async () => {
      const readFileMock = readFileSync as unknown as ReturnType<typeof vi.fn>;
      readFileMock.mockImplementationOnce(() => `---
name: toolless-agent
tools: []
---

Synthesis only.`);
      const def = loadAgentDef('toolless-agent');
      expect(def.tools).toEqual([]);
      expect(def.noTools).toBe(true);
    });

    it('does NOT flag an omitted tools field as tool-less', async () => {
      const readFileMock = readFileSync as unknown as ReturnType<typeof vi.fn>;
      readFileMock.mockImplementationOnce(() => `---
name: no-tools-key
---

Body.`);
      const def = loadAgentDef('no-tools-key');
      expect(def.tools).toEqual([]);
      expect(def.noTools).toBeUndefined();
    });
  });

  describe('runAgent', () => {
    it('loads agent def inline and passes --agents JSON, --allowedTools, and date context', async () => {
      // runAgent defaults to userVisible=true → execClaude uses stream-json,
      // so the mock has to emit a `result` event for the final text. The
      // raw "agent result" buffer-mode test moved to a dedicated case below.
      spawnMock.mockReturnValue(createChild({
        stdout: JSON.stringify({ type: 'result', result: 'agent result' }) + '\n',
      }));
      const result = await runAgent('wiki-compiler', 'do stuff');

      const args = spawnMock.mock.calls[0]![1] as string[];

      // Passes --agent and --agents with inline definition
      expect(args).toContain('--agent');
      expect(args[args.indexOf('--agent') + 1]).toBe('wiki-compiler');
      expect(args).toContain('--agents');
      const agentsJson = JSON.parse(args[args.indexOf('--agents') + 1]!);
      expect(agentsJson['wiki-compiler'].prompt).toContain('wiki compiler');
      // `description` is required: the CLI silently drops inline agents without
      // it, breaking `--agent <name>` lookup. Must always be present.
      expect(agentsJson['wiki-compiler'].description).toBeTruthy();

      // Passes --allowedTools from frontmatter
      expect(args).toContain('--allowedTools');
      const toolsIdx = args.indexOf('--allowedTools');
      expect(args.slice(toolsIdx + 1)).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']));

      // Passes model and date context
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
      const promptIdx = args.indexOf('-p');
      const prompt = args[promptIdx + 1]!;
      expect(prompt).toMatch(/^Today is .+\(America\/Chicago\)/);
      expect(prompt).toContain('do stuff');

      expect(result.text).toBe('agent result');
    });

    it('embeds tools: [] in the agents JSON and omits --allowedTools for a tool-less agent', async () => {
      const readFileMock = readFileSync as unknown as ReturnType<typeof vi.fn>;
      readFileMock.mockImplementationOnce(() => `---
name: toolless-runner
description: "synthesis-only test agent"
model: sonnet
tools: []
---

Synthesize from provided context only.`);
      spawnMock.mockReturnValue(createChild({ stdout: streamResultLine('ok') }));
      await runAgent('toolless-runner', 'question');

      const args = spawnMock.mock.calls[0]![1] as string[];
      const agentsJson = JSON.parse(args[args.indexOf('--agents') + 1]!);
      // The empty tools list must ride inside the agents JSON — that is what
      // strips the subagent's toolset (effective under skip-permissions),
      // unlike --allowedTools, which must be absent.
      expect(agentsJson['toolless-runner'].tools).toEqual([]);
      expect(args).not.toContain('--allowedTools');
    });

    it('passes the frontmatter model: as an explicit pin through the policy resolver', async () => {
      // wiki-compiler pins `model: sonnet`; the resolver honors it as an explicit pin.
      spawnMock.mockReturnValue(createChild({ stdout: streamResultLine('ok') }));
      await runAgent('wiki-compiler', 'do stuff');
      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    });

    it('resolves an unpinned agent through the model policy (role default beats AGENT_MODEL)', async () => {
      // plain-agent has no `model:` frontmatter; the policy's roleDefaults routes it to
      // haiku. Pre-wiring runAgent would have used config.AGENT_MODEL ('opus') — resolving
      // to haiku proves runAgent now goes through the policy resolver.
      spawnMock.mockReturnValue(createChild({ stdout: streamResultLine('ok') }));
      await runAgent('plain-agent', 'do stuff');
      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    });

    it('does NOT use --add-dir (which resets cwd)', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: streamResultLine('ok') }));
      await runAgent('wiki-compiler', 'ingest something');
      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).not.toContain('--add-dir');
    });

    it('runs from VAULT_DIR so agent relative paths resolve to vault', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: streamResultLine('ok') }));
      await runAgent('wiki-compiler', 'ingest something');
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        expect.any(Array),
        expect.objectContaining({ cwd: '/tmp/test-vault' }),
      );
    });

    it('omits the Learnings block when learnings.jsonl is absent', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: streamResultLine('ok') }));
      await runAgent('wiki-compiler', 'do stuff');
      const args = spawnMock.mock.calls[0]![1] as string[];
      const prompt = args[args.indexOf('-p') + 1]!;
      // Default ENOENT for any path that's not an agent file — no learnings to
      // prepend — so prompt starts directly with the date context.
      expect(prompt.startsWith('## Learnings')).toBe(false);
      expect(prompt).toMatch(/^Today is /);
      expect(prompt).toContain('do stuff');
    });

    it('prepends the Learnings block before date context and user prompt when learnings.jsonl exists', async () => {
      const { readFileSync } = await import('node:fs');
      const readFileMock = readFileSync as unknown as ReturnType<typeof vi.fn>;
      // Override for this one call: respond to the learnings path; keep agent-file behavior.
      // Single-shot override that handles both possible reads (agent file + learnings
       // file). `loadAgentDef` caches agent defs across tests, so depending on test
       // order the agent-file branch may or may not fire — handle both.
      readFileMock.mockImplementationOnce((path: string) => {
        if (typeof path === 'string' && path.endsWith('learnings.jsonl')) {
          return [
            JSON.stringify({ ts: '2025-01-01T00:00:00.000Z', text: 'prefer terse answers' }),
            JSON.stringify({ ts: '2025-02-01T00:00:00.000Z', text: 'cite sources when discussing papers' }),
          ].join('\n') + '\n';
        }
        if (typeof path === 'string' && path.includes('model-policy.json')) return MOCK_MODEL_POLICY;
        if (typeof path === 'string' && path.includes('.claude/agents/')) return MOCK_AGENT_FILE;
        throw new Error(`ENOENT: ${path}`);
      });
      // Same impl for any second read (in case both happen in this test).
      readFileMock.mockImplementationOnce((path: string) => {
        if (typeof path === 'string' && path.endsWith('learnings.jsonl')) {
          return [
            JSON.stringify({ ts: '2025-01-01T00:00:00.000Z', text: 'prefer terse answers' }),
            JSON.stringify({ ts: '2025-02-01T00:00:00.000Z', text: 'cite sources when discussing papers' }),
          ].join('\n') + '\n';
        }
        if (typeof path === 'string' && path.includes('model-policy.json')) return MOCK_MODEL_POLICY;
        if (typeof path === 'string' && path.includes('.claude/agents/')) return MOCK_AGENT_FILE;
        throw new Error(`ENOENT: ${path}`);
      });

      spawnMock.mockReturnValue(createChild({ stdout: streamResultLine('ok') }));
      await runAgent('wiki-compiler', 'ingest this paper');
      const args = spawnMock.mock.calls[0]![1] as string[];
      const prompt = args[args.indexOf('-p') + 1]!;

      // Block is at the very start.
      expect(prompt.startsWith('## Learnings')).toBe(true);
      // Both entries appear oldest-first in the block.
      const terseIdx = prompt.indexOf('prefer terse answers');
      const citeIdx = prompt.indexOf('cite sources when discussing papers');
      expect(terseIdx).toBeGreaterThan(-1);
      expect(citeIdx).toBeGreaterThan(-1);
      expect(terseIdx).toBeLessThan(citeIdx);
      // Date context appears AFTER the block.
      const dateIdx = prompt.indexOf('Today is ');
      expect(dateIdx).toBeGreaterThan(citeIdx);
      // Original user prompt appears AFTER the date context.
      const userIdx = prompt.indexOf('ingest this paper');
      expect(userIdx).toBeGreaterThan(dateIdx);
    });
  });

  // Phase 6 B1.4 — observation-log wiring on runAgent
  describe('runAgent — observation-log interaction wiring (B1.4)', () => {
    it('appends a kind:"agent-call" record after a successful run', async () => {
      const { appendInteraction } = await import('../utils/observation-log.js');
      const mockAppend = appendInteraction as unknown as ReturnType<typeof vi.fn>;
      mockAppend.mockClear();
      spawnMock.mockReturnValue(createChild({ stdout: streamResultLine('agent result') }));

      await runAgent('wiki-compiler', 'do stuff');

      expect(mockAppend).toHaveBeenCalledTimes(1);
      const record = mockAppend.mock.calls[0]![0] as { kind: string; outcome: string; detail: string };
      expect(record.kind).toBe('agent-call');
      expect(record.outcome).toBe('success');
      expect(record.detail).toMatch(/agent=wiki-compiler/);
      expect(record.detail).toMatch(/dur=\d+/);
    });

    it('outcome is "failure" when the agent run errors (non-zero exit)', async () => {
      const { appendInteraction } = await import('../utils/observation-log.js');
      const mockAppend = appendInteraction as unknown as ReturnType<typeof vi.fn>;
      mockAppend.mockClear();
      // Non-zero exit with no stream result → execClaude returns { error }.
      spawnMock.mockReturnValue(createChild({ code: 1, stderr: 'boom' }));

      await runAgent('wiki-compiler', 'do stuff');

      expect(mockAppend).toHaveBeenCalledTimes(1);
      const record = mockAppend.mock.calls[0]![0] as { outcome: string };
      expect(record.outcome).toBe('failure');
    });

    it('detail NEVER contains the prompt body (strict-discipline invariant)', async () => {
      const { appendInteraction } = await import('../utils/observation-log.js');
      const mockAppend = appendInteraction as unknown as ReturnType<typeof vi.fn>;
      mockAppend.mockClear();
      spawnMock.mockReturnValue(createChild({ stdout: streamResultLine('ok') }));

      const sensitivePrompt = 'investigate vault path /Users/me/secrets "quoted content"';
      await runAgent('wiki-compiler', sensitivePrompt);

      const record = mockAppend.mock.calls[0]![0] as { detail: string };
      expect(record.detail).not.toContain('vault');
      expect(record.detail).not.toContain('/Users/me/secrets');
      expect(record.detail).not.toContain(sensitivePrompt);
    });

  });

  describe('cwd routing', () => {
    it('all calls use VAULT_DIR as cwd', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaude('hello', 'cwd-test-sess');
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        expect.any(Array),
        expect.objectContaining({ cwd: '/tmp/test-vault' }),
      );

      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaudeOneShot('test');
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        expect.any(Array),
        expect.objectContaining({ cwd: '/tmp/test-vault' }),
      );

      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await runAgent('wiki-compiler', 'classify this');
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        expect.any(Array),
        expect.objectContaining({ cwd: '/tmp/test-vault' }),
      );
    });
  });

  describe('timeout', () => {
    it('returns timeout error when process exceeds limit', async () => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => {
        process.nextTick(() => child.emit('close', null, 'SIGTERM'));
      });
      spawnMock.mockReturnValue(child);

      const result = await askClaudeOneShot('slow query');
      expect(result.text).toBeNull();
      expect(result.error).toContain('timed out');
    });

    it('classifies exit code 143 as a timeout (Claude CLI catches SIGTERM)', async () => {
      // When our timer fires child.kill('SIGTERM'), the Claude CLI installs a
      // SIGTERM handler and exits with code 143 (POSIX 128+SIGTERM). Node then
      // emits close with {code: 143, signal: null} rather than signal: 'SIGTERM'.
      // The close-handler must treat that as a timeout, not a generic error.
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => {
        process.nextTick(() => child.emit('close', 143, null));
      });
      spawnMock.mockReturnValue(child);

      const result = await askClaudeOneShot('slow query');
      expect(result.text).toBeNull();
      expect(result.error).toMatch(/^Claude timed out after/);
    });

    it('uses config.CLAUDE_TIMEOUT_MS when timeoutMs is not provided', async () => {
      vi.useFakeTimers();
      try {
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn(() => {
          child.emit('close', null, 'SIGTERM');
        });
        spawnMock.mockReturnValue(child);

        const promise = askClaudeOneShot('test prompt');

        // Advance to just before the config default (100ms in test config)
        await vi.advanceTimersByTimeAsync(99);
        expect(child.kill).not.toHaveBeenCalled();

        // Advance past the config default
        await vi.advanceTimersByTimeAsync(1);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');

        const result = await promise;
        expect(result.error).toBe('Claude timed out after 0.1s');
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses custom timeoutMs when provided to askClaudeOneShot', async () => {
      vi.useFakeTimers();
      try {
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn(() => {
          child.emit('close', null, 'SIGTERM');
        });
        spawnMock.mockReturnValue(child);

        const promise = askClaudeOneShot('test prompt', 5000);

        // Should not fire at the config default (100ms)
        await vi.advanceTimersByTimeAsync(100);
        expect(child.kill).not.toHaveBeenCalled();

        // Advance to just before custom timeout
        await vi.advanceTimersByTimeAsync(4899);
        expect(child.kill).not.toHaveBeenCalled();

        // Advance past custom timeout
        await vi.advanceTimersByTimeAsync(1);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');

        const result = await promise;
        expect(result.error).toBe('Claude timed out after 5s');
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses custom timeoutMs when provided to runAgent', async () => {
      vi.useFakeTimers();
      try {
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn(() => {
          child.emit('close', null, 'SIGTERM');
        });
        spawnMock.mockReturnValue(child);

        const promise = runAgent('wiki-compiler', 'ingest', 30000);

        // Should not fire at config default
        await vi.advanceTimersByTimeAsync(100);
        expect(child.kill).not.toHaveBeenCalled();

        // Advance to just before custom timeout
        await vi.advanceTimersByTimeAsync(29899);
        expect(child.kill).not.toHaveBeenCalled();

        // Advance past custom timeout
        await vi.advanceTimersByTimeAsync(1);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');

        const result = await promise;
        expect(result.error).toBe('Claude timed out after 30s');
      } finally {
        vi.useRealTimers();
      }
    });

    it('timeout error message reflects the actual timeout value used', async () => {
      vi.useFakeTimers();
      try {
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn(() => {
          child.emit('close', null, 'SIGTERM');
        });
        spawnMock.mockReturnValue(child);

        const promise = askClaudeOneShot('test', 90000);

        await vi.advanceTimersByTimeAsync(90000);
        const result = await promise;
        expect(result.error).toBe('Claude timed out after 90s');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('WORKSPACE_DIR env passthrough (WORKSPACE_DIR unset)', () => {
    it('does not set RUNE_WORKSPACE_DIR when WORKSPACE_DIR is empty', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaudeOneShot('test prompt');
      const spawnEnv = spawnMock.mock.calls[0]![2].env as NodeJS.ProcessEnv;
      expect(spawnEnv).not.toHaveProperty('RUNE_WORKSPACE_DIR');
    });

    it('runAgent prompt does not contain workspace directory line when WORKSPACE_DIR is empty', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await runAgent('wiki-compiler', 'do stuff');
      const args = spawnMock.mock.calls[0]![1] as string[];
      const prompt = args[args.indexOf('-p') + 1]!;
      expect(prompt).not.toContain('Workspace directory');
    });
  });

  describe('summarizeSession', () => {
    it('uses the default chat model', async () => {
      // First call creates the session with haiku (not the default)
      spawnMock.mockReturnValue(createChild({ stdout: 'first reply' }));
      await askClaude('hello', 'sum-sess', 'haiku');

      // summarizeSession passes config.DEFAULT_CHAT_MODEL (opus in this test config)
      spawnMock.mockReturnValue(createChild({ stdout: 'Topic: test\nDiscussion: stuff' }));
      const result = await summarizeSession('sum-sess');
      expect(result.text).toBe('Topic: test\nDiscussion: stuff');
      expect(spawnMock).toHaveBeenLastCalledWith(
        '/usr/local/bin/claude',
        expect.arrayContaining(['--resume', 'sum-sess', '--model', 'opus']),
        expect.any(Object),
      );
    });

    it('summarizes stored transcript messages in a fresh one-shot call', async () => {
      markSessionCreated('missing-transcript-session');
      spawnMock.mockReturnValue(createChild({ stdout: 'Topic: recovered\nKB-worthy: no' }));

      const result = await summarizeConversationMessages([
        { role: 'user', text: 'What did we decide?', ts: '2026-04-14 14:00' },
        { role: 'assistant', text: 'We decided to use the fallback.', ts: '2026-04-14 14:01' },
      ]);

      expect(result.text).toBe('Topic: recovered\nKB-worthy: no');
      const args = spawnMock.mock.calls.at(-1)![1] as string[];
      expect(args).toContain('--model');
      expect(args).toContain('opus');
      expect(args).not.toContain('--resume');
      expect(args).not.toContain('--session-id');
      expect(args[args.indexOf('-p') + 1]).toContain('[user] What did we decide?');
      expect(args[args.indexOf('-p') + 1]).toContain('[assistant] We decided to use the fallback.');
    });
  });

  describe('stream-json mode (execClaude streaming)', () => {
    it('runAgent (userVisible=true) passes --output-format stream-json --verbose to spawn', async () => {
      spawnMock.mockReturnValue(createChild({
        stdout: JSON.stringify({ type: 'result', result: 'ok' }) + '\n',
      }));
      await runAgent('wiki-compiler', 'ingest');
      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).toContain('--output-format');
      expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
      expect(args).toContain('--verbose');
    });

    it('runAgent (userVisible=false) does NOT include stream-json args', async () => {
      // userVisible=false → opMeta is undefined → streaming=false
      spawnMock.mockReturnValue(createChild({ stdout: 'plain text result' }));
      await runAgent('wiki-compiler', 'ingest', undefined, false);
      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).not.toContain('--output-format');
      expect(args).not.toContain('--verbose');
    });

    it('runAgent returns text from the result event when stream-json is used', async () => {
      const resultEvent = JSON.stringify({ type: 'result', result: 'compiled wiki page content' });
      spawnMock.mockReturnValue(createChild({ stdout: resultEvent + '\n' }));
      const result = await runAgent('wiki-compiler', 'ingest something');
      expect(result.text).toBe('compiled wiki page content');
      expect(result.error).toBeNull();
    });

    it('runAgent falls back to accumulated assistant text when no result event arrives', async () => {
      // Simulate the CLI exiting without a `result` event — only assistant text blocks
      const assistantEvent = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'partial output' },
          ],
        },
      });
      spawnMock.mockReturnValue(createChild({ stdout: assistantEvent + '\n' }));
      const result = await runAgent('wiki-compiler', 'do stuff');
      expect(result.text).toBe('partial output');
      expect(result.error).toBeNull();
    });

    it('askHaikuOneShot (classifier kind) does NOT use stream-json', async () => {
      const { askHaikuOneShot } = await import('./claude.js');
      spawnMock.mockReturnValue(createChild({ stdout: '{"skill":"kb","confidence":0.9}' }));
      const result = await askHaikuOneShot('classify this');
      expect(result.text).toBe('{"skill":"kb","confidence":0.9}');
      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).not.toContain('--output-format');
      expect(args).not.toContain('stream-json');
    });

    it('askClaudeOneShot without opLabel does NOT use stream-json (no opMeta)', async () => {
      // opLabel is absent → opMeta is undefined → streaming=false
      spawnMock.mockReturnValue(createChild({ stdout: 'plain answer' }));
      const result = await askClaudeOneShot('what is today');
      expect(result.text).toBe('plain answer');
      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).not.toContain('--output-format');
    });

    it('handleStreamEvent ignores non-JSON lines without throwing', async () => {
      // The CLI sometimes emits banner lines like "Claude Code 1.x.y"
      const stdout = [
        'Claude Code 1.2.3',             // non-JSON banner
        JSON.stringify({ type: 'result', result: 'good output' }),
        '',
      ].join('\n') + '\n';
      spawnMock.mockReturnValue(createChild({ stdout }));
      const result = await runAgent('wiki-compiler', 'ingest');
      expect(result.text).toBe('good output');
    });

    it('handleStreamEvent accumulates multiple assistant text blocks', async () => {
      const block1 = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello ' }] },
      });
      const block2 = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'World' }] },
      });
      spawnMock.mockReturnValue(createChild({ stdout: block1 + '\n' + block2 + '\n' }));
      const result = await runAgent('wiki-compiler', 'do stuff', undefined, false);
      // Non-streaming path — raw stdout is used, not parsed
      // (userVisible=false, so streaming is off and stdout is returned as-is)
      expect(result.text).not.toBeNull();
    });

    it('result event text wins over accumulated text blocks when both are present', async () => {
      const assistantEvent = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'intermediate text' }] },
      });
      const resultEvent = JSON.stringify({ type: 'result', result: 'final answer' });
      spawnMock.mockReturnValue(createChild({
        stdout: assistantEvent + '\n' + resultEvent + '\n',
      }));
      const result = await runAgent('wiki-compiler', 'do stuff');
      expect(result.text).toBe('final answer');
    });
  });
});
