/**
 * Production feedback reader (project 14, Phase 6).
 *
 * The concrete `FeedbackReader` the nightly learning loop wires in: reads
 * machine-readable feedback records from a JSONL file (one JSON object per line)
 * and returns them RAW. Shape validation is deliberately NOT done here — that is
 * `parseFeedbackRecord`'s job in the loop, so a structurally-invalid record still
 * reaches the loop and is skipped there with a durable reason (spec req 30),
 * rather than vanishing silently at the read layer.
 *
 * Torn-line tolerant (mirrors `readRecentIndex` in work-run-store.ts): a blank or
 * un-parseable line is skipped with a warn; a missing file yields []. So a
 * half-written final line never crashes the nightly pass.
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { createLogger } from '../utils/logger.js';

const log = createLogger('feedback-reader');

/** Read raw feedback records from a JSONL file. Each non-blank line is parsed as
 *  one JSON value and returned as-is (unvalidated). Blank/torn lines are skipped;
 *  a missing file returns []. */
export function readFeedbackRecords(filePath: string): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return []; // file doesn't exist yet — no feedback
  }

  const records: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      log.warn('feedback.jsonl: skipped malformed line');
    }
  }
  return records;
}

/** Stable content id for a raw feedback record, so the loop can process each
 *  exactly once regardless of the source's own id scheme (or lack of one). The id
 *  is a SHA-256 over the record's canonical JSON (keys sorted) — a re-ordered but
 *  otherwise-identical record hashes the same; any content change is a new id.
 *  Non-object / unstringifiable input falls back to a hash of its string form so a
 *  malformed record still gets a stable id (it is marked processed once, not retried). */
export function feedbackRecordId(raw: unknown): string {
  // `JSON.stringify(undefined)` returns JS `undefined`, so canonical is genuinely
  // optional here — the `?? 'null'` below is load-bearing, not decorative.
  let canonical: string | undefined;
  try {
    canonical = raw && typeof raw === 'object' ? JSON.stringify(raw, Object.keys(raw as object).sort()) : JSON.stringify(raw);
  } catch {
    canonical = String(raw);
  }
  return createHash('sha256').update(canonical ?? 'null').digest('hex');
}

/** Read the set of already-processed feedback-record ids. Missing/corrupt file → []. */
export function readProcessedFeedbackIds(filePath: string): Set<string> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    log.warn('feedback-processed.json: corrupt, treating as empty');
  }
  return new Set();
}

/** Atomically persist the processed-id set (temp-then-rename). Best-effort: a disk
 *  failure logs a warning rather than crashing the nightly pass — the cost of a lost
 *  marker is at worst one re-run of a post-mortem, which the lesson dedup absorbs. */
export function writeProcessedFeedbackIds(filePath: string, ids: Set<string>): void {
  try {
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify([...ids]), 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    log.warn('feedback-processed.json: write failed', { error: String(err) });
  }
}
