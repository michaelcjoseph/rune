import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

describe('config', () => {
  const ORIGINAL_ENV = { ...process.env };
  const retiredBrand = ['jar', 'vis'].join('');

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

  it('sets LOGS_DIR to project-root/logs when RUNE_LOGS_DIR is unset', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_USER_ID'] = '12345';
    process.env['VAULT_DIR'] = '/tmp/vault';
    delete process.env['RUNE_LOGS_DIR'];
    const { default: config, PROJECT_ROOT } = await import('./config.js');
    expect(config.LOGS_DIR).toBe(join(PROJECT_ROOT, 'logs'));
  });

  it('LOGS_DIR honors RUNE_LOGS_DIR over the computed default', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_USER_ID'] = '12345';
    process.env['VAULT_DIR'] = '/tmp/vault';
    process.env['RUNE_LOGS_DIR'] = '/tmp/rune-logs-override';
    const { default: config } = await import('./config.js');
    expect(config.LOGS_DIR).toBe('/tmp/rune-logs-override');
  });

  it('LOGS_DIR ignores the stale pre-rename logs env var', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_USER_ID'] = '12345';
    process.env['VAULT_DIR'] = '/tmp/vault';
    delete process.env['RUNE_LOGS_DIR'];
    const oldLogsEnv = ['JAR', 'VIS_LOGS_DIR'].join('');
    process.env[oldLogsEnv] = '/tmp/stale-logs-dir';
    const { default: config, PROJECT_ROOT } = await import('./config.js');
    expect(config.LOGS_DIR).not.toBe('/tmp/stale-logs-dir');
    expect(config.LOGS_DIR).toBe(join(PROJECT_ROOT, 'logs'));
  });

  it('WORKSPACE_DIR defaults to the computed project root when RUNE_WORKSPACE_DIR is unset', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_USER_ID'] = '12345';
    process.env['VAULT_DIR'] = '/tmp/vault';
    delete process.env['RUNE_WORKSPACE_DIR'];
    delete process.env['WORKSPACE_DIR'];
    const { default: config, PROJECT_ROOT } = await import('./config.js');
    expect(config.WORKSPACE_DIR).toBeDefined();
    expect(config.WORKSPACE_DIR).toBe(PROJECT_ROOT);
  });

  it('WORKSPACE_DIR returns RUNE_WORKSPACE_DIR as-is for absolute paths', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_USER_ID'] = '12345';
    process.env['VAULT_DIR'] = '/tmp/vault';
    process.env['RUNE_WORKSPACE_DIR'] = '/home/user/workspace';
    process.env['WORKSPACE_DIR'] = '/tmp/stale-workspace-dir';
    const { default: config } = await import('./config.js');
    expect(config.WORKSPACE_DIR).toBe('/home/user/workspace');
  });

  it('WORKSPACE_DIR expands leading ~ in RUNE_WORKSPACE_DIR', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_USER_ID'] = '12345';
    process.env['VAULT_DIR'] = '/tmp/vault';
    process.env['RUNE_WORKSPACE_DIR'] = '~/workspace';
    const { default: config } = await import('./config.js');
    const { homedir } = await import('node:os');
    expect(config.WORKSPACE_DIR).toBe(`${homedir()}/workspace`);
    expect(config.WORKSPACE_DIR).not.toMatch(/^~/);
  });

  it('resolves HTTP auth from RUNE_HTTP_SECRET and ignores the retired env name', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_USER_ID'] = '12345';
    process.env['VAULT_DIR'] = '/tmp/vault';
    process.env['RUNE_HTTP_SECRET'] = 'rune-secret';
    const oldHttpSecretEnv = ['JAR', 'VIS_HTTP_SECRET'].join('');
    process.env[oldHttpSecretEnv] = 'retired-secret';

    const { default: config } = await import('./config.js');
    const cfg = config as unknown as Record<string, unknown>;
    expect(cfg['RUNE_HTTP_SECRET']).toBe('rune-secret');
    expect(cfg[oldHttpSecretEnv]).toBeUndefined();
  });

  it('resolves allowed hosts from RUNE_ALLOWED_HOSTS and ignores the retired env name', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_USER_ID'] = '12345';
    process.env['VAULT_DIR'] = '/tmp/vault';
    process.env['RUNE_ALLOWED_HOSTS'] = 'localhost,rune.local';
    const oldAllowedHostsEnv = ['JAR', 'VIS_ALLOWED_HOSTS'].join('');
    process.env[oldAllowedHostsEnv] = 'retired.local';

    const { default: config } = await import('./config.js');
    const cfg = config as unknown as Record<string, unknown>;
    const hosts = cfg['RUNE_ALLOWED_HOSTS'];
    expect(hosts).toBeInstanceOf(Set);
    expect(hosts as Set<string>).toEqual(new Set(['localhost', 'rune.local']));
    expect(cfg[oldAllowedHostsEnv]).toBeUndefined();
  });

  it('committed product config renames the runtime product identifier to rune without a retired alias', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_USER_ID'] = '12345';
    process.env['VAULT_DIR'] = '/tmp/vault';
    const { readFileSync } = await import('node:fs');
    const { PROJECT_ROOT } = await import('./config.js');
    const products = JSON.parse(
      readFileSync(join(PROJECT_ROOT, 'policies', 'products.json'), 'utf8'),
    ) as Record<string, { repoPath?: string; credentialsFile?: string }>;

    expect(products).toHaveProperty('rune');
    expect(products).not.toHaveProperty(retiredBrand);
    expect(products['rune']?.repoPath).toBe('~/workspace/rune');
    expect(products['rune']?.credentialsFile ?? '').not.toMatch(new RegExp(retiredBrand, 'i'));
  });

  describe('work-run concurrency cap defaults (project 17)', () => {
    const REQUIRED = {
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_USER_ID: '12345',
      VAULT_DIR: '/tmp/vault',
    };

    async function loadConfig(extra: Record<string, string> = {}) {
      vi.resetModules();
      Object.assign(process.env, REQUIRED);
      delete process.env['WORK_RUN_GLOBAL_CAP'];
      delete process.env['WORK_RUN_PER_PROJECT_CAP'];
      Object.assign(process.env, extra);
      const { default: config } = await import('./config.js');
      return config;
    }

    it('raises the default global cap above the old cap of 2 while preserving per-project cap 1', async () => {
      const config = await loadConfig();

      expect(config.WORK_RUN_GLOBAL_CAP).toBeGreaterThan(2);
      expect(config.WORK_RUN_PER_PROJECT_CAP).toBe(1);
    });

    it('honors a WORK_RUN_GLOBAL_CAP override through the env-configurable path', async () => {
      const config = await loadConfig({ WORK_RUN_GLOBAL_CAP: '6' });

      expect(config.WORK_RUN_GLOBAL_CAP).toBe(6);
    });

    it('falls back to the raised default for invalid WORK_RUN_GLOBAL_CAP values', async () => {
      const defaultConfig = await loadConfig();
      const defaultGlobalCap = defaultConfig.WORK_RUN_GLOBAL_CAP;

      expect((await loadConfig({ WORK_RUN_GLOBAL_CAP: '0' })).WORK_RUN_GLOBAL_CAP).toBe(defaultGlobalCap);
      expect((await loadConfig({ WORK_RUN_GLOBAL_CAP: 'not-a-number' })).WORK_RUN_GLOBAL_CAP).toBe(defaultGlobalCap);
    });

    it('keeps WORK_RUN_GLOBAL_CAP on the integer parse path', async () => {
      const config = await loadConfig({ WORK_RUN_GLOBAL_CAP: '6.9' });

      expect(config.WORK_RUN_GLOBAL_CAP).toBe(6);
    });
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

  describe('MCP daemon standalone config (project 19 / W1 Phase 1)', () => {
    const REQUIRED = {
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_USER_ID: '12345',
      VAULT_DIR: '/tmp/vault',
    };

    async function loadConfig(extra: Record<string, string | undefined> = {}) {
      Object.assign(process.env, REQUIRED);
      for (const key of [
        'RUNE_HTTP_SECRET',
        'MCP_ISSUER_URL',
        'RUNE_MCP_SECRET',
        'RUNE_MCP_ISSUER_URL',
        'RUNE_MCP_OAUTH_STORE_FILE',
        'RUNE_MCP_HOST',
        'RUNE_MCP_PORT',
        'RUNE_MCP_TOOL_TIMEOUT_MS',
        'RUNE_LOGS_DIR',
      ]) {
        delete process.env[key];
      }
      for (const [key, value] of Object.entries(extra)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const { default: config } = await import('./config.js');
      return config as unknown as Record<string, unknown>;
    }

    it('defaults daemon host, port, and OAuth store independently of web MCP config', async () => {
      const config = await loadConfig({
        RUNE_HTTP_SECRET: 'web-secret',
        MCP_ISSUER_URL: 'https://web.example.invalid',
      });

      expect(config['RUNE_MCP_HOST']).toBe('127.0.0.1');
      expect(config['RUNE_MCP_PORT']).toBe(3848);
      expect(config['RUNE_MCP_OAUTH_STORE_FILE']).toMatch(/\/logs\/rune-mcp-oauth-store\.json$/);
      expect(config['RUNE_MCP_TOOL_TIMEOUT_MS']).toBe(30_000);
      expect(config['RUNE_MCP_SECRET']).toBe('');
      expect(config['RUNE_MCP_ISSUER_URL']).toBe('');
    });

    it('reads daemon secret and issuer from RUNE_MCP_* env vars, not the web vars', async () => {
      const config = await loadConfig({
        RUNE_HTTP_SECRET: 'web-secret',
        MCP_ISSUER_URL: 'https://web.example.invalid',
        RUNE_MCP_SECRET: 'daemon-secret',
        RUNE_MCP_ISSUER_URL: 'https://mcp.example.invalid',
      });

      expect(config['RUNE_HTTP_SECRET']).toBe('web-secret');
      expect(config['MCP_ISSUER_URL']).toBe('https://web.example.invalid');
      expect(config['RUNE_MCP_SECRET']).toBe('daemon-secret');
      expect(config['RUNE_MCP_ISSUER_URL']).toBe('https://mcp.example.invalid');
    });

    it('honors daemon host, port, and OAuth store overrides without changing web auth config', async () => {
      const config = await loadConfig({
        RUNE_HTTP_SECRET: 'web-secret',
        MCP_ISSUER_URL: 'https://web.example.invalid',
        RUNE_MCP_HOST: '0.0.0.0',
        RUNE_MCP_PORT: '4850',
        RUNE_MCP_OAUTH_STORE_FILE: '/tmp/rune-mcp/oauth-store.json',
      });

      expect(config['RUNE_MCP_HOST']).toBe('0.0.0.0');
      expect(config['RUNE_MCP_PORT']).toBe(4850);
      expect(config['RUNE_MCP_OAUTH_STORE_FILE']).toBe('/tmp/rune-mcp/oauth-store.json');
      expect(config['RUNE_HTTP_SECRET']).toBe('web-secret');
      expect(config['MCP_ISSUER_URL']).toBe('https://web.example.invalid');
    });

    it('honors the MCP per-tool timeout override and rejects unsafe values', async () => {
      let config = await loadConfig({ RUNE_MCP_TOOL_TIMEOUT_MS: '1250' });
      expect(config['RUNE_MCP_TOOL_TIMEOUT_MS']).toBe(1_250);

      for (const badTimeout of ['not-a-number', '0', '-1']) {
        vi.resetModules();
        config = await loadConfig({ RUNE_MCP_TOOL_TIMEOUT_MS: badTimeout });
        expect(config['RUNE_MCP_TOOL_TIMEOUT_MS']).toBe(30_000);
      }
    });

    it('falls back to the default daemon port when RUNE_MCP_PORT is not a valid TCP port', async () => {
      for (const badPort of ['not-a-number', '-1', '65536']) {
        vi.resetModules();
        const config = await loadConfig({
          RUNE_MCP_PORT: badPort,
        });

        expect(config['RUNE_MCP_PORT']).toBe(3848);
      }
    });

    it('places the default daemon OAuth store under an overridden LOGS_DIR', async () => {
      const config = await loadConfig({
        RUNE_LOGS_DIR: '/tmp/rune-config-test-logs',
      });

      expect(config['RUNE_MCP_OAUTH_STORE_FILE']).toBe(
        '/tmp/rune-config-test-logs/rune-mcp-oauth-store.json',
      );
    });
  });
});
