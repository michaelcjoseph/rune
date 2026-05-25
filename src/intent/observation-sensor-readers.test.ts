/**
 * Failing tests for `src/intent/observation-sensor-readers.ts` — project
 * 08-intent-layer Phase 6 B2.1. The module is the production filler for
 * `SensorReaders.vault` in `src/intent/observation-sensor.ts`.
 *
 * Written test-first; the module does not exist yet — every test must
 * fail with a missing-module or missing-export error.
 *
 * Scope: `readVaultSignals(opts)` scans recent journal files for
 * `#friction` / `#bug` / `#stuck` tags and recent world-view changelog
 * entries, returning a capped `SensorSignal[]`.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { readVaultSignals } = await import('./observation-sensor-readers.js');

import type { SensorSignal } from './observation-loop.js';

/** A fake vault filesystem the tests inject. Maps relative path → content,
 *  and relative dir → file list. */
interface FakeVault {
  files: Map<string, string>;
}

function buildVault(files: Record<string, string>): FakeVault {
  return { files: new Map(Object.entries(files)) };
}

/** Reader callbacks injected via opts so unit tests don't touch disk. */
function readers(vault: FakeVault) {
  return {
    readJournalFile: (filename: string): string | null => vault.files.get(`journals/${filename}`) ?? null,
    listWorldviewFiles: (): string[] =>
      Array.from(vault.files.keys())
        .filter((p) => p.startsWith('world-view/') && p.endsWith('.md'))
        .map((p) => p.slice('world-view/'.length)),
    readWorldviewFile: (filename: string): string | null => vault.files.get(`world-view/${filename}`) ?? null,
  };
}

const NOW = new Date('2026-05-25T12:00:00.000Z');

describe('readVaultSignals', () => {
  it('returns an empty array when no journals exist and no worldview tension is found', () => {
    const vault = buildVault({});
    const signals = readVaultSignals({ now: NOW, lookbackDays: 7, ...readers(vault) });
    expect(signals).toEqual([]);
  });

  it('emits a SensorSignal for each #friction / #bug / #stuck tag in recent journals', () => {
    const vault = buildVault({
      'journals/2026_05_24.md': [
        '## Notes',
        '- 10am tried to ship — broke #friction the build twice',
        '- 11am morning notes (no tag)',
        '- 12pm #bug whoop sync silently dropped yesterday',
        '- 3pm wrapped up',
      ].join('\n'),
      'journals/2026_05_23.md': [
        '- 9am pairing — #stuck on the policy parser',
      ].join('\n'),
    });
    const signals = readVaultSignals({ now: NOW, lookbackDays: 7, ...readers(vault) });
    expect(signals.length).toBeGreaterThanOrEqual(3);
    const contents = signals.map((s: SensorSignal) => s.content);
    expect(contents.some((c) => c.includes('#friction'))).toBe(true);
    expect(contents.some((c) => c.includes('#bug'))).toBe(true);
    expect(contents.some((c) => c.includes('#stuck'))).toBe(true);
  });

  it('every signal carries source="vault" and a parseable ts', () => {
    const vault = buildVault({
      'journals/2026_05_25.md': '- #friction the resolver misclassified twice today',
    });
    const signals = readVaultSignals({ now: NOW, lookbackDays: 7, ...readers(vault) });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.source).toBe('vault');
    expect(Number.isFinite(Date.parse(signals[0]!.ts))).toBe(true);
  });

  it('skips journals outside the lookback window', () => {
    const vault = buildVault({
      'journals/2026_05_25.md': '- #friction today',
      'journals/2026_05_01.md': '- #friction three+ weeks ago',
    });
    const signals = readVaultSignals({ now: NOW, lookbackDays: 7, ...readers(vault) });
    const contents = signals.map((s: SensorSignal) => s.content);
    expect(contents.some((c) => c.includes('today'))).toBe(true);
    expect(contents.some((c) => c.includes('weeks ago'))).toBe(false);
  });

  it('emits a SensorSignal for world-view changelog headings within the window', () => {
    const vault = buildVault({
      'world-view/ai.md': [
        '# AI',
        '## Thesis',
        'Models are improving fast.',
        '## Changelog',
        '### [[2026_05_24]]',
        'Updated thesis after a paper on long-context retention.',
        '### [[2025_12_01]]',
        'Initial draft.',
      ].join('\n'),
      'world-view/energy.md': [
        '# Energy',
        '## Changelog',
        '### [[2026_05_23]]',
        'New data on grid capacity.',
      ].join('\n'),
    });
    const signals = readVaultSignals({ now: NOW, lookbackDays: 7, ...readers(vault) });
    const wvContents = signals.filter((s) => s.content.includes('world-view/'));
    expect(wvContents.length).toBeGreaterThanOrEqual(2);
    expect(wvContents.some((s) => s.content.includes('ai.md'))).toBe(true);
    expect(wvContents.some((s) => s.content.includes('energy.md'))).toBe(true);
  });

  it('skips world-view changelog entries outside the window', () => {
    const vault = buildVault({
      'world-view/ai.md': [
        '## Changelog',
        '### [[2025_12_01]]',
        'Old entry.',
      ].join('\n'),
    });
    const signals = readVaultSignals({ now: NOW, lookbackDays: 7, ...readers(vault) });
    expect(signals).toEqual([]);
  });

  it('caps total signals at the default cap (20)', () => {
    // 30 journal lines all tagged #friction in one file → still capped at 20.
    const lines = Array.from({ length: 30 }, (_, i) => `- #friction issue ${i}`);
    const vault = buildVault({
      'journals/2026_05_25.md': lines.join('\n'),
    });
    const signals = readVaultSignals({ now: NOW, lookbackDays: 7, ...readers(vault) });
    expect(signals.length).toBeLessThanOrEqual(20);
    expect(signals.length).toBe(20);
  });

  it('honors a custom cap', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `- #friction issue ${i}`);
    const vault = buildVault({
      'journals/2026_05_25.md': lines.join('\n'),
    });
    const signals = readVaultSignals({ now: NOW, lookbackDays: 7, cap: 5, ...readers(vault) });
    expect(signals).toHaveLength(5);
  });

  it('missing journal file (null reader return) does not crash', () => {
    const vault = buildVault({});
    const signals = readVaultSignals({ now: NOW, lookbackDays: 7, ...readers(vault) });
    expect(signals).toEqual([]);
  });
});
