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

const { readVaultSignals, readTelemetrySignals, readInteractionSignals } = await import('./observation-sensor-readers.js');

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

// ---------------------------------------------------------------------------
// readTelemetrySignals (Phase 6 B2.2)
// ---------------------------------------------------------------------------
//
// Source: agent-runs.jsonl + mutations.jsonl.
// Output: one SensorSignal per (agent with N+ failures in window) and per
// (project slug with M+ failed work-runs in window). Per-product (Aura /
// Assay) telemetry is deferred — module doc notes the gap.

/** Build a JSONL string from an array of entry objects. */
function jsonl(entries: Array<Record<string, unknown>>): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

const TELEMETRY_NOW = new Date('2026-05-25T12:00:00.000Z');
const RECENT_ISO = '2026-05-25T10:00:00.000Z'; // within 7-day window
const OLD_ISO = '2026-04-01T10:00:00.000Z'; // outside 7-day window

describe('readTelemetrySignals', () => {
  it('returns [] when both log readers return empty/null', () => {
    const signals = readTelemetrySignals({
      now: TELEMETRY_NOW,
      lookbackDays: 7,
      readAgentRunsLog: () => null,
      readMutationsLog: () => null,
    });
    expect(signals).toEqual([]);
  });

  it('emits a SensorSignal when an agent has 3+ failures in the window (default threshold)', () => {
    const runs = jsonl([
      { agent: 'wiki-compiler', startedAt: RECENT_ISO, durationMs: 100, status: 'error' },
      { agent: 'wiki-compiler', startedAt: RECENT_ISO, durationMs: 100, status: 'error' },
      { agent: 'wiki-compiler', startedAt: RECENT_ISO, durationMs: 100, status: 'error' },
      { agent: 'wiki-compiler', startedAt: RECENT_ISO, durationMs: 100, status: 'success' },
    ]);
    const signals = readTelemetrySignals({
      now: TELEMETRY_NOW,
      lookbackDays: 7,
      readAgentRunsLog: () => runs,
      readMutationsLog: () => null,
    });
    const agentSignals = signals.filter((s) => s.content.includes('wiki-compiler'));
    expect(agentSignals.length).toBeGreaterThanOrEqual(1);
    expect(agentSignals[0]!.source).toBe('telemetry');
    expect(agentSignals[0]!.content).toMatch(/3.*fail/i);
  });

  it('does NOT emit when failure count is below the default threshold (3)', () => {
    const runs = jsonl([
      { agent: 'wiki-compiler', startedAt: RECENT_ISO, durationMs: 100, status: 'error' },
      { agent: 'wiki-compiler', startedAt: RECENT_ISO, durationMs: 100, status: 'error' },
    ]);
    const signals = readTelemetrySignals({
      now: TELEMETRY_NOW,
      lookbackDays: 7,
      readAgentRunsLog: () => runs,
      readMutationsLog: () => null,
    });
    expect(signals.filter((s) => s.content.includes('wiki-compiler'))).toHaveLength(0);
  });

  it('drops agent-runs entries outside the lookback window', () => {
    const runs = jsonl([
      { agent: 'wiki-compiler', startedAt: OLD_ISO, durationMs: 100, status: 'error' },
      { agent: 'wiki-compiler', startedAt: OLD_ISO, durationMs: 100, status: 'error' },
      { agent: 'wiki-compiler', startedAt: OLD_ISO, durationMs: 100, status: 'error' },
    ]);
    const signals = readTelemetrySignals({
      now: TELEMETRY_NOW,
      lookbackDays: 7,
      readAgentRunsLog: () => runs,
      readMutationsLog: () => null,
    });
    expect(signals).toEqual([]);
  });

  it('emits a SensorSignal when a work-run project slug has 2+ failures in the window (default threshold)', () => {
    const mutations = jsonl([
      { id: 'm1', kind: 'work-run', target: { type: 'work-run', ref: '08-intent-layer' }, status: 'failed', createdAt: RECENT_ISO, payload: { projectSlug: '08-intent-layer' }, source: 'review', preview: { summary: '' } },
      { id: 'm2', kind: 'work-run', target: { type: 'work-run', ref: '08-intent-layer' }, status: 'failed', createdAt: RECENT_ISO, payload: { projectSlug: '08-intent-layer' }, source: 'review', preview: { summary: '' } },
    ]);
    const signals = readTelemetrySignals({
      now: TELEMETRY_NOW,
      lookbackDays: 7,
      readAgentRunsLog: () => null,
      readMutationsLog: () => mutations,
    });
    const slugSignals = signals.filter((s) => s.content.includes('08-intent-layer'));
    expect(slugSignals.length).toBeGreaterThanOrEqual(1);
    expect(slugSignals[0]!.source).toBe('telemetry');
    expect(slugSignals[0]!.content).toMatch(/2.*fail/i);
  });

  it('only counts mutations of kind work-run for the slug-failure scan', () => {
    const mutations = jsonl([
      { id: 'm1', kind: 'gen-eval-loop', target: { type: '', ref: 'aura/01-growth' }, status: 'failed', createdAt: RECENT_ISO, payload: {}, source: 'webview', preview: { summary: '' } },
      { id: 'm2', kind: 'gen-eval-loop', target: { type: '', ref: 'aura/01-growth' }, status: 'failed', createdAt: RECENT_ISO, payload: {}, source: 'webview', preview: { summary: '' } },
    ]);
    const signals = readTelemetrySignals({
      now: TELEMETRY_NOW,
      lookbackDays: 7,
      readAgentRunsLog: () => null,
      readMutationsLog: () => mutations,
    });
    expect(signals).toEqual([]);
  });

  it('drops mutations outside the lookback window', () => {
    const mutations = jsonl([
      { id: 'm1', kind: 'work-run', target: { type: 'work-run', ref: '01-mvp' }, status: 'failed', createdAt: OLD_ISO, payload: { projectSlug: '01-mvp' }, source: 'review', preview: { summary: '' } },
      { id: 'm2', kind: 'work-run', target: { type: 'work-run', ref: '01-mvp' }, status: 'failed', createdAt: OLD_ISO, payload: { projectSlug: '01-mvp' }, source: 'review', preview: { summary: '' } },
    ]);
    const signals = readTelemetrySignals({
      now: TELEMETRY_NOW,
      lookbackDays: 7,
      readAgentRunsLog: () => null,
      readMutationsLog: () => mutations,
    });
    expect(signals).toEqual([]);
  });

  it('honors custom thresholds via opts', () => {
    const runs = jsonl([
      { agent: 'kb-query', startedAt: RECENT_ISO, durationMs: 50, status: 'error' },
      { agent: 'kb-query', startedAt: RECENT_ISO, durationMs: 50, status: 'error' },
    ]);
    const signals = readTelemetrySignals({
      now: TELEMETRY_NOW,
      lookbackDays: 7,
      agentFailureThreshold: 2,
      readAgentRunsLog: () => runs,
      readMutationsLog: () => null,
    });
    expect(signals.filter((s) => s.content.includes('kb-query'))).toHaveLength(1);
  });

  it('skips malformed JSONL lines without crashing', () => {
    const runs = [
      JSON.stringify({ agent: 'wiki-compiler', startedAt: RECENT_ISO, durationMs: 100, status: 'error' }),
      'not valid json {',
      JSON.stringify({ agent: 'wiki-compiler', startedAt: RECENT_ISO, durationMs: 100, status: 'error' }),
      JSON.stringify({ agent: 'wiki-compiler', startedAt: RECENT_ISO, durationMs: 100, status: 'error' }),
    ].join('\n');
    const signals = readTelemetrySignals({
      now: TELEMETRY_NOW,
      lookbackDays: 7,
      readAgentRunsLog: () => runs,
      readMutationsLog: () => null,
    });
    const agentSignals = signals.filter((s) => s.content.includes('wiki-compiler'));
    expect(agentSignals.length).toBeGreaterThanOrEqual(1);
  });

  it('every signal has source="telemetry" and a parseable ts', () => {
    const runs = jsonl([
      { agent: 'wiki-compiler', startedAt: RECENT_ISO, durationMs: 100, status: 'error' },
      { agent: 'wiki-compiler', startedAt: RECENT_ISO, durationMs: 100, status: 'error' },
      { agent: 'wiki-compiler', startedAt: RECENT_ISO, durationMs: 100, status: 'error' },
    ]);
    const signals = readTelemetrySignals({
      now: TELEMETRY_NOW,
      lookbackDays: 7,
      readAgentRunsLog: () => runs,
      readMutationsLog: () => null,
    });
    for (const s of signals) {
      expect(s.source).toBe('telemetry');
      expect(Number.isFinite(Date.parse(s.ts))).toBe(true);
    }
  });

  it('honors a custom cap', () => {
    // 10 distinct agents each with 3+ failures → 10 signals, capped at 3.
    const entries: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i++) {
      const agent = `agent-${i}`;
      for (let j = 0; j < 3; j++) {
        entries.push({ agent, startedAt: RECENT_ISO, durationMs: 100, status: 'error' });
      }
    }
    const signals = readTelemetrySignals({
      now: TELEMETRY_NOW,
      lookbackDays: 7,
      cap: 3,
      readAgentRunsLog: () => jsonl(entries),
      readMutationsLog: () => null,
    });
    expect(signals).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// readInteractionSignals (Phase 6 B2.3)
// ---------------------------------------------------------------------------
//
// Source: logs/observation-interactions.jsonl (the B1 writer's output).
// Output: one SensorSignal per (kind, outcome) bucket whose count meets
// the failure threshold within the lookback hours. Bucket grain uses
// kind+outcome only — `detail` is structured but heterogeneous across
// kinds (e.g., `route=/fresh`, `agent=wiki-compiler dur=200`), so the
// reader counts patterns, not exact detail strings.

/** "Now" for the interaction tests — same fixed clock as telemetry. */
const INTERACTION_NOW = new Date('2026-05-25T12:00:00.000Z');
/** Inside the 24-hour default window. */
const RECENT_INTERACTION_ISO = '2026-05-25T08:00:00.000Z';
/** Outside the 24-hour default window. */
const OLD_INTERACTION_ISO = '2026-05-22T08:00:00.000Z';

describe('readInteractionSignals', () => {
  it('returns [] when the reader returns null (no file)', () => {
    const signals = readInteractionSignals({
      now: INTERACTION_NOW,
      readInteractionsLog: () => null,
    });
    expect(signals).toEqual([]);
  });

  it('returns [] when no bucket meets the failure threshold', () => {
    const interactions = jsonl([
      { ts: RECENT_INTERACTION_ISO, kind: 'agent-call', outcome: 'success', detail: 'agent=wiki-compiler dur=100' },
      { ts: RECENT_INTERACTION_ISO, kind: 'agent-call', outcome: 'failure', detail: 'agent=wiki-compiler dur=100' },
      { ts: RECENT_INTERACTION_ISO, kind: 'tg-message', outcome: 'success', detail: 'route=/fresh' },
    ]);
    const signals = readInteractionSignals({
      now: INTERACTION_NOW,
      readInteractionsLog: () => interactions,
    });
    // Default threshold is 3 failures within window — only 1 failure here.
    expect(signals).toEqual([]);
  });

  it('emits a signal when failure bucket meets the default threshold (3)', () => {
    const interactions = jsonl([
      { ts: RECENT_INTERACTION_ISO, kind: 'agent-call', outcome: 'failure', detail: 'agent=wiki-compiler dur=100' },
      { ts: RECENT_INTERACTION_ISO, kind: 'agent-call', outcome: 'failure', detail: 'agent=wiki-compiler dur=100' },
      { ts: RECENT_INTERACTION_ISO, kind: 'agent-call', outcome: 'failure', detail: 'agent=other dur=100' },
    ]);
    const signals = readInteractionSignals({
      now: INTERACTION_NOW,
      readInteractionsLog: () => interactions,
    });
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0]!.source).toBe('interaction');
    expect(signals[0]!.content).toMatch(/agent-call/);
    expect(signals[0]!.content).toMatch(/3.*fail/i);
  });

  it('drops interactions outside the lookback hours (24 default)', () => {
    const interactions = jsonl([
      { ts: OLD_INTERACTION_ISO, kind: 'agent-call', outcome: 'failure', detail: 'a' },
      { ts: OLD_INTERACTION_ISO, kind: 'agent-call', outcome: 'failure', detail: 'b' },
      { ts: OLD_INTERACTION_ISO, kind: 'agent-call', outcome: 'failure', detail: 'c' },
    ]);
    const signals = readInteractionSignals({
      now: INTERACTION_NOW,
      readInteractionsLog: () => interactions,
    });
    expect(signals).toEqual([]);
  });

  it('honors custom lookbackHours', () => {
    // 30 hours ago — inside a custom 48h window, outside the default 24h.
    const ts30hAgo = new Date(INTERACTION_NOW.getTime() - 30 * 60 * 60 * 1000).toISOString();
    const interactions = jsonl([
      { ts: ts30hAgo, kind: 'command', outcome: 'failure', detail: 'cmd=workout' },
      { ts: ts30hAgo, kind: 'command', outcome: 'failure', detail: 'cmd=workout' },
      { ts: ts30hAgo, kind: 'command', outcome: 'failure', detail: 'cmd=workout' },
    ]);
    const defaultWindow = readInteractionSignals({
      now: INTERACTION_NOW,
      readInteractionsLog: () => interactions,
    });
    expect(defaultWindow).toEqual([]);
    const wideWindow = readInteractionSignals({
      now: INTERACTION_NOW,
      lookbackHours: 48,
      readInteractionsLog: () => interactions,
    });
    expect(wideWindow.length).toBeGreaterThanOrEqual(1);
  });

  it('honors custom failure threshold', () => {
    const interactions = jsonl([
      { ts: RECENT_INTERACTION_ISO, kind: 'webview', outcome: 'failure', detail: 'action=mutation-create' },
      { ts: RECENT_INTERACTION_ISO, kind: 'webview', outcome: 'failure', detail: 'action=mutation-create' },
    ]);
    const signals = readInteractionSignals({
      now: INTERACTION_NOW,
      failureThreshold: 2,
      readInteractionsLog: () => interactions,
    });
    expect(signals.length).toBeGreaterThanOrEqual(1);
  });

  it('groups by kind only (not by detail) — different details, same kind/outcome cluster as one signal', () => {
    const interactions = jsonl([
      { ts: RECENT_INTERACTION_ISO, kind: 'agent-call', outcome: 'failure', detail: 'agent=a dur=100' },
      { ts: RECENT_INTERACTION_ISO, kind: 'agent-call', outcome: 'failure', detail: 'agent=b dur=200' },
      { ts: RECENT_INTERACTION_ISO, kind: 'agent-call', outcome: 'failure', detail: 'agent=c dur=300' },
    ]);
    const signals = readInteractionSignals({
      now: INTERACTION_NOW,
      readInteractionsLog: () => interactions,
    });
    // One signal covering all three failures of kind agent-call.
    const agentCallSignals = signals.filter((s) => s.content.includes('agent-call'));
    expect(agentCallSignals).toHaveLength(1);
  });

  it('only counts failure outcomes, not success or cancelled', () => {
    const interactions = jsonl([
      { ts: RECENT_INTERACTION_ISO, kind: 'agent-call', outcome: 'success', detail: 'a' },
      { ts: RECENT_INTERACTION_ISO, kind: 'agent-call', outcome: 'success', detail: 'b' },
      { ts: RECENT_INTERACTION_ISO, kind: 'agent-call', outcome: 'success', detail: 'c' },
      { ts: RECENT_INTERACTION_ISO, kind: 'agent-call', outcome: 'cancelled', detail: 'd' },
    ]);
    const signals = readInteractionSignals({
      now: INTERACTION_NOW,
      readInteractionsLog: () => interactions,
    });
    expect(signals).toEqual([]);
  });

  it('every signal has source="interaction" and parseable ts', () => {
    const interactions = jsonl([
      { ts: RECENT_INTERACTION_ISO, kind: 'command', outcome: 'failure', detail: 'cmd=x' },
      { ts: RECENT_INTERACTION_ISO, kind: 'command', outcome: 'failure', detail: 'cmd=y' },
      { ts: RECENT_INTERACTION_ISO, kind: 'command', outcome: 'failure', detail: 'cmd=z' },
    ]);
    const signals = readInteractionSignals({
      now: INTERACTION_NOW,
      readInteractionsLog: () => interactions,
    });
    for (const s of signals) {
      expect(s.source).toBe('interaction');
      expect(Number.isFinite(Date.parse(s.ts))).toBe(true);
    }
  });

  it('honors a custom cap', () => {
    // 5 distinct kinds each with 3+ failures → 5 signals; cap at 2.
    const entries: Array<Record<string, unknown>> = [];
    for (const k of ['agent-call', 'command', 'tg-message', 'webview', 'other']) {
      for (let i = 0; i < 3; i++) {
        entries.push({ ts: RECENT_INTERACTION_ISO, kind: k, outcome: 'failure', detail: 'x' });
      }
    }
    const signals = readInteractionSignals({
      now: INTERACTION_NOW,
      cap: 2,
      readInteractionsLog: () => jsonl(entries),
    });
    expect(signals).toHaveLength(2);
  });

  it('skips malformed JSONL lines', () => {
    const interactions = [
      JSON.stringify({ ts: RECENT_INTERACTION_ISO, kind: 'agent-call', outcome: 'failure', detail: 'a' }),
      'oops { not json',
      JSON.stringify({ ts: RECENT_INTERACTION_ISO, kind: 'agent-call', outcome: 'failure', detail: 'b' }),
      JSON.stringify({ ts: RECENT_INTERACTION_ISO, kind: 'agent-call', outcome: 'failure', detail: 'c' }),
    ].join('\n');
    const signals = readInteractionSignals({
      now: INTERACTION_NOW,
      readInteractionsLog: () => interactions,
    });
    expect(signals.length).toBeGreaterThanOrEqual(1);
  });
});
