/**
 * Phase 3 test suite for `src/jobs/work-run-forensics.ts` — forensic evidence
 * export (test-plan §3, project 11 work-run-observability).
 *
 * Written TEST-FIRST: `exportForensics` throws `notImplemented(...)`, so every
 * test here is RED until the Phase 3 implementation task lands. Expected failure
 * mode: assertion failure or the `work-run-forensics: exportForensics not
 * implemented` throw — NEVER a module-resolution / syntax / missing-env crash.
 *
 * Real tmpdir for the output dir; an injected `GitRunner` stub so the suite
 * never shells out to real git. The stub simulates the file-producing commands
 * (`git bundle create` writes its target) and returns canned stdout for the
 * text-capture commands (diff/status).
 *
 * See: docs/projects/11-work-run-observability/test-plan.md §3
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// work-run-forensics now imports `redactSecrets` from work-run-transcript, which
// transitively imports tool-labels → config.js (which throws on missing env at
// import time). Mock it so this suite loads with no real environment.
vi.mock('../config.js', () => ({
  default: {
    LOGS_DIR: '/tmp',
    VAULT_DIR: '/test/vault',
    WORKSPACE_DIR: '/test/workspace',
    PROJECT_ROOT: '/test/project',
  },
  PROJECT_ROOT: '/test/project',
}));

import { exportForensics } from './work-run-forensics.js';
import type { ExportForensicsOpts } from './work-run-forensics.js';
import type { GitRunner } from './sandbox-runtime.js';

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'work-run-forensics-test-'));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

/**
 * A GitRunner stub that records calls, returns canned stdout for text-capture
 * commands, and simulates the side-effecting `git bundle create <path>` by
 * writing an (empty) file at the requested path — so an assertion that
 * `bundle.git` exists passes once the implementation issues the command.
 */
function makeGitStub() {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const stub = vi.fn<GitRunner>().mockImplementation(async (args, opts) => {
    calls.push({ args: [...args], cwd: opts?.cwd });
    if (args.includes('bundle') && args.includes('create')) {
      // `git bundle create <path> <branch>` — the path is the arg after 'create'.
      const path = args[args.indexOf('create') + 1];
      if (path) writeFileSync(path, 'BUNDLE');
      return { stdout: '', stderr: '' };
    }
    if (args.includes('--stat')) return { stdout: ' src/foo.ts | 2 +-\n 1 file changed', stderr: '' };
    if (args.includes('--porcelain')) return { stdout: ' M src/foo.ts\n?? new.txt', stderr: '' };
    if (args.includes('--staged') || args.includes('--cached')) return { stdout: 'STAGED DIFF', stderr: '' };
    if (args.includes('diff')) return { stdout: 'WORKING DIFF', stderr: '' };
    return { stdout: '', stderr: '' };
  });
  return { stub, calls };
}

type ForensicsInput = Omit<ExportForensicsOpts, 'runGit'>;
function baseOpts(overrides: Partial<ForensicsInput> = {}): ForensicsInput {
  return {
    worktree: '/fake/worktree',
    outDir,
    baseSha: 'deadbeef1234567890abcdef1234567890abcdef',
    branch: 'rune-work/abcd1234',
    nonClean: true,
    ...overrides,
  };
}

