import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseIdeas } from '../intent/backlog-parser.js';

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

function readPkmsWritingFile(relativePath: string): string {
  return readFileSync(join(homedir(), 'workspace', 'pkms', 'writing', relativePath), 'utf8');
}

function expectDirectory(relativePath: string): void {
  const fullPath = join(michaelcjosephRepo(), relativePath);
  expect(existsSync(fullPath), `${relativePath} must exist in michaelcjoseph.com`).toBe(true);
  expect(statSync(fullPath).isDirectory(), `${relativePath} must be a directory`).toBe(true);
}

function normalizeTitle(value: string): string {
  return value
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function topicTitlesFromTopicsMarkdown(markdown: string): string[] {
  return markdown
    .split('\n')
    .map(line => /^- \*\*([^*]+)\*\*/.exec(line)?.[1] ?? null)
    .filter((title): title is string => title !== null)
    .map(normalizeTitle);
}

function publishedTitlesFromIndexMarkdown(markdown: string): string[] {
  const titles: string[] = [];
  let inPublished = false;
  for (const line of markdown.split('\n')) {
    if (/^## Published\b/.test(line)) {
      inPublished = true;
      continue;
    }
    if (inPublished && /^##\s+/.test(line)) break;
    const title = /\[\[([^\]]+)\]\]/.exec(line)?.[1];
    if (title) titles.push(normalizeTitle(title));
  }
  return titles;
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

  it('migrates forward-looking pkms topics into the writing ideas queue and leaves historical blog inventory behind', () => {
    const sourceTopicTitles = topicTitlesFromTopicsMarkdown(readPkmsWritingFile('topics.md'));
    expect(sourceTopicTitles.length, 'pkms writing/topics.md must have forward-looking topics to migrate').toBeGreaterThan(0);

    const writingIdeas = readRepoFile('docs/rune/writing-ideas.md');
    const parsed = parseIdeas(writingIdeas, 'docs/rune/writing-ideas.md');
    const migratedTitles = new Set(parsed.items.map(item => normalizeTitle(item.text)));
    const migratedTitleList = [...migratedTitles];

    expect(parsed.fileWarnings).toEqual([]);
    for (const title of sourceTopicTitles) {
      expect(migratedTitleList, `missing migrated writing topic: ${title}`).toContain(title);
    }

    expect(writingIdeas).not.toContain('## Published');
    expect(writingIdeas).not.toContain('published: [[');
    for (const historicalTitle of publishedTitlesFromIndexMarkdown(readPkmsWritingFile('index.md'))) {
      expect(migratedTitleList, `historical blog content should stay in pkms: ${historicalTitle}`).not.toContain(historicalTitle);
    }
  });
});
