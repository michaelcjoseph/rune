import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = join(tmpdir(), `rune-vault-test-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: tmpDir },
}));

const { readVaultFile, writeVaultFile, vaultFileExists, listVaultFiles, listVaultDirEntries, getFileModTime, getVaultPath } =
  await import('./files.js');

describe('vault/files', () => {
  describe('readVaultFile', () => {
    it('reads existing file', () => {
      writeFileSync(join(tmpDir, 'read-test.md'), 'hello');
      expect(readVaultFile('read-test.md')).toBe('hello');
    });

    it('returns null for missing file', () => {
      expect(readVaultFile('nonexistent.md')).toBeNull();
    });
  });

  describe('writeVaultFile', () => {
    it('writes content and creates parent directories', () => {
      writeVaultFile('deep/nested/file.md', 'nested content');
      expect(readVaultFile('deep/nested/file.md')).toBe('nested content');
    });
  });

  describe('vaultFileExists', () => {
    it('returns true for existing file', () => {
      writeFileSync(join(tmpDir, 'exists.md'), '');
      expect(vaultFileExists('exists.md')).toBe(true);
    });

    it('returns false for missing file', () => {
      expect(vaultFileExists('nope.md')).toBe(false);
    });
  });

  describe('listVaultFiles', () => {
    it('lists .md files recursively, ignores non-md', () => {
      mkdirSync(join(tmpDir, 'listdir/sub'), { recursive: true });
      writeFileSync(join(tmpDir, 'listdir/a.md'), '');
      writeFileSync(join(tmpDir, 'listdir/sub/b.md'), '');
      writeFileSync(join(tmpDir, 'listdir/c.txt'), '');
      const files = listVaultFiles('listdir');
      expect(files).toContain('listdir/a.md');
      expect(files).toContain('listdir/sub/b.md');
      expect(files).not.toContain('listdir/c.txt');
    });

    it('returns empty array for nonexistent directory', () => {
      expect(listVaultFiles('no-such-dir')).toEqual([]);
    });
  });

  describe('listVaultDirEntries', () => {
    it('lists all entries (files and directories) non-recursively', () => {
      mkdirSync(join(tmpDir, 'direntries/subdir'), { recursive: true });
      writeFileSync(join(tmpDir, 'direntries/a.json'), '{}');
      writeFileSync(join(tmpDir, 'direntries/b.md'), '');
      writeFileSync(join(tmpDir, 'direntries/c.txt'), '');

      const entries = listVaultDirEntries('direntries');
      expect(entries).toContain('a.json');
      expect(entries).toContain('b.md');
      expect(entries).toContain('c.txt');
      expect(entries).toContain('subdir');
      // Does NOT recurse into subdir
      expect(entries).not.toContain('direntries/a.json');
    });

    it('returns [] for a missing directory', () => {
      expect(listVaultDirEntries('no-such-dir-entries')).toEqual([]);
    });

    it('returns [] for an empty directory', () => {
      mkdirSync(join(tmpDir, 'emptydirentries'), { recursive: true });
      expect(listVaultDirEntries('emptydirentries')).toEqual([]);
    });

    it('returns filenames without path prefix', () => {
      mkdirSync(join(tmpDir, 'rawnames'), { recursive: true });
      writeFileSync(join(tmpDir, 'rawnames/2026-04-27.json'), '{}');

      const entries = listVaultDirEntries('rawnames');
      expect(entries).toEqual(['2026-04-27.json']);
    });
  });

  describe('getFileModTime', () => {
    it('returns Date for existing file', () => {
      writeFileSync(join(tmpDir, 'modtime.md'), '');
      expect(getFileModTime('modtime.md')).toBeInstanceOf(Date);
    });

    it('returns null for missing file', () => {
      expect(getFileModTime('missing.md')).toBeNull();
    });
  });

  describe('getVaultPath', () => {
    it('joins relative path with vault root', () => {
      expect(getVaultPath('some/file.md')).toBe(join(tmpDir, 'some/file.md'));
    });
  });
});
