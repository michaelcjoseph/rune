import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import config, { PROJECT_ROOT } from '../config.js';

const WORKSPACE_ROOT = resolve(config.WORKSPACE_DIR ?? PROJECT_ROOT);

function assertWithinWorkspace(fullPath: string): void {
  const resolved = resolve(fullPath);
  if (!resolved.startsWith(WORKSPACE_ROOT + '/') && resolved !== WORKSPACE_ROOT) {
    throw new Error(`Path escapes workspace boundary: ${fullPath}`);
  }
}

/** Read a file from the workspace. Path is relative to workspace root. */
export function readWorkspaceFile(relativePath: string): string | null {
  const fullPath = join(WORKSPACE_ROOT, relativePath);
  assertWithinWorkspace(fullPath);
  try {
    return readFileSync(fullPath, 'utf8');
  } catch {
    return null;
  }
}

/** Write a file to the workspace. Path is relative to workspace root. Creates directories as needed. */
export function writeWorkspaceFile(relativePath: string, content: string): void {
  const fullPath = join(WORKSPACE_ROOT, relativePath);
  assertWithinWorkspace(fullPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  const tmp = fullPath + '.tmp';
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, fullPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** Append content to a workspace file. Path is relative to workspace root. Creates
 *  the parent directory + the file itself on first write. Atomic replace is
 *  deliberately NOT used here — append-then-rename loses the existing contents. */
export function appendWorkspaceFile(relativePath: string, content: string): void {
  const fullPath = join(WORKSPACE_ROOT, relativePath);
  assertWithinWorkspace(fullPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  appendFileSync(fullPath, content);
}

/** Check if a workspace file exists. Path is relative to workspace root. */
export function workspaceFileExists(relativePath: string): boolean {
  const fullPath = join(WORKSPACE_ROOT, relativePath);
  assertWithinWorkspace(fullPath);
  return existsSync(fullPath);
}

/** List markdown files in a workspace directory. Returns relative paths from workspace root. */
export function listWorkspaceFiles(relativeDir: string): string[] {
  const root = WORKSPACE_ROOT;
  const fullDir = join(root, relativeDir);
  assertWithinWorkspace(fullDir);
  if (!existsSync(fullDir)) return [];

  const results: string[] = [];

  function walk(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(relative(root, fullPath));
      }
    }
  }

  walk(fullDir);
  return results;
}

/** List all entries (file + directory names) in a workspace directory. Non-recursive.
 *  Returns raw filenames with no extension filter. Missing dir → []. */
export function listWorkspaceDirEntries(relativeDir: string): string[] {
  const fullDir = join(WORKSPACE_ROOT, relativeDir);
  assertWithinWorkspace(fullDir);
  try {
    return readdirSync(fullDir);
  } catch {
    return [];
  }
}

/** Get file modification time. Returns null if file doesn't exist. */
export function getWorkspaceFileModTime(relativePath: string): Date | null {
  const fullPath = join(WORKSPACE_ROOT, relativePath);
  assertWithinWorkspace(fullPath);
  try {
    return statSync(fullPath).mtime;
  } catch {
    return null;
  }
}

/** Get the absolute workspace path for a relative path. */
export function getWorkspacePath(relativePath: string): string {
  const fullPath = join(WORKSPACE_ROOT, relativePath);
  assertWithinWorkspace(fullPath);
  return fullPath;
}
