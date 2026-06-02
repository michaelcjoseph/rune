/**
 * Phase 1 tests for project 10-jarvis-identity-refactor.
 * Covers test-plan.md §1: Snapshot completeness, Inventory tooling, Ownership manifest.
 *
 * These tests are written FIRST and must fail (red) until Phase 1 implementation
 * tasks produce the actual artifacts. Red is the deliverable for this task.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import path from 'node:path';

// All paths are resolved dynamically from process.cwd(), which vitest sets to the repo root.
const PROJECT_ROOT = path.resolve(process.cwd());
const PHASE1_DIR = path.resolve(PROJECT_ROOT, 'docs/projects/10-jarvis-identity-refactor');
const SNAPSHOTS_DIR = path.resolve(PHASE1_DIR, 'snapshots');
const TOOLS_DIR = path.resolve(PHASE1_DIR, 'tools');
const LIST_SECTIONS_SCRIPT = path.resolve(TOOLS_DIR, 'list-sections.sh');
const INVENTORY_FILE = path.resolve(PHASE1_DIR, 'inventory.md');
const OWNERSHIP_FILE = path.resolve(PHASE1_DIR, 'ownership.md');
const MISSING_MARKER = path.resolve(SNAPSHOTS_DIR, 'MISSING.md');

// Always-required snapshot files (repos whose instruction files definitely existed).
const REQUIRED_SNAPSHOTS = [
  'pkms-CLAUDE.md',
  'jarvis-CLAUDE.md',
  'jarvis-AGENTS.md',
];

// Conditional variants: each must EITHER be present as a snapshot file OR recorded in MISSING.md.
const CONDITIONAL_SNAPSHOT_VARIANTS = [
  'aura-CLAUDE.md',
  'aura-AGENTS.md',
  'assay-CLAUDE.md',
  'assay-AGENTS.md',
];

// Relay MUST NOT have snapshot files (spec: relay has no pre-migration instruction files).
const FORBIDDEN_SNAPSHOTS = [
  'relay-CLAUDE.md',
  'relay-AGENTS.md',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read MISSING.md content, returning empty string if not present. */
function readMissingMarker(): string {
  if (!existsSync(MISSING_MARKER)) return '';
  return readFileSync(MISSING_MARKER, 'utf8');
}

/** Collect all headings (lines starting with one or more `#`) from snapshot files. */
function collectSnapshotHeadings(): string[] {
  const headings: string[] = [];
  if (!existsSync(SNAPSHOTS_DIR)) return headings;
  const entries = readdirSync(SNAPSHOTS_DIR);
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const fullPath = path.resolve(SNAPSHOTS_DIR, entry);
    if (!statSync(fullPath).isFile()) continue;
    const content = readFileSync(fullPath, 'utf8');
    for (const line of content.split('\n')) {
      if (/^#{1,6}\s/.test(line)) {
        headings.push(line.trim());
      }
    }
  }
  return headings;
}

/** Parse a markdown table from text. Returns rows (excluding header separator rows). */
function parseMarkdownTableRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    // Skip separator rows like |---|---|
    if (/^\|[\s\-|:]+\|$/.test(trimmed)) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1) // drop the empty leading/trailing fields produced by split on a `|...|` row
      .map((c) => c.trim());
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  return rows;
}

/** Run list-sections.sh, failing the test cleanly if the script does not exist yet. */
function runListSections(): SpawnSyncReturns<string> {
  if (!existsSync(LIST_SECTIONS_SCRIPT)) {
    expect.fail(`${LIST_SECTIONS_SCRIPT} does not exist — cannot run it`);
  }
  return spawnSync('bash', [LIST_SECTIONS_SCRIPT], {
    cwd: PHASE1_DIR,
    encoding: 'utf8',
    timeout: 8_000,
  });
}

/** Read and parse ownership.md table rows, failing the test cleanly if it does not exist yet. */
function readOwnershipRows(): string[][] {
  if (!existsSync(OWNERSHIP_FILE)) {
    expect.fail(`${OWNERSHIP_FILE} does not exist`);
  }
  return parseMarkdownTableRows(readFileSync(OWNERSHIP_FILE, 'utf8'));
}

// ---------------------------------------------------------------------------
// 1. Snapshot completeness
// ---------------------------------------------------------------------------

