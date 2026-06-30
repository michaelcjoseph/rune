#!/usr/bin/env tsx
/**
 * Real-scale warm-index acceptance for Project 19 W1 Phase 2.
 *
 * Usage:
 *   npx tsx --env-file-if-exists=.env.local \
 *     src/kb/__acceptance__/vault-index-realscale.acceptance.ts
 *
 * Default behavior builds a generated ~72 MiB markdown vault dominated by
 * knowledge/ files. Set RUNE_REALSCALE_INDEX_VAULT_DIR to run against an
 * existing vault; the generated fixture is still the canonical destructive
 * proof that post-build queries read only resident index state.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

interface IndexedLine {
  file: string;
  line: number;
  content: string;
}

interface VaultIndexStatus {
  ready: boolean;
  status: string;
  lastRebuild: {
    files: number;
    lines: number;
    bytes: number;
    heapUsed: number;
    buildMs: number;
  } | null;
}

interface VaultIndexModule {
  buildVaultIndex: () => void;
  getVaultIndexStatus: () => VaultIndexStatus;
  queryVaultIndex: (
    query: string,
    options?: { directory?: string; maxResults?: number },
  ) => IndexedLine[];
}

interface AcceptanceRecord {
  fixture: string;
  fixtureBytes: number | null;
  thresholds: {
    buildMs: number;
    heapUsedBytes: number;
  };
  measured: {
    files: number;
    lines: number;
    bytes: number;
    heapUsed: number;
    buildMs: number;
  } | null;
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const NOTE_PATH = join(
  PROJECT_ROOT,
  'docs/projects/19-rune-product-os/realscale-index-budget-acceptance.md',
);
const SOURCE_PATH = join(PROJECT_ROOT, 'src/kb/vault-index.ts');

const TARGET_FIXTURE_BYTES = 72 * 1024 * 1024;
const DEFAULT_BUILD_BUDGET_MS = 10_000;
const DEFAULT_HEAP_BUDGET_BYTES = 512 * 1024 * 1024;
const KNOWLEDGE_FILE_COUNT = 64;
const PERIPHERAL_FILE_COUNT = 8;

class AcceptanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcceptanceError';
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AcceptanceError(message);
}

function assertNumber(value: unknown, label: string): asserts value is number {
  assert(typeof value === 'number' && Number.isFinite(value), `${label} must be a finite number`);
}

function parseAcceptanceRecord(): AcceptanceRecord {
  assert(existsSync(NOTE_PATH), `missing acceptance note at ${NOTE_PATH}`);
  const note = readFileSync(NOTE_PATH, 'utf8');
  const match = note.match(/```json\s*([\s\S]*?)\s*```/);
  assert(match?.[1], 'acceptance note must contain a JSON code block');
  const parsed = JSON.parse(match[1]) as AcceptanceRecord;

  assertNumber(parsed.thresholds?.buildMs, 'thresholds.buildMs');
  assertNumber(parsed.thresholds?.heapUsedBytes, 'thresholds.heapUsedBytes');
  assert(
    parsed.thresholds.buildMs <= DEFAULT_BUILD_BUDGET_MS,
    `build budget must start at or tighten below ${DEFAULT_BUILD_BUDGET_MS}ms`,
  );
  assert(
    parsed.thresholds.heapUsedBytes <= DEFAULT_HEAP_BUDGET_BYTES,
    `heap budget must start at or tighten below ${DEFAULT_HEAP_BUDGET_BYTES} bytes`,
  );

  if (parsed.measured) {
    for (const key of ['files', 'lines', 'bytes', 'heapUsed', 'buildMs'] as const) {
      assertNumber(parsed.measured[key], `measured.${key}`);
      assert(parsed.measured[key] > 0, `measured.${key} must be positive`);
    }
    assertNumber(parsed.fixtureBytes, 'fixtureBytes');
    assert(parsed.fixtureBytes >= TARGET_FIXTURE_BYTES, 'fixtureBytes must cover at least ~72 MiB');

    const buildCeiling = Math.max(parsed.measured.buildMs * 2, parsed.measured.buildMs + 1_000);
    assert(
      parsed.thresholds.buildMs > parsed.measured.buildMs &&
        parsed.thresholds.buildMs <= buildCeiling,
      'thresholds.buildMs must be a sane margin above the recorded measurement',
    );

    const heapCeiling = Math.max(parsed.measured.heapUsed * 2, parsed.measured.heapUsed + 64 * 1024 * 1024);
    assert(
      parsed.thresholds.heapUsedBytes > parsed.measured.heapUsed &&
        parsed.thresholds.heapUsedBytes <= heapCeiling,
      'thresholds.heapUsedBytes must be a sane margin above the recorded measurement',
    );
  }

  return parsed;
}

function writeSizedMarkdown(filePath: string, targetBytes: number, header: string): number {
  mkdirSync(dirname(filePath), { recursive: true });
  const fd = openSync(filePath, 'w');
  let bytes = 0;
  const headerBuffer = Buffer.from(`${header}\n`, 'utf8');
  const chunk = Buffer.from(
    Array.from({ length: 512 }, (_, i) => (
      `scale filler line ${i.toString().padStart(3, '0')} with [[links]] #tags and repeatable markdown content\n`
    )).join(''),
    'utf8',
  );

  try {
    bytes += writeSync(fd, headerBuffer);
    while (bytes < targetBytes) {
      bytes += writeSync(fd, chunk);
    }
  } finally {
    closeSync(fd);
  }

  return bytes;
}

function createGeneratedFixture(): { root: string; bytes: number } {
  const root = mkdtempSync(join(tmpdir(), 'rune-vault-index-realscale-'));
  let bytes = 0;
  const perFileBytes = Math.ceil(TARGET_FIXTURE_BYTES / (KNOWLEDGE_FILE_COUNT + PERIPHERAL_FILE_COUNT));

  for (let i = 0; i < KNOWLEDGE_FILE_COUNT; i += 1) {
    const marker = i === 0 ? 'REALSCALE_KNOWLEDGE_MARKER resident proof' : `knowledge scale file ${i}`;
    bytes += writeSizedMarkdown(
      join(root, 'knowledge/scale', `knowledge-${i.toString().padStart(2, '0')}.md`),
      perFileBytes,
      marker,
    );
  }

  const peripheralDirs = ['world-view', 'pages', 'projects', 'journals'] as const;
  for (let i = 0; i < PERIPHERAL_FILE_COUNT; i += 1) {
    const directory = peripheralDirs[i % peripheralDirs.length]!;
    const marker = i === 0 ? 'REALSCALE_PERIPHERAL_MARKER resident proof' : `${directory} scale file ${i}`;
    bytes += writeSizedMarkdown(
      join(root, directory, `peripheral-${i.toString().padStart(2, '0')}.md`),
      perFileBytes,
      marker,
    );
  }

  assert(bytes >= TARGET_FIXTURE_BYTES, 'generated fixture did not reach the target size');
  return { root, bytes };
}

function assertQueryDoesNotWalkVaultSource(): void {
  const source = readFileSync(SOURCE_PATH, 'utf8');
  const queryStart = source.indexOf('export function queryVaultIndex');
  assert(queryStart >= 0, 'queryVaultIndex export is missing');
  const querySource = source.slice(queryStart);
  assert(
    !/\b(?:readdirSync|readFileSync|statSync|lstatSync|realpathSync|walkDirectory|buildReplacementIndex)\b/.test(querySource),
    'queryVaultIndex must answer from resident index state, not per-query filesystem walking',
  );
}

function parseVaultIndexBuildLogs(lines: string[]): Record<string, unknown>[] {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as {
          component?: string;
          message?: string;
          data?: Record<string, unknown>;
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { data: Record<string, unknown> } => (
      entry?.component === 'vault-index' &&
      entry.message === 'Built vault index' &&
      !!entry.data
    ))
    .map((entry) => entry.data);
}

async function main(): Promise<void> {
  const record = parseAcceptanceRecord();
  assertQueryDoesNotWalkVaultSource();

  const suppliedVault = process.env['RUNE_REALSCALE_INDEX_VAULT_DIR'];
  const generated = suppliedVault ? null : createGeneratedFixture();
  const vaultRoot = suppliedVault ? resolve(suppliedVault) : generated!.root;
  process.env['VAULT_DIR'] = vaultRoot;

  const logLines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
    originalLog(...args);
  };

  try {
    const mod = (await import('../vault-index.js')) as unknown as VaultIndexModule;
    const startedAt = performance.now();
    mod.buildVaultIndex();
    const wallMs = Math.round(performance.now() - startedAt);
    const status = mod.getVaultIndexStatus();
    const stats = status.lastRebuild;

    assert(status.ready, `index should be ready after build, got status=${status.status}`);
    assert(stats, 'build must report lastRebuild stats');
    assert(stats.files > 0, 'build must index files');
    assert(stats.lines > 0, 'build must index lines');
    assert(stats.bytes >= (generated?.bytes ?? record.fixtureBytes ?? TARGET_FIXTURE_BYTES), 'build stats must report real indexed bytes');
    assert(stats.buildMs < record.thresholds.buildMs, `buildMs ${stats.buildMs} exceeded ${record.thresholds.buildMs}`);
    assert(stats.heapUsed < record.thresholds.heapUsedBytes, `heapUsed ${stats.heapUsed} exceeded ${record.thresholds.heapUsedBytes}`);

    const buildLogs = parseVaultIndexBuildLogs(logLines);
    assert(buildLogs.length > 0, 'build must emit a vault-index build log');
    const latestLog = buildLogs[buildLogs.length - 1]!;
    for (const key of ['files', 'lines', 'bytes', 'heapUsed', 'buildMs']) {
      assertNumber(latestLog[key], `build log ${key}`);
    }

    const knowledgeHit = mod.queryVaultIndex('REALSCALE_KNOWLEDGE_MARKER', { maxResults: 5 });
    assert(
      suppliedVault || knowledgeHit.some((hit) => hit.file.startsWith('knowledge/')),
      'generated fixture query must hit knowledge/ from the resident index',
    );

    if (generated) {
      const peripheralHit = mod.queryVaultIndex('REALSCALE_PERIPHERAL_MARKER', { maxResults: 5 });
      assert(
        peripheralHit.some((hit) => hit.file.startsWith('world-view/')),
        'generated fixture query must hit a peripheral folder from the resident index',
      );

      rmSync(vaultRoot, { recursive: true, force: true });
      assert(
        mod.queryVaultIndex('REALSCALE_KNOWLEDGE_MARKER', { maxResults: 5 }).some((hit) => hit.file.startsWith('knowledge/')),
        'query after fixture removal must still answer from resident index state',
      );
      assert(
        mod.queryVaultIndex('REALSCALE_PERIPHERAL_MARKER', { maxResults: 5 }).some((hit) => hit.file.startsWith('world-view/')),
        'peripheral query after fixture removal must still answer from resident index state',
      );
    }

    console.log(JSON.stringify({
      acceptance: 'vault-index-realscale',
      fixture: suppliedVault ? 'real-vault' : 'generated-72mb',
      fixtureBytes: generated?.bytes ?? stats.bytes,
      measured: {
        ...stats,
        wallMs,
      },
    }, null, 2));

    assert(record.measured, 'record the measured numbers above in the acceptance note before closeout');
  } finally {
    console.log = originalLog;
    if (generated && existsSync(generated.root)) {
      rmSync(generated.root, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[vault-index-realscale] ${message}`);
  process.exitCode = 1;
});
