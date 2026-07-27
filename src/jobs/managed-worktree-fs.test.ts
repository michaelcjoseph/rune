import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertManagedWorktreeDirectory,
  readManagedWorktreeFile,
  writeManagedWorktreeFile,
} from './managed-worktree-fs.js';

let root: string;
let worktree: string;
let projectDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'managed-worktree-fs-'));
  worktree = join(root, 'worktree');
  projectDir = join(worktree, 'docs', 'projects', 'assay');
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('managed-worktree-fs', () => {
  it('creates, verifies, and reads a missing managed file', () => {
    const contextPath = join(projectDir, 'context.md');

    writeManagedWorktreeFile(worktree, contextPath, '# Context\n', true);

    expect(readManagedWorktreeFile(worktree, contextPath, false)).toBe('# Context\n');
  });

  it('refuses a leaf symlink without truncating its external target', () => {
    const external = join(root, 'external.md');
    const contextPath = join(projectDir, 'context.md');
    writeFileSync(external, 'outside\n');
    symlinkSync(external, contextPath);

    expect(() =>
      writeManagedWorktreeFile(worktree, contextPath, 'changed\n', true),
    ).toThrow(/symlink/i);
    expect(readFileSync(external, 'utf8')).toBe('outside\n');
  });

  it('refuses an ancestor symlink that resolves outside the worktree', () => {
    const externalDir = join(root, 'external-project');
    mkdirSync(externalDir);
    writeFileSync(join(externalDir, 'tasks.md'), '- [ ] outside\n');
    const linkedProject = join(worktree, 'linked-project');
    symlinkSync(externalDir, linkedProject);

    expect(() =>
      readManagedWorktreeFile(worktree, join(linkedProject, 'tasks.md'), false),
    ).toThrow(/outside the worktree/i);
  });

  it('refuses hard-linked managed files', () => {
    const external = join(root, 'external.md');
    const contextPath = join(projectDir, 'context.md');
    writeFileSync(external, 'outside\n');
    linkSync(external, contextPath);

    expect(() =>
      writeManagedWorktreeFile(worktree, contextPath, 'changed\n', false),
    ).toThrow(/hard-linked/i);
    expect(readFileSync(external, 'utf8')).toBe('outside\n');
  });

  it('rejects a project-directory symlink', () => {
    const externalDir = join(root, 'external-project');
    mkdirSync(externalDir);
    const linkedProject = join(worktree, 'linked-project');
    symlinkSync(externalDir, linkedProject);

    expect(() =>
      assertManagedWorktreeDirectory(worktree, linkedProject, 'project directory'),
    ).toThrow(/must not be a symlink/i);
  });
});
