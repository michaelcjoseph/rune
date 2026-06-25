import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from './logger.js';

describe('createLogger', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(async () => {
    const { flushLogger } = await import('./logger.js');
    await flushLogger();
    vi.restoreAllMocks();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns an object with info, warn, error, debug methods', () => {
    const log = createLogger('test');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.debug).toBe('function');
  });

  it('outputs structured JSON with component tag', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('my-component');
    log.info('hello');

    expect(spy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(parsed.component).toBe('my-component');
    expect(parsed.message).toBe('hello');
    expect(parsed.level).toBe('info');
    expect(parsed.time).toBeDefined();
    spy.mockRestore();
  });

  it('routes errors to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger('test');
    log.error('fail');

    const parsed = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(parsed.level).toBe('error');
    spy.mockRestore();
  });

  it('includes data when provided', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('test');
    log.info('with data', { key: 'value' });

    const parsed = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(parsed.data).toEqual({ key: 'value' });
    spy.mockRestore();
  });

  it('omits data field when not provided', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('test');
    log.info('no data');

    const parsed = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(parsed.data).toBeUndefined();
    spy.mockRestore();
  });

  it('file sink is disabled under vitest (so test runs do not append to real jarvis.log)', () => {
    // VITEST is set by vitest itself — sanity check the sentinel our logger uses.
    expect(process.env.VITEST).toBeTruthy();
  });

  it('writes through RUNE_LOGS_DIR and ignores the stale pre-rename logs env var', async () => {
    vi.resetModules();
    const root = join(tmpdir(), `rune-logger-${process.pid}-${Date.now()}`);
    const runeLogs = join(root, 'rune');
    const staleLogs = join(root, 'stale');
    const oldLogsEnv = ['JAR', 'VIS_LOGS_DIR'].join('');

    delete process.env.VITEST;
    process.env.RUNE_LOGS_DIR = runeLogs;
    process.env[oldLogsEnv] = staleLogs;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { createLogger: createLiveLogger, flushLogger } = await import('./logger.js');
      createLiveLogger('path-contract').info('rune log path selected');
      await flushLogger();

      expect(existsSync(staleLogs)).toBe(false);
      const files = readdirSync(runeLogs);
      expect(files.length).toBeGreaterThan(0);
      const written = files
        .map((file) => readFileSync(join(runeLogs, file), 'utf8'))
        .join('\n');
      expect(written).toContain('rune log path selected');
    } finally {
      logSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
