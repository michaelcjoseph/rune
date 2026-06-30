/**
 * Test suite for `src/mcp/tools/read-tools.ts` — project 16-claude-app-connector,
 * Phase 1, test-plan.md §5 "Read tools trio".
 *
 * Written TEST-FIRST: the implementation module does not exist yet.
 * Every test in this file is expected to be RED until the implementation lands.
 *
 * Contracts:
 *   vaultSearch(input: VaultSearchInput, deps: VaultSearchDeps): Promise<McpTextResult>
 *   crmLookup(input: CrmLookupInput, deps: CrmLookupDeps): Promise<McpTextResult>
 *   getPriorities(deps: GetPrioritiesDeps): Promise<McpTextResult>
 *
 * Mechanics:
 *   - Dynamic import via computed specifier defeats tsc's static resolution so
 *     the file is tsc-clean before the module exists.
 *   - Every test calls requireReadToolsModule() which fails with a clean
 *     "implementation pending" message when the module is absent — never an
 *     import crash.
 *   - deps use plain vi.fn() fakes — no real fs, no vault.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Local structural types — mirror the future module's public surface so the
// test file is tsc-clean today while the implementation module does not exist.
// These are CASTING ONLY; they must stay in sync with the final module types.
// ---------------------------------------------------------------------------

interface McpTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

interface VaultSearchInput {
  query: string;
  /** Project 19 cutover: optional top-level vault folder prefixes. */
  types?: string[];
  maxResults?: number;
}

interface SearchResult {
  file: string;
  line: number;
  content: string;
}

interface VaultSearchDeps {
  searchVault: (
    query: string,
    options?: { directory?: string; maxResults?: number },
  ) => SearchResult[];
}

interface CrmLookupInput {
  name: string;
}

interface CrmLookupDeps {
  readVaultFile: (rel: string) => string | null;
}

interface GetPrioritiesDeps {
  readVaultFile: (rel: string) => string | null;
  getTodayFilename: () => string;
  getYesterdayFilename: () => string;
}

type VaultSearchFn = (
  input: VaultSearchInput,
  deps: VaultSearchDeps,
) => Promise<McpTextResult>;

type CrmLookupFn = (
  input: CrmLookupInput,
  deps: CrmLookupDeps,
) => Promise<McpTextResult>;

type GetPrioritiesFn = (deps: GetPrioritiesDeps) => Promise<McpTextResult>;

// ---------------------------------------------------------------------------
// Dynamic import — computed specifier bypasses tsc static resolution.
// ---------------------------------------------------------------------------

const IMPL_PENDING =
  'src/mcp/tools/read-tools.ts not implemented yet — implementation pending';

