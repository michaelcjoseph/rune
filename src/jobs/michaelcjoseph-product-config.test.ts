import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSandboxEnv } from './credential-injector.js';
import { readProductsConfig } from './sandbox-runtime.js';
import type { SandboxSpec } from '../intent/sandbox.js';

const PRODUCTS_JSON = fileURLToPath(new URL('../../policies/products.json', import.meta.url));

function sandboxFor(product: string): SandboxSpec {
  return {
    product,
    project: 'michaelcjoseph-product-config',
    worktree: `/tmp/rune-worktrees/${product}/michaelcjoseph-product-config`,
    egressAllowlist: ['github.com', 'registry.npmjs.org'],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('michaelcjoseph.com product config', () => {
  it('registers brand and writing as runnable shared-repo products with scoped credentials, egress, and validation', () => {
    const products = readProductsConfig(PRODUCTS_JSON);
    const writing = products['writing'];
    const brand = products['brand'];

    expect(writing).toBeDefined();
    expect(brand).toBeDefined();
    expect(writing?.repoPath).toMatch(/\/workspace\/michaelcjoseph\.com$/);
    expect(brand?.repoPath).toBe(writing?.repoPath);

    for (const [slug, product] of Object.entries({ writing, brand })) {
      expect(product, `${slug} must be present in policies/products.json`).toBeDefined();
      expect(product).toMatchObject({
        class: 'external',
        baseBranch: 'main',
        orchestratedMode: true,
        credentialsFile: expect.stringMatching(new RegExp(`/\\.config/rune/credentials/${slug}/\\.env$`)),
        containerCapabilities: expect.objectContaining({
          runs: true,
          chat: true,
          monitoring: 'stubbed',
        }),
        validationCommands: expect.arrayContaining(['npm run build']),
        egressAllowlist: expect.arrayContaining([
          'github.com',
          'api.github.com',
          'codeload.github.com',
          'objects.githubusercontent.com',
          'registry.npmjs.org',
        ]),
      });
    }

    expect(writing).toMatchObject({
      scopePath: 'docs/rune',
      containerCapabilities: expect.objectContaining({
        projects: false,
        bugs: false,
        ideas: true,
      }),
    });
    expect(brand?.scopePath).toBeUndefined();
    expect(brand?.containerCapabilities).toMatchObject({
      projects: true,
      bugs: true,
      ideas: true,
    });
  });

  it('builds a writing sandbox env from only writing credentials and allowed shell basics', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'rune-writing-creds-'));
    try {
      const writingCreds = join(tmpDir, 'writing.env');
      const brandCreds = join(tmpDir, 'brand.env');
      const runeCreds = join(tmpDir, 'rune.env');
      writeFileSync(writingCreds, 'WRITING_ONLY_TOKEN=writing-product-secret\n');
      writeFileSync(brandCreds, 'BRAND_ONLY_TOKEN=brand-product-secret\n');
      writeFileSync(runeCreds, 'RUNE_ONLY_TOKEN=rune-product-secret\n');

      const productsPath = join(tmpDir, 'products.json');
      writeFileSync(productsPath, JSON.stringify({
        writing: {
          repoPath: '/tmp/michaelcjoseph.com',
          baseBranch: 'main',
          credentialsFile: writingCreds,
          egressAllowlist: ['github.com', 'registry.npmjs.org'],
        },
        brand: {
          repoPath: '/tmp/michaelcjoseph.com',
          baseBranch: 'main',
          credentialsFile: brandCreds,
          egressAllowlist: ['github.com', 'registry.npmjs.org'],
        },
        rune: {
          repoPath: '/tmp/rune',
          baseBranch: 'main',
          credentialsFile: runeCreds,
          egressAllowlist: ['github.com', 'registry.npmjs.org'],
        },
      }));

      vi.stubEnv('PATH', '/usr/bin:/bin');
      vi.stubEnv('TELEGRAM_BOT_TOKEN', 'parent-telegram-secret');
      vi.stubEnv('RUNE_HTTP_SECRET', 'parent-http-secret');
      vi.stubEnv('READWISE_TOKEN', 'parent-readwise-secret');
      vi.stubEnv('WHOOP_CLIENT_SECRET', 'parent-whoop-secret');

      const env = buildSandboxEnv(sandboxFor('writing'), {
        productsConfigPath: productsPath,
        baseEnvKeys: ['PATH'],
      });

      expect(env).toMatchObject({
        PATH: '/usr/bin:/bin',
        WRITING_ONLY_TOKEN: 'writing-product-secret',
      });
      expect(env).not.toHaveProperty('BRAND_ONLY_TOKEN');
      expect(env).not.toHaveProperty('RUNE_ONLY_TOKEN');
      expect(env).not.toHaveProperty('TELEGRAM_BOT_TOKEN');
      expect(env).not.toHaveProperty('RUNE_HTTP_SECRET');
      expect(env).not.toHaveProperty('READWISE_TOKEN');
      expect(env).not.toHaveProperty('WHOOP_CLIENT_SECRET');
      expect(Object.values(env)).not.toEqual(expect.arrayContaining([
        'brand-product-secret',
        'rune-product-secret',
        'parent-telegram-secret',
        'parent-http-secret',
        'parent-readwise-secret',
        'parent-whoop-secret',
      ]));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