describe('exportForensics', () => {
  it('writes diffstat.txt from the baseSha..branch diff --stat', async () => {
    const { stub, calls } = makeGitStub();
    await exportForensics({ runGit: stub, ...baseOpts() });

    expect(existsSync(join(outDir, 'diffstat.txt'))).toBe(true);
    expect(readFileSync(join(outDir, 'diffstat.txt'), 'utf8')).toContain('1 file changed');
    // The stat range is the captured baseSha..branch, not main/HEAD…
    const statCall = calls.find(c => c.args.includes('--stat'));
    expect(statCall?.args.some(a => a.includes('deadbeef1234567890abcdef1234567890abcdef..rune-work/abcd1234'))).toBe(true);
    // …and git runs in the worktree, not the output dir.
    expect(statCall?.cwd).toBe('/fake/worktree');
  });

  it('writes status.txt from git status --porcelain', async () => {
    const { stub } = makeGitStub();
    await exportForensics({ runGit: stub, ...baseOpts() });
    expect(existsSync(join(outDir, 'status.txt'))).toBe(true);
    expect(readFileSync(join(outDir, 'status.txt'), 'utf8')).toContain('src/foo.ts');
  });

  it('writes diff.patch (working tree) and diff-staged.patch (staged)', async () => {
    const { stub } = makeGitStub();
    await exportForensics({ runGit: stub, ...baseOpts() });
    expect(existsSync(join(outDir, 'diff.patch'))).toBe(true);
    expect(existsSync(join(outDir, 'diff-staged.patch'))).toBe(true);
  });

  it('bundles the run branch into bundle.git (bundle over a live worktree)', async () => {
    const { stub, calls } = makeGitStub();
    await exportForensics({ runGit: stub, ...baseOpts() });
    expect(existsSync(join(outDir, 'bundle.git'))).toBe(true);
    // The bundle is created from the run branch, in the worktree.
    const bundleCall = calls.find(c => c.args.includes('bundle') && c.args.includes('create'));
    expect(bundleCall).toBeDefined();
    expect(bundleCall!.args.some(a => a.includes('rune-work/abcd1234'))).toBe(true);
    expect(bundleCall!.cwd).toBe('/fake/worktree');
  });

  it('exports untracked.tar for a non-clean run', async () => {
    const { stub } = makeGitStub();
    const result = await exportForensics({ runGit: stub, ...baseOpts({ nonClean: true }) });
    expect(existsSync(join(outDir, 'untracked.tar'))).toBe(true);
    expect(result.files).toContain('untracked.tar');
  });

  it('does NOT export untracked.tar for a clean run', async () => {
    const { stub } = makeGitStub();
    const result = await exportForensics({ runGit: stub, ...baseOpts({ nonClean: false }) });
    expect(existsSync(join(outDir, 'untracked.tar'))).toBe(false);
    expect(result.files).not.toContain('untracked.tar');
  });

  it('archives real untracked files (incl. a leading-dash name) without tar arg-injection', async () => {
    // The security-critical path: real `tar` over real files, including a
    // filename that starts with `--` (a tar argument-injection vector). The `--`
    // separator must make tar treat it as a file, not an option.
    const worktree = mkdtempSync(join(tmpdir(), 'work-run-forensics-wt-'));
    try {
      writeFileSync(join(worktree, 'new.txt'), 'untracked content');
      // A pathological name git could legitimately report from ls-files.
      writeFileSync(join(worktree, '--checkpoint-action.txt'), 'evil');

      // A git stub whose `ls-files -z` reports both files NUL-delimited.
      const stub = vi.fn<GitRunner>().mockImplementation(async (args) => {
        if (args.includes('ls-files')) {
          return { stdout: 'new.txt\0--checkpoint-action.txt\0', stderr: '' };
        }
        if (args.includes('bundle') && args.includes('create')) {
          const path = args[args.indexOf('create') + 1];
          if (path) writeFileSync(path, 'BUNDLE');
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await exportForensics({ runGit: stub, ...baseOpts({ worktree, nonClean: true }) });

      const tarPath = join(outDir, 'untracked.tar');
      expect(existsSync(tarPath)).toBe(true);
      expect(result.files).toContain('untracked.tar');
      // Listing the archive proves both files (including the dash-named one)
      // were archived as files, not interpreted as tar options.
      const listing = execFileSync('tar', ['-tf', tarPath], { encoding: 'utf8' });
      expect(listing).toContain('new.txt');
      expect(listing).toContain('--checkpoint-action.txt');
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('returns the forensicsPath and the list of artifacts written', async () => {
    const { stub } = makeGitStub();
    const result = await exportForensics({ runGit: stub, ...baseOpts() });
    expect(result.forensicsPath).toBe(outDir);
    expect(result.files).toEqual(
      expect.arrayContaining(['bundle.git', 'diffstat.txt', 'status.txt', 'diff.patch', 'diff-staged.patch']),
    );
  });
});
