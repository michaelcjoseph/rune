import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  existsSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProductPromptContext, SessionScope } from './sessions.js';

const tmpDir = join(tmpdir(), `rune-sessions-test-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });
const sessionsFile = join(tmpDir, 'tg-sessions.json');
const productsConfigFile = join(tmpDir, 'products.json');
const workspaceDir = join(tmpDir, 'workspace');
const vaultDir = join(tmpDir, 'vault');
const fallbackRoot = join(tmpDir, 'fallback-product-chats');

vi.mock('../config.js', () => ({
  default: {
    SESSIONS_FILE: sessionsFile,
    LOGS_DIR: tmpDir,
    TIMEZONE: 'America/Chicago',
    PRODUCTS_CONFIG_FILE: productsConfigFile,
    WORKSPACE_DIR: workspaceDir,
    PRODUCT_CHAT_FALLBACK_ROOT: fallbackRoot,
    VAULT_DIR: vaultDir,
    DEFAULT_CHAT_MODEL: 'gpt-5.6-terra',
  },
  // Required by transitively-imported ai/claude.js, which builds an MCP
  // config path at module load.
  PROJECT_ROOT: '/tmp/test-project',
}));

const sessionsModule = await import('./sessions.js');
const {
  getSession,
  createSession,
  updateSession,
  deleteSession,
  setSessionModel,
  setSessionExecutor,
  getAllSessions,
  restoreSessions,
  persistSessions,
  appendMessageToSession,
  getSessionMessages,
  buildSessionSystemPrompt,
  resolveProductChat,
  resolveProductFallbackWorkspace,
} = sessionsModule;

function writeFileEnsuringDir(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeProductChatFixture(): { runeRepo: string; siteRepo: string } {
  const runeRepo = join(tmpDir, 'product-chat-rune');
  const siteRepo = join(tmpDir, 'product-chat-site');

  writeFileSync(productsConfigFile, JSON.stringify({
    'rune-mcp': {
      class: 'internal',
      repoPath: runeRepo,
      baseBranch: 'main',
      credentialsFile: join(tmpDir, 'creds', 'rune-mcp.env'),
      egressAllowlist: [],
    },
    writing: {
      class: 'external',
      repoPath: siteRepo,
      scopePath: 'docs/rune',
      baseBranch: 'main',
      credentialsFile: join(tmpDir, 'creds', 'writing.env'),
      egressAllowlist: [],
    },
    brand: {
      class: 'external',
      repoPath: siteRepo,
      baseBranch: 'main',
      credentialsFile: join(tmpDir, 'creds', 'brand.env'),
      egressAllowlist: [],
    },
  }));

  writeFileEnsuringDir(join(runeRepo, 'AGENTS.md'), 'RUNE_MCP_REPO_CONTEXT: MCP daemon lives in the Rune repo.');
  writeFileEnsuringDir(
    join(runeRepo, 'docs', 'projects', '19-rune-product-os', 'spec.md'),
    'RUNE_MCP_PROJECT_CONTEXT: standalone MCP and cockpit product OS.',
  );
  writeFileEnsuringDir(
    join(runeRepo, 'docs', 'projects', '19-rune-product-os', 'tasks.md'),
    '- [ ] RUNE_MCP_TASK_CONTEXT product-scoped chat',
  );

  writeFileEnsuringDir(join(siteRepo, 'README.md'), 'BRAND_ROOT_CONTEXT: root Next.js brand app.');
  writeFileEnsuringDir(
    join(siteRepo, 'docs', 'projects', 'brand-refresh', 'spec.md'),
    'BRAND_PROJECT_CONTEXT: brand home page work.',
  );
  writeFileEnsuringDir(
    join(siteRepo, 'docs', 'projects', 'brand-refresh', 'tasks.md'),
    '- [ ] BRAND_TASK_CONTEXT brand app polish',
  );
  writeFileEnsuringDir(
    join(siteRepo, 'docs', 'rune', 'AGENTS.md'),
    'WRITING_SCOPED_CONTEXT: writing product owns /rune content only.',
  );
  writeFileEnsuringDir(
    join(siteRepo, 'docs', 'rune', 'projects', 'writing-pipeline', 'spec.md'),
    'WRITING_PROJECT_CONTEXT: Rune-authored essays under /rune/{topic}.',
  );
  writeFileEnsuringDir(
    join(siteRepo, 'docs', 'rune', 'projects', 'writing-pipeline', 'tasks.md'),
    '- [ ] WRITING_TASK_CONTEXT draft and publish scoped writing',
  );

  return { runeRepo, siteRepo };
}

describe('vault/sessions', () => {
  beforeEach(() => {
    for (const { userId, transport, scope } of getAllSessions() as any[]) {
      deleteSession(userId, transport, scope);
    }
  });

  describe('createSession', () => {
    it('creates a session with UUID and metadata', () => {
      const session = createSession(123, 'telegram', 'hello world');
      expect(session.sessionId).toBeDefined();
      expect(session.messageCount).toBe(1);
      expect(session.firstMessage).toBe('hello world');
      expect(session.lastActivity).toBeDefined();
    });

    it('truncates long first messages to 100 chars', () => {
      const session = createSession(123, 'telegram', 'x'.repeat(200));
      expect(session.firstMessage).toHaveLength(100);
    });
  });

  describe('getSession', () => {
    it('returns null for unknown chat', () => {
      expect(getSession(999, 'telegram')).toBeNull();
    });

    it('returns existing session', () => {
      createSession(123, 'telegram', 'test');
      expect(getSession(123, 'telegram')!.firstMessage).toBe('test');
    });
  });

  describe('updateSession', () => {
    it('increments message count', () => {
      createSession(123, 'telegram', 'test');
      updateSession(123, 'telegram');
      expect(getSession(123, 'telegram')!.messageCount).toBe(2);
    });

    it('no-ops for unknown chat', () => {
      expect(() => updateSession(999, 'telegram')).not.toThrow();
    });
  });

  describe('deleteSession', () => {
    it('removes session', () => {
      createSession(123, 'telegram', 'test');
      deleteSession(123, 'telegram');
      expect(getSession(123, 'telegram')).toBeNull();
    });
  });

  describe('getAllSessions', () => {
    it('returns all active sessions', () => {
      createSession(1, 'telegram', 'one');
      createSession(2, 'telegram', 'two');
      expect(getAllSessions()).toHaveLength(2);
    });

    it('surfaces userId and transport per entry', () => {
      createSession(1, 'telegram', 'tg');
      createSession(1, 'webview', 'web');
      const entries = getAllSessions();
      const sorted = [...entries].sort((a, b) => a.transport.localeCompare(b.transport));
      expect(sorted.map(e => `${e.transport}:${e.userId}`)).toEqual(['telegram:1', 'webview:1']);
    });
  });

  describe('parseSessionKey', () => {
    it('decodes product-scoped keys and still accepts legacy global keys', () => {
      const parseSessionKey = (sessionsModule as {
        parseSessionKey?: (key: string) => unknown;
      }).parseSessionKey;
      expect(parseSessionKey).toEqual(expect.any(Function));

      expect(parseSessionKey!('rune:webview:42')).toEqual({
        userId: 42,
        transport: 'webview',
        scope: { kind: 'product', product: 'rune' },
      });
      expect(parseSessionKey!('telegram:7')).toEqual({
        userId: 7,
        transport: 'telegram',
        scope: { kind: 'global' },
      });
    });

    it('round-trips the exported sessionKeyForScope through the existing parser semantics', () => {
      const sessionKeyForScope = (sessionsModule as {
        sessionKeyForScope?: (userId: number, transport: 'telegram' | 'webview', scope?: SessionScope) => string;
      }).sessionKeyForScope;
      const parseSessionKey = (sessionsModule as {
        parseSessionKey?: (key: string) => unknown;
      }).parseSessionKey;

      expect(
        sessionKeyForScope,
        'src/vault/sessions.ts must export sessionKeyForScope so dispatch and session storage share one key format',
      ).toEqual(expect.any(Function));
      expect(parseSessionKey).toEqual(expect.any(Function));

      const globalKey = sessionKeyForScope!(42, 'webview', { kind: 'global' });
      expect(globalKey).toBe('webview:42');
      expect(parseSessionKey!(globalKey)).toEqual({
        userId: 42,
        transport: 'webview',
        scope: { kind: 'global' },
      });

      const productKey = sessionKeyForScope!(42, 'webview', { kind: 'product', product: 'rune' });
      expect(productKey).toBe('rune:webview:42');
      expect(parseSessionKey!(productKey)).toEqual({
        userId: 42,
        transport: 'webview',
        scope: { kind: 'product', product: 'rune' },
      });
    });
  });

  describe('cross-transport isolation', () => {
    it('keeps TG and webview sessions independent under the same userId', () => {
      const tg = createSession(42, 'telegram', 'tg first message');
      const web = createSession(42, 'webview', 'webview first message');
      expect(tg.sessionId).not.toBe(web.sessionId);
      expect(getSession(42, 'telegram')!.firstMessage).toBe('tg first message');
      expect(getSession(42, 'webview')!.firstMessage).toBe('webview first message');
    });

    it('deleting the TG session leaves the webview session intact', () => {
      createSession(42, 'telegram', 'tg');
      const web = createSession(42, 'webview', 'web');
      deleteSession(42, 'telegram');
      expect(getSession(42, 'telegram')).toBeNull();
      expect(getSession(42, 'webview')!.sessionId).toBe(web.sessionId);
    });

    it('appendMessageToSession is scoped per-transport', () => {
      createSession(42, 'telegram', 'tg');
      createSession(42, 'webview', 'web');
      appendMessageToSession(42, 'telegram', 'user', 'tg-only');
      expect(getSessionMessages(42, 'telegram')).toHaveLength(1);
      expect(getSessionMessages(42, 'webview')).toHaveLength(0);
    });
  });

  describe('product-scoped sessions', () => {
    const runeScope: SessionScope = { kind: 'product', product: 'rune' };
    const pkmsScope: SessionScope = { kind: 'product', product: 'pkms' };

    it('keeps global, telegram, and per-product webview sessions on independent keys', () => {
      const globalWeb = createSession(42, 'webview', 'global webview');
      const runeWeb = createSession(42, 'webview', 'rune webview', undefined, runeScope);
      const pkmsWeb = createSession(42, 'webview', 'pkms webview', undefined, pkmsScope);
      const telegram = createSession(42, 'telegram', 'telegram global');

      expect(runeWeb.sessionId).not.toBe(globalWeb.sessionId);
      expect(pkmsWeb.sessionId).not.toBe(runeWeb.sessionId);
      expect(telegram.sessionId).not.toBe(runeWeb.sessionId);
      expect(getSession(42, 'webview')!.firstMessage).toBe('global webview');
      expect(getSession(42, 'webview', runeScope)!.firstMessage).toBe('rune webview');
      expect(getSession(42, 'webview', pkmsScope)!.firstMessage).toBe('pkms webview');
      expect(getSession(42, 'telegram')!.firstMessage).toBe('telegram global');
    });

    it('surfaces scope metadata from getAllSessions for capture and state snapshot consumers', () => {
      createSession(7, 'webview', 'rune scoped', undefined, runeScope);
      createSession(7, 'telegram', 'telegram global');

      const keys = getAllSessions()
        .map(e => `${e.scope?.kind ?? 'global'}:${e.scope?.product ?? ''}:${e.transport}:${e.userId}`)
        .sort();

      expect(keys).toEqual([
        'global::telegram:7',
        'product:rune:webview:7',
      ]);
    });

    it('restores product-scoped keys without stranding legacy global sessions', () => {
      const data = [
        ['rune:webview:12', {
          sessionId: 'product-session',
          lastActivity: '2026-04-07T12:00:00Z',
          messageCount: 2,
          firstMessage: 'product restored',
        }],
        ['webview:12', {
          sessionId: 'global-session',
          lastActivity: '2026-04-07T12:00:00Z',
          messageCount: 3,
          firstMessage: 'global restored',
        }],
        [13, {
          sessionId: 'legacy-telegram-session',
          lastActivity: '2026-04-07T12:00:00Z',
          messageCount: 4,
          firstMessage: 'legacy restored',
        }],
      ];
      writeFileSync(sessionsFile, JSON.stringify(data));

      restoreSessions();

      expect(getSession(12, 'webview', runeScope)!.sessionId).toBe('product-session');
      expect(getSession(12, 'webview')!.sessionId).toBe('global-session');
      expect(getSession(13, 'telegram')!.sessionId).toBe('legacy-telegram-session');
      const persisted = JSON.parse(readFileSync(sessionsFile, 'utf8')) as [string, unknown][];
      expect(persisted.map(([k]) => k).sort()).toEqual([
        'rune:webview:12',
        'telegram:13',
        'webview:12',
      ]);
    });

    it('preserves a product-scoped session through getAllSessions, persist, and restore', () => {
      const session = createSession(88, 'webview', 'repo scoped first turn', 'haiku', runeScope);
      appendMessageToSession(88, 'webview', 'user', 'look in this product repo', runeScope);
      updateSession(88, 'webview', runeScope);

      const before = getAllSessions().find(e =>
        e.userId === 88
        && e.transport === 'webview'
        && e.scope?.kind === 'product'
        && e.scope.product === 'rune',
      );
      expect(before?.session.sessionId).toBe(session.sessionId);

      persistSessions();
      const persisted = readFileSync(sessionsFile, 'utf8');
      deleteSession(88, 'webview', runeScope);
      expect(getSession(88, 'webview', runeScope)).toBeNull();

      writeFileSync(sessionsFile, persisted);
      restoreSessions();

      const restored = getSession(88, 'webview', runeScope);
      expect(restored?.sessionId).toBe(session.sessionId);
      expect(restored?.model).toBe('haiku');
      expect(restored?.messageCount).toBe(2);
      expect(getSessionMessages(88, 'webview', runeScope).map(m => m.text)).toEqual([
        'look in this product repo',
      ]);
      expect(getAllSessions()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          userId: 88,
          transport: 'webview',
          scope: { kind: 'product', product: 'rune' },
          session: expect.objectContaining({ sessionId: session.sessionId }),
        }),
      ]));
    });

    it('updates, appends, model-switches, and deletes only the addressed product scope', () => {
      createSession(42, 'webview', 'global webview', 'haiku');
      createSession(42, 'webview', 'rune webview', 'haiku', runeScope);

      appendMessageToSession(42, 'webview', 'user', 'rune-only', runeScope);
      updateSession(42, 'webview', runeScope);
      setSessionModel(42, 'webview', 'opus', runeScope);

      expect(getSession(42, 'webview')!.messageCount).toBe(1);
      expect(getSession(42, 'webview')!.model).toBe('haiku');
      expect(getSessionMessages(42, 'webview')).toEqual([]);
      expect(getSession(42, 'webview', runeScope)!.messageCount).toBe(2);
      expect(getSession(42, 'webview', runeScope)!.model).toBe('opus');
      expect(getSessionMessages(42, 'webview', runeScope).map(m => m.text)).toEqual([
        'rune-only',
      ]);

      deleteSession(42, 'webview', runeScope);

      expect(getSession(42, 'webview', runeScope)).toBeNull();
      expect(getSession(42, 'webview')!.firstMessage).toBe('global webview');
    });
  });

  describe('buildSessionSystemPrompt — product-tailored context', () => {
    const runeScope: SessionScope = { kind: 'product', product: 'rune' };
    const runeContext: ProductPromptContext = {
      product: 'rune',
      repoPath: '/workspace/rune',
      repoDocs: [
        {
          path: 'CLAUDE.md',
          content: 'Rune architecture: one Node process owns Telegram polling and the localhost cockpit.',
        },
        {
          path: 'docs/operations.md',
          content: 'Restart is production-only and goes through launchctl kickstart.',
        },
      ],
      projects: [
        {
          slug: '17-cockpit-redesign',
          spec: 'The cockpit deep view makes Product, Project, Bug, Idea, Run, and Chat first-class.',
          tasks: '- [ ] product-tailored-system-prompt\n- [ ] repo-plus-vault-chat-search',
        },
      ],
      worldview: [
        {
          path: 'world-view/ai.md',
          anchor: 'operator-cockpit',
          content: 'Operator cockpits should preserve human judgment while delegating scoped execution.',
        },
      ],
    };

    it('assembles product-scoped prompts from that product repo docs, project specs/tasks, and worldview', () => {
      const prompt = buildSessionSystemPrompt({
        scope: runeScope,
        productContext: runeContext,
        workspaceDir: '/workspace',
      });

      expect(prompt).toMatch(/active product:\s*rune/i);
      expect(prompt).toContain('CLAUDE.md');
      expect(prompt).toContain('one Node process owns Telegram polling');
      expect(prompt).toContain('17-cockpit-redesign');
      expect(prompt).toContain('Product, Project, Bug, Idea, Run, and Chat');
      expect(prompt).toContain('product-tailored-system-prompt');
      expect(prompt).toContain('world-view/ai.md');
      expect(prompt).toContain('Operator cockpits should preserve human judgment');
    });

    it('routes product chat search by subject: code and project work to the active repo, people and concepts to the KB', () => {
      const prompt = buildSessionSystemPrompt({
        scope: runeScope,
        productContext: runeContext,
        workspaceDir: '/workspace',
      });

      expect(prompt).toMatch(/code\/project questions route to (?:the )?(?:active )?product repo/i);
      expect(prompt).toMatch(/concept\/people questions route to (?:the )?(?:KB|knowledge base|kb_query)/i);
    });

    it('keeps global sessions on the generic prompt and does not leak product context', () => {
      const prompt = buildSessionSystemPrompt({
        scope: { kind: 'global' },
        productContext: runeContext,
        workspaceDir: '/workspace',
      });

      expect(prompt).toContain('second-brain conversational layer');
      expect(prompt).not.toContain('one Node process owns Telegram polling');
      expect(prompt).not.toContain('product-tailored-system-prompt');
      expect(prompt).not.toContain('Operator cockpits should preserve human judgment');
    });

    it('presents the product repo as the working repo and drops the vault-as-working-dir identity', () => {
      const prompt = buildSessionSystemPrompt({
        scope: runeScope,
        productContext: runeContext,
        workspaceDir: '/workspace',
      });

      // Rune introduces itself as the product's dev agent, working in the product repo.
      expect(prompt).toMatch(/development agent for[^\n]*\brune\b/i);
      expect(prompt).toMatch(/working repo/i);
      expect(prompt).toContain('/workspace/rune');

      // The global vault-centric identity must NOT leak into a product chat —
      // this is the bug: Rune called the vault its primary working repo.
      expect(prompt).not.toContain('second-brain conversational layer');
      expect(prompt).not.toMatch(/working directory is their Obsidian vault/i);
      // The bald global "Never write files." blanket is gone for product chats.
      expect(prompt).not.toContain('Never write files.');
    });

    it('frames the second brain as read-only via the rune-kb MCP, not as the working directory', () => {
      const prompt = buildSessionSystemPrompt({
        scope: runeScope,
        productContext: runeContext,
        workspaceDir: '/workspace',
      });

      expect(prompt).toMatch(/rune-kb/);
      expect(prompt).toMatch(/read-only/i);
      // Explicitly never writes the vault from chat.
      expect(prompt).toMatch(/never write[^\n]*vault|vault[^\n]*(read-only|never)/i);
    });

    it('states scoped edit + raw Bash capability honestly with full product authority', () => {
      const prompt = buildSessionSystemPrompt({
        scope: runeScope,
        productContext: runeContext,
        workspaceDir: '/workspace',
        authority: 'product-full-access' as const,
      });

      // Can read, edit, and run code in the repo.
      expect(prompt).toMatch(/\bedit\b/i);
      expect(prompt).toContain('Edit');
      expect(prompt).toContain('Write');
      expect(prompt).toContain('Bash');
      expect(prompt).toMatch(/run|build|test/i);
      // The prompt must state honestly that tools are NOT OS-confined — the
      // boundary is an explicit instruction, not harness enforcement.
      expect(prompt).toMatch(/not OS-confined|not.*confined/i);
      // Must forbid writing the vault / outside the repo via ANY tool (incl. Bash).
      expect(prompt).toMatch(/write only inside this product's repo|never[^\n]*vault/i);
      // Must forbid reading/printing Rune's own secrets (new boundary).
      expect(prompt).toMatch(/secrets/i);
      // Vault remains read-only even when the repo is writable.
      expect(prompt).toMatch(/read-only/i);
    });

    it('tells scoped products their editable workspace is the scoped subdirectory', () => {
      const prompt = buildSessionSystemPrompt({
        scope: { kind: 'product', product: 'writing' },
        productContext: {
          ...runeContext,
          product: 'writing',
          repoPath: '/workspace/site',
          scopePath: 'docs/rune',
        },
        workspaceDir: '/workspace',
        authority: 'product-full-access',
      });

      expect(prompt).toContain('Your working repo is /workspace/site (focused on docs/rune).');
      expect(prompt).toContain('Your editable product workspace is /workspace/site/docs/rune.');
    });

    it('keeps read-and-reason language (no edit claim) with read-only authority', () => {
      const prompt = buildSessionSystemPrompt({
        scope: runeScope,
        productContext: runeContext,
        workspaceDir: '/workspace',
      });
      expect(prompt).toMatch(/read and reason/i);
      expect(prompt).not.toContain('Read/Edit/Write');
    });

    it('describes unresolved product workspace authority without claiming a resolved repo or diagnostics', () => {
      const prompt = buildSessionSystemPrompt({
        scope: { kind: 'product', product: 'unknown' },
        productContext: {
          product: 'unknown',
          repoPath: '/stale/product/repo',
          repoDocs: [{ path: 'README.md', content: 'stale repo context' }],
          projects: [],
          worldview: [],
        },
        workspaceDir: '/workspace',
        authority: 'product-workspace-write',
      });

      expect(prompt).toContain('dedicated fallback workspace /workspace');
      expect(prompt).toContain('Read/Edit/Write/Bash');
      expect(prompt).toMatch(/constrained unresolved-product scratch workspace/i);
      expect(prompt).toMatch(/not authority over a resolved product repository/i);
      expect(prompt).toMatch(/do not use or claim product-scoped Cockpit or rune-kb diagnostics/i);
      expect(prompt).toMatch(/no vault or rune-kb tools/i);
      expect(prompt).not.toMatch(/full filesystem access|not OS-confined/i);
      expect(prompt).not.toContain('Your working repo is this product');
      expect(prompt).not.toContain('/stale/product/repo');
      expect(prompt).not.toContain('stale repo context');
      expect(prompt).not.toContain('kb_query first');
      expect(prompt).not.toContain('code/this-repo → repo tools');
    });

    it('fails closed instead of grounding one product chat with another product context', () => {
      const auraContext: ProductPromptContext = {
        ...runeContext,
        product: 'aura',
        repoPath: '/workspace/aura',
        repoDocs: [{ path: 'README.md', content: 'Aura-only billing dashboard context.' }],
      };

      expect(() => buildSessionSystemPrompt({
        scope: runeScope,
        productContext: auraContext,
        workspaceDir: '/workspace',
      })).toThrow(/rune|aura|product context|scope/i);
    });

    it('loads runnable chat context for rune-mcp, writing, and brand from product policy', () => {
      const { runeRepo, siteRepo } = writeProductChatFixture();
      const realRuneRepo = realpathSync(runeRepo);
      const realSiteRepo = realpathSync(siteRepo);

      const runeMcpPrompt = buildSessionSystemPrompt({
        scope: { kind: 'product', product: 'rune-mcp' },
        workspaceDir,
      });
      expect(runeMcpPrompt).toMatch(/active product:\s*rune-mcp/i);
      expect(runeMcpPrompt).toContain(`Product repo: ${realRuneRepo}`);
      expect(runeMcpPrompt).toContain('RUNE_MCP_REPO_CONTEXT');
      expect(runeMcpPrompt).toContain('RUNE_MCP_PROJECT_CONTEXT');
      expect(runeMcpPrompt).not.toContain('BRAND_ROOT_CONTEXT');
      expect(runeMcpPrompt).not.toContain('WRITING_SCOPED_CONTEXT');

      const writingPrompt = buildSessionSystemPrompt({
        scope: { kind: 'product', product: 'writing' },
        workspaceDir,
      });
      expect(writingPrompt).toMatch(/active product:\s*writing/i);
      expect(writingPrompt).toContain(`Product repo: ${realSiteRepo}`);
      expect(writingPrompt).toContain('WRITING_SCOPED_CONTEXT');
      expect(writingPrompt).toContain('WRITING_PROJECT_CONTEXT');
      expect(writingPrompt).not.toContain('BRAND_ROOT_CONTEXT');
      expect(writingPrompt).not.toContain('BRAND_PROJECT_CONTEXT');

      const brandPrompt = buildSessionSystemPrompt({
        scope: { kind: 'product', product: 'brand' },
        workspaceDir,
      });
      expect(brandPrompt).toMatch(/active product:\s*brand/i);
      expect(brandPrompt).toContain(`Product repo: ${realSiteRepo}`);
      expect(brandPrompt).toContain('BRAND_ROOT_CONTEXT');
      expect(brandPrompt).toContain('BRAND_PROJECT_CONTEXT');
      expect(brandPrompt).not.toContain('WRITING_SCOPED_CONTEXT');
      expect(brandPrompt).not.toContain('WRITING_PROJECT_CONTEXT');
    });
  });

  describe('resolveProductChat', () => {
    it('returns repoRoot and workRoot for a configured product', () => {
      const { runeRepo, siteRepo } = writeProductChatFixture();
      const realRuneRepo = realpathSync(runeRepo);
      const realSiteRepo = realpathSync(siteRepo);
      expect(resolveProductChat('rune-mcp')?.workspace).toEqual({ repoRoot: realRuneRepo, workRoot: realRuneRepo });
      expect(resolveProductChat('writing')?.workspace).toEqual({
        repoRoot: realSiteRepo,
        workRoot: realpathSync(join(siteRepo, 'docs/rune')),
        scopePath: 'docs/rune',
      });
    });

    it('returns null for an unknown product', () => {
      writeProductChatFixture();
      expect(resolveProductChat('does-not-exist')).toBeNull();
    });

    it('returns null for a configured product whose repository is missing', () => {
      writeProductChatFixture();
      const productConfig = JSON.parse(readFileSync(productsConfigFile, 'utf8')) as Record<string, unknown>;
      productConfig['stale'] = {
        class: 'internal',
        repoPath: join(tmpDir, 'missing-repo'),
        baseBranch: 'main',
        credentialsFile: join(tmpDir, 'creds', 'stale.env'),
        egressAllowlist: [],
      };
      writeFileSync(productsConfigFile, JSON.stringify(productConfig));
      expect(resolveProductChat('stale')).toBeNull();
    });

    it('returns null when a configured scope directory is missing', () => {
      const { siteRepo } = writeProductChatFixture();
      const productConfig = JSON.parse(readFileSync(productsConfigFile, 'utf8')) as Record<string, unknown>;
      productConfig['stale-scope'] = {
        class: 'external',
        repoPath: siteRepo,
        scopePath: 'docs/missing',
        baseBranch: 'main',
        credentialsFile: join(tmpDir, 'creds', 'stale-scope.env'),
        egressAllowlist: [],
      };
      writeFileSync(productsConfigFile, JSON.stringify(productConfig));
      expect(resolveProductChat('stale-scope')).toBeNull();
    });

    it.each(['/absolute/scope', '../outside'])(
      'rejects a configured scope path that is not repo-relative: %s',
      (scopePath) => {
        const { siteRepo } = writeProductChatFixture();
        const productConfig = JSON.parse(readFileSync(productsConfigFile, 'utf8')) as Record<string, unknown>;
        productConfig['invalid-scope'] = {
          class: 'external',
          repoPath: siteRepo,
          scopePath,
          baseBranch: 'main',
          credentialsFile: join(tmpDir, 'creds', 'invalid-scope.env'),
          egressAllowlist: [],
        };
        writeFileSync(productsConfigFile, JSON.stringify(productConfig));
        expect(resolveProductChat('invalid-scope')).toBeNull();
      },
    );

    it('rejects a configured scope directory that resolves outside the product repo', () => {
      const { siteRepo } = writeProductChatFixture();
      const outside = join(tmpDir, 'outside-product-scope');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'README.md'), 'OUTSIDE_SCOPE_SECRET');
      symlinkSync(outside, join(siteRepo, 'linked-scope'), 'dir');
      const productConfig = JSON.parse(readFileSync(productsConfigFile, 'utf8')) as Record<string, unknown>;
      productConfig['symlink-scope'] = {
        class: 'external',
        repoPath: siteRepo,
        scopePath: 'linked-scope',
        baseBranch: 'main',
        credentialsFile: join(tmpDir, 'creds', 'symlink-scope.env'),
        egressAllowlist: [],
      };
      writeFileSync(productsConfigFile, JSON.stringify(productConfig));
      expect(resolveProductChat('symlink-scope')).toBeNull();
      const prompt = buildSessionSystemPrompt({
        scope: { kind: 'product', product: 'symlink-scope' },
        authority: 'product-full-access',
      });
      expect(prompt).not.toContain('OUTSIDE_SCOPE_SECRET');
    });
  });

  describe('resolveProductFallbackWorkspace', () => {
    it('provisions a dedicated real directory outside workspace, vault, and product repos', () => {
      writeProductChatFixture();
      const fallback = resolveProductFallbackWorkspace('unknown');
      expect(fallback.repoRoot).toBe(fallback.workRoot);
      expect(fallback.repoRoot.startsWith(realpathSync(fallbackRoot))).toBe(true);
      expect(existsSync(fallback.repoRoot)).toBe(true);
      expect(fallback.repoRoot.startsWith(workspaceDir)).toBe(false);
      expect(fallback.repoRoot.startsWith(vaultDir)).toBe(false);
    });

    it('fails before provisioning when the configured fallback root overlaps a product repo', () => {
      const { runeRepo } = writeProductChatFixture();
      const productConfig = JSON.parse(readFileSync(productsConfigFile, 'utf8')) as Record<string, any>;
      productConfig['fallback-root-collision'] = {
        class: 'internal',
        repoPath: fallbackRoot,
        baseBranch: 'main',
        credentialsFile: join(tmpDir, 'creds', 'collision.env'),
        egressAllowlist: [],
      };
      writeFileSync(productsConfigFile, JSON.stringify(productConfig));
      expect(() => resolveProductFallbackWorkspace('collision')).toThrow(/overlaps protected product/i);
      const collisionWorkspace = join(
        fallbackRoot,
        createHash('sha256').update('collision').digest('hex').slice(0, 20),
      );
      expect(existsSync(collisionWorkspace)).toBe(false);
      expect(existsSync(runeRepo)).toBe(true);
    });
  });

  describe('appendMessageToSession', () => {
    it('appends a user message to an existing session', () => {
      createSession(123, 'telegram', 'hello');
      appendMessageToSession(123, 'telegram', 'user', 'hello world');
      const messages = getSessionMessages(123, 'telegram');
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe('user');
      expect(messages[0]!.text).toBe('hello world');
    });

    it('appends an assistant message', () => {
      createSession(123, 'telegram', 'hi');
      appendMessageToSession(123, 'telegram', 'assistant', 'Hello there!');
      const messages = getSessionMessages(123, 'telegram');
      expect(messages[0]!.role).toBe('assistant');
      expect(messages[0]!.text).toBe('Hello there!');
    });

    it('appends multiple messages in order', () => {
      createSession(123, 'telegram', 'first');
      appendMessageToSession(123, 'telegram', 'user', 'msg 1');
      appendMessageToSession(123, 'telegram', 'assistant', 'reply 1');
      appendMessageToSession(123, 'telegram', 'user', 'msg 2');
      const messages = getSessionMessages(123, 'telegram');
      expect(messages).toHaveLength(3);
      expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(messages.map(m => m.text)).toEqual(['msg 1', 'reply 1', 'msg 2']);
    });

    it('records a timestamp (ts) on each message', () => {
      createSession(123, 'telegram', 'hi');
      appendMessageToSession(123, 'telegram', 'user', 'timestamped');
      const ts = getSessionMessages(123, 'telegram')[0]!.ts;
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('is a no-op when no session exists for chatId', () => {
      expect(() => appendMessageToSession(999, 'telegram', 'user', 'ghost')).not.toThrow();
      expect(getSessionMessages(999, 'telegram')).toHaveLength(0);
    });
  });

  describe('getSessionMessages', () => {
    it('returns empty array when no session exists', () => {
      expect(getSessionMessages(999, 'telegram')).toEqual([]);
    });

    it('returns empty array for a fresh session with no appended messages', () => {
      createSession(123, 'telegram', 'hello');
      expect(getSessionMessages(123, 'telegram')).toEqual([]);
    });

    it('reflects messages appended after session creation', () => {
      createSession(123, 'telegram', 'hello');
      appendMessageToSession(123, 'telegram', 'user', 'first');
      appendMessageToSession(123, 'telegram', 'assistant', 'second');
      expect(getSessionMessages(123, 'telegram')).toHaveLength(2);
    });

    it('returns empty array after session is deleted', () => {
      createSession(123, 'telegram', 'hello');
      appendMessageToSession(123, 'telegram', 'user', 'something');
      deleteSession(123, 'telegram');
      expect(getSessionMessages(123, 'telegram')).toHaveLength(0);
    });
  });

  describe('persistence', () => {
    it('creates new sessions with the Terra default and no executor thread yet', () => {
      const session = createSession(123, 'telegram', 'test');
      expect(session.model).toBe('gpt-5.6-terra');
      expect(session.executor).toBeNull();
      setSessionExecutor(123, 'telegram', { format: 'codex', sessionId: 'thread-1' });
      expect(getSession(123, 'telegram')?.executor).toEqual({ format: 'codex', sessionId: 'thread-1' });
    });

    it('round-trips a scoped Codex executor posture through persistence and restore', () => {
      const scope = { kind: 'product' as const, product: 'writing' };
      createSession(123, 'webview', 'test', undefined, scope);
      const executor = {
        format: 'codex' as const,
        sessionId: 'writing-scope-thread',
        authority: 'product-full-access' as const,
        cwd: '/workspace/writing',
        writableRoot: '/workspace/writing/docs/rune',
      };

      setSessionExecutor(123, 'webview', executor, scope);
      expect(getSession(123, 'webview', scope)?.executor).toEqual(executor);

      persistSessions();
      const persisted = readFileSync(sessionsFile, 'utf8');
      deleteSession(123, 'webview', scope);
      expect(getSession(123, 'webview', scope)).toBeNull();

      writeFileSync(sessionsFile, persisted);
      restoreSessions();
      expect(getSession(123, 'webview', scope)?.executor).toEqual(executor);
    });

    it('round-trips fallback workspace authority through persistence and restore', () => {
      const scope = { kind: 'product' as const, product: 'unknown' };
      createSession(124, 'webview', 'test', undefined, scope);
      const executor = {
        format: 'codex' as const,
        sessionId: 'fallback-thread',
        authority: 'product-workspace-write' as const,
        cwd: workspaceDir,
        writableRoot: workspaceDir,
      };

      setSessionExecutor(124, 'webview', executor, scope);
      persistSessions();
      const persisted = readFileSync(sessionsFile, 'utf8');
      deleteSession(124, 'webview', scope);
      writeFileSync(sessionsFile, persisted);
      restoreSessions();

      expect(getSession(124, 'webview', scope)?.executor).toEqual(executor);
    });

    it('writes sessions to disk on create', () => {
      createSession(123, 'telegram', 'test');
      expect(existsSync(sessionsFile)).toBe(true);
    });

    it('restores sessions from file', () => {
      const data = [['telegram:123', {
        sessionId: 'restored-uuid',
        lastActivity: '2026-04-07T12:00:00Z',
        messageCount: 5,
        firstMessage: 'restored',
      }]];
      writeFileSync(sessionsFile, JSON.stringify(data));
      restoreSessions();
      const session = getSession(123, 'telegram');
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe('restored-uuid');
      expect(session!.messageCount).toBe(5);
    });

    it('migrates legacy numeric-keyed entries to telegram:<n>', () => {
      // Legacy format: `[number, Session][]` with no transport prefix.
      const data = [[123, {
        sessionId: 'legacy-uuid',
        lastActivity: '2026-04-07T12:00:00Z',
        messageCount: 3,
        firstMessage: 'legacy',
      }]];
      writeFileSync(sessionsFile, JSON.stringify(data));
      restoreSessions();
      expect(getSession(123, 'telegram')!.sessionId).toBe('legacy-uuid');
      expect(getSession(123, 'webview')).toBeNull();

      // After restore, the file should be rewritten in the new format.
      const persisted = JSON.parse(readFileSync(sessionsFile, 'utf8')) as [string, unknown][];
      expect(persisted.map(([k]) => k)).toEqual(['telegram:123']);
    });

    it('handles corrupt file gracefully', () => {
      writeFileSync(sessionsFile, 'not json!!!');
      expect(() => restoreSessions()).not.toThrow();
    });

    it('handles missing file gracefully', () => {
      if (existsSync(sessionsFile)) unlinkSync(sessionsFile);
      expect(() => restoreSessions()).not.toThrow();
    });
  });
});
