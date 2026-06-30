import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type ProductsPolicy = Record<string, {
  repoPath?: string;
}>;

const PRODUCTS_JSON = fileURLToPath(new URL('../../policies/products.json', import.meta.url));
const V1_TOPIC = 'Operating from memory';
const V1_SLUG = 'operating-from-memory';
const V1_BRANCH = `rune-writing/${V1_SLUG}`;

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/')
    ? join(homedir(), path.slice(2))
    : path;
}

function michaelcjosephRepo(): string {
  const policy = JSON.parse(readFileSync(PRODUCTS_JSON, 'utf8')) as ProductsPolicy;
  const writingRepo = policy['writing']?.repoPath;

  expect(writingRepo, 'writing.repoPath must point at michaelcjoseph.com').toBeTruthy();
  return expandHome(writingRepo!);
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function expectCommittedFile(repo: string, branch: string, path: string): string {
  const objectName = `${branch}:${path}`;
  expect(() => git(repo, ['cat-file', '-e', objectName]), `${path} must be committed on ${branch}`).not.toThrow();
  return git(repo, ['show', objectName]);
}

describe('writing-v1-artifacts (project 19 Phase 6 acceptance)', () => {
  it('commits the v1 /rune and /rune/{topic} artifacts on the writing acceptance branch', () => {
    const repo = michaelcjosephRepo();

    expect(() => git(repo, ['rev-parse', '--verify', V1_BRANCH]), `${V1_BRANCH} branch must exist`).not.toThrow();

    const runeIndex = expectCommittedFile(repo, V1_BRANCH, 'src/app/rune/page.tsx');
    const topicRoute = expectCommittedFile(repo, V1_BRANCH, 'src/app/rune/[slug]/page.tsx');
    const registry = expectCommittedFile(repo, V1_BRANCH, 'src/app/rune/_content/index.ts');
    const topicArtifact = expectCommittedFile(repo, V1_BRANCH, `docs/rune/${V1_SLUG}.md`);
    const voiceGuidelines = expectCommittedFile(repo, V1_BRANCH, 'docs/rune/writing-voice.md');
    const writingIdeas = expectCommittedFile(repo, V1_BRANCH, 'docs/rune/writing-ideas.md');

    expect(runeIndex).toMatch(/Rune/);
    expect(topicRoute).toMatch(/slug/);
    expect(registry).toContain(V1_SLUG);
    expect(topicArtifact).toMatch(new RegExp(`#\\s+${V1_TOPIC}`, 'i'));
    expect(voiceGuidelines).toContain('# Writing Voice');
    expect(writingIdeas).toMatch(/^- \[[ x]\] .+/m);
  });
});
