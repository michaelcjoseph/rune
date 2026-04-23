import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import config from '../config.js';

function assertWithinVault(fullPath: string): void {
  const resolved = resolve(fullPath);
  const vaultRoot = resolve(config.VAULT_DIR);
  if (!resolved.startsWith(vaultRoot + '/') && resolved !== vaultRoot) {
    throw new Error(`Path escapes vault boundary: ${fullPath}`);
  }
}

/** Read a file from the vault. Path is relative to vault root. */
export function readVaultFile(relativePath: string): string | null {
  const fullPath = join(config.VAULT_DIR, relativePath);
  assertWithinVault(fullPath);
  try {
    return readFileSync(fullPath, 'utf8');
  } catch {
    return null;
  }
}

/** Write a file to the vault. Path is relative to vault root. Creates directories as needed. */
export function writeVaultFile(relativePath: string, content: string): void {
  const fullPath = join(config.VAULT_DIR, relativePath);
  assertWithinVault(fullPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  const tmp = fullPath + '.tmp';
  writeFileSync(tmp, content);
  renameSync(tmp, fullPath);
}

/** Append content to a vault file. Path is relative to vault root. Creates
 *  the parent directory + the file itself on first write. Atomic replace is
 *  deliberately NOT used here — append-then-rename loses the existing
 *  contents. For inherently append-only artifacts like knowledge/log.md. */
export function appendVaultFile(relativePath: string, content: string): void {
  const fullPath = join(config.VAULT_DIR, relativePath);
  assertWithinVault(fullPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  appendFileSync(fullPath, content);
}

/** Check if a vault file exists. Path is relative to vault root. */
export function vaultFileExists(relativePath: string): boolean {
  const fullPath = join(config.VAULT_DIR, relativePath);
  assertWithinVault(fullPath);
  return existsSync(fullPath);
}

/** List markdown files in a vault directory. Returns relative paths. */
export function listVaultFiles(relativeDir: string): string[] {
  const fullDir = join(config.VAULT_DIR, relativeDir);
  assertWithinVault(fullDir);
  if (!existsSync(fullDir)) return [];

  const results: string[] = [];

  function walk(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.md')) {
          results.push(relative(config.VAULT_DIR, fullPath));
        }
      }
    }
  }

  walk(fullDir);
  return results;
}

/** Get file modification time. Returns null if file doesn't exist. */
export function getFileModTime(relativePath: string): Date | null {
  const fullPath = join(config.VAULT_DIR, relativePath);
  assertWithinVault(fullPath);
  try {
    return statSync(fullPath).mtime;
  } catch {
    return null;
  }
}

/** Get the absolute vault path for a relative path. */
export function getVaultPath(relativePath: string): string {
  const fullPath = join(config.VAULT_DIR, relativePath);
  assertWithinVault(fullPath);
  return fullPath;
}
