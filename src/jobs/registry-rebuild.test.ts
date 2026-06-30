import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanRegistrySources } from './registry-rebuild.js';
import { buildRegistry } from '../intent/registry.js';

/**
 * Build a fake multi-repo workspace on disk: a `products.json` plus per-product
 * repos with `docs/projects/<slug>/{index row, tasks.md}`. Exercises the scanner
 * end-to-end against real fs (mirrors the sandbox-runtime test convention).
 */
let root: string;

function repoIndex(rows: Array<{ slug: string; status: string }>): string {
  const header = '| Project | Status | Summary |\n|---|---|---|';
  const body = rows.map((r) => `| [${r.slug}](${r.slug}/spec.md) | ${r.status} | x |`).join('\n');
  return `# Projects\n\n${header}\n${body}\n`;
}

function makeProject(repo: string, slug: string, tasks: string | null) {
  const dir = join(repo, 'docs', 'projects', slug);
  mkdirSync(dir, { recursive: true });
  if (tasks !== null) writeFileSync(join(dir, 'tasks.md'), tasks, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rune-registry-scan-'));

  // rune: two projects, both with tasks.md
  const rune = join(root, 'rune');
  makeProject(rune, '01-mvp', '- [x] a\n- [x] b\n');
  makeProject(rune, '10-thing', '- [x] a\n- [ ] b\n- [ ] c\n');
  mkdirSync(join(rune, 'docs', 'projects'), { recursive: true });
  writeFileSync(
    join(rune, 'docs', 'projects', 'index.md'),
    repoIndex([{ slug: '01-mvp', status: 'Done' }, { slug: '10-thing', status: 'In Progress' }]),
    'utf8',
  );

  // aura: one project, no tasks.md (status only)
  const aura = join(root, 'aura');
  makeProject(aura, '01-core', null);
  writeFileSync(
    join(aura, 'docs', 'projects', 'index.md'),
    repoIndex([{ slug: '01-core', status: 'Planned' }]),
    'utf8',
  );

  // relay: repo exists but no docs/projects at all
  mkdirSync(join(root, 'relay'), { recursive: true });

  const productsJson = {
    rune: { class: 'internal', repoPath: rune, baseBranch: 'main', credentialsFile: '', egressAllowlist: [] },
    aura: { class: 'external', repoPath: aura, baseBranch: 'main', credentialsFile: '', egressAllowlist: [] },
    relay: { class: 'external', repoPath: join(root, 'relay'), baseBranch: 'main', credentialsFile: '', egressAllowlist: [] },
    // a product whose repo is absent on disk entirely
    ghost: { class: 'external', repoPath: join(root, 'does-not-exist'), baseBranch: 'main', credentialsFile: '', egressAllowlist: [] },
  };
  writeFileSync(join(root, 'products.json'), JSON.stringify(productsJson), 'utf8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scanRegistrySources', () => {
  it('scans every product in products.json', () => {
    const sources = scanRegistrySources(join(root, 'products.json'));
    expect(sources.products.map((p) => p.name).sort()).toEqual(['aura', 'ghost', 'relay', 'rune']);
  });

  it('copies product class from products.json into registry sources', () => {
    const sources = scanRegistrySources(join(root, 'products.json'));
    expect(Object.fromEntries(sources.products.map((p) => [p.name, p.class]))).toEqual({
      rune: 'internal',
      aura: 'external',
      relay: 'external',
      ghost: 'external',
    });
  });

  it('copies scopePath from products.json into registry sources for shared-repo products', () => {
    const sharedRepo = join(root, 'michaelcjoseph.com');
    mkdirSync(sharedRepo, { recursive: true });
    writeFileSync(
      join(root, 'products.json'),
      JSON.stringify({
        writing: {
          class: 'external',
          repoPath: sharedRepo,
          scopePath: 'docs/rune',
          baseBranch: 'main',
          credentialsFile: '',
          egressAllowlist: [],
        },
        brand: {
          class: 'external',
          repoPath: sharedRepo,
          baseBranch: 'main',
          credentialsFile: '',
          egressAllowlist: [],
        },
      }),
      'utf8',
    );

    const sources = scanRegistrySources(join(root, 'products.json'));

    const byName = Object.fromEntries(sources.products.map((p) => [p.name, p]));
    expect(byName['writing']!.scopePath).toBe('docs/rune');
    expect(byName['brand']!.scopePath).toBeUndefined();
  });

  it('builds a registry projection with product class and scopePath from products.json', () => {
    const sharedRepo = join(root, 'michaelcjoseph.com');
    mkdirSync(sharedRepo, { recursive: true });
    writeFileSync(
      join(root, 'products.json'),
      JSON.stringify({
        'rune-mcp': {
          class: 'internal',
          repoPath: join(root, 'rune'),
          baseBranch: 'main',
          credentialsFile: '',
          egressAllowlist: [],
        },
        writing: {
          class: 'external',
          repoPath: sharedRepo,
          scopePath: 'docs/rune',
          baseBranch: 'main',
          credentialsFile: '',
          egressAllowlist: [],
        },
      }),
      'utf8',
    );

    const registry = buildRegistry(scanRegistrySources(join(root, 'products.json')));

    expect(registry.products).toEqual([
      expect.objectContaining({ name: 'rune-mcp', class: 'internal' }),
      expect.objectContaining({
        name: 'writing',
        class: 'external',
        scopePath: 'docs/rune',
        projects: [],
      }),
    ]);
  });

  it('reads each repo index and per-project task progress', () => {
    const sources = scanRegistrySources(join(root, 'products.json'));
    const rune = sources.products.find((p) => p.name === 'rune')!;
    expect(rune.projectsIndex).toContain('10-thing');
    expect(rune.taskProgress).toEqual({
      '01-mvp': { done: 2, total: 2 },
      '10-thing': { done: 1, total: 3 },
    });
  });

  it('marks a product with no task files as having no progress entries', () => {
    const sources = scanRegistrySources(join(root, 'products.json'));
    const aura = sources.products.find((p) => p.name === 'aura')!;
    expect(aura.projectsIndex).toContain('01-core');
    expect(aura.taskProgress).toEqual({});
  });

  it('tolerates a repo with no docs/projects and a repo absent on disk', () => {
    const sources = scanRegistrySources(join(root, 'products.json'));
    const relay = sources.products.find((p) => p.name === 'relay')!;
    expect(relay.repoBacked).toBe(true);
    expect(relay.projectsIndex).toBeNull();
    expect(relay.taskProgress).toEqual({});

    const ghost = sources.products.find((p) => p.name === 'ghost')!;
    expect(ghost.repoBacked).toBe(false);
    expect(ghost.projectsIndex).toBeNull();
  });
});
