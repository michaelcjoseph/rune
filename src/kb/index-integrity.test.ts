import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { repairKnowledgeIndex } from './index-integrity.js';

const vaultRoot = mkdtempSync(join(tmpdir(), 'rune-index-integrity-'));

function writeVaultFile(relativePath: string, content: string): void {
  const fullPath = join(vaultRoot, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function readVaultFile(relativePath: string): string {
  return readFileSync(join(vaultRoot, relativePath), 'utf8');
}

describe('kb/index-integrity', () => {
  beforeEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
    mkdirSync(vaultRoot, { recursive: true });
  });

  afterAll(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('adds a missing entity wiki page under the Entities heading', () => {
    writeVaultFile('knowledge/index.md', ['# Knowledge Index', '', '## Entities', ''].join('\n'));
    writeVaultFile('knowledge/wiki/entities/alice.md', [
      '---',
      'last-verified: 2026-07-01',
      '---',
      '# Alice',
      '',
      'Alice is a fixture entity.',
      '',
    ].join('\n'));

    const result = repairKnowledgeIndex(vaultRoot);

    expect(result).toMatchObject({
      added: 1,
      addedPages: ['knowledge/wiki/entities/alice.md'],
    });
    expect(readVaultFile('knowledge/index.md')).toContain('## Entities\n\n- [[alice]] — Alice');
  });

  it('does not duplicate existing entries using basename or wiki path links', () => {
    writeVaultFile('knowledge/index.md', [
      '# Knowledge Index',
      '',
      '## Entities',
      '',
      '- [[alice]] — Existing basename link',
      '- [[wiki/entities/bob]] — Existing wiki path link',
      '',
    ].join('\n'));
    writeVaultFile('knowledge/wiki/entities/alice.md', '# Alice\n');
    writeVaultFile('knowledge/wiki/entities/bob.md', '# Bob\n');

    const result = repairKnowledgeIndex(vaultRoot);

    expect(result.added).toBe(0);
    expect(readVaultFile('knowledge/index.md').match(/\[\[alice\]\]/g)).toHaveLength(1);
    expect(readVaultFile('knowledge/index.md').match(/\[\[wiki\/entities\/bob\]\]/g)).toHaveLength(1);
  });

  it('places unknown wiki subdirectories under Other', () => {
    writeVaultFile('knowledge/index.md', '# Knowledge Index\n');
    writeVaultFile('knowledge/wiki/custom/foo.md', [
      'No H1 here.',
      '',
      'Foo is described by the first sentence. Extra detail follows.',
    ].join('\n'));

    const result = repairKnowledgeIndex(vaultRoot);
    const index = readVaultFile('knowledge/index.md');

    expect(result.added).toBe(1);
    expect(index).toContain('## Other');
    expect(index).toContain('- [[foo]] — No H1 here.');
  });

  it('is idempotent when run twice', () => {
    writeVaultFile('knowledge/index.md', '# Knowledge Index\n');
    writeVaultFile('knowledge/wiki/entities/alice.md', '# Alice\n');

    const first = repairKnowledgeIndex(vaultRoot);
    const afterFirst = readVaultFile('knowledge/index.md');
    const second = repairKnowledgeIndex(vaultRoot);

    expect(first.added).toBe(1);
    expect(second.added).toBe(0);
    expect(readVaultFile('knowledge/index.md')).toBe(afterFirst);
  });
});
