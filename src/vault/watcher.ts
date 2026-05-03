import { watch, existsSync, statSync, readFileSync, readdirSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { NotificationBus } from '../transport/notification-bus.js';
import config from '../config.js';
import { enqueue } from '../kb/queue.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('watcher');

const READWISE_DIR = 'Readwise/Articles';

let watcher: FSWatcher | null = null;
const seen = new Set<string>();
let clearTimer: ReturnType<typeof setInterval> | null = null;

export function extractTitle(filepath: string): string | null {
  try {
    const content = readFileSync(filepath, 'utf8');
    const match = content.match(/^#\s+(.+)$/m);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export function startWatcher(bus: NotificationBus): void {
  const dir = join(config.VAULT_DIR, READWISE_DIR);

  if (!existsSync(dir)) {
    log.info('Readwise directory not found, watcher disabled', { dir });
    return;
  }

  // Seed seen-Set with existing files to avoid notifying on startup
  try {
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.md')) seen.add(file);
    }
  } catch {
    // Empty dir or read error — start with empty set
  }

  watcher = watch(dir, (event, filename) => {
    if (!filename || !filename.endsWith('.md')) return;
    if (event !== 'rename') return;
    if (seen.has(filename)) return;

    // rename fires on both create and delete — check if file exists
    const filepath = join(dir, filename);
    try {
      statSync(filepath);
    } catch {
      return; // File was deleted, not created
    }

    seen.add(filename);
    const relativePath = `${READWISE_DIR}/${filename}`;
    const title = extractTitle(filepath) || filename.replace('.md', '');

    enqueue(relativePath);
    log.info('New Readwise article detected', { filename, title });

    bus.publish({
      kind: 'message',
      userId: config.TELEGRAM_USER_ID,
      text: `New article: ${title}\n\nQueued for ingestion. Reply /ingest to process now.`,
    });
  });

  clearTimer = setInterval(() => {
    const before = seen.size;
    seen.clear();
    try {
      for (const file of readdirSync(dir)) {
        if (file.endsWith('.md')) seen.add(file);
      }
    } catch {
      // read error — cleared set will re-seed on next event
    }
    log.info('Watcher seen-set refreshed', { before, after: seen.size });
  }, 24 * 60 * 60 * 1000);

  log.info('Readwise watcher started', { dir, existingFiles: seen.size });
}

export function stopWatcher(): void {
  if (clearTimer) {
    clearInterval(clearTimer);
    clearTimer = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
    log.info('Readwise watcher stopped');
  }
}
