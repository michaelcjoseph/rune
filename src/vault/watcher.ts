import { watch, existsSync, statSync, readFileSync, readdirSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { NotificationBus } from '../transport/notification-bus.js';
import config from '../config.js';
import { enqueue } from '../kb/queue.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('watcher');

const READWISE_DIRS = ['Readwise/Articles', 'Readwise/Tweets', 'Readwise/Books'];

let watchers: FSWatcher[] = [];
const seen = new Set<string>(); // keyed on full relative path e.g. "Readwise/Tweets/foo.md"
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

function watchDir(subDir: string, bus: NotificationBus): FSWatcher | null {
  const dir = join(config.VAULT_DIR, subDir);

  if (!existsSync(dir)) {
    log.info('Readwise directory not found, skipping', { dir });
    return null;
  }

  // Seed seen-set with existing files to avoid notifying on startup
  const sizeBefore = seen.size;
  try {
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.md')) seen.add(`${subDir}/${file}`);
    }
  } catch {
    // Empty dir or read error — start with empty set
  }

  const w = watch(dir, (event, filename) => {
    if (!filename || !filename.endsWith('.md')) return;
    if (event !== 'rename') return;

    const relPath = `${subDir}/${filename}`;
    if (seen.has(relPath)) return;

    // rename fires on both create and delete — check if file exists
    const filepath = join(dir, filename);
    try {
      statSync(filepath);
    } catch {
      return; // File was deleted, not created
    }

    seen.add(relPath);
    const title = extractTitle(filepath) || filename.replace('.md', '');

    enqueue(relPath);
    log.info('New Readwise content detected', { subDir, filename, title });

    bus.publish({
      kind: 'message',
      userId: config.TELEGRAM_USER_ID,
      text: `New Readwise content: ${title}\n\nQueued for ingestion. Reply /ingest to process now.`,
    });
  });

  log.info('Readwise watcher started', { dir, existingFiles: seen.size - sizeBefore });
  return w;
}

export function startWatcher(bus: NotificationBus): void {
  for (const subDir of READWISE_DIRS) {
    const w = watchDir(subDir, bus);
    if (w) watchers.push(w);
  }

  if (watchers.length === 0) return;

  clearTimer = setInterval(() => {
    const before = seen.size;
    seen.clear();
    for (const subDir of READWISE_DIRS) {
      const dir = join(config.VAULT_DIR, subDir);
      try {
        for (const file of readdirSync(dir)) {
          if (file.endsWith('.md')) seen.add(`${subDir}/${file}`);
        }
      } catch {
        // read error — cleared set will re-seed on next event
      }
    }
    log.info('Watcher seen-set refreshed', { before, after: seen.size });
  }, 24 * 60 * 60 * 1000);
}

export function stopWatcher(): void {
  if (clearTimer) {
    clearInterval(clearTimer);
    clearTimer = null;
  }
  const wasRunning = watchers.length > 0 || clearTimer !== null;
  for (const w of watchers) w.close();
  watchers = [];
  if (wasRunning) log.info('Readwise watcher stopped');
}
