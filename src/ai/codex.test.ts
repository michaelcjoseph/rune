import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(), spawn: vi.fn() };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn() };
});

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../config.js', () => ({
  default: { CLAUDE_TIMEOUT_MS: 600_000 },
  PROJECT_ROOT: '/test/project',
}));

vi.mock('./claude.js', () => ({
  registerActiveProcess: vi.fn(),
  unregisterActiveProcess: vi.fn(),
}));

// Imports are hoisted after mocks resolve — use dynamic import to pick up mocked modules.
const { execFileSync, spawn } = await import('node:child_process');
const { existsSync } = await import('node:fs');
const { registerActiveProcess, unregisterActiveProcess } = await import('./claude.js');

const execFileSyncMock = execFileSync as unknown as ReturnType<typeof vi.fn>;
const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
const existsSyncMock = existsSync as unknown as ReturnType<typeof vi.fn>;
const registerMock = registerActiveProcess as unknown as ReturnType<typeof vi.fn>;
const unregisterMock = unregisterActiveProcess as unknown as ReturnType<typeof vi.fn>;

/** Build a fake child process that emits stdout/stderr/close/error events. */
function createChild(opts: {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: string | null;
  /** If true, never emits close (simulates a hung process). */
  neverClose?: boolean;
} = {}) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  if (!opts.neverClose) {
    const { stdout, stderr, code = 0, signal = null } = opts;
    process.nextTick(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code, signal);
    });
  }
  return child;
}

// ─── resolveCodexPath tests ──────────────────────────────────────────────────
// These tests import `resolveCodexPath` directly. Because CODEX_BIN is resolved
// at module load time, we test the function in isolation via a fresh import reset
// or by inspecting the exported function directly if the implementation allows
// calling it again.  For the tests that need different execFileSync/existsSync
// behavior we re-mock before importing.

