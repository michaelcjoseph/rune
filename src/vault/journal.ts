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

const MORNING_PREP_MARKER = '## Morning Prep';

export function writeMorningPrep(sections: string): { written: boolean; filepath: string } {
  const filepath = getTodayPath();

  if (!existsSync(filepath)) {
    writeFileSync(filepath, '');
  }

  const existing = readFileSync(filepath, 'utf8');
  if (existing.includes(MORNING_PREP_MARKER)) {
    return { written: false, filepath };
  }

  const prefix = existing.length === 0 ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  appendFileSync(filepath, `${prefix}${MORNING_PREP_MARKER}\n\n${sections}\n`);
  return { written: true, filepath };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract lines after a #tag marker until the next line-leading tag, heading, or EOF. */
export function parseTag(content: string, tag: string): string | null {
  const lines = content.split('\n');
  const tagPattern = new RegExp(`(?:^|\\s)#${escapeRegex(tag)}(?:\\s|$)`);

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (tagPattern.test(lines[i])) {
      startIdx = i + 1;
      break;
    }
  }

  if (startIdx === -1) return null;

  const collected: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    // Stop at line-leading #tag (section divider) or markdown heading
    if (/^#\w/.test(line) || /^#{1,6}\s/.test(line)) break;
    collected.push(line);
  }

  return collected.join('\n').trim();
}
