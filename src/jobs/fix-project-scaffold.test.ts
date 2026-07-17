import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BacklogItem } from '../intent/backlog-parser.js';
import type { BugScopingFacts } from './bug-fix-gate.js';

const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/logger.js', () => ({ createLogger: () => mockLog }));

import { scaffoldAndCommitFixProject } from './fix-project-scaffold.js';

const bug: BacklogItem = {
  id: 'BUG-save-crash',
  kind: 'bugs',
  text: 'Saving settings crashes the app',
  status: 'open',
  body: ['Repro: open Settings and select Save.'],
  source: { file: 'docs/projects/bugs.md', lineNumber: 1, raw: '- [ ] Saving settings crashes the app' },
  warnings: [],
};

const facts: BugScopingFacts = {
  itemEligible: true,
  fieldsComplete: true,
  pmAssessed: true,
  pmWellScoped: true,
  techLeadReviewed: true,
};

const tempRoots: string[] = [];

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'rune-fix-project-scaffold-'));
  tempRoots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 'rune-test@example.com']);
  git(repo, ['config', 'user.name', 'Rune Test']);
  writeFileSync(join(repo, 'README.md'), '# temporary fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-qm', 'initial']);
  return repo;
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('scaffoldAndCommitFixProject', () => {
  it('commits one deterministic one-task fix project without touching unrelated staged or dirty operator work', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'operator-staged.md'), 'do not commit\n');
    git(repo, ['add', 'operator-staged.md']);
    writeFileSync(join(repo, 'README.md'), '# operator dirty change\n');
    const operatorStatus = git(repo, ['status', '--porcelain']);

    const first = await scaffoldAndCommitFixProject({
      repoPath: repo,
      baseBranch: 'main',
      product: 'rune',
      bugId: bug.id,
      bug,
      facts,
    });

    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;
    expect(first.projectSlug).toMatch(/^\d{2,}-fix-bug-save-crash$/);
    expect(first.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const projectDir = join(repo, 'docs', 'projects', first.projectSlug);
    expect(readFileSync(join(projectDir, 'spec.md'), 'utf8')).toContain(bug.text);
    expect(readFileSync(join(projectDir, 'spec.md'), 'utf8')).toContain('Repro: open Settings and select Save.');
    const tasks = readFileSync(join(projectDir, 'tasks.md'), 'utf8');
    expect(tasks.match(/^- \[ \]/gm)).toHaveLength(1);
    expect(tasks).toMatch(/test/i);
    expect(git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', first.commitSha]).split('\n').sort()).toEqual([
      `docs/projects/${first.projectSlug}/spec.md`,
      `docs/projects/${first.projectSlug}/tasks.md`,
    ]);
    expect(git(repo, ['status', '--porcelain'])).toBe(operatorStatus);
    expect(mockLog.info).toHaveBeenCalledWith('fix project scaffold committed', {
      projectSlug: first.projectSlug,
      commitSha: first.commitSha,
    });

    const retry = await scaffoldAndCommitFixProject({
      repoPath: repo,
      baseBranch: 'main',
      product: 'rune',
      bugId: bug.id,
      bug,
      facts,
    });

    expect(retry).toEqual(first);
    expect(existsSync(projectDir)).toBe(true);
    expect(git(repo, ['status', '--porcelain'])).toBe(operatorStatus);
    expect(mockLog.info).toHaveBeenCalledWith('fix project scaffold reused', {
      projectSlug: first.projectSlug,
      commitSha: first.commitSha,
    });
  });

  it('logs a typed, reason-bearing failure when the product base branch is not checked out', async () => {
    const repo = makeRepo();

    await expect(scaffoldAndCommitFixProject({
      repoPath: repo,
      baseBranch: 'release',
      product: 'rune',
      bugId: bug.id,
      bug,
      facts,
    })).resolves.toEqual({
      ok: false,
      reason: 'commit-failed',
      detail: 'product base branch is not checked out',
    });

    expect(mockLog.warn).toHaveBeenCalledWith('fix project scaffold rejected', {
      product: 'rune',
      bugId: bug.id,
      reason: 'commit-failed',
      detail: 'product base branch is not checked out',
    });
  });
});
