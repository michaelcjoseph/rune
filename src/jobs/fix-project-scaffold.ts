import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import type { BacklogItem } from '../intent/backlog-parser.js';
import { createLogger } from '../utils/logger.js';
import type { BugScopingFacts } from './bug-fix-gate.js';

const log = createLogger('fix-project-scaffold');

export interface ScaffoldFixProjectInput {
  repoPath: string;
  baseBranch: string;
  product: string;
  bugId: string;
  bug: BacklogItem;
  facts: BugScopingFacts;
}

export type ScaffoldFixProjectResult =
  | { ok: true; projectSlug: string; commitSha: string }
  | { ok: false; reason: 'scaffold-failed' | 'commit-failed'; detail?: string };

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'bug';
}

function deriveProjectSlug(repoPath: string, bugId: string): string {
  const projectsDir = join(repoPath, 'docs', 'projects');
  const suffix = `fix-${slugify(bugId)}`;
  let names: string[] = [];
  try {
    names = readdirSync(projectsDir);
  } catch {
    // A repository without a projects directory starts at project 01.
  }

  const existing = names.find((name) => /^\d+-/.test(name) && name.endsWith(`-${suffix}`));
  if (existing) return existing;

  const highest = names.reduce((max, name) => {
    const match = /^(\d+)-/.exec(name);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${String(highest + 1).padStart(2, '0')}-${suffix}`;
}

function renderSpec(input: ScaffoldFixProjectInput, projectSlug: string): string {
  const body = input.bug.body.length > 0
    ? input.bug.body.map((line) => `- ${line}`).join('\n')
    : '- No additional bug notes supplied.';
  const facts = Object.entries(input.facts)
    .map(([name, value]) => `- ${name}: ${String(value)}`)
    .join('\n');

  return `# Fix ${input.bugId}\n\n` +
    `Project: \`${projectSlug}\`  \nProduct: \`${input.product}\`\n\n` +
    `## Bug\n\n${input.bug.text}\n\n${body}\n\n` +
    `## Scoping facts\n\n${facts}\n\n` +
    '## Acceptance\n\n' +
    '- Implement the smallest coherent fix for the bug described above.\n' +
    '- Add or update automated tests that reproduce the bug and verify the fix.\n' +
    '- Run the repository validation commands and leave the full suite green.\n';
}

function renderTasks(input: ScaffoldFixProjectInput): string {
  return `# Fix ${input.bugId} — Tasks\n\n` +
    `- [ ] Implement the fix for “${input.bug.text}”, add regression tests, and run the full repository validation suite.\n`;
}

function committedScaffoldSha(repoPath: string, paths: string[]): string | null {
  try {
    const sha = git(repoPath, ['log', '-1', '--format=%H', '--', ...paths]);
    if (!/^[0-9a-f]{40}$/.test(sha)) return null;
    const committedPaths = new Set(
      git(repoPath, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).split('\n'),
    );
    return paths.every((path) => committedPaths.has(path)) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Writes and commits the minimal project consumed by orchestrated-work while
 * leaving every unrelated index and worktree entry untouched.
 */
export async function scaffoldAndCommitFixProject(
  input: ScaffoldFixProjectInput,
): Promise<ScaffoldFixProjectResult> {
  let branch: string;
  try {
    branch = git(input.repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  } catch {
    return { ok: false, reason: 'commit-failed', detail: 'repository branch is unavailable' };
  }
  if (branch !== input.baseBranch) {
    return { ok: false, reason: 'commit-failed', detail: 'product base branch is not checked out' };
  }

  const projectSlug = deriveProjectSlug(input.repoPath, input.bugId);
  const projectDir = join(input.repoPath, 'docs', 'projects', projectSlug);
  const specPath = join(projectDir, 'spec.md');
  const tasksPath = join(projectDir, 'tasks.md');
  const relativePaths = [specPath, tasksPath].map((path) => relative(input.repoPath, path));
  const spec = renderSpec(input, projectSlug);
  const tasks = renderTasks(input);

  const projectDirExists = existsSync(projectDir);
  const specExists = existsSync(specPath);
  const tasksExists = existsSync(tasksPath);
  if (projectDirExists) {
    if (!specExists || !tasksExists) {
      return { ok: false, reason: 'scaffold-failed', detail: 'fix project path is incomplete' };
    }
    let existingSpec: string;
    let existingTasks: string;
    try {
      existingSpec = readFileSync(specPath, 'utf8');
      existingTasks = readFileSync(tasksPath, 'utf8');
    } catch {
      return { ok: false, reason: 'scaffold-failed', detail: 'fix project path is unreadable' };
    }
    if (existingSpec !== spec || existingTasks !== tasks) {
      return { ok: false, reason: 'scaffold-failed', detail: 'fix project path conflicts with existing content' };
    }
    const commitSha = committedScaffoldSha(input.repoPath, relativePaths);
    if (!commitSha) {
      return { ok: false, reason: 'commit-failed', detail: 'existing fix project is not committed together' };
    }
    log.info('fix project scaffold reused', { projectSlug, commitSha });
    return { ok: true, projectSlug, commitSha };
  }

  try {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(specPath, spec, { flag: 'wx' });
    writeFileSync(tasksPath, tasks, { flag: 'wx' });
  } catch {
    rmSync(projectDir, { recursive: true, force: true });
    return { ok: false, reason: 'scaffold-failed', detail: 'unable to write fix project scaffold' };
  }

  try {
    git(input.repoPath, ['add', '--', ...relativePaths]);
    git(input.repoPath, [
      'commit',
      '--only',
      '-m',
      `scaffold fix project ${projectSlug}`,
      '--',
      ...relativePaths,
    ]);
    const commitSha = git(input.repoPath, ['rev-parse', 'HEAD']);
    log.info('fix project scaffold committed', { projectSlug, commitSha });
    return { ok: true, projectSlug, commitSha };
  } catch {
    try {
      git(input.repoPath, ['reset', '--quiet', '--', ...relativePaths]);
    } catch {
      // Cleanup below remains safe even if Git cannot update its index.
    }
    rmSync(projectDir, { recursive: true, force: true });
    return { ok: false, reason: 'commit-failed', detail: 'unable to commit fix project scaffold' };
  }
}
