import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureVaultRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/ripgrep-parity-vault',
);

process.env['VAULT_DIR'] = fixtureVaultRoot;

interface IndexedLine {
  file: string;
  line: number;
  content: string;
}

interface VaultIndexModule {
  buildVaultIndex: () => void;
  queryVaultIndex: (
    query: string,
    options?: { directory?: string; maxResults?: number },
  ) => IndexedLine[];
}

interface RipgrepCase {
  name: string;
  query: string;
  fixedStringFallback?: boolean;
  requiredPrefixes: string[];
}

const parityCases: RipgrepCase[] = [
  {
    name: 'knowledge coverage',
    query: 'PARITY_KNOWLEDGE_MARKER',
    requiredPrefixes: ['knowledge/'],
  },
  {
    name: 'journal mixed-case coverage',
    query: 'mixed_case_parity',
    requiredPrefixes: ['journals/'],
  },
  {
    name: 'peripheral folder coverage',
    query: 'PARITY_PERIPHERAL_SHARED',
    requiredPrefixes: ['world-view/', 'pages/'],
  },
  {
    name: 'escaped regex metacharacters',
    query: 'literal\\.token\\(42\\)',
    requiredPrefixes: ['knowledge/', 'world-view/'],
  },
  {
    name: 'invalid regex literal fallback',
    query: 'literal[unclosed',
    fixedStringFallback: true,
    requiredPrefixes: ['knowledge/', 'pages/'],
  },
];

async function requireVaultIndexModule(): Promise<VaultIndexModule> {
  const specifier = './vault-index' + '.js';
  const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  expect(typeof mod.buildVaultIndex).toBe('function');
  expect(typeof mod.queryVaultIndex).toBe('function');
  return mod as unknown as VaultIndexModule;
}

function normalizeFixturePath(pathText: string): string {
  const relativePath = isAbsolute(pathText)
    ? relative(fixtureVaultRoot, pathText)
    : pathText;
  return relativePath.split(sep).join('/');
}

function parseRipgrepJson(stdout: string): Set<string> {
  const hits = new Set<string>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as {
      type?: string;
      data?: {
        path?: { text?: string };
        line_number?: number;
      };
    };
    if (event.type !== 'match') continue;
    const pathText = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    if (!pathText || typeof lineNumber !== 'number') continue;
    hits.add(`${normalizeFixturePath(pathText)}:${lineNumber}`);
  }
  return hits;
}

function runRipgrep(query: string, fixedStrings = false): { status: number | null; stderr: string; hits: Set<string> } {
  const args = [
    '--json',
    '-i',
    '--glob',
    '*.md',
    ...(fixedStrings ? ['--fixed-strings'] : []),
    '--',
    query,
    fixtureVaultRoot,
  ];
  const result = spawnSync('rg', args, { encoding: 'utf8' });
  return {
    status: result.status,
    stderr: result.stderr,
    hits: result.status === 0 ? parseRipgrepJson(result.stdout) : new Set<string>(),
  };
}

function indexedPairs(hits: IndexedLine[]): Set<string> {
  return new Set(hits.map((hit) => `${hit.file}:${hit.line}`));
}

describe('kb/vault-index ripgrep parity harness', () => {
  it('keeps warm-index file+line coverage at least equal to real ripgrep over the fixture vault', async () => {
    expect(existsSync(fixtureVaultRoot), 'committed fixture vault must exist').toBe(true);
    const rgVersion = spawnSync('rg', ['--version'], { encoding: 'utf8' });
    expect(rgVersion.status, `real ripgrep must be available: ${rgVersion.stderr}`).toBe(0);

    const { buildVaultIndex, queryVaultIndex } = await requireVaultIndexModule();
    buildVaultIndex();

    for (const testCase of parityCases) {
      const regexRipgrep = runRipgrep(testCase.query);
      let expected = regexRipgrep.hits;

      if (testCase.fixedStringFallback) {
        expect(
          regexRipgrep.status,
          `${testCase.name} should prove the regex path is unsupported before fallback`,
        ).not.toBe(0);
        expected = runRipgrep(testCase.query, true).hits;
      } else {
        expect(
          regexRipgrep.status,
          `${testCase.name} rg failed: ${regexRipgrep.stderr}`,
        ).toBe(0);
      }

      for (const prefix of testCase.requiredPrefixes) {
        expect(
          [...expected].some((pair) => pair.startsWith(prefix)),
          `${testCase.name} fixture must include a ripgrep hit under ${prefix}`,
        ).toBe(true);
      }

      const actual = indexedPairs(queryVaultIndex(testCase.query, { maxResults: 10_000 }));
      const missing = [...expected].filter((pair) => !actual.has(pair));
      expect(missing, `${testCase.name} missing warm-index pairs`).toEqual([]);
    }
  });
});
