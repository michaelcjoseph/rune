import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '../config.js';
import { runAgent } from '../ai/claude.js';
import { readVaultFile } from '../vault/files.js';
import { getTodayFilename, getTodayDate } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('playbook-extract');

export interface PlaybookDraft {
  draftedAt: string;
  sourceJournal: string;
  domain: string;
  slug: string;
  date: string;
  entryMarkdown: string;
  status: 'pending' | 'approved' | 'rejected';
}

export interface PlaybookExtractResult {
  status: 'skipped' | 'success' | 'error';
  detail: string;
}

// Exported for the cockpit approval inbox (C2.2) — read/write the queue
// to flip a draft's status when the user approves or rejects from the UI.
// The nightly playbook-updater post-review path still consumes these queue
// entries; the inbox is a parallel surface that produces the same status
// transition.
export { readQueue as readPlaybookQueue, writeQueue as writePlaybookQueue };

function readQueue(): PlaybookDraft[] {
  try {
    const data = readFileSync(config.PLAYBOOK_QUEUE_FILE, 'utf8');
    return JSON.parse(data) as PlaybookDraft[];
  } catch {
    return [];
  }
}

function writeQueue(entries: PlaybookDraft[]): void {
  mkdirSync(dirname(config.PLAYBOOK_QUEUE_FILE), { recursive: true });
  writeFileSync(config.PLAYBOOK_QUEUE_FILE, JSON.stringify(entries, null, 2));
}

export function getPendingPlaybookDrafts(): PlaybookDraft[] {
  return readQueue().filter(d => d.status === 'pending');
}

export function clearApprovedPlaybookDrafts(): void {
  writeQueue(readQueue().filter(d => d.status === 'pending'));
}

/**
 * Scan today's journal for #playbook tags. If found, invoke the
 * playbook-proposer agent to draft entries and append them to
 * logs/playbook-queue.json with status: 'pending'.
 */
export async function extractPlaybookDrafts(): Promise<PlaybookExtractResult> {
  const filename = getTodayFilename();
  const content = readVaultFile(`journals/${filename}`);

  if (!content?.trim()) {
    return { status: 'skipped', detail: 'No journal for today' };
  }

  if (!/#playbook\b/.test(content)) {
    return { status: 'skipped', detail: 'No #playbook tag' };
  }

  const journalDate = filename.replace(/\.md$/, '');
  const prompt = `journal_date: ${journalDate}
journal_content:
${content}

Extract all #playbook tags into structured draft entries. Return a JSON array as specified.`;

  const result = await runAgent('playbook-proposer', prompt, undefined, false);
  if (result.error || !result.text) {
    log.error('playbook-proposer failed', { error: result.error });
    return { status: 'error', detail: result.error || 'Empty response' };
  }

  let drafts: Omit<PlaybookDraft, 'status'>[];
  try {
    const cleaned = result.text.replace(/```json?\n?|\n?```/g, '').trim();
    drafts = JSON.parse(cleaned);
  } catch (err) {
    log.error('Failed to parse playbook-proposer output', { text: result.text.slice(0, 200) });
    return { status: 'error', detail: `Invalid JSON from proposer: ${(err as Error).message}` };
  }

  if (!Array.isArray(drafts) || drafts.length === 0) {
    return { status: 'skipped', detail: 'Proposer returned no drafts' };
  }

  const today = getTodayDate();
  const existing = readQueue();
  const existingSlugs = new Set(existing.map(d => `${d.slug}-${d.date}`));

  const newDrafts: PlaybookDraft[] = [];
  for (const d of drafts) {
    const key = `${d.slug}-${d.date || today}`;
    if (existingSlugs.has(key)) continue;
    newDrafts.push({
      draftedAt: d.draftedAt || new Date().toISOString(),
      sourceJournal: d.sourceJournal || journalDate,
      domain: d.domain || 'Other',
      slug: d.slug,
      date: d.date || today,
      entryMarkdown: d.entryMarkdown,
      status: 'pending',
    });
  }

  if (newDrafts.length === 0) {
    return { status: 'skipped', detail: 'All drafts already in queue' };
  }

  writeQueue([...existing, ...newDrafts]);
  log.info(`Queued ${newDrafts.length} playbook draft(s)`, { slugs: newDrafts.map(d => d.slug) });
  return { status: 'success', detail: `${newDrafts.length} draft(s) queued` };
}
