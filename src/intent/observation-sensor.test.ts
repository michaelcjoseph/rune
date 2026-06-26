import { describe, it, expect } from 'vitest';

/*
 * Test suite for the sensor layer of project 08-intent-layer's observation loop (Phase 5).
 * The observation loop itself is pinned by `observation-loop.test.ts` (test-plan.md §16);
 * this module covers the layer that **produces** the `SensorSignal[]` the loop consumes.
 *
 * Scope: the deterministic composer (`readSensors`) that fans the three source readers in a
 * stable order. The actual source readers (reading vault files, product repo telemetry, and
 * the interaction log) are integration around this — they are the `SignalReader` callbacks
 * the composer takes. The cross-cutting wiring that appends to the interaction log from
 * every Rune call site is genuine multi-file integration, separately handled.
 */

import { readSensors, type SignalReader } from './observation-sensor.js';
import type { SensorSignal } from './observation-loop.js';

// --- Fixtures ---

function sig(source: SensorSignal['source'], content: string): SensorSignal {
  return { source, content, ts: '2026-01-15T00:00:00.000Z' };
}

const empty: SignalReader = () => [];
const reader = (signals: SensorSignal[]): SignalReader => () => signals;

describe('observation sensor — readSensors composer', () => {
  it('returns an empty list when every reader is quiet', () => {
    expect(readSensors({ vault: empty, telemetry: empty, interactions: empty })).toEqual([]);
  });

  it('combines signals from all three sources', () => {
    const result = readSensors({
      vault: reader([sig('vault', 'a vault signal')]),
      telemetry: reader([sig('telemetry', 'a telemetry signal')]),
      interactions: reader([sig('interaction', 'an interaction signal')]),
    });
    expect(result.map((s) => s.source).sort()).toEqual(['interaction', 'telemetry', 'vault']);
  });

  it('preserves source order — vault first, then telemetry, then interactions', () => {
    const v = sig('vault', 'v');
    const t = sig('telemetry', 't');
    const i = sig('interaction', 'i');
    expect(readSensors({ vault: reader([v]), telemetry: reader([t]), interactions: reader([i]) })).toEqual([v, t, i]);
  });

  it('preserves each reader\'s own signal order within its block', () => {
    const v1 = sig('vault', 'v1');
    const v2 = sig('vault', 'v2');
    expect(readSensors({ vault: reader([v1, v2]), telemetry: empty, interactions: empty })).toEqual([v1, v2]);
  });
});
