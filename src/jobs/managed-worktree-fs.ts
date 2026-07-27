/**
 * Security-sensitive filesystem operations for Rune-owned managed worktree
 * files (`spec.md`, `tasks.md`, and `context.md`).
 *
 * Opens never truncate before the returned descriptor is verified against the
 * current pathname, its realpath, and the resolved worktree. This closes the
 * practical validate-then-open race and rejects leaf/ancestor symlink escapes
 * plus hard-linked managed files.
 *
 * Node does not expose `openat(2)`, so it cannot pin every ancestor directory
 * through the final read/write syscall. The remaining adversarial rename race
 * requires a concurrently surviving worktree process; orchestrated closeout
 * serializes access after child-process reaping, so that actor is outside the
 * accepted lifecycle threat model. Keep all managed-file access here if that
 * posture changes and a native directory-handle implementation is introduced.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname } from 'node:path';
import { isContainedIn } from '../intent/sandbox.js';

export function assertManagedWorktreeDirectory(
  worktree: string,
  candidate: string,
  label: string,
): void {
  const entry = lstatSync(candidate);
  if (entry.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`${label} is not a directory`);
  }
  const realWorktree = realpathSync(worktree);
  if (!isContainedIn(realWorktree, realpathSync(candidate))) {
    throw new Error(`${label} resolves outside the worktree`);
  }
}

export function assertManagedWorktreeFile(
  worktree: string,
  path: string,
  allowMissing: boolean,
): boolean {
  const realWorktree = realpathSync(worktree);
  const realParent = realpathSync(dirname(path));
  if (!isContainedIn(realWorktree, realParent)) {
    throw new Error('managed worktree file parent resolves outside the worktree');
  }
  try {
    const entry = lstatSync(path);
    assertRegularUnlinkedFile(entry);
    if (!isContainedIn(realWorktree, realpathSync(path))) {
      throw new Error('managed worktree file resolves outside the worktree');
    }
    return true;
  } catch (err) {
    if (allowMissing && (err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export function readManagedWorktreeFile(
  worktree: string,
  path: string,
  allowMissing: boolean,
): string {
  if (!assertManagedWorktreeFile(worktree, path, allowMissing)) return '';
  const fd = openVerifiedManagedFile(
    worktree,
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function writeManagedWorktreeFile(
  worktree: string,
  path: string,
  content: string,
  allowCreate: boolean,
): void {
  const exists = assertManagedWorktreeFile(worktree, path, allowCreate);
  const flags = exists
    ? fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW
    : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  const fd = openVerifiedManagedFile(worktree, path, flags, 0o644);
  try {
    // Truncate only after the descriptor and current pathname are proven to
    // identify the same contained regular file.
    ftruncateSync(fd, 0);
    writeFileSync(fd, content, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function openVerifiedManagedFile(
  worktree: string,
  path: string,
  flags: number,
  mode?: number,
): number {
  const fd = openSync(path, flags, mode);
  try {
    const opened = fstatSync(fd);
    const currentEntry = lstatSync(path);
    const current = statSync(path);
    assertRegularUnlinkedFile(opened);
    assertRegularUnlinkedFile(currentEntry);
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error('managed worktree file changed while it was being opened');
    }
    const realWorktree = realpathSync(worktree);
    if (!isContainedIn(realWorktree, realpathSync(path))) {
      throw new Error('managed worktree file resolves outside the worktree');
    }
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

function assertRegularUnlinkedFile(entry: Stats): void {
  if (entry.isSymbolicLink()) {
    throw new Error('managed worktree file must not be a symlink');
  }
  if (!entry.isFile()) {
    throw new Error('managed worktree path is not a regular file');
  }
  if (entry.nlink !== 1) {
    throw new Error('managed worktree file must not be hard-linked');
  }
}
