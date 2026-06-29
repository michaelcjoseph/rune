import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type ProductsPolicy = Record<string, {
  repoPath?: string;
  scopePath?: string;
}>;

const PRODUCTS_JSON = fileURLToPath(new URL('../../policies/products.json', import.meta.url));

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/')
    ? join(homedir(), path.slice(2))
    : path;
}

function michaelcjosephRepo(): string {
  const policy = JSON.parse(readFileSync(PRODUCTS_JSON, 'utf8')) as ProductsPolicy;
  const writingRepo = policy['writing']?.repoPath;
  const brandRepo = policy['brand']?.repoPath;

  expect(writingRepo, 'writing.repoPath must point at michaelcjoseph.com').toBeTruthy();
  expect(brandRepo, 'brand.repoPath must point at michaelcjoseph.com').toBe(writingRepo);

  return expandHome(writingRepo!);
}

function readRepoFile(relativePath: string): string {
  const fullPath = join(michaelcjosephRepo(), relativePath);
  expect(existsSync(fullPath), `${relativePath} must exist in michaelcjoseph.com`).toBe(true);
  return readFileSync(fullPath, 'utf8');
}

function expectDirectory(relativePath: string): void {
  const fullPath = join(michaelcjosephRepo(), relativePath);
  expect(existsSync(fullPath), `${relativePath} must exist in michaelcjoseph.com`).toBe(true);
  expect(statSync(fullPath).isDirectory(), `${relativePath} must be a directory`).toBe(true);
}

describe('michaelcjoseph-two-product-repo (project 19 Phase 6)', () => {
  it('preserves the Brand app as the root App Router page with the existing identity signals', () => {
    const rootPage = readRepoFile('src/app/page.tsx');

    expect(rootPage).toContain('export default function Home');
    expect(rootPage).toContain('michael');
    expect(rootPage).toContain('cjoseph');
    expect(rootPage).toContain('builder, investor, optimist');
    expect(rootPage).toContain('https://twitter.com/michaelcjoseph');
    expect(rootPage).toContain('https://github.com/michaelcjoseph');
    expect(existsSync(join(michaelcjosephRepo(), 'src/pages'))).toBe(false);
    expect(existsSync(join(michaelcjosephRepo(), 'src/app/brand/page.tsx'))).toBe(false);
  });

  it('adds Writing as an App Router /rune subtree without moving Brand off the root', () => {
    const runeIndex = readRepoFile('src/app/rune/page.tsx');
    const runeTopicPage = readRepoFile('src/app/rune/[slug]/page.tsx');

    expectDirectory('src/app/rune/_content');
    expect(runeIndex).toMatch(/export\s+default\s+function\s+\w+/);
    expect(runeTopicPage).toMatch(/export\s+default\s+(?:async\s+)?function\s+\w+/);
    expect(runeTopicPage).toContain('params');
    expect(existsSync(join(michaelcjosephRepo(), 'src/pages/rune'))).toBe(false);
  });

  it('keeps writing-owned content private to the /rune route folder and exposes a registry for topic pages', () => {
    const registry = readRepoFile('src/app/rune/_content/index.ts');
    const topicPage = readRepoFile('src/app/rune/[slug]/page.tsx');

    expect(registry).toMatch(/export\s+(const|function)\s+(runeWriting|writingPieces|writingContent|getWritingPiece)/);
    expect(registry).toMatch(/slug/);
    expect(topicPage).toMatch(/generateStaticParams|getWritingPiece|writingPieces|writingContent/);
    expect(topicPage).toContain('slug');
  });
});
