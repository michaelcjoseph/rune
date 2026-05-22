import { describe, it, expect, vi } from 'vitest';

/*
 * Test suite for the synthesis stage of project 08-intent-layer's observation loop
 * (Phase 5). The synthesis stage diarizes the sensor layer's signals into the compact
 * digest the loop consumes; the LLM diarization itself is injected, so this suite pins the
 * deterministic core (empty-input short-circuit, call shape, output passthrough).
 *
 * Scope: the actual LLM diarization is the `Diarizer` callback — its content is integration.
 */

import { synthesizeDigest, type Diarizer } from './observation-synthesis.js';
import type { SensorSignal } from './observation-loop.js';

// --- Fixtures ---

function sig(content: string): SensorSignal {
  return { source: 'vault', content, ts: '2026-01-15T00:00:00.000Z' };
}

describe('observation synthesis — synthesizeDigest', () => {
  it('returns an empty digest for an empty input without calling the diarizer', () => {
    const diarize = vi.fn<Diarizer>();
    expect(synthesizeDigest([], diarize)).toEqual([]);
    expect(diarize).not.toHaveBeenCalled();
  });

  it('calls the diarizer with the input signals and returns its output', () => {
    const input = [sig('a'), sig('b')];
    const summarised = [sig('a & b')];
    const diarize = vi.fn<Diarizer>().mockReturnValue(summarised);
    expect(synthesizeDigest(input, diarize)).toEqual(summarised);
    expect(diarize).toHaveBeenCalledWith(input);
  });

  it('preserves the diarizer\'s output order — does not reorder behind its back', () => {
    const out = [sig('first'), sig('second'), sig('third')];
    expect(synthesizeDigest([sig('x')], () => out)).toEqual(out);
  });
});
