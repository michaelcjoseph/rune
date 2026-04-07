import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import config from '../config.js';

/** Read a file from the vault. Path is relative to vault root. */
export function readVaultFile(relativePath: string): string | null {
  const fullPath = join(config.VAULT_DIR, relativePath);
  try {
    return readFileSync(fullPath, 'utf8');
  } catch {
    return null;
  }
}

/** Write a file to the vault. Path is relative to vault root. Creates directories as needed. */
export function writeVaultFile(relativePath: string, content: string): void {
  const fullPath = join(config.VAULT_DIR, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

/** Check if a vault file exists. Path is relative to vault root. */
export function vaultFileExists(relativePath: string): boolean {
  return existsSync(join(config.VAULT_DIR, relativePath));
}

/** List markdown files in a vault directory. Returns relative paths. */
export function listVaultFiles(relativeDir: string): string[] {
  const fullDir = join(config.VAULT_DIR, relativeDir);
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
  try {
    return statSync(fullPath).mtime;
  } catch {
    return null;
  }
}

/** Get the absolute vault path for a relative path. */
export function getVaultPath(relativePath: string): string {
  return join(config.VAULT_DIR, relativePath);
}
