/**
 * Tests for WORKSPACE_DIR passthrough behavior in src/ai/claude.ts.
 * Kept separate from claude.test.ts because the config mock needs WORKSPACE_DIR set.
 */
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
    WORKSPACE_DIR: '/home/user/workspace',
    CLAUDE_STREAM_LOG: '/tmp/test-logs/claude-stream.jsonl',
    // Points to a nonexistent path so loadModelPolicy returns null → pre-policy fallback.
    MODEL_POLICY_FILE: '/tmp/rune-nonexistent-model-policy.json',
  },
  PROJECT_ROOT: '/tmp/test-project',
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(() => '/usr/local/bin/claude\n'),
}));

const MOCK_AGENT_FILE = `---
name: wiki-compiler
model: sonnet
tools:
  - Read
  - Write
---

You are the wiki compiler for a personal knowledge base.`;

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn((path: string) => {
      if (typeof path === 'string' && path.includes('.claude/agents/')) return MOCK_AGENT_FILE;
      // Throw a proper ENOENT so loadModelPolicy sees code==='ENOENT' and returns null.
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }),
  };
});

const { spawn } = await import('node:child_process');
const { askClaudeOneShot, runAgent, askClaudeWithContext } = await import('./claude.js');

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

function createChild(opts: { stdout?: string; stderr?: string; code?: number } = {}) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  const { stdout, stderr, code = 0 } = opts;
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code, null);
  });
  return child;
}

