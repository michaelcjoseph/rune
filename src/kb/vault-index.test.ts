import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const vaultRoot = mkdtempSync(join(tmpdir(), 'rune-vault-index-'));
process.env['VAULT_DIR'] = vaultRoot;

const { buildVaultIndex, refreshVaultIndex, queryVaultIndex } = await import('./vault-index.js');

function writeVaultFile(relativePath: string, content: string): void {
  const fullPath = join(vaultRoot, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}

describe('kb/vault-index warm retrieval core', () => {
  beforeEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
    mkdirSync(vaultRoot, { recursive: true });
    buildVaultIndex();
  });

  afterAll(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('indexes markdown from every vault folder, including knowledge and peripheral folders', () => {
    writeVaultFile('knowledge/semantic.md', 'shared marker: WARM_FULL_VAULT_MARKER\n');
    writeVaultFile('world-view/beliefs.md', 'peripheral marker: WARM_FULL_VAULT_MARKER\n');
    writeVaultFile('journals/2026_06_29.md', 'journal marker: WARM_FULL_VAULT_MARKER\n');
    writeVaultFile('knowledge/ignored.txt', 'WARM_FULL_VAULT_MARKER should not be indexed\n');
    writeVaultFile('.git/config.md', 'WARM_FULL_VAULT_MARKER should not be indexed\n');

    buildVaultIndex();

    const files = queryVaultIndex('WARM_FULL_VAULT_MARKER').map((hit) => hit.file);
    expect(files).toEqual(expect.arrayContaining([
      'knowledge/semantic.md',
      'world-view/beliefs.md',
      'journals/2026_06_29.md',
    ]));
    expect(files).not.toContain('knowledge/ignored.txt');
    expect(files).not.toContain('.git/config.md');
  });

  it('treats empty folders as a no-op instead of an index failure', () => {
    mkdirSync(join(vaultRoot, 'library'), { recursive: true });

    expect(() => buildVaultIndex()).not.toThrow();
    expect(queryVaultIndex('anything')).toEqual([]);
  });

  it('skips unreadable markdown files but keeps indexing readable files', () => {
    writeVaultFile('knowledge/readable.md', 'VISIBLE_READABLE_MARKER survives\n');
    writeVaultFile('knowledge/unreadable.md', 'HIDDEN_UNREADABLE_MARKER should be skipped\n');
    const unreadablePath = join(vaultRoot, 'knowledge/unreadable.md');
    chmodSync(unreadablePath, 0o000);

    try {
      expect(() => buildVaultIndex()).not.toThrow();
      expect(queryVaultIndex('VISIBLE_READABLE_MARKER')).toEqual([
        { file: 'knowledge/readable.md', line: 1, content: 'VISIBLE_READABLE_MARKER survives' },
      ]);
      expect(queryVaultIndex('HIDDEN_UNREADABLE_MARKER')).toEqual([]);
    } finally {
      chmodSync(unreadablePath, 0o600);
    }
  });

  it('keeps the previous complete index when refresh cannot build a replacement', () => {
    writeVaultFile('knowledge/existing.md', 'ATOMIC_OLD_MARKER stays available\n');
    buildVaultIndex();

    rmSync(vaultRoot, { recursive: true, force: true });

    expect(() => refreshVaultIndex()).not.toThrow();
    expect(queryVaultIndex('ATOMIC_OLD_MARKER')).toEqual([
      { file: 'knowledge/existing.md', line: 1, content: 'ATOMIC_OLD_MARKER stays available' },
    ]);
  });

  it('matches case-insensitive regex queries and falls back to literal substring matching for invalid regex', () => {
    writeVaultFile('knowledge/search.md', [
      'Alpha    Beta matches a regex query',
      'literal[bracket falls back when the query is not valid regex',
    ].join('\n'));
    buildVaultIndex();

    expect(queryVaultIndex('alpha\\s+beta')).toEqual([
      { file: 'knowledge/search.md', line: 1, content: 'Alpha    Beta matches a regex query' },
    ]);
    expect(queryVaultIndex('literal[bracket')).toEqual([
      {
        file: 'knowledge/search.md',
        line: 2,
        content: 'literal[bracket falls back when the query is not valid regex',
      },
    ]);
  });

  it('filters results by vault-relative directory prefix without narrowing indexed coverage', () => {
    writeVaultFile('knowledge/topic.md', 'PREFIX_FILTER_MARKER from knowledge\n');
    writeVaultFile('world-view/topic.md', 'PREFIX_FILTER_MARKER from world-view\n');
    buildVaultIndex();

    expect(queryVaultIndex('PREFIX_FILTER_MARKER', { directory: 'knowledge' })).toEqual([
      { file: 'knowledge/topic.md', line: 1, content: 'PREFIX_FILTER_MARKER from knowledge' },
    ]);
    expect(queryVaultIndex('PREFIX_FILTER_MARKER')).toEqual(expect.arrayContaining([
      { file: 'knowledge/topic.md', line: 1, content: 'PREFIX_FILTER_MARKER from knowledge' },
      { file: 'world-view/topic.md', line: 1, content: 'PREFIX_FILTER_MARKER from world-view' },
    ]));
  });

  it('applies maxResults as an output cap only', () => {
    writeVaultFile('knowledge/a.md', 'MAX_RESULTS_MARKER a\n');
    writeVaultFile('world-view/b.md', 'MAX_RESULTS_MARKER b\n');
    writeVaultFile('journals/c.md', 'MAX_RESULTS_MARKER c\n');
    buildVaultIndex();

    expect(queryVaultIndex('MAX_RESULTS_MARKER')).toHaveLength(3);
    expect(queryVaultIndex('MAX_RESULTS_MARKER', { maxResults: 2 })).toHaveLength(2);
    expect(queryVaultIndex('MAX_RESULTS_MARKER', { directory: 'world-view', maxResults: 2 })).toEqual([
      { file: 'world-view/b.md', line: 1, content: 'MAX_RESULTS_MARKER b' },
    ]);
  });

  it('returns vault-relative file, one-based line, and line content for each hit', () => {
    writeVaultFile('knowledge/shape.md', [
      '# Shape',
      'SHAPE_MARKER appears on the second line',
      'tail',
    ].join('\n'));
    buildVaultIndex();

    expect(queryVaultIndex('shape_marker')).toEqual([
      { file: 'knowledge/shape.md', line: 2, content: 'SHAPE_MARKER appears on the second line' },
    ]);
  });
});