describe('ai/codex', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    spawnMock.mockReset();
    existsSyncMock.mockReset();
    registerMock.mockReset();
    unregisterMock.mockReset();
  });

  // ── resolveCodexPath ───────────────────────────────────────────────────────

  describe('resolveCodexPath', () => {
    it('returns trimmed path when which codex succeeds', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      const { resolveCodexPath } = await import('./codex.js');
      const result = resolveCodexPath();
      expect(result).toBe('/opt/homebrew/bin/codex');
    });

    it('getCodexBin() lazily resolves and returns the trimmed which output', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      const { getCodexBin } = await import('./codex.js');
      expect(getCodexBin()).toBe('/opt/homebrew/bin/codex');
    });

    it('isCodexAvailable() returns true when resolution succeeds', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      const { isCodexAvailable } = await import('./codex.js');
      expect(isCodexAvailable()).toBe(true);
    });

    it('isCodexAvailable() returns false when neither which nor fallback finds codex', async () => {
      // Force a fresh evaluation by resetting module cache, since the lazy
      // CODEX_BIN cache persists across imports otherwise.
      vi.resetModules();
      execFileSyncMock.mockImplementation(() => { throw new Error('not found'); });
      existsSyncMock.mockReturnValue(false);
      const { isCodexAvailable } = await import('./codex.js');
      expect(isCodexAvailable()).toBe(false);
    });

    it('falls back to /opt/homebrew/bin/codex when which throws and fallback exists', async () => {
      execFileSyncMock.mockImplementation(() => { throw new Error('not found'); });
      existsSyncMock.mockImplementation((p: string) => p === '/opt/homebrew/bin/codex');
      const { resolveCodexPath } = await import('./codex.js');
      const result = resolveCodexPath();
      expect(result).toBe('/opt/homebrew/bin/codex');
    });

    it('throws a "Codex CLI not found" error when which throws and fallback is absent', async () => {
      execFileSyncMock.mockImplementation(() => { throw new Error('not found'); });
      existsSyncMock.mockReturnValue(false);
      const { resolveCodexPath } = await import('./codex.js');
      expect(() => resolveCodexPath()).toThrow(/codex.*not found/i);
    });
  });

  // ── runCodex ──────────────────────────────────────────────────────────────

  describe('runCodex', () => {
    it('happy path: collects stdout and returns exitCode 0', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(createChild({ stdout: 'collected stdout', code: 0 }));

      const { runCodex } = await import('./codex.js');
      const result = await runCodex('my prompt');

      expect(result).toEqual({ text: 'collected stdout', error: null, exitCode: 0 });
    });

    it('requests codex JSON mode when an onEvent callback is injected', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(createChild({ stdout: '{"type":"turn.completed"}\n', code: 0 }));

      const { runCodex } = await import('./codex.js');
      const opts = { onEvent: vi.fn() };
      await runCodex('my prompt', opts);

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).toContain('--json');
    });

    it('fires injected onStdout and onEvent callbacks for streamed JSONL stdout', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      const firstEvent = { type: 'thread.started', thread_id: 'thread-123' };
      const secondEvent = { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } };
      const stdout =
        `${JSON.stringify(firstEvent)}\n` +
        `${JSON.stringify(secondEvent)}\n`;
      spawnMock.mockReturnValue(createChild({ stdout, code: 0 }));
      const onStdout = vi.fn();
      const onEvent = vi.fn();

      const { runCodex } = await import('./codex.js');
      const opts = { onStdout, onEvent };
      const result = await runCodex('my prompt', opts);

      expect(result).toEqual({ text: stdout.trim(), error: null, exitCode: 0 });
      expect(onStdout).toHaveBeenCalledWith(stdout);
      expect(onEvent).toHaveBeenNthCalledWith(1, firstEvent);
      expect(onEvent).toHaveBeenNthCalledWith(2, secondEvent);
      expect(onEvent).toHaveBeenCalledTimes(2);
    });

    it('calls onStdout incrementally while the codex process is still running', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      const child = createChild({ neverClose: true });
      spawnMock.mockReturnValue(child);
      const onStdout = vi.fn();

      const { runCodex } = await import('./codex.js');
      const pending = runCodex('my prompt', { onStdout });

      child.stdout.emit('data', Buffer.from('first chunk'));
      expect(onStdout).toHaveBeenCalledTimes(1);
      expect(onStdout).toHaveBeenLastCalledWith('first chunk');
      expect(unregisterMock).not.toHaveBeenCalledWith(child);

      child.stdout.emit('data', Buffer.from(' second chunk\n'));
      expect(onStdout).toHaveBeenCalledTimes(2);
      expect(onStdout).toHaveBeenLastCalledWith(' second chunk\n');

      child.emit('close', 0, null);
      await expect(pending).resolves.toEqual({
        text: 'first chunk second chunk',
        error: null,
        exitCode: 0,
      });
    });

    it('reassembles split JSONL stdout before firing onEvent', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      const child = createChild({ neverClose: true });
      spawnMock.mockReturnValue(child);
      const onEvent = vi.fn();

      const { runCodex } = await import('./codex.js');
      const pending = runCodex('my prompt', { onEvent });

      child.stdout.emit('data', Buffer.from('{"type":"turn.'));
      expect(onEvent).not.toHaveBeenCalled();

      child.stdout.emit('data', Buffer.from('completed","delta":"ok"}\n'));
      expect(onEvent).toHaveBeenCalledOnce();
      expect(onEvent).toHaveBeenCalledWith({ type: 'turn.completed', delta: 'ok' });

      child.emit('close', 0, null);
      await expect(pending).resolves.toMatchObject({ error: null, exitCode: 0 });
    });

    it('streams malformed JSONL as a scrubbed raw fallback event', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(
        createChild({ stdout: 'not-json /test/project/private/file.md\n', code: 0 }),
      );
      const onEvent = vi.fn();

      const { runCodex } = await import('./codex.js');
      await runCodex('my prompt', { onEvent });

      expect(onEvent).toHaveBeenCalledOnce();
      expect(onEvent).toHaveBeenCalledWith({
        type: 'raw',
        line: 'not-json private/file.md',
      });
      expect(onEvent.mock.calls[0]![0].line).not.toContain('/test/project');
    });

    it('non-zero exit: returns partial stdout and error from stderr', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(createChild({ stdout: 'partial', stderr: 'error from codex', code: 1 }));

      const { runCodex } = await import('./codex.js');
      const result = await runCodex('my prompt');

      expect(result.text).toBe('partial');
      expect(result.error).toBeTruthy();
      expect(result.exitCode).toBe(1);
    });

    it('non-zero exit with no stderr: error contains exit code', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(createChild({ code: 2 }));

      const { runCodex } = await import('./codex.js');
      const result = await runCodex('my prompt');

      expect(result.error).toMatch(/2/);
      expect(result.exitCode).toBe(2);
    });

    it('spawn error event: returns error message and undefined exitCode', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      // Emit error synchronously inside spawnMock so it fires after runCodex
      // attaches its listener (avoids an unhandled EventEmitter error).
      spawnMock.mockImplementation(() => {
        process.nextTick(() => child.emit('error', new Error('ENOENT: codex not found')));
        return child;
      });

      const { runCodex } = await import('./codex.js');
      const result = await runCodex('my prompt');

      expect(result.text).toBeNull();
      expect(result.error).toMatch(/ENOENT/i);
      expect(result.exitCode).toBeUndefined();
    });

    it('timeout/SIGTERM: kills the child and returns a timeout error', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn((_signal: string) => {
        // Simulate child reacting to SIGTERM by closing
        process.nextTick(() => child.emit('close', null, 'SIGTERM'));
      });
      spawnMock.mockReturnValue(child);

      const { runCodex } = await import('./codex.js');
      const result = await runCodex('my prompt', { timeoutMs: 100 });

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(result.error).toMatch(/timeout|timed out/i);
    });

    it('registers the child via registerActiveProcess and unregisters on close', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      const child = createChild({ stdout: 'ok', code: 0 });
      spawnMock.mockReturnValue(child);

      const { runCodex } = await import('./codex.js');
      await runCodex('my prompt');

      expect(registerMock).toHaveBeenCalledWith(child);
      expect(unregisterMock).toHaveBeenCalledWith(child);
    });

    it('always includes --ephemeral and --skip-git-repo-check in spawn args', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));

      const { runCodex } = await import('./codex.js');
      await runCodex('my prompt');

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).toContain('--ephemeral');
      expect(args).toContain('--skip-git-repo-check');
    });

    it('passes -m flag when model option is provided', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));

      const { runCodex } = await import('./codex.js');
      await runCodex('my prompt', { model: 'o4-mini' });

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).toContain('-m');
      expect(args[args.indexOf('-m') + 1]).toBe('o4-mini');
    });

    it('passes -s flag when sandboxMode option is provided', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));

      const { runCodex } = await import('./codex.js');
      await runCodex('my prompt', { sandboxMode: 'read-only' });

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).toContain('-s');
      expect(args[args.indexOf('-s') + 1]).toBe('read-only');
    });

    it('passes all three optional flags together', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));

      const { runCodex } = await import('./codex.js');
      await runCodex('my prompt', {
        cwd: '/custom/dir',
        model: 'o4-mini',
        sandboxMode: 'workspace-write',
      });

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args).toContain('-m');
      expect(args[args.indexOf('-m') + 1]).toBe('o4-mini');
      expect(args).toContain('-s');
      expect(args[args.indexOf('-s') + 1]).toBe('workspace-write');
      // --cd flag OR cwd option: check at least one conveys the custom dir
      const hasCdFlag = args.includes('--cd') && args[args.indexOf('--cd') + 1] === '/custom/dir';
      const spawnOpts = spawnMock.mock.calls[0]![2] as { cwd?: string };
      const hasCwdOpt = spawnOpts?.cwd === '/custom/dir';
      expect(hasCdFlag || hasCwdOpt).toBe(true);
    });

    it('prompt is the final positional arg to codex exec', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));

      const { runCodex } = await import('./codex.js');
      const prompt = 'write me a hello world program';
      await runCodex(prompt);

      const args = spawnMock.mock.calls[0]![1] as string[];
      expect(args[args.length - 1]).toBe(prompt);
    });

    it('defaults cwd to PROJECT_ROOT when opts.cwd is omitted', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(createChild({ stdout: 'ok' }));

      const { runCodex } = await import('./codex.js');
      await runCodex('my prompt');

      const args = spawnMock.mock.calls[0]![1] as string[];
      const spawnOpts = spawnMock.mock.calls[0]![2] as { cwd?: string };
      // Implementation may use --cd flag or spawn cwd option; both are valid
      const hasCdFlag = args.includes('--cd') && args[args.indexOf('--cd') + 1] === '/test/project';
      const hasCwdOpt = spawnOpts?.cwd === '/test/project';
      expect(hasCdFlag || hasCwdOpt).toBe(true);
    });
  });

  // ── isCodexLoggedIn ───────────────────────────────────────────────────────

  describe('isCodexLoggedIn', () => {
    it('returns true when spawn exits 0 and stdout contains "Logged in"', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(
        createChild({ stdout: 'Logged in using ChatGPT', code: 0 }),
      );

      const { isCodexLoggedIn } = await import('./codex.js');
      const result = await isCodexLoggedIn();

      expect(result).toBe(true);
    });

    it('returns true when the "Logged in" marker arrives on stderr (current CLI writes it there)', async () => {
      // Regression: the Codex CLI emits "Logged in using ChatGPT" on STDERR
      // (stdout empty). The probe must read both streams or it false-negatives
      // and fail-closes the entire orchestrated path.
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(
        createChild({ stdout: '', stderr: 'Logged in using ChatGPT', code: 0 }),
      );

      const { isCodexLoggedIn } = await import('./codex.js');
      const result = await isCodexLoggedIn();

      expect(result).toBe(true);
    });

    it('returns false when "Not logged in" arrives on stderr (no false-positive)', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(
        createChild({ stdout: '', stderr: 'Not logged in', code: 0 }),
      );

      const { isCodexLoggedIn } = await import('./codex.js');
      const result = await isCodexLoggedIn();

      expect(result).toBe(false);
    });

    it('returns false when stdout does not contain "Logged in" (exit 0)', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(
        createChild({ stdout: 'Not logged in', code: 0 }),
      );

      const { isCodexLoggedIn } = await import('./codex.js');
      const result = await isCodexLoggedIn();

      expect(result).toBe(false);
    });

    it('returns false when exit code is non-zero', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      spawnMock.mockReturnValue(createChild({ stdout: 'Logged in', code: 1 }));

      const { isCodexLoggedIn } = await import('./codex.js');
      const result = await isCodexLoggedIn();

      expect(result).toBe(false);
    });

    it('returns false (does not throw) when spawn emits an error event', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      spawnMock.mockImplementation(() => {
        process.nextTick(() => child.emit('error', new Error('ENOENT: spawn failed')));
        return child;
      });

      const { isCodexLoggedIn } = await import('./codex.js');
      const result = await isCodexLoggedIn();

      expect(result).toBe(false);
    });
  });

  // ── probeCodexProvider ────────────────────────────────────────────────────

  describe('probeCodexProvider', () => {
    it('returns { available: true } when binary is found AND login status passes', async () => {
      // binary found via which
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      // login status spawn returns "Logged in" with exit 0
      spawnMock.mockReturnValue(
        createChild({ stdout: 'Logged in using ChatGPT', code: 0 }),
      );

      const { probeCodexProvider } = await import('./codex.js');
      const result = await probeCodexProvider();

      expect(result).toEqual({ available: true });
    });

    it('returns { available: false, reason: /binary|not found|path/i } when binary is missing and does NOT attempt login probe', async () => {
      vi.resetModules();
      execFileSyncMock.mockImplementation(() => { throw new Error('not found'); });
      existsSyncMock.mockReturnValue(false);

      const { probeCodexProvider } = await import('./codex.js');
      const result = await probeCodexProvider();

      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.reason).toMatch(/binary|not found|path/i);
      }
      // spawn must not have been called — the probe should short-circuit
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('returns { available: false, reason: /logged in|login|authenticate/i } when binary is present but not logged in', async () => {
      execFileSyncMock.mockReturnValue('/opt/homebrew/bin/codex\n');
      // login status spawn: binary runs but user is not logged in
      spawnMock.mockReturnValue(
        createChild({ stdout: 'Not logged in', code: 0 }),
      );

      const { probeCodexProvider } = await import('./codex.js');
      const result = await probeCodexProvider();

      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.reason).toMatch(/logged in|login|authenticate/i);
      }
    });
  });
});
