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

  it('WORKSPACE_DIR is undefined when not set', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_USER_ID'] = '12345';
    process.env['VAULT_DIR'] = '/tmp/vault';
    delete process.env['WORKSPACE_DIR'];
    const { default: config } = await import('./config.js');
    expect(config.WORKSPACE_DIR).toBeUndefined();
  });

  it('WORKSPACE_DIR returns the value as-is for absolute paths', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_USER_ID'] = '12345';
    process.env['VAULT_DIR'] = '/tmp/vault';
    process.env['WORKSPACE_DIR'] = '/home/user/workspace';
    const { default: config } = await import('./config.js');
    expect(config.WORKSPACE_DIR).toBe('/home/user/workspace');
  });

  it('WORKSPACE_DIR expands leading ~ to homedir', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_USER_ID'] = '12345';
    process.env['VAULT_DIR'] = '/tmp/vault';
    process.env['WORKSPACE_DIR'] = '~/workspace';
    const { default: config } = await import('./config.js');
    const { homedir } = await import('node:os');
    expect(config.WORKSPACE_DIR).toBe(`${homedir()}/workspace`);
    expect(config.WORKSPACE_DIR).not.toMatch(/^~/);
  });

  // -------------------------------------------------------------------------
  // Project 14 (Phase 8) — PRODUCTS_CONFIG_FILE env redirect. The live-acceptance
  // harness points the orchestrated applier at a throwaway products.json without
  // editing the committed policies/products.json. WRITE-FIRST: the getter ignores
  // the env var today, so the override assertion is red until the redirect lands.
  // -------------------------------------------------------------------------
  describe('PRODUCTS_CONFIG_FILE env redirect (Phase 8)', () => {
    const REQUIRED = {
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_USER_ID: '12345',
      VAULT_DIR: '/tmp/vault',
    };

    it('defaults to policies/products.json under PROJECT_ROOT when unset', async () => {
      Object.assign(process.env, REQUIRED);
      delete process.env['PRODUCTS_CONFIG_FILE'];
      const { default: config } = await import('./config.js');
      expect(config.PRODUCTS_CONFIG_FILE).toMatch(/\/policies\/products\.json$/);
    });

    it('honors a PRODUCTS_CONFIG_FILE override (absolute path as-is)', async () => {
      Object.assign(process.env, REQUIRED, {
        PRODUCTS_CONFIG_FILE: '/tmp/p14-accept/products.json',
      });
      const { default: config } = await import('./config.js');
      expect(config.PRODUCTS_CONFIG_FILE).toBe('/tmp/p14-accept/products.json');
    });

    it('expands a leading ~ in the PRODUCTS_CONFIG_FILE override', async () => {
      Object.assign(process.env, REQUIRED, {
        PRODUCTS_CONFIG_FILE: '~/tmp/products.json',
      });
      const { default: config } = await import('./config.js');
      const { homedir } = await import('node:os');
      expect(config.PRODUCTS_CONFIG_FILE).toBe(`${homedir()}/tmp/products.json`);
    });

    it('WORKTREE_ROOT is a getter: an override set AFTER import is still honored', async () => {
      Object.assign(process.env, REQUIRED);
      delete process.env['WORKTREE_ROOT'];
      const { default: config } = await import('./config.js');
      // Default before any override.
      expect(config.WORKTREE_ROOT).toMatch(/\/\.worktrees$/);
      // The harness redirects worktrees AFTER config is first imported — a
      // getter (not an eager property) must reflect the late override.
      process.env['WORKTREE_ROOT'] = '/tmp/p14-accept/worktrees';
      expect(config.WORKTREE_ROOT).toBe('/tmp/p14-accept/worktrees');
    });
  });

  // -------------------------------------------------------------------------
  // Project 15 (P0.2) — work-run finalizer timing constants. WRITE-FIRST: the
  // five constants don't exist in config.ts yet, so they read `undefined` and
  // every assertion below is red until the P0.2 task adds them via
  // parseNumericEnv with the spec defaults + a positive-integer (min 1) guard.
  // No wall-clock sleeps — these are plain numeric values; the timers that use
  // them are exercised with injected clocks in their own suites.
  // -------------------------------------------------------------------------
  describe('work-run finalizer timing constants (P0.2)', () => {
    const REQUIRED = {
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_USER_ID: '12345',
      VAULT_DIR: '/tmp/vault',
    };

    /** Spec defaults (spec.md "Pinned runtime constants"). */
    const DEFAULTS: Record<string, number> = {
      WORK_RUN_TERMINAL_DRAIN_MS: 30_000,
      WORK_RUN_REAP_GRACE_MS: 5_000,
      WORK_RUN_QUIET_CANCEL_AFTER_MS: 1_200_000,
      WORK_RUN_MAX_RUNTIME_MS: 7_200_000,
      WORK_RUN_GATE_COMMAND_TIMEOUT_MS: 600_000,
    };

    async function loadConfig(extra: Record<string, string> = {}): Promise<Record<string, unknown>> {
      Object.assign(process.env, REQUIRED, extra);
      const { default: config } = await import('./config.js');
      return config as unknown as Record<string, unknown>;
    }

    it('default to the spec values when the env vars are unset', async () => {
      // Defensive: beforeEach restores ORIGINAL_ENV, which would carry these
      // vars if a developer has them set in their real shell — delete so the
      // unset-defaults assertion isn't masked by an inherited override.
      for (const k of Object.keys(DEFAULTS)) delete process.env[k];
      const config = await loadConfig();
      // Single source of the five spec defaults (also used by the fallback tests).
      for (const [key, value] of Object.entries(DEFAULTS)) {
        expect(config[key]).toBe(value);
      }
    });

    it('respect a valid numeric override', async () => {
      const config = await loadConfig({
        WORK_RUN_TERMINAL_DRAIN_MS: '45000',
        WORK_RUN_MAX_RUNTIME_MS: '3600000',
      });
      expect(config['WORK_RUN_TERMINAL_DRAIN_MS']).toBe(45_000);
      expect(config['WORK_RUN_MAX_RUNTIME_MS']).toBe(3_600_000);
    });

    it('reject a non-numeric value and fall back to the default', async () => {
      const config = await loadConfig({ WORK_RUN_TERMINAL_DRAIN_MS: 'not-a-number' });
      expect(config['WORK_RUN_TERMINAL_DRAIN_MS']).toBe(DEFAULTS['WORK_RUN_TERMINAL_DRAIN_MS']);
    });

    it('reject a non-positive value and fall back to the default (min-1 guard)', async () => {
      const config = await loadConfig({
        WORK_RUN_REAP_GRACE_MS: '0',
        WORK_RUN_QUIET_CANCEL_AFTER_MS: '-1',
      });
      expect(config['WORK_RUN_REAP_GRACE_MS']).toBe(DEFAULTS['WORK_RUN_REAP_GRACE_MS']);
      expect(config['WORK_RUN_QUIET_CANCEL_AFTER_MS']).toBe(DEFAULTS['WORK_RUN_QUIET_CANCEL_AFTER_MS']);
    });
  });
});