describe('Snapshot completeness', () => {
  it.each(REQUIRED_SNAPSHOTS)(
    'always-required snapshot %s exists as a regular file',
    (filename) => {
      const p = path.resolve(SNAPSHOTS_DIR, filename);
      expect(existsSync(p), `${p} does not exist`).toBe(true);
      expect(statSync(p).isFile(), `${p} is not a regular file`).toBe(true);
    },
  );

  it.each(CONDITIONAL_SNAPSHOT_VARIANTS)(
    'conditional snapshot %s is either present or recorded in MISSING.md',
    (filename) => {
      const filePath = path.resolve(SNAPSHOTS_DIR, filename);
      const filePresent = existsSync(filePath) && statSync(filePath).isFile();
      const missingContent = readMissingMarker();
      const recordedAsMissing = missingContent.includes(filename);

      expect(
        filePresent || recordedAsMissing,
        `${filename} is neither present in snapshots/ nor recorded in MISSING.md`,
      ).toBe(true);
    },
  );

  it('MISSING.md exists (required to account for conditional snapshots)', () => {
    // Contract: MISSING.md must always exist as the explicit accounting record for
    // the conditional aura/assay variants — even when every variant is present as a
    // snapshot (in which case it records "none missing"). Making the file mandatory
    // forces the implementer to affirmatively state which pre-migration files were
    // absent rather than leaving absence implicit. The per-variant test above asserts
    // each variant is either a real snapshot or named in this file.
    expect(
      existsSync(MISSING_MARKER),
      `${MISSING_MARKER} does not exist — needed to account for conditional snapshots`,
    ).toBe(true);
  });

  it.each(FORBIDDEN_SNAPSHOTS)(
    'relay snapshot %s MUST NOT exist (relay has no pre-migration instruction files)',
    (filename) => {
      const filePath = path.resolve(SNAPSHOTS_DIR, filename);
      expect(
        existsSync(filePath),
        `${filePath} exists but relay must have no pre-migration snapshots`,
      ).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Inventory tooling
// ---------------------------------------------------------------------------

describe('Inventory tooling', () => {
  it('tools/list-sections.sh exists', () => {
    expect(existsSync(LIST_SECTIONS_SCRIPT), `${LIST_SECTIONS_SCRIPT} does not exist`).toBe(true);
  });

  it('tools/list-sections.sh is executable (mode bits include x)', () => {
    // existsSync guard so a missing script fails on a clean expect, not a statSync throw.
    expect(existsSync(LIST_SECTIONS_SCRIPT), `${LIST_SECTIONS_SCRIPT} does not exist — cannot check mode bits`).toBe(true);
    const mode = statSync(LIST_SECTIONS_SCRIPT).mode;
    // Check owner-execute bit (0o100)
    const ownerExecutable = (mode & 0o100) !== 0;
    expect(ownerExecutable, `${LIST_SECTIONS_SCRIPT} is not executable (mode: ${mode.toString(8)})`).toBe(true);
  });

  it('tools/list-sections.sh exits 0 when run', () => {
    const result = runListSections();
    expect(result.status, `list-sections.sh exited ${result.status}: ${result.stderr}`).toBe(0);
  });

  it('tools/list-sections.sh stdout is a non-empty markdown table', () => {
    const result = runListSections();
    const stdout = result.stdout ?? '';
    expect(stdout.trim().length, 'script produced no output').toBeGreaterThan(0);
    // A markdown table has at least one line starting with |
    const hasTableLine = stdout.split('\n').some((line) => line.trim().startsWith('|'));
    expect(hasTableLine, 'script output does not contain any markdown table rows (lines starting with |)').toBe(true);
  });

  it('every Markdown heading found in snapshot files appears in list-sections.sh output', () => {
    const headings = collectSnapshotHeadings();
    // If there are no snapshot files yet, this assertion fails with a clear message;
    // the REQUIRED_SNAPSHOTS tests above also fail, making the full red cascade visible.
    expect(headings.length, 'no headings found in snapshot files — snapshots may be missing').toBeGreaterThan(0);

    const result = runListSections();
    const stdout = result.stdout ?? '';

    const missingFromOutput: string[] = [];
    for (const heading of headings) {
      // Strip leading # chars and whitespace for the substring check; the table
      // may render them differently (e.g., without the `#` sigil).
      const headingText = heading.replace(/^#+\s*/, '').trim();
      if (!stdout.includes(headingText)) {
        missingFromOutput.push(heading);
      }
    }
    expect(
      missingFromOutput,
      `These headings from snapshot files were not found in list-sections.sh output:\n${missingFromOutput.join('\n')}`,
    ).toHaveLength(0);
  });

  it('list-sections.sh output flags duplicate/common/shared content between jarvis-CLAUDE.md and jarvis-AGENTS.md snapshots', () => {
    const result = runListSections();
    const stdout = (result.stdout ?? '').toLowerCase();
    const flagsDuplicates =
      stdout.includes('duplicate') || stdout.includes('common') || stdout.includes('shared');
    expect(
      flagsDuplicates,
      'list-sections.sh output does not mention "duplicate", "common", or "shared" — expected duplicate-content detection between jarvis CLAUDE.md and AGENTS.md snapshots',
    ).toBe(true);
  });

  it('inventory.md exists at docs/projects/10-jarvis-identity-refactor/inventory.md', () => {
    expect(existsSync(INVENTORY_FILE), `${INVENTORY_FILE} does not exist`).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Ownership manifest
// ---------------------------------------------------------------------------

describe('Ownership manifest', () => {
  it('ownership.md exists', () => {
    expect(existsSync(OWNERSHIP_FILE), `${OWNERSHIP_FILE} does not exist`).toBe(true);
  });

  it('ownership.md contains a markdown table with exactly 5 header columns', () => {
    const rows = readOwnershipRows();
    expect(rows.length, 'ownership.md contains no markdown table rows').toBeGreaterThan(0);

    // The first row must be the header row with 5 columns.
    const headerRow = rows[0] ?? [];
    expect(
      headerRow.length,
      `ownership.md header row has ${headerRow.length} columns, expected 5 (heading | snapshot file | new owner | target fragment | notes)`,
    ).toBe(5);
  });

  it('ownership.md header row contains expected column names (case-insensitive substring match)', () => {
    const rows = readOwnershipRows();
    expect(rows.length, 'ownership.md contains no table rows').toBeGreaterThan(0);

    const rawHeader = rows[0] ?? [];
    const headerRow = rawHeader.map((c) => c.toLowerCase());
    const expectedSubstrings = ['heading', 'snapshot', 'owner', 'fragment', 'note'];
    const missing: string[] = [];
    for (const expected of expectedSubstrings) {
      const found = headerRow.some((cell) => cell.includes(expected));
      if (!found) missing.push(expected);
    }
    expect(
      missing,
      `ownership.md header row does not contain columns matching: ${missing.join(', ')}\nActual header: ${rawHeader.join(' | ')}`,
    ).toHaveLength(0);
  });

  it('every data row in ownership.md has all 5 cells non-empty', () => {
    const rows = readOwnershipRows();
    // Skip header row (index 0); check all data rows.
    const dataRows = rows.slice(1);
    expect(dataRows.length, 'ownership.md has no data rows (only header)').toBeGreaterThan(0);

    const failingRows: Array<{ rowIndex: number; cells: string[]; emptyCols: number[] }> = [];
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      if (!row) continue; // unreachable given the loop bound; narrows row to string[]
      if (row.length !== 5) {
        failingRows.push({ rowIndex: i + 2, cells: row, emptyCols: [] });
        continue;
      }
      const emptyCols: number[] = [];
      for (let j = 0; j < row.length; j++) {
        const cell = (row[j] ?? '').trim();
        // Treat empty strings, single dashes, and placeholder-like values as empty.
        if (cell === '' || cell === '-' || cell === '—') {
          emptyCols.push(j + 1);
        }
      }
      if (emptyCols.length > 0) {
        failingRows.push({ rowIndex: i + 2, cells: row, emptyCols });
      }
    }

    const messages = failingRows.map(
      ({ rowIndex, cells, emptyCols }) =>
        `Row ${rowIndex}: empty columns ${emptyCols.join(', ')} — [${cells.join(' | ')}]`,
    );
    expect(
      failingRows,
      `ownership.md has rows with empty cells:\n${messages.join('\n')}`,
    ).toHaveLength(0);
  });
});
