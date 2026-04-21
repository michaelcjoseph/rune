import { WriteStream, chmodSync, createWriteStream, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Level = 'info' | 'warn' | 'error' | 'debug';

const LOGGER_PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOGGER_LOGS_DIR = process.env.JARVIS_LOGS_DIR || join(LOGGER_PROJECT_ROOT, 'logs');
const LOG_FILE_NAME = 'jarvis.log';
const LOG_ROTATE_BYTES = 50 * 1024 * 1024; // 50 MB → rename to .1 on next open

let fileStream: WriteStream | null = null;
let fileStreamDisabled = !!process.env.VITEST;

function rotateIfOversized(logPath: string): void {
  try {
    const stats = statSync(logPath);
    if (stats.size > LOG_ROTATE_BYTES) {
      renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // ENOENT on first run — fine
  }
}

function getFileStream(): WriteStream | null {
  if (fileStreamDisabled) return null;
  if (fileStream) return fileStream;

  try {
    mkdirSync(LOGGER_LOGS_DIR, { recursive: true });
    const logPath = join(LOGGER_LOGS_DIR, LOG_FILE_NAME);
    rotateIfOversized(logPath);
    // mode 0o600 — the log may contain error strings that quote vault-adjacent
    // content; keep it readable only by the owning user. `mode:` only applies
    // when the file is created; chmod explicitly for existing files.
    const stream = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
    try { chmodSync(logPath, 0o600); } catch { /* best-effort */ }
    stream.on('error', (err) => {
      console.error(`[logger] file sink error: ${err.message}; disabling`);
      try { stream.destroy(); } catch { /* already destroyed */ }
      fileStreamDisabled = true;
      fileStream = null;
    });
    fileStream = stream;
    return stream;
  } catch (err) {
    console.error(`[logger] failed to open file sink: ${(err as Error).message}; disabling`);
    fileStreamDisabled = true;
    return null;
  }
}

/**
 * Flush and close the file sink. Call from process shutdown hooks (SIGTERM/SIGINT,
 * uncaughtException) so the last log lines aren't dropped with the write buffer.
 * Resolves when the OS-level write has completed.
 */
export function flushLogger(): Promise<void> {
  const stream = fileStream;
  if (!stream) return Promise.resolve();
  fileStream = null;
  fileStreamDisabled = true; // prevent re-open after flush
  return new Promise((resolve) => {
    stream.end(() => resolve());
  });
}

function log(level: Level, component: string, message: string, data?: Record<string, unknown>) {
  const entry = {
    time: new Date().toISOString(),
    level,
    component,
    message,
    ...(data ? { data } : {}),
  };
  const line = JSON.stringify(entry);

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }

  const stream = getFileStream();
  if (stream) stream.write(`${line}\n`);
}

export function createLogger(component: string) {
  return {
    info: (message: string, data?: Record<string, unknown>) => log('info', component, message, data),
    warn: (message: string, data?: Record<string, unknown>) => log('warn', component, message, data),
    error: (message: string, data?: Record<string, unknown>) => log('error', component, message, data),
    debug: (message: string, data?: Record<string, unknown>) => log('debug', component, message, data),
  };
}
