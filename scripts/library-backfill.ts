#!/usr/bin/env tsx
// One-time backfill: enqueue every existing library/*.md into the KB ingestion
// queue. Idempotent (enqueue() dedupes by source path), so re-running is safe.
// Mirrors the style of scripts/run-intent-scan.ts.
import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import config from '../src/config.js';
import { enqueue } from '../src/kb/queue.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('library-backfill');

// Keep in sync with the library/* cases in src/kb/ingest.ts determineRawDir().
const LIBRARY_SUBDIRS = ['lennys-podcast', 'graham-essays', 'lenny'] as const;

function collectMarkdown(absDir: string): string[] {
  const out: string[] = [];
  // Node ≥ 20 supports recursive: true; package.json pins ≥ 22. Dirent.parentPath
  // is set by recursive walks so each entry knows its own directory.
  const entries = readdirSync(absDir, { recursive: true, withFileTypes: true }) as Dirent[];
  for (const entry of entries) {
    if (!entry.isFile()) continue; // skips symlinks and directories
    if (!entry.name.endsWith('.md')) continue;
    out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

async function main(): Promise<void> {
  const libraryAbs = join(config.VAULT_DIR, 'library');
  if (!existsSync(libraryAbs)) {
    log.warn('No library directory found, nothing to backfill', { libraryAbs });
    return;
  }

  let found = 0;
  for (const subdir of LIBRARY_SUBDIRS) {
    const subdirAbs = join(libraryAbs, subdir);
    if (!existsSync(subdirAbs)) {
      log.info('Subdir absent, skipping', { subdir });
      continue;
    }
    const files = collectMarkdown(subdirAbs);
    for (const abs of files) {
      const rel = relative(config.VAULT_DIR, abs);
      enqueue(rel);
      found++;
    }
    log.info('Walked subdir', { subdir, count: files.length });
  }

  // enqueue() dedupes silently, so re-runs report the same `found` count even
  // when nothing was actually appended to the queue.
  console.log(`Found ${found} library file(s); already-queued entries were skipped.`);
}

main().catch((err) => {
  console.error('library-backfill crashed:', err);
  process.exit(1);
});
