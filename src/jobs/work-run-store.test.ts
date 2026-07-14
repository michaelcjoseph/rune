/**
 * Phase 2 test suite for `src/jobs/work-run-store.ts` — run store persistence
 * (test-plan §2, project 11 work-run-observability).
 *
 * Written TEST-FIRST. Every body in the scaffold throws `notImplemented(...)`,
 * so all tests here must be RED until the Phase 2 implementation tasks complete.
 *
 * Expected failure mode: assertion failure or "work-run-store: <fn> not
 * implemented (project 11 Phase 2 pending)" throw. NEVER a module-resolution
 * error, syntax error, or "Missing env var" crash.
 *
 * Uses real tmpdir + real fs — no fs mocking needed for these tests.
 *
 * See: docs/projects/11-work-run-observability/test-plan.md §2
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  writeSummary,
  appendIndexRow,
  readRecentIndex,
  readWorkRunSummaryResult,
} from './work-run-store.js';
import type { WorkRunSummary, WorkRunIndexRow } from './work-run-store.js';

// ---------------------------------------------------------------------------
// Temp dir management — one fresh dir per test
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'work-run-store-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<WorkRunSummary> = {}): WorkRunSummary {
  return {
    id: 'mut-test-001',
    project: '11-work-run-observability',
    product: 'rune',
    outcome: 'noop',
    reason: 'zero commits + clean tree',
    exit: { exitCode: 0, signal: null, cancelled: false, durationMs: 1200 },
    workProduct: {
      commitCount: 0,
      commitShas: [],
      filesChanged: [],
      diffstat: '',
      dirty: false,
      untracked: false,
      transitions: {
        tasksNewlyChecked: 0,
        tasksRemaining: 0,
        tasksAdded: 0,
        tasksRemoved: 0,
      },
    },
    baseSha: 'deadbeef1234567890abcdef1234567890abcdef',
    branch: 'rune-gen-eval/mut-test-001',
    startedAt: '2026-05-30T10:00:00.000Z',
    endedAt: '2026-05-30T10:00:01.200Z',
    transcriptPath: '/tmp/logs/work-runs/mut-test-001/transcript.jsonl',
    forensicsPath: '/tmp/logs/work-runs/mut-test-001',
    ...overrides,
  };
}

function makeIndexRow(overrides: Partial<WorkRunIndexRow> = {}): WorkRunIndexRow {
  return {
    id: 'mut-test-001',
    project: '11-work-run-observability',
    outcome: 'noop',
    durationMs: 1200,
    startedAt: '2026-05-30T10:00:00.000Z',
    endedAt: '2026-05-30T10:00:01.200Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §2 writeSummary — atomic temp-then-rename
// ---------------------------------------------------------------------------

describe('writeSummary', () => {
  it(
    // test-plan §2 (🟡): summary.json is written atomically (temp-then-rename);
    // write a WorkRunSummary to a tmpdir, read it back, assert it round-trips.
    'writes summary.json and it round-trips correctly',
    () => {
      const runDir = tmpDir;
      const summary = makeSummary();

      writeSummary(runDir, summary);

      const summaryPath = join(runDir, 'summary.json');
      expect(existsSync(summaryPath)).toBe(true);

      const parsed: WorkRunSummary = JSON.parse(readFileSync(summaryPath, 'utf8'));
      expect(parsed).toEqual(summary);
    },
  );

  it(
    // Atomicity: no leftover .tmp file should remain after a successful write.
    'leaves no leftover .tmp file in the dir after write',
    () => {
      const runDir = tmpDir;
      const summary = makeSummary();

      writeSummary(runDir, summary);

      const files = readdirSync(runDir);
      const tmpFiles = files.filter(f => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    },
  );

  it(
    // Different run dirs produce isolated summary.json files
    'write to two different dirs produces two independent summary.json files',
    () => {
      const dirA = mkdtempSync(join(tmpdir(), 'wrs-a-'));
      const dirB = mkdtempSync(join(tmpdir(), 'wrs-b-'));

      try {
        const summaryA = makeSummary({ id: 'mut-a', outcome: 'noop' });
        const summaryB = makeSummary({ id: 'mut-b', outcome: 'branch-complete' });

        writeSummary(dirA, summaryA);
        writeSummary(dirB, summaryB);

        const parsedA: WorkRunSummary = JSON.parse(readFileSync(join(dirA, 'summary.json'), 'utf8'));
        const parsedB: WorkRunSummary = JSON.parse(readFileSync(join(dirB, 'summary.json'), 'utf8'));

        expect(parsedA.id).toBe('mut-a');
        expect(parsedB.id).toBe('mut-b');
        expect(parsedA.outcome).toBe('noop');
        expect(parsedB.outcome).toBe('branch-complete');
      } finally {
        rmSync(dirA, { recursive: true, force: true });
        rmSync(dirB, { recursive: true, force: true });
      }
    },
  );
});

describe('readWorkRunSummaryResult', () => {
  it('distinguishes missing, invalid, and valid ownership evidence', () => {
    expect(readWorkRunSummaryResult(tmpDir, 'missing-run')).toEqual({ status: 'missing' });

    const invalidDir = join(tmpDir, 'invalid-run');
    mkdirSync(invalidDir);
    writeFileSync(join(invalidDir, 'summary.json'), '{bad json');
    expect(readWorkRunSummaryResult(tmpDir, 'invalid-run')).toEqual({ status: 'invalid' });

    const nullTargetDir = join(tmpDir, 'null-target-run');
    mkdirSync(nullTargetDir);
    writeFileSync(join(nullTargetDir, 'summary.json'), JSON.stringify({
      ...makeSummary({ id: 'null-target-run' }),
      target: null,
    }));
    expect(readWorkRunSummaryResult(tmpDir, 'null-target-run')).toEqual({ status: 'invalid' });

    const valid = makeSummary({ id: 'valid-run' });
    writeSummary(join(tmpDir, 'valid-run'), valid);
    expect(readWorkRunSummaryResult(tmpDir, 'valid-run')).toEqual({ status: 'found', summary: valid });
  });

  it('round-trips a valid nested-role cancellation through the typed reader', () => {
    const summary = makeSummary({
      id: 'nested-cancel-run',
      cancellation: {
        role: 'reviewer',
        operationId: 'abc12345-1234-1234-1234-123456789abc',
        source: 'telegram',
        requestedAt: '2026-07-13T12:34:56.000Z',
      },
    });
    writeSummary(join(tmpDir, summary.id), summary);
    const summaryPath = join(tmpDir, summary.id, 'summary.json');
    const persisted = JSON.parse(readFileSync(summaryPath, 'utf8'));
    persisted.cancellation.unexpected = 'not part of the diagnostic DTO';
    writeFileSync(summaryPath, JSON.stringify(persisted));

    expect(readWorkRunSummaryResult(tmpDir, summary.id)).toEqual({
      status: 'found',
      summary,
    });
  });

  it('rejects a persisted cancellation with an unknown source', () => {
    const id = 'invalid-cancellation-run';
    const runDir = join(tmpDir, id);
    mkdirSync(runDir);
    writeFileSync(join(runDir, 'summary.json'), JSON.stringify({
      ...makeSummary({ id }),
      cancellation: {
        role: 'reviewer',
        operationId: 'abc12345-1234-1234-1234-123456789abc',
        source: 'web',
        requestedAt: '2026-07-13T12:34:56.000Z',
      },
    }));

    expect(readWorkRunSummaryResult(tmpDir, id)).toEqual({ status: 'invalid' });
  });
});

// ---------------------------------------------------------------------------
// §2 appendIndexRow + readRecentIndex — round-trip + torn-line handling
// ---------------------------------------------------------------------------

describe('appendIndexRow / readRecentIndex', () => {
  it(
    // test-plan §2 (🟡): appendIndexRow then readRecentIndex round-trips
    'appendIndexRow then readRecentIndex round-trips a single row',
    () => {
      const indexPath = join(tmpDir, 'index.jsonl');
      const row = makeIndexRow();

      appendIndexRow(indexPath, row);

      const rows = readRecentIndex(indexPath, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(row);
    },
  );

  it(
    // Multiple rows appended should all be readable
    'appending three rows and reading them back returns all three',
    () => {
      const indexPath = join(tmpDir, 'index.jsonl');
      const rowA = makeIndexRow({ id: 'mut-a', outcome: 'noop' });
      const rowB = makeIndexRow({ id: 'mut-b', outcome: 'partial' });
      const rowC = makeIndexRow({ id: 'mut-c', outcome: 'branch-complete' });

      appendIndexRow(indexPath, rowA);
      appendIndexRow(indexPath, rowB);
      appendIndexRow(indexPath, rowC);

      const rows = readRecentIndex(indexPath, 10);
      expect(rows).toHaveLength(3);
    },
  );

  it(
    // test-plan §2 (🟡): readRecentIndex returns rows newest-first
    'readRecentIndex returns rows newest-first',
    () => {
      const indexPath = join(tmpDir, 'index.jsonl');
      const rowA = makeIndexRow({ id: 'mut-first', startedAt: '2026-05-30T10:00:00.000Z' });
      const rowB = makeIndexRow({ id: 'mut-second', startedAt: '2026-05-30T11:00:00.000Z' });
      const rowC = makeIndexRow({ id: 'mut-third', startedAt: '2026-05-30T12:00:00.000Z' });

      appendIndexRow(indexPath, rowA);
      appendIndexRow(indexPath, rowB);
      appendIndexRow(indexPath, rowC);

      const rows = readRecentIndex(indexPath, 10);
      // Newest-first: last appended is first returned
      expect(rows[0]!.id).toBe('mut-third');
      expect(rows[1]!.id).toBe('mut-second');
      expect(rows[2]!.id).toBe('mut-first');
    },
  );

  it(
    // test-plan §2 (🟡): n cap is respected — readRecentIndex with n=2 returns
    // at most 2 rows
    'readRecentIndex respects the n cap',
    () => {
      const indexPath = join(tmpDir, 'index.jsonl');
      for (let i = 0; i < 5; i++) {
        appendIndexRow(indexPath, makeIndexRow({ id: `mut-${i}` }));
      }

      const rows = readRecentIndex(indexPath, 2);
      expect(rows).toHaveLength(2);
    },
  );

  it(
    // test-plan §2 (🟡): torn trailing line — file has 3 valid rows + a 4th
    // torn/garbage line; readRecentIndex returns the 3 valid rows newest-first
    // and does NOT throw.
    '3 valid rows + torn trailing line → 3 valid rows returned, no throw',
    () => {
      const indexPath = join(tmpDir, 'index.jsonl');
      const rowA = makeIndexRow({ id: 'mut-a' });
      const rowB = makeIndexRow({ id: 'mut-b' });
      const rowC = makeIndexRow({ id: 'mut-c' });

      // Write 3 valid JSON lines
      const validLines = [rowA, rowB, rowC].map(r => JSON.stringify(r)).join('\n');
      // Append a 4th torn/garbage line (partial JSON, no newline at end — crash mid-append)
      const torn = '\n{"id":"mut-d","project":"partial JSON without closing';
      writeFileSync(indexPath, validLines + torn, 'utf8');

      let rows: WorkRunIndexRow[];
      expect(() => {
        rows = readRecentIndex(indexPath, 10);
      }).not.toThrow();

      // The 3 valid rows are returned
      expect(rows!).toHaveLength(3);

      // Verify the torn line was not included
      const ids = rows!.map(r => r.id);
      expect(ids).not.toContain('mut-d');
    },
  );

  it(
    // Edge: readRecentIndex on a non-existent file should return [] gracefully
    // (mirrors the skip-malformed pattern from readRecentMutations).
    // The scaffold throws notImplemented, so this test will be RED until the
    // implementation handles a missing file by returning an empty array.
    'readRecentIndex on non-existent file returns [] (graceful, does not throw)',
    () => {
      const missingPath = join(tmpDir, 'nonexistent-index.jsonl');
      // The implementation must return an empty array for a missing file —
      // readers calling this at startup must not crash if no index exists yet.
      const rows = readRecentIndex(missingPath, 10);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(0);
    },
  );

  it(
    // test-plan §2 (🟡): mutation status stays in existing enum after
    // appendIndexRow — the index row has outcome, not status, so it cannot
    // corrupt the status enum. This test verifies the index row never gains
    // a status field (which would conflict with MutationStatus).
    'index rows carry outcome, not status — no status field on index rows',
    () => {
      const indexPath = join(tmpDir, 'index.jsonl');
      const row = makeIndexRow({ outcome: 'failed' });
      appendIndexRow(indexPath, row);

      const rows = readRecentIndex(indexPath, 10);
      expect(rows).toHaveLength(1);
      const retrieved = rows[0]!;

      // outcome is present
      expect(retrieved.outcome).toBe('failed');
      // status must NOT appear on index rows (it is a MutationDescriptor field,
      // not a WorkRunIndexRow field)
      expect(Object.prototype.hasOwnProperty.call(retrieved, 'status')).toBe(false);
    },
  );
});