async function loadReadToolsModule(): Promise<Record<string, unknown> | null> {
  const specifier = './read-tools' + '.js';
  try {
    return (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Load the module and return a typed handle, or fail THIS test with a clean
 *  "implementation pending" message. Called per-test so each red is an
 *  isolated, descriptive assertion failure — never an import crash. */
async function requireReadToolsModule(): Promise<{
  vaultSearch: VaultSearchFn;
  crmLookup: CrmLookupFn;
  getPriorities: GetPrioritiesFn;
}> {
  const mod = await loadReadToolsModule();
  if (
    !mod ||
    typeof mod.vaultSearch !== 'function' ||
    typeof mod.crmLookup !== 'function' ||
    typeof mod.getPriorities !== 'function'
  ) {
    expect.fail(IMPL_PENDING);
  }
  return {
    vaultSearch: mod.vaultSearch as VaultSearchFn,
    crmLookup: mod.crmLookup as CrmLookupFn,
    getPriorities: mod.getPriorities as GetPrioritiesFn,
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Builds a minimal valid VaultSearchDeps bag. searchVault returns empty by
 *  default; individual tests override per-directory via mockImplementation. */
function makeVaultSearchDeps(
  overrides?: Partial<VaultSearchDeps>,
): VaultSearchDeps {
  return {
    searchVault: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

/** Builds a minimal valid CrmLookupDeps bag. */
function makeCrmDeps(overrides?: Partial<CrmLookupDeps>): CrmLookupDeps {
  return {
    readVaultFile: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

/** Builds a minimal valid GetPrioritiesDeps bag with safe defaults (no file
 *  content). Tests supply real journal text via readVaultFile overrides. */
function makePrioritiesDeps(
  overrides?: Partial<GetPrioritiesDeps>,
): GetPrioritiesDeps {
  return {
    readVaultFile: vi.fn().mockReturnValue(null),
    getTodayFilename: vi.fn().mockReturnValue('2026_06_10.md'),
    getYesterdayFilename: vi.fn().mockReturnValue('2026_06_09.md'),
    ...overrides,
  };
}

// Fixture: crm.json entries used across crm_lookup tests.
const CRM_FIXTURE_ARRAY = [
  { name: 'Ada Lovelace', company: 'Analytical Engines Ltd' },
  { name: 'Grace Hopper', company: 'Navy' },
];

/** Shared no-result phrasing accepted for BOTH the missing-crm.json and the
 *  no-match cases — one consistent implementation message passes both. */
const NO_CRM_RESULT_RE = /no\s.*(crm|match|result|data|entr|record)|not found/i;

// ---------------------------------------------------------------------------
// §5 Tests — vault_search
// ---------------------------------------------------------------------------

describe('vaultSearch — §5 vault_search tool (read-tools.ts)', () => {
  // -------------------------------------------------------------------------
  // Test 1 🔴 — default (no types): whole-vault warm-index call
  // -------------------------------------------------------------------------
  it('1: no types → searchVault called once without a directory filter; result text includes knowledge and a peripheral folder', async () => {
    const { vaultSearch } = await requireReadToolsModule();

    const fullVaultResults: SearchResult[] = [
      { file: 'knowledge/semantic-layer.md', line: 3, content: 'FULLCOVERAGE_MARKER in knowledge' },
      { file: 'world-view/beliefs.md', line: 7, content: 'FULLCOVERAGE_MARKER in peripheral folder' },
    ];

    const deps = makeVaultSearchDeps({
      searchVault: vi.fn().mockImplementation(
        (_q: string, opts?: { directory?: string; maxResults?: number }) => {
          if (opts?.directory === undefined) return fullVaultResults;
          return [];
        },
      ),
    });

    const result = await vaultSearch({ query: 'FULLCOVERAGE_MARKER' }, deps);

    expect(deps.searchVault).toHaveBeenCalledTimes(1);
    const [calledQuery, calledOptions] = vi.mocked(deps.searchVault).mock.calls[0]!;
    expect(calledQuery).toBe('FULLCOVERAGE_MARKER');
    expect(calledOptions?.directory).toBeUndefined();

    expect(result.isError).toBeFalsy();

    const text = result.content[0]!.text;
    expect(text).toContain('knowledge/semantic-layer.md:3');
    expect(text).toContain('FULLCOVERAGE_MARKER in knowledge');
    expect(text).toContain('world-view/beliefs.md:7');
    expect(text).toContain('FULLCOVERAGE_MARKER in peripheral folder');
    // em-dash separator used (mirrors kb_search in server.ts)
    expect(text).toMatch(/—/);
  });

  // -------------------------------------------------------------------------
  // Test 2 🔴 — types:['knowledge'] restricts by top-level folder prefix
  // -------------------------------------------------------------------------
  it('2: types:[\'knowledge\'] → searchVault called exactly once with directory \'knowledge\'; peripheral folders are not searched', async () => {
    const { vaultSearch } = await requireReadToolsModule();

    const deps = makeVaultSearchDeps({
      searchVault: vi.fn().mockReturnValue([
        { file: 'knowledge/topic.md', line: 1, content: 'just knowledge' },
      ]),
    });

    const result = await vaultSearch({ query: 'test', types: ['knowledge'] }, deps);

    expect(deps.searchVault).toHaveBeenCalledTimes(1);
    expect(deps.searchVault).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ directory: 'knowledge' }),
    );
    expect(result.isError).toBeFalsy();
  });

  // -------------------------------------------------------------------------
  // Test 3 🔴 — valid type strings narrow by folder prefix; unsafe strings are ignored
  // -------------------------------------------------------------------------
  it('3: mixed folder prefixes and unsafe values → searches only clean top-level folder prefixes', async () => {
    const { vaultSearch } = await requireReadToolsModule();

    const deps = makeVaultSearchDeps({
      searchVault: vi.fn().mockImplementation(
        (_q: string, opts?: { directory?: string; maxResults?: number }) => {
          if (opts?.directory === 'world-view') {
            return [
              {
                file: 'world-view/beliefs.md',
                line: 2,
                content: 'UNKNOWN_TYPE_MARKER still visible',
              },
            ];
          }
          return [];
        },
      ),
    });

    const result = await vaultSearch(
      {
        query: 'UNKNOWN_TYPE_MARKER',
        types: ['world-view', 'not-a-real-folder', '../escape', '/absolute'],
      },
      deps,
    );

    expect(deps.searchVault).toHaveBeenCalledTimes(2);
    expect(deps.searchVault).toHaveBeenNthCalledWith(
      1,
      'UNKNOWN_TYPE_MARKER',
      expect.objectContaining({ directory: 'world-view' }),
    );
    expect(deps.searchVault).toHaveBeenNthCalledWith(
      2,
      'UNKNOWN_TYPE_MARKER',
      expect.objectContaining({ directory: 'not-a-real-folder' }),
    );
    expect(vi.mocked(deps.searchVault).mock.calls).not.toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.any(String),
          expect.objectContaining({ directory: '../escape' }),
        ]),
      ]),
    );
    expect(vi.mocked(deps.searchVault).mock.calls).not.toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.any(String),
          expect.objectContaining({ directory: '/absolute' }),
        ]),
      ]),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('world-view/beliefs.md:2');
  });

  it('3b: only unsafe type values → ignores them and does not fall back to default whole-vault search', async () => {
    const { vaultSearch } = await requireReadToolsModule();
    const deps = makeVaultSearchDeps();

    const result = await vaultSearch(
      { query: 'UNKNOWN_ONLY_MARKER', types: ['../escape', '/absolute', ''] },
      deps,
    );

    expect(deps.searchVault).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe('No results found.');
  });

  // -------------------------------------------------------------------------
  // Test 4 🔴 — maxResults forwarded to searchVault options
  // -------------------------------------------------------------------------
  it('4: maxResults:5 is forwarded to the warm-index search call in options', async () => {
    const { vaultSearch } = await requireReadToolsModule();
    const deps = makeVaultSearchDeps();

    await vaultSearch({ query: 'x', maxResults: 5 }, deps);

    expect(deps.searchVault).toHaveBeenCalledTimes(1);
    for (const call of vi.mocked(deps.searchVault).mock.calls) {
      const opts = call[1];
      expect(opts).toMatchObject({ maxResults: 5 });
    }
  });

  // -------------------------------------------------------------------------
  // Test 5 🔴 — zero matches across the vault → 'No results found.'
  // -------------------------------------------------------------------------
  it('5: zero matches across the vault → text is exactly \'No results found.\', isError falsy', async () => {
    const { vaultSearch } = await requireReadToolsModule();
    const deps = makeVaultSearchDeps({
      searchVault: vi.fn().mockReturnValue([]),
    });

    const result = await vaultSearch({ query: 'nothing here' }, deps);

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe('No results found.');
  });

  // -------------------------------------------------------------------------
  // Test 6 🟡 — empty/missing query → isError true, searchVault not called
  // -------------------------------------------------------------------------
  it('6: empty query → isError true, searchVault never called', async () => {
    const { vaultSearch } = await requireReadToolsModule();
    const deps = makeVaultSearchDeps();

    const result = await vaultSearch({ query: '' }, deps);

    expect(result.isError).toBe(true);
    expect(deps.searchVault).not.toHaveBeenCalled();
  });
});

