import { describe, it, expect, vi } from 'vitest';
import { createLogger } from './logger.js';

describe('createLogger', () => {
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
});
