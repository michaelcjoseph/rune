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
const { askClaude, askClaudeOneShot, runAgent, summarizeSession, markSessionCreated } =
  await import('./claude.js');

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

    it('uses sonnet model', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaudeOneShot('test prompt');
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['-p', 'test prompt', '--no-session-persistence', '--model', 'sonnet'],
        expect.objectContaining({ cwd: '/tmp/test-vault' }),
      );
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

  describe('runAgent', () => {
    it('uses opus model', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'agent result' }));
      const result = await runAgent('wiki-compiler', 'do stuff');
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['--agent', 'wiki-compiler', '-p', 'do stuff', '--no-session-persistence', '--model', 'opus'],
        expect.any(Object),
      );
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