describe('vaultSearch — project 19 fullcoverage cutover source pins', () => {
  it('does not keep a closed default search-type allowlist or folder include/exclude config in read-tools.ts', () => {
    const source = readFileSync(new URL('./read-tools.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/\bALL_SEARCH_TYPES\b/);
    expect(source).not.toMatch(/['"]journals['"]\s*,\s*['"]pages['"]\s*,\s*['"]projects['"]/);
    expect(source).not.toMatch(
      /\b(?:SEARCH|VAULT_SEARCH)_(?:INCLUDE|EXCLUDE|ALLOW|DENY)(?:ED)?_(?:TYPES|FOLDERS|DIRECTORIES)\b/,
    );
  });

  it('binds production vault_search to queryVaultIndex with cold ripgrep only as the not-ready fallback', () => {
    const source = readFileSync(new URL('./read-tools-deps.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/\bqueryVaultIndex\b/);
    expect(source).toMatch(/\bgetVaultIndexStatus\b/);
    expect(source).toMatch(/\bsearchVault\b/);
    expect(source).toMatch(/from ['"]\.\.\/\.\.\/kb\/vault-index\.js['"]/);
    expect(source).toMatch(/from ['"]\.\.\/\.\.\/kb\/search\.js['"]/);
    expect(source).toMatch(/ready[\s\S]*\?[\s\S]*queryVaultIndex[\s\S]*:[\s\S]*searchVault|if\s*\([^)]*ready[^)]*\)[\s\S]*queryVaultIndex[\s\S]*searchVault/);
  });
});

// ---------------------------------------------------------------------------
// §5 Tests — crm_lookup
// ---------------------------------------------------------------------------

describe('crmLookup — §5 crm_lookup tool (read-tools.ts)', () => {
  // -------------------------------------------------------------------------
  // Test 6 🔴 — case-insensitive substring match returns the full record
  // -------------------------------------------------------------------------
  it('6: name \'ada\' (case-insensitive substring) matches \'Ada Lovelace\'; text contains Ada Lovelace AND Analytical Engines Ltd; does NOT contain Grace Hopper', async () => {
    const { crmLookup } = await requireReadToolsModule();

    const deps = makeCrmDeps({
      readVaultFile: vi.fn().mockReturnValue(JSON.stringify(CRM_FIXTURE_ARRAY)),
    });

    const result = await crmLookup({ name: 'ada' }, deps);

    expect(deps.readVaultFile).toHaveBeenCalledWith('pages/crm.json');
    expect(result.isError).toBeFalsy();

    const text = result.content[0]!.text;
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('Analytical Engines Ltd');
    expect(text).not.toContain('Grace Hopper');
  });

  // -------------------------------------------------------------------------
  // Test 7 🔴 — multiple matches both surface
  // -------------------------------------------------------------------------
  it('7: query matching multiple records → both names appear in text', async () => {
    const { crmLookup } = await requireReadToolsModule();

    // Both 'Ada' and 'Grace' contain 'a' — or use a more deliberate shared
    // substring. We add a third fixture that shares 'Tech' with a second to
    // make the multi-match intent unambiguous.
    const multiFixture = [
      { name: 'Alice Tech', company: 'TechCorp' },
      { name: 'Bob Tech', company: 'TechCorp' },
      { name: 'Carol Jones', company: 'Other' },
    ];

    const deps = makeCrmDeps({
      readVaultFile: vi.fn().mockReturnValue(JSON.stringify(multiFixture)),
    });

    const result = await crmLookup({ name: 'tech' }, deps);

    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('Alice Tech');
    expect(text).toContain('Bob Tech');
    expect(text).not.toContain('Carol Jones');
  });

  // -------------------------------------------------------------------------
  // Test 8 🟡 — missing crm.json → graceful empty result (NOT an error)
  // -------------------------------------------------------------------------
  it('8: readVaultFile returns null (missing crm.json) → isError FALSY, graceful no-result text', async () => {
    const { crmLookup } = await requireReadToolsModule();

    const deps = makeCrmDeps({
      readVaultFile: vi.fn().mockReturnValue(null),
    });

    const result = await crmLookup({ name: 'anyone' }, deps);

    expect(result.isError).toBeFalsy();
    // Same regex as test 9 so one consistent no-result phrasing passes both.
    expect(result.content[0]!.text).toMatch(NO_CRM_RESULT_RE);
  });

  // -------------------------------------------------------------------------
  // Test 9 🟡 — no match for the name → graceful
  // -------------------------------------------------------------------------
  it('9: name not found in crm.json → isError falsy, graceful no-result text', async () => {
    const { crmLookup } = await requireReadToolsModule();

    const deps = makeCrmDeps({
      readVaultFile: vi.fn().mockReturnValue(JSON.stringify(CRM_FIXTURE_ARRAY)),
    });

    const result = await crmLookup({ name: 'zzznobodyzzz' }, deps);

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toMatch(NO_CRM_RESULT_RE);
  });

  // -------------------------------------------------------------------------
  // Test 10 🟢 — malformed JSON → graceful empty result, no throw
  // -------------------------------------------------------------------------
  it('10: malformed JSON in crm.json → resolves with isError falsy, no throw', async () => {
    const { crmLookup } = await requireReadToolsModule();

    const deps = makeCrmDeps({
      readVaultFile: vi.fn().mockReturnValue('{ this is not valid json !!!'),
    });

    const result = await crmLookup({ name: 'anyone' }, deps);
    expect(result.isError).toBeFalsy();
    // The malformed-JSON path must still be human-readable, not empty.
    expect(result.content[0]!.text).toMatch(/\w/);
  });
});

// ---------------------------------------------------------------------------
// §5 Tests — get_priorities
// ---------------------------------------------------------------------------

describe('getPriorities — §5 get_priorities tool (read-tools.ts)', () => {
  // -------------------------------------------------------------------------
  // Test 11 🔴 — today's journal has #priorities block → returned
  // -------------------------------------------------------------------------
  it('11: today\'s journal has #priorities block → readVaultFile called with journals/2026_06_10.md; text contains both bullets; isError falsy', async () => {
    const { getPriorities } = await requireReadToolsModule();

    const todayContent = [
      '# 2026-06-10',
      '',
      '#priorities',
      '- ship the connector',
      '- review PR',
      '',
    ].join('\n');

    const deps = makePrioritiesDeps({
      readVaultFile: vi.fn().mockReturnValue(todayContent),
    });

    const result = await getPriorities(deps);

    expect(deps.readVaultFile).toHaveBeenCalledWith('journals/2026_06_10.md');
    expect(result.isError).toBeFalsy();

    const text = result.content[0]!.text;
    expect(text).toContain('ship the connector');
    expect(text).toContain('review PR');
  });

  // -------------------------------------------------------------------------
  // Test 12 🔴 — today lacks #priorities; fallback to yesterday
  //
  // SETTLED CONTRACT NOTE: the /priorities command defaults to YESTERDAY's
  // journal when called with no args. get_priorities deliberately departs:
  // it tries TODAY first and falls back to yesterday, because a mid-thread
  // App call wants the freshest priorities. The "mirrors /priorities" in
  // test-plan §5 refers to reusing the parseTag(#priorities) parsing, not the
  // command's day-resolution default. (Noted in test-plan.md §5.)
  // -------------------------------------------------------------------------
  it('12: today has no #priorities; yesterday does → readVaultFile called for yesterday; text contains yesterday\'s priorities', async () => {
    const { getPriorities } = await requireReadToolsModule();

    const todayContent = '# 2026-06-10\nNo priorities here.\n';
    const yesterdayContent = [
      '# 2026-06-09',
      '',
      '#priorities',
      '- fix the bug',
      '- deploy hotfix',
      '',
    ].join('\n');

    const deps = makePrioritiesDeps({
      readVaultFile: vi.fn().mockImplementation((rel: string) => {
        if (rel === 'journals/2026_06_10.md') return todayContent;
        if (rel === 'journals/2026_06_09.md') return yesterdayContent;
        return null;
      }),
    });

    const result = await getPriorities(deps);

    // Must have tried yesterday's journal
    expect(deps.readVaultFile).toHaveBeenCalledWith('journals/2026_06_09.md');
    expect(result.isError).toBeFalsy();

    const text = result.content[0]!.text;
    expect(text).toContain('fix the bug');
    expect(text).toContain('deploy hotfix');
  });

  // -------------------------------------------------------------------------
  // Test 13 🟡 — neither journal has priorities → graceful
  // -------------------------------------------------------------------------
  it('13: neither today nor yesterday has #priorities (readVaultFile returns null for both) → isError falsy, text matches /no priorities/i', async () => {
    const { getPriorities } = await requireReadToolsModule();

    const deps = makePrioritiesDeps({
      readVaultFile: vi.fn().mockReturnValue(null),
    });

    const result = await getPriorities(deps);

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toMatch(/no priorities/i);
  });
});

// ---------------------------------------------------------------------------
// §5 Test 14 🟢 — Shared-shape assertion across all three handlers
// ---------------------------------------------------------------------------

describe('Shared MCP text-content shape — all three read tools (read-tools.ts)', () => {
  it('14: each handler on a happy-path call returns exactly one {type:\'text\', text:string} content item with isError === false', async () => {
    const { vaultSearch, crmLookup, getPriorities } = await requireReadToolsModule();

    // vault_search happy path — returns one result
    const searchDeps = makeVaultSearchDeps({
      searchVault: vi.fn().mockReturnValue([
        { file: 'journals/2026_06_10.md', line: 1, content: 'hello world' },
      ]),
    });
    const searchResult = await vaultSearch({ query: 'hello' }, searchDeps);

    expect(Array.isArray(searchResult.content)).toBe(true);
    expect(searchResult.content).toHaveLength(1);
    expect(searchResult.content[0]).toMatchObject({ type: 'text' });
    expect(typeof searchResult.content[0]!.text).toBe('string');
    expect(searchResult.isError ?? false).toBe(false);

    // crm_lookup happy path — returns one match
    const crmDeps = makeCrmDeps({
      readVaultFile: vi.fn().mockReturnValue(
        JSON.stringify([{ name: 'Test Person', company: 'ACME' }]),
      ),
    });
    const crmResult = await crmLookup({ name: 'test' }, crmDeps);

    expect(Array.isArray(crmResult.content)).toBe(true);
    expect(crmResult.content).toHaveLength(1);
    expect(crmResult.content[0]).toMatchObject({ type: 'text' });
    expect(typeof crmResult.content[0]!.text).toBe('string');
    expect(crmResult.isError ?? false).toBe(false);

    // get_priorities happy path — today has #priorities
    const priorityContent = '#priorities\n- top task\n';
    const prioritiesDeps = makePrioritiesDeps({
      readVaultFile: vi.fn().mockReturnValue(priorityContent),
    });
    const prioritiesResult = await getPriorities(prioritiesDeps);

    expect(Array.isArray(prioritiesResult.content)).toBe(true);
    expect(prioritiesResult.content).toHaveLength(1);
    expect(prioritiesResult.content[0]).toMatchObject({ type: 'text' });
    expect(typeof prioritiesResult.content[0]!.text).toBe('string');
    expect(prioritiesResult.isError ?? false).toBe(false);
  });
});
