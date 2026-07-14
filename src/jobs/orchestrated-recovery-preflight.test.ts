import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { OrchestrationRunCursor } from '../intent/project-orchestrator.js';
import type { TaskRunRecord } from '../intent/orch-run-record.js';
import type { MutationDescriptor } from '../transport/mutations.js';
import { defaultRunGit } from './sandbox-runtime.js';
import {
  preflightOrchestratedRecovery,
  readTasksMdForRecoveredCursor,
  type OrchestratedRecoveryPreflightDeps,
} from './orchestrated-work-runner.js';

const roots: string[] = [];
const PROJECT = '22-recovery-safety';
const BRANCH = `rune-work/${PROJECT}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture(worktreeBranch = BRANCH): { repo: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), 'rune-recovery-preflight-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const worktree = join(root, 'worktree');
  const projectDir = join(repo, 'docs', 'projects', PROJECT);
  mkdirSync(projectDir, { recursive: true });
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'rune-tests@example.com');
  git(repo, 'config', 'user.name', 'Rune Tests');
  writeFileSync(join(projectDir, 'spec.md'), '# Spec\n');
  writeFileSync(join(projectDir, 'tasks.md'), '# Tasks\n- [ ] Resume safely\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'worktree', 'add', '-q', '-b', worktreeBranch, worktree);
  return { repo: realpathSync(repo), worktree: realpathSync(worktree) };
}

function mutation(): MutationDescriptor<{ projectSlug: string; product: string }> {
  return {
    id: 'mut-recovery-safe',
    kind: 'orchestrated-work',
    source: 'webview',
    target: { type: 'orchestrated-work', ref: PROJECT },
    preview: { summary: 'recover' },
    payload: { projectSlug: PROJECT, product: 'rune' },
    createdAt: '2026-07-14T12:00:00.000Z',
    status: 'running',
  };
}

function cursor(worktree: string): OrchestrationRunCursor {
  return {
    runId: mutation().id,
    product: 'rune',
    project: PROJECT,
    branch: BRANCH,
    baseBranch: 'main',
    worktreePath: worktree,
    resumeMarker: 'resumable',
    cursor: { completedTaskIds: [], currentTaskId: 'resume-safely', nextTaskId: 'resume-safely' },
  };
}

function deps(repo: string, worktree: string, overrides: Partial<OrchestratedRecoveryPreflightDeps> = {}): OrchestratedRecoveryPreflightDeps {
  return {
    readRunCursor: async () => cursor(worktree),
    readTaskRunRecords: async () => [],
    readTasksMd: readTasksMdForRecoveredCursor,
    worktreeExists: () => true,
    runGit: defaultRunGit,
    resolveProduct: () => ({ repoPath: repo, baseBranch: 'main' }),
    resolveWorktreePath: () => worktree,
    ...overrides,
  };
}

describe('preflightOrchestratedRecovery', () => {
  it('accepts an exact registered worktree on the expected branch', async () => {
    const f = fixture();
    const result = await preflightOrchestratedRecovery(mutation(), deps(f.repo, f.worktree));
    expect(result.kind).toBe('recoverable');
  });

  it('rejects a missing worktree with an operator-safe reason', async () => {
    const f = fixture();
    const result = await preflightOrchestratedRecovery(mutation(), deps(f.repo, f.worktree, {
      worktreeExists: () => false,
    }));
    expect(result).toEqual({ kind: 'not-resumable', reason: 'worktree no longer exists; this run cannot be recovered' });
  });

  it('rejects an existing but unregistered directory', async () => {
    const f = fixture();
    const unregistered = join(f.worktree, 'unregistered');
    mkdirSync(join(unregistered, 'docs', 'projects', PROJECT), { recursive: true });
    writeFileSync(join(unregistered, 'docs', 'projects', PROJECT, 'tasks.md'), '- [ ] Resume safely\n');
    const result = await preflightOrchestratedRecovery(mutation(), deps(f.repo, unregistered));
    expect(result).toEqual({ kind: 'not-resumable', reason: 'worktree is not registered on the expected branch' });
  });

  it('rejects a registered worktree checked out on the wrong branch', async () => {
    const f = fixture('rune-work/wrong-branch');
    const result = await preflightOrchestratedRecovery(mutation(), deps(f.repo, f.worktree));
    expect(result).toEqual({ kind: 'not-resumable', reason: 'worktree is registered on a different branch' });
  });

  it('rejects an unreadable or missing tasks.md', async () => {
    const f = fixture();
    rmSync(join(f.worktree, 'docs', 'projects', PROJECT, 'tasks.md'));
    const result = await preflightOrchestratedRecovery(mutation(), deps(f.repo, f.worktree));
    expect(result).toEqual({ kind: 'not-resumable', reason: 'project tasks and durable task records could not be reconstructed' });
  });

  it('rejects durable record drift', async () => {
    const f = fixture();
    const record: TaskRunRecord = {
      taskId: 'resume-safely', taskText: 'Resume safely', attemptId: 'attempt-1',
      rolesInvoked: ['qa', 'coder'], transcriptIds: [], modelChoices: {}, commitSha: 'abc1234',
      verdicts: { reviewer: 'pass', 'tech-lead': 'pass' }, contextOutcome: 'updated',
      gates: { objectionOpen: false }, outcome: 'ready-for-closeout',
    };
    const result = await preflightOrchestratedRecovery(mutation(), deps(f.repo, f.worktree, {
      readTaskRunRecords: async () => [record],
    }));
    expect(result).toEqual({ kind: 'not-resumable', reason: 'completed task records disagree with tasks.md' });
  });

  it.each([
    ['run id', { runId: 'different-run' }],
    ['product', { product: 'different-product' }],
    ['project', { project: 'different-project' }],
  ] as const)('rejects a cursor whose %s does not match the active mutation', async (_field, cursorOverride) => {
    const f = fixture();
    const result = await preflightOrchestratedRecovery(mutation(), deps(f.repo, f.worktree, {
      readRunCursor: async () => ({ ...cursor(f.worktree), ...cursorOverride }),
    }));
    expect(result).toEqual({ kind: 'not-resumable', reason: 'run and resumable cursor identity do not agree' });
  });

  it.each([
    ['path', { worktreePath: '/tmp/different-worktree' }],
    ['branch', { branch: 'rune-work/different-project' }],
    ['base branch', { baseBranch: 'develop' }],
  ] as const)('rejects a cursor whose deterministic %s does not match configuration', async (_field, cursorOverride) => {
    const f = fixture();
    const result = await preflightOrchestratedRecovery(mutation(), deps(f.repo, f.worktree, {
      readRunCursor: async () => ({ ...cursor(f.worktree), ...cursorOverride }),
    }));
    expect(result).toEqual({ kind: 'not-resumable', reason: 'resumable cursor does not match the expected worktree and branch' });
  });

  it('fails closed when Git worktree registration cannot be inspected', async () => {
    const f = fixture();
    const result = await preflightOrchestratedRecovery(mutation(), deps(f.repo, f.worktree, {
      runGit: async () => { throw new Error('git unavailable'); },
    }));
    expect(result).toEqual({ kind: 'not-resumable', reason: 'Git worktree registration could not be verified' });
  });
});
