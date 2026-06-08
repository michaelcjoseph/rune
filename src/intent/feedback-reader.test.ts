/**
 * Phase 6 test suite for `src/intent/feedback-reader.ts` — the production
 * `FeedbackReader` that reads machine-readable feedback records from a JSONL file
 * for the learning loop (project 14, test-plan §6.2, §6.8).
 *
 * TEST-FIRST. The module under test does not exist yet; until it lands these
 * tests fail RED on module-not-found.
 *
 * The reader is deliberately TOLERANT: it parses each JSONL line into a raw object
 * (the learning loop validates shape via `parseFeedbackRecord`), skips blank and
 * torn/un-parseable lines, and returns [] for a missing file. It does NOT validate
 * record shape — that is the loop's job, so a structurally-invalid-but-parseable
 * record still reaches the loop and is skipped there with a durable reason.
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §6
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readFeedbackRecords,
  feedbackRecordId,
  readProcessedFeedbackIds,
  writeProcessedFeedbackIds,
} from './feedback-reader.js';

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    tmpDir = null;
  }
});

function writeJsonl(lines: string[]): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-feedback-'));
  const file = join(tmpDir, 'feedback.jsonl');
  writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

describe('feedback-reader — readFeedbackRecords', () => {
  it('returns [] for a missing file', () => {
    expect(readFeedbackRecords(join(tmpdir(), 'does-not-exist-xyz.jsonl'))).toEqual([]);
  });

  it('parses each JSONL line into a raw object', () => {
    const file = writeJsonl([
      JSON.stringify({ projectSlug: 'a', source: 'manual', createdAt: '2026-06-08', issueSummary: 'x', evidence: 'y' }),
      JSON.stringify({ projectSlug: 'b', source: 'telegram', createdAt: '2026-06-08', issueSummary: 'p', evidence: 'q' }),
    ]);
    const records = readFeedbackRecords(file);
    expect(records).toHaveLength(2);
    expect((records[0] as Record<string, unknown>)['projectSlug']).toBe('a');
    expect((records[1] as Record<string, unknown>)['projectSlug']).toBe('b');
  });

  it('skips blank and whitespace-only lines', () => {
    const file = writeJsonl([
      JSON.stringify({ projectSlug: 'a', source: 'manual', createdAt: '2026-06-08', issueSummary: 'x', evidence: 'y' }),
      '',
      '   ',
      JSON.stringify({ projectSlug: 'b', source: 'manual', createdAt: '2026-06-08', issueSummary: 'x', evidence: 'y' }),
    ]);
    expect(readFeedbackRecords(file)).toHaveLength(2);
  });

  it('skips torn / un-parseable lines and returns the valid ones', () => {
    const file = writeJsonl([
      JSON.stringify({ projectSlug: 'a', source: 'manual', createdAt: '2026-06-08', issueSummary: 'x', evidence: 'y' }),
      '{ not valid json',
      JSON.stringify({ projectSlug: 'b', source: 'manual', createdAt: '2026-06-08', issueSummary: 'x', evidence: 'y' }),
    ]);
    const records = readFeedbackRecords(file);
    expect(records).toHaveLength(2);
  });

  it('does NOT validate record shape — a structurally-invalid object still reaches the caller', () => {
    // Missing required fields — the reader returns it raw; the LOOP marks it malformed.
    const file = writeJsonl([JSON.stringify({ projectSlug: 'a' })]);
    const records = readFeedbackRecords(file);
    expect(records).toHaveLength(1);
    expect((records[0] as Record<string, unknown>)['projectSlug']).toBe('a');
  });

  it('returns [] for an empty file', () => {
    const file = writeJsonl([]);
    expect(readFeedbackRecords(file)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Processed-marker helpers — process each record exactly once
// ---------------------------------------------------------------------------

describe('feedback-reader — feedbackRecordId', () => {
  it('is stable for the same record content', () => {
    const r = { projectSlug: 'a', issueSummary: 'x' };
    expect(feedbackRecordId(r)).toBe(feedbackRecordId({ ...r }));
  });

  it('is invariant to key ordering (canonical JSON)', () => {
    expect(feedbackRecordId({ a: 1, b: 2 })).toBe(feedbackRecordId({ b: 2, a: 1 }));
  });

  it('differs when content differs', () => {
    expect(feedbackRecordId({ a: 1 })).not.toBe(feedbackRecordId({ a: 2 }));
  });

  it('produces a stable id for non-object input (malformed records still get marked once)', () => {
    expect(feedbackRecordId('oops')).toBe(feedbackRecordId('oops'));
    expect(feedbackRecordId(null)).toBe(feedbackRecordId(null));
  });
});

describe('feedback-reader — processed-id set persistence', () => {
  function processedPath(): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-feedback-proc-'));
    return join(tmpDir, 'feedback-processed.json');
  }

  it('returns an empty set for a missing file', () => {
    expect(readProcessedFeedbackIds(join(tmpdir(), 'nope-xyz.json')).size).toBe(0);
  });

  it('round-trips a set of ids atomically', () => {
    const file = processedPath();
    writeProcessedFeedbackIds(file, new Set(['a', 'b', 'c']));
    const back = readProcessedFeedbackIds(file);
    expect(back.has('a')).toBe(true);
    expect(back.has('b')).toBe(true);
    expect(back.size).toBe(3);
  });

  it('treats a corrupt processed file as empty', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-feedback-proc-'));
    const file = join(tmpDir, 'feedback-processed.json');
    writeFileSync(file, '{ not json', 'utf8');
    expect(readProcessedFeedbackIds(file).size).toBe(0);
  });
});
