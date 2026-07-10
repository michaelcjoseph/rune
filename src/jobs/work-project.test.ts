import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findWorkProjectDir, resolveLiveWorkProject } from './work-project.js';

const roots: string[] = [];

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeProject(repo: string, slug: string): string {
  const projectDir = join(repo, 'docs', 'projects', slug);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'spec.md'), '# Spec\n', 'utf8');
  return projectDir;
}

function writeProductsConfig(root: string, products: Record<string, unknown>): string {
  const path = join(root, 'products.json');
  writeFileSync(path, JSON.stringify(products), 'utf8');
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('work-project', () => {
  it('resolves an external product project from its configured git repo', () => {
    const root = makeRoot('work-project-external-');
    const runeRepo = join(root, 'rune');
    const externalRepo = join(root, 'brand');
    mkdirSync(runeRepo);
    mkdirSync(externalRepo);
    execFileSync('git', ['init', '-q', externalRepo]);
    const projectDir = writeProject(externalRepo, '01-rune-writing-product');
    const productsConfigPath = writeProductsConfig(root, {
      brand: { repoPath: externalRepo, baseBranch: 'main' },
    });

    expect(resolveLiveWorkProject({
      projectSlug: '01-rune-writing-product',
      product: 'brand',
      productsConfigPath,
      fallbackRoot: runeRepo,
    })).toEqual({ ok: true, projectDir });
  });

  it('keeps lifecycle projects at repo-root docs/projects when scopePath is configured', () => {
    const root = makeRoot('work-project-scope-');
    const repo = join(root, 'shared-repo');
    mkdirSync(repo);
    const projectDir = writeProject(repo, '01-writing');
    const productsConfigPath = writeProductsConfig(root, {
      writing: { repoPath: repo, scopePath: 'docs/rune', baseBranch: 'main' },
    });

    expect(resolveLiveWorkProject({
      projectSlug: 'writing',
      product: 'writing',
      productsConfigPath,
      fallbackRoot: join(root, 'rune'),
    })).toEqual({ ok: true, projectDir });
  });

  it('returns distinct failures for unknown products and malformed config', () => {
    const root = makeRoot('work-project-errors-');
    const validConfig = writeProductsConfig(root, {});
    const malformedConfig = join(root, 'malformed.json');
    writeFileSync(malformedConfig, '{not-json', 'utf8');

    expect(resolveLiveWorkProject({
      projectSlug: 'demo',
      product: 'missing',
      productsConfigPath: validConfig,
      fallbackRoot: root,
    })).toEqual({ ok: false, reason: 'unknown product: missing' });
    expect(resolveLiveWorkProject({
      projectSlug: 'demo',
      product: 'brand',
      productsConfigPath: malformedConfig,
      fallbackRoot: root,
    })).toEqual({ ok: false, reason: 'products config unavailable' });
  });

  it('finds the same repo-root project inside a created worktree', () => {
    const root = makeRoot('work-project-tree-');
    const projectDir = writeProject(root, '06-webview');
    expect(findWorkProjectDir('webview', root)).toBe(projectDir);
  });
});
