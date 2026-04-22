import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';
import { readVaultFile } from './files.js';

export const LEARNINGS_FILENAME = 'learnings.jsonl';

/** Default cap on how many recent learnings to surface (display + prompt prepend). */
export const DEFAULT_LEARNINGS_LIMIT = 20;

/** Soft character budget for learnings prepended to an agent prompt. If the
 *  N most-recent entries exceed this, we drop oldest-first until we fit.
 *  The file itself is never truncated. */
export const LEARNINGS_PROMPT_CHAR_BUDGET = 4000;

export interface LearningEntry {
  /** UTC ISO 8601 — machine-parseable regardless of reader timezone. */
  ts: string;
  text: string;
}

export function learningsPath(): string {
  return join(config.VAULT_DIR, LEARNINGS_FILENAME);
}

/** Append a learning. Deliberately bypasses the vault abstraction: writeVaultFile
 *  is atomic-replace (tmp+rename) and would clobber an append. files.ts has no
 *  append primitive. appendFileSync's default flag 'a' creates the file on
 *  first write. Same pattern as src/vault/journal.ts. */
export function appendLearning(text: string, now: Date = new Date()): LearningEntry {
  const entry: LearningEntry = { ts: now.toISOString(), text };
  appendFileSync(learningsPath(), `${JSON.stringify(entry)}\n`);
  return entry;
}

/** Read all learnings from disk. Missing file → []. Malformed lines and
 *  wrong-shape JSON are silently skipped so one bad entry doesn't hide history.
 *  Uses readVaultFile so path-escape guard + read-error swallowing are applied
 *  consistently with the rest of the vault layer. */
export function readLearnings(): LearningEntry[] {
  const raw = readVaultFile(LEARNINGS_FILENAME);
  if (raw === null) return [];
  const entries: LearningEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as { ts?: unknown }).ts === 'string' &&
        typeof (parsed as { text?: unknown }).text === 'string'
      ) {
        entries.push(parsed as LearningEntry);
      }
    } catch {
      // skip malformed line
    }
  }
  return entries;
}

/** Return the tail of the learnings list — up to `limit` entries, oldest-first
 *  within the slice (so the most recent has the greatest weight when prepended). */
export function recentLearnings(limit: number = DEFAULT_LEARNINGS_LIMIT): LearningEntry[] {
  if (limit <= 0) return [];
  const all = readLearnings();
  return all.slice(-limit);
}

/** Build a `## Learnings` block for prepending to an agent prompt.
 *  Returns '' if there are no learnings (caller concatenates unconditionally).
 *  Enforces both a count cap and a character budget; drops oldest entries
 *  until the block fits. The on-disk file is never modified. */
export function buildLearningsPrompt(
  entries: LearningEntry[] = recentLearnings(),
  charBudget: number = LEARNINGS_PROMPT_CHAR_BUDGET,
): string {
  if (entries.length === 0) return '';
  let slice = entries.slice();
  let block = renderLearningsBlock(slice);
  while (block.length > charBudget && slice.length > 1) {
    slice = slice.slice(1);
    block = renderLearningsBlock(slice);
  }
  // Final block may still exceed budget if a single entry is huge;
  // that's acceptable — the user's latest intent wins.
  return block;
}

function renderLearningsBlock(entries: LearningEntry[]): string {
  const lines = entries.map((e) => `- ${e.text}`);
  return `## Learnings\n\nUser-authored guidance to apply (most recent has greatest weight — listed oldest-first):\n\n${lines.join('\n')}\n\n`;
}
