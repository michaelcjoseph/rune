import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';
import { getTodayFilename } from '../utils/time.js';

function getTodayPath(): string {
  return join(config.VAULT_DIR, 'journals', getTodayFilename());
}

export function appendToJournal(text: string): string {
  const filepath = getTodayPath();

  if (!existsSync(filepath)) {
    writeFileSync(filepath, '');
  }

  // Ensure existing content ends with newline
  const existing = readFileSync(filepath, 'utf8');
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';

  appendFileSync(filepath, `${prefix}${text}\n`);
  return filepath;
}
