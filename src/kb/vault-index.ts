import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createLogger } from '../utils/logger.js';

export interface IndexedLine {
  file: string;
  line: number;
  content: string;
}

interface VaultIndexStats {
  files: number;
  lines: number;
  bytes: number;
  heapUsed: number;
  buildMs: number;
}

export interface VaultIndexStatus {
  ready: boolean;
  status: string;
  lastRebuild: VaultIndexStats | null;
}

interface BuildState {
  lines: IndexedLine[];
  stats: VaultIndexStats;
}

export interface BuildVaultIndexOpts {
  /** Reject symlink targets outside the configured vault root. Trusted Rune
   * surfaces retain the historical default; artifact MCP enables this. */
  containWithinRoot?: boolean;
}

const log = createLogger('vault-index');
const DEFAULT_MAX_RESULTS = 20;

let activeIndex: BuildState | null = null;
let status = 'not-ready';
let lastRebuild: VaultIndexStats | null = null;

function getVaultRoot(): string {
  const raw = process.env['VAULT_DIR'];
  if (!raw) throw new Error('Missing required env var: VAULT_DIR');
  return raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
}

function toVaultRelative(vaultRoot: string, fullPath: string): string {
  return relative(vaultRoot, fullPath).split(sep).join('/');
}

function normalizeRelativePrefix(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (isAbsolute(trimmed)) return null;

  const normalized = normalize(trimmed).split(sep).join('/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized === '.') return '';
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function splitIndexedLines(content: string): string[] {
  const lines = content.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function visitedKey(path: string, stats?: { dev: number; ino: number }): string {
  if (stats && Number.isFinite(stats.dev) && Number.isFinite(stats.ino)) {
    return `${stats.dev}:${stats.ino}`;
  }
  return path;
}

function skipLog(kind: 'file' | 'directory', vaultRoot: string, fullPath: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  const relativePath = toVaultRelative(vaultRoot, fullPath);
  log.warn(`Skipping unreadable ${kind} while building vault index`, {
    file: relativePath,
    reason,
  });
}

function addMarkdownFile(
  vaultRoot: string,
  fullPath: string,
  indexLines: IndexedLine[],
): { files: number; lines: number; bytes: number } {
  let content: string;
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch (err) {
    skipLog('file', vaultRoot, fullPath, err);
    return { files: 0, lines: 0, bytes: 0 };
  }

  const file = toVaultRelative(vaultRoot, fullPath);
  const fileLines = splitIndexedLines(content);
  for (let i = 0; i < fileLines.length; i += 1) {
    indexLines.push({
      file,
      line: i + 1,
      content: fileLines[i]!.trim(),
    });
  }

  return {
    files: 1,
    lines: fileLines.length,
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function buildReplacementIndex(opts: BuildVaultIndexOpts = {}): BuildState {
  const startedAt = performance.now();
  const vaultRoot = getVaultRoot();
  const rootStats = statSync(vaultRoot);
  const rootRealPath = realpathSync(vaultRoot);
  const visitedDirs = new Set<string>([visitedKey(rootRealPath, rootStats)]);
  const visitedFiles = new Set<string>();
  const indexLines: IndexedLine[] = [];
  const stats = {
    files: 0,
    lines: 0,
    bytes: 0,
  };

  function walkDirectory(fullDir: string): void {
    let entries;
    try {
      entries = readdirSync(fullDir, { withFileTypes: true });
    } catch (err) {
      skipLog('directory', vaultRoot, fullDir, err);
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;

      const fullPath = join(fullDir, entry.name);
      let linkStats;
      try {
        linkStats = lstatSync(fullPath);
      } catch (err) {
        skipLog('file', vaultRoot, fullPath, err);
        continue;
      }

      let targetStats;
      let targetRealPath;
      try {
        targetStats = linkStats.isSymbolicLink() ? statSync(fullPath) : linkStats;
        targetRealPath = realpathSync(fullPath);
      } catch (err) {
        skipLog(linkStats.isDirectory() ? 'directory' : 'file', vaultRoot, fullPath, err);
        continue;
      }

      if (opts.containWithinRoot && !isWithinRoot(rootRealPath, targetRealPath)) {
        continue;
      }

      if (targetStats.isDirectory()) {
        const dirKey = visitedKey(targetRealPath, targetStats);
        if (visitedDirs.has(dirKey)) continue;
        visitedDirs.add(dirKey);
        walkDirectory(fullPath);
        continue;
      }

      if (!targetStats.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
        continue;
      }

      const fileKey = visitedKey(targetRealPath, targetStats);
      if (visitedFiles.has(fileKey)) continue;
      visitedFiles.add(fileKey);

      const added = addMarkdownFile(vaultRoot, fullPath, indexLines);
      stats.files += added.files;
      stats.lines += added.lines;
      stats.bytes += added.bytes;
    }
  }

  walkDirectory(vaultRoot);

  const completeStats: VaultIndexStats = {
    ...stats,
    heapUsed: process.memoryUsage().heapUsed,
    buildMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };

  return {
    lines: indexLines,
    stats: completeStats,
  };
}

function installIndex(next: BuildState): void {
  activeIndex = next;
  lastRebuild = next.stats;
  status = 'ready';
  log.info('Built vault index', { ...next.stats });
}

export function buildVaultIndex(opts: BuildVaultIndexOpts = {}): void {
  status = 'building';
  try {
    installIndex(buildReplacementIndex(opts));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    status = activeIndex ? 'ready' : 'failed';
    log.error('Failed to build vault index', { reason });
  }
}

export function refreshVaultIndex(): void {
  status = 'refreshing';
  try {
    installIndex(buildReplacementIndex());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    status = activeIndex ? 'stale' : 'failed';
    log.error('Failed to refresh vault index; retaining previous index', { reason });
  }
}

export function getVaultIndexStatus(): VaultIndexStatus {
  return {
    ready: activeIndex !== null,
    status,
    lastRebuild,
  };
}

function makeMatcher(query: string): (content: string) => boolean {
  try {
    const regex = new RegExp(query, 'i');
    return (content: string) => regex.test(content);
  } catch {
    const needle = query.toLowerCase();
    return (content: string) => content.toLowerCase().includes(needle);
  }
}

function matchesDirectory(file: string, directory?: string): boolean {
  if (!directory) return true;
  const prefix = normalizeRelativePrefix(directory);
  if (prefix === null) return false;
  if (!prefix) return true;
  return file === prefix || file.startsWith(`${prefix}/`);
}

export function queryVaultIndex(
  query: string,
  options: { directory?: string; maxResults?: number } = {},
): IndexedLine[] {
  if (!activeIndex) return [];

  const maxResults = options.maxResults !== undefined && Number.isFinite(options.maxResults)
    ? Math.max(0, Math.floor(options.maxResults))
    : DEFAULT_MAX_RESULTS;
  const matcher = makeMatcher(query);
  const results: IndexedLine[] = [];

  for (const line of activeIndex.lines) {
    if (!matchesDirectory(line.file, options.directory)) continue;
    if (!matcher(line.content)) continue;

    results.push(line);
    if (results.length >= maxResults) break;
  }

  return results;
}
