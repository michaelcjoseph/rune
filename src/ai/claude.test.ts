import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: '/tmp/test-vault',
    CLAUDE_TIMEOUT_MS: 100,
    TIMEZONE: 'America/Chicago',
  },
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

const { spawn } = await import('node:child_process');
const { askClaude, askClaudeOneShot, runAgent, summarizeSession } = await import('./claude.js');

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

    it('passes correct args', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));
      await askClaudeOneShot('test prompt');
      expect(spawnMock).toHaveBeenCalledWith(
        'claude',
        ['-p', 'test prompt', '--no-session-persistence'],
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
    it('includes session-id in args', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'reply' }));
      await askClaude('hello', 'sess-123');
      expect(spawnMock).toHaveBeenCalledWith(
        'claude',
        ['-p', 'hello', '--session-id', 'sess-123'],
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

      // Only first spawn should have fired
      await new Promise((r) => setTimeout(r, 10));
      expect(spawnMock).toHaveBeenCalledTimes(1);

      // Complete first — second should then spawn
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
    it('passes agent flag and name', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'agent result' }));
      const result = await runAgent('wiki-compiler', 'do stuff');
      expect(spawnMock).toHaveBeenCalledWith(
        'claude',
        ['--agent', 'wiki-compiler', '-p', 'do stuff', '--no-session-persistence'],
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
    it('uses session id and returns summary text', async () => {
      spawnMock.mockReturnValue(createChild({ stdout: 'Topic: test\nDiscussion: stuff' }));
      const result = await summarizeSession('sess-sum');
      expect(result.text).toBe('Topic: test\nDiscussion: stuff');
      expect(spawnMock).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['--session-id', 'sess-sum']),
        expect.any(Object),
      );
    });
  });
});