describe('ai/claude WORKSPACE_DIR set', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  describe('execClaude env passthrough', () => {
    it('sets RUNE_WORKSPACE_DIR in child process env when WORKSPACE_DIR is configured', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaudeOneShot('test prompt');
      const spawnEnv = spawnMock.mock.calls[0]![2].env as NodeJS.ProcessEnv;
      expect(spawnEnv['RUNE_WORKSPACE_DIR']).toBe('/home/user/workspace');
    });

    it('always sets RUNE_PROJECT_ROOT regardless of WORKSPACE_DIR', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaudeOneShot('test prompt');
      const spawnEnv = spawnMock.mock.calls[0]![2].env as NodeJS.ProcessEnv;
      expect(spawnEnv['RUNE_PROJECT_ROOT']).toBe('/tmp/test-project');
    });
  });

  describe('askClaudeWithContext writable-roots confinement', () => {
    function addDirsOf(args: string[]): string[] {
      const dirs: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--add-dir') dirs.push(args[i + 1]!);
      }
      return dirs;
    }

    it('defaults to the blanket WORKSPACE_DIR add-dir when no writableRoots given', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaudeWithContext('hi', 'wr-default-sess', 'sys');
      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(addDirsOf(args)).toContain('/home/user/workspace');
    });

    it('narrows the --add-dir hint to writableRoots (replacing the blanket WORKSPACE_DIR)', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaudeWithContext('hi', 'wr-confined-sess', 'sys', {
        cwd: '/home/user/workspace/aura',
        writableRoots: ['/home/user/workspace/aura'],
      });
      const args = spawnMock.mock.calls[0]![1] as string[];
      const dirs = addDirsOf(args);
      expect(dirs).toEqual(['/home/user/workspace/aura']);
      // NOTE: this only narrows the declared --add-dir set. Under
      // --dangerously-skip-permissions it does NOT enforce write boundaries
      // (cwd is writable, Bash is unbounded) — it's a defense-in-depth hint.
      // We still assert the blanket WORKSPACE_DIR (which contains the vault) is
      // not in the declared set.
      expect(dirs).not.toContain('/home/user/workspace');
    });

    it('scrubs Rune secrets + personal identifiers from product-chat env, keeps paths + shell essentials', async () => {
      const oldEnv = { ...process.env };
      process.env['TELEGRAM_BOT_TOKEN'] = 'bot-secret';
      process.env['RUNE_HTTP_SECRET'] = 'web-secret';
      process.env['RUNE_MCP_SECRET'] = 'mcp-secret';
      process.env['READWISE_TOKEN'] = 'readwise-secret';
      process.env['WHOOP_CLIENT_SECRET'] = 'whoop-secret';
      process.env['SOME_API_KEY'] = 'api-secret';
      process.env['STRIPE_SECRET_KEY'] = 'stripe-secret'; // _KEY$ pattern
      process.env['FAMILY_NAMES'] = 'alice,bob';          // personal identifier
      process.env['IMPLICIT_CRM_NAMES'] = 'carol';        // personal identifier
      process.env['OBSIDIAN_VAULT_NAME'] = 'michael';     // personal identifier
      process.env['GIT_ASKPASS'] = '/usr/bin/askpass';    // credential helper
      process.env['VAULT_DIR'] = '/home/user/pkms';       // non-secret path — KEPT
      process.env['SAFE_VALUE'] = 'keep-me';
      try {
        spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
        await askClaudeWithContext('hi', 'wr-product-env-sess', 'sys', {
          cwd: '/home/user/workspace/aura',
          writableRoots: ['/home/user/workspace/aura'],
          envMode: 'product-chat',
        });
        const spawnEnv = spawnMock.mock.calls[0]![2].env as NodeJS.ProcessEnv;
        // Secrets + personal identifiers scrubbed.
        expect(spawnEnv['TELEGRAM_BOT_TOKEN']).toBeUndefined();
        expect(spawnEnv['RUNE_HTTP_SECRET']).toBeUndefined();
        expect(spawnEnv['RUNE_MCP_SECRET']).toBeUndefined();
        expect(spawnEnv['READWISE_TOKEN']).toBeUndefined();
        expect(spawnEnv['WHOOP_CLIENT_SECRET']).toBeUndefined();
        expect(spawnEnv['SOME_API_KEY']).toBeUndefined();
        expect(spawnEnv['STRIPE_SECRET_KEY']).toBeUndefined();
        expect(spawnEnv['FAMILY_NAMES']).toBeUndefined();
        expect(spawnEnv['IMPLICIT_CRM_NAMES']).toBeUndefined();
        expect(spawnEnv['OBSIDIAN_VAULT_NAME']).toBeUndefined();
        expect(spawnEnv['GIT_ASKPASS']).toBeUndefined();
        // RUNE_PROJECT_ROOT is NOT handed to a product chat (no need; would point
        // a Bash shell at PROJECT_ROOT/.env.local).
        expect(spawnEnv['RUNE_PROJECT_ROOT']).toBeUndefined();
        // Non-secret paths are KEPT — the rune-kb MCP/KB read VAULT_DIR directly,
        // and RUNE_WORKSPACE_DIR is config-governed (not a secret).
        expect(spawnEnv['VAULT_DIR']).toBe('/home/user/pkms');
        expect(spawnEnv['RUNE_WORKSPACE_DIR']).toBe('/home/user/workspace');
        // Shell essentials survive (Bash/git/node need them).
        expect(spawnEnv['PATH']).toBeDefined();
        expect(spawnEnv['HOME']).toBeDefined();
        expect(spawnEnv['SAFE_VALUE']).toBe('keep-me');
      } finally {
        process.env = oldEnv;
      }
    });

    it('default (non-product) env mode keeps RUNE_PROJECT_ROOT and full env', async () => {
      const oldEnv = { ...process.env };
      process.env['TELEGRAM_BOT_TOKEN'] = 'bot-secret';
      try {
        spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
        await askClaudeWithContext('hi', 'wr-default-env-sess', 'sys');
        const spawnEnv = spawnMock.mock.calls[0]![2].env as NodeJS.ProcessEnv;
        // Default spawns (agents, global chat) get RUNE_PROJECT_ROOT and are NOT
        // scrubbed — agents legitimately need Rune's env (and the vault).
        expect(spawnEnv['RUNE_PROJECT_ROOT']).toBe('/tmp/test-project');
        expect(spawnEnv['TELEGRAM_BOT_TOKEN']).toBe('bot-secret');
      } finally {
        process.env = oldEnv;
      }
    });
  });

  describe('runAgent prompt with WORKSPACE_DIR', () => {
    it('appends workspace directory line to prompt when WORKSPACE_DIR is set', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'agent result' }));
      await runAgent('wiki-compiler', 'do stuff');
      const args = spawnMock.mock.calls[0]![1] as string[];
      const prompt = args[args.indexOf('-p') + 1]!;
      expect(prompt).toContain('Workspace directory (read-only): /home/user/workspace');
    });

    it('workspace directory line appears after date context and before user prompt', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await runAgent('wiki-compiler', 'my task');
      const args = spawnMock.mock.calls[0]![1] as string[];
      const prompt = args[args.indexOf('-p') + 1]!;
      const dateIdx = prompt.indexOf('Today is ');
      const wsIdx = prompt.indexOf('Workspace directory (read-only):');
      const taskIdx = prompt.indexOf('my task');
      expect(dateIdx).toBeGreaterThan(-1);
      expect(wsIdx).toBeGreaterThan(dateIdx);
      expect(taskIdx).toBeGreaterThan(wsIdx);
    });
  });
});
