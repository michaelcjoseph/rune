import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('config', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('throws when TELEGRAM_BOT_TOKEN is missing', async () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TELEGRAM_USER_ID'];
    await expect(() => import('./config.js')).rejects.toThrow(
      'Missing required env var: TELEGRAM_BOT_TOKEN',
    );
  });

  it('throws when TELEGRAM_USER_ID is missing', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    delete process.env['TELEGRAM_USER_ID'];
    await expect(() => import('./config.js')).rejects.toThrow(
      'Missing required env var: TELEGRAM_USER_ID',
    );
  });

  it('loads successfully when all required vars are set', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_USER_ID'] = '12345';
    process.env['VAULT_DIR'] = '/tmp/vault';
    const { default: config } = await import('./config.js');
    expect(config.TELEGRAM_BOT_TOKEN).toBe('test-token');
    expect(config.TELEGRAM_USER_ID).toBe(12345);
    expect(config.VAULT_DIR).toBe('/tmp/vault');
  });

  it('throws when VAULT_DIR is missing', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_USER_ID'] = '12345';
    delete process.env['VAULT_DIR'];
    await expect(() => import('./config.js')).rejects.toThrow(
      'Missing required env var: VAULT_DIR',
    );
  });

  it('sets LOGS_DIR to project-root/logs', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_USER_ID'] = '12345';
    process.env['VAULT_DIR'] = '/tmp/vault';
    const { default: config } = await import('./config.js');
    expect(config.LOGS_DIR).toMatch(/\/logs$/);
  });
});
