import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: '/tmp/test-vault',
    CLAUDE_TIMEOUT_MS: 100,
    DEFAULT_CHAT_MODEL: 'haiku',
    ONESHOT_MODEL: 'sonnet',
    AGENT_MODEL: 'opus',
    TIMEZONE: 'America/Chicago',
  },
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(() => '/usr/local/bin/claude\n'),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn(() => false) };
});

const { spawn } = await import('node:child_process');
const { askClaude, askClaudeWithContext, askClaudeOneShot, runAgent, summarizeSession, markSessionCreated } =
  await import('./claude.js');
// Type import — verifies ClaudeResult is exported (TS compile error if not)
import type { ClaudeResult } from './claude.js';

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

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

    it('uses sonnet model and prepends date context', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaudeOneShot('test prompt');
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['-p', expect.stringContaining('test prompt'), '--no-session-persistence', '--model', 'sonnet'],
        expect.objectContaining({ cwd: '/tmp/test-vault' }),
      );
      const prompt = spawnMock.mock.calls[0]![1][1] as string;
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
    it('uses --session-id and haiku for new sessions', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'reply' }));
      await askClaude('hello', 'new-sess');
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['-p', 'hello', '--session-id', 'new-sess', '--model', 'haiku'],
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
        ['-p', 'msg2', '--resume', 'resume-test', '--model', 'haiku'],
        expect.any(Object),
      );
    });

    it('uses --resume for sessions marked as created (restored)', async () => {
      markSessionCreated('restored-sess');
      spawnMock.mockReturnValue(createChild({ stdout: 'reply' }));
      await askClaude('hello', 'restored-sess');
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['-p', 'hello', '--resume', 'restored-sess', '--model', 'haiku'],
        expect.any(Object),
      );
    });

    it('passes custom model when specified', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'reply' }));
      await askClaude('hello', 'opus-sess', 'opus');
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['-p', 'hello', '--session-id', 'opus-sess', '--model', 'opus'],
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
        ['-p', 'retry', '--session-id', 'fail-sess', '--model', 'haiku'],
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
      await askClaudeWithContext('hello', 'ctx-opus-sess', 'sys', 'opus');

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).toContain('--model');
      expect(args).toContain('opus');
    });

    it('uses default model when none specified', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'reply' }));
      await askClaudeWithContext('hello', 'ctx-default-model', 'sys');

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).toContain('--model');
      expect(args).toContain('haiku');
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

  describe('runAgent', () => {
    it('uses opus model and prepends date context', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'agent result' }));
      const result = await runAgent('wiki-compiler', 'do stuff');
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['--agent', 'wiki-compiler', '-p', expect.stringContaining('do stuff'), '--no-session-persistence', '--model', 'opus'],
        expect.any(Object),
      );
      const prompt = spawnMock.mock.calls[0]![1][3] as string;
      expect(prompt).toMatch(/^Today is .+\(America\/Chicago\)/);
      expect(prompt).toContain('do stuff');
      expect(result.text).toBe('agent result');
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

  describe('summarizeSession', () => {
    it('always uses haiku model', async () => {
      // First call creates the session with opus
      spawnMock.mockReturnValue(createChild({ stdout: 'first reply' }));
      await askClaude('hello', 'sum-sess', 'opus');

      // summarizeSession should use haiku regardless
      spawnMock.mockReturnValue(createChild({ stdout: 'Topic: test\nDiscussion: stuff' }));
      const result = await summarizeSession('sum-sess');
      expect(result.text).toBe('Topic: test\nDiscussion: stuff');
      expect(spawnMock).toHaveBeenLastCalledWith(
        '/usr/local/bin/claude',
        expect.arrayContaining(['--resume', 'sum-sess', '--model', 'haiku']),
        expect.any(Object),
      );
    });
  });
});
