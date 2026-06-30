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

    it('replaces the WORKSPACE_DIR add-dir with exactly the writableRoots (confines a product chat to its repo)', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaudeWithContext('hi', 'wr-confined-sess', 'sys', {
        cwd: '/home/user/workspace/aura',
        writableRoots: ['/home/user/workspace/aura'],
      });
      const args = spawnMock.mock.calls[0]![1] as string[];
      const dirs = addDirsOf(args);
      expect(dirs).toEqual(['/home/user/workspace/aura']);
      // The vault lives under WORKSPACE_DIR; dropping that blanket keeps it off
      // the writable surface (reached read-only via the rune-kb MCP instead).
      expect(dirs).not.toContain('/home/user/workspace');
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
