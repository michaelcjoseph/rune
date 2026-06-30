import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const warmIndexModuleRe =
  /(?:from\s*['"]|import\s*\(\s*['"])(?:\.\.\/kb\/vault-index|\.\/.*warm.*index).*\.js['"]/;
const warmIndexBuildCallRe = /\b(?:buildVaultIndex|refreshVaultIndex)\s*\(/;
const warmIndexQueryCallRe = /\bqueryVaultIndex\s*\(/;
const warmIndexOwnershipCallRe =
  /\b(?:buildVaultIndex|refreshVaultIndex|start[A-Za-z]*WarmIndex|create[A-Za-z]*WarmIndex)\s*\(/;

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function adminStdioLoadGraphSource(): string {
  return [
    './index.ts',
    './server.ts',
    '../kb/engine.ts',
    '../kb/query.ts',
  ].map(source).join('\n');
}

describe('kb_query/admin-stdio warm-index boundary', () => {
  it('keeps the local admin stdio load graph off the warm index entirely', () => {
    const stdioSource = source('./index.ts');
    const loadGraphSource = adminStdioLoadGraphSource();

    expect(stdioSource).toMatch(/createKBServer/);
    expect(stdioSource).toMatch(/initKB\s*\(\s*\)/);
    expect(loadGraphSource).not.toMatch(warmIndexModuleRe);
    expect(loadGraphSource).not.toMatch(warmIndexBuildCallRe);
    expect(loadGraphSource).not.toMatch(warmIndexQueryCallRe);
  });

  it('keeps the admin kb_query retrieval path on cold ripgrep, not queryVaultIndex', () => {
    const querySource = source('../kb/query.ts');

    expect(querySource).toMatch(/from ['"]\.\/search\.js['"]/);
    expect(querySource).toMatch(/\bsearchVault\s*\(/);
    expect(querySource).not.toMatch(warmIndexModuleRe);
    expect(querySource).not.toMatch(warmIndexBuildCallRe);
    expect(querySource).not.toMatch(warmIndexQueryCallRe);
  });

  it('puts warm-index ownership in the long-lived MCP daemon path only', () => {
    const daemonSource = source('./daemon.ts');
    const stdioSource = source('./index.ts');
    const querySource = source('../kb/query.ts');

    expect(daemonSource).toMatch(warmIndexModuleRe);
    expect(daemonSource).toMatch(warmIndexOwnershipCallRe);
    expect(adminStdioLoadGraphSource()).not.toMatch(warmIndexModuleRe);
    expect(stdioSource + querySource).not.toMatch(warmIndexBuildCallRe);
  });
});
