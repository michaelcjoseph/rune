/**
 * Synthesis stage for Phase 5's observation loop. The sensor layer
 * (`observation-sensor.ts`) produces per-source `SensorSignal[]`; the synthesis stage
 * diarizes that combined stream into the **compact, structured digest** the loop reasons
 * over. The loop never consumes raw entries directly.
 *
 * `synthesizeDigest` is the deterministic shell: it short-circuits on an empty input so the
 * LLM call is never made on a quiet pass, and otherwise hands the signals to an injected
 * `Diarizer` callback. The LLM-driven diarization itself is integration that fills the
 * callback in.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Phase 5"), test-plan.md (§16)}.
 */

import type { SensorSignal } from './observation-loop.js';

/**
 * The LLM-driven diarizer — takes the sensor layer's combined signals and returns a
 * compact, structured digest (the same `SensorSignal[]` shape, typically with fewer
 * entries that group recurring friction). Injected so the synthesis pass is unit-testable.
 */
export type Diarizer = (signals: SensorSignal[]) => SensorSignal[];

/**
 * Diarize the combined sensor signals into the loop-ready digest. An empty input is the
 * quiet case — `synthesizeDigest` returns `[]` immediately and never invokes the diarizer,
 * so a quiet pass costs nothing. Otherwise the diarizer's output is returned verbatim —
 * the synthesis stage does not reorder or trim what the LLM produced.
 */
export function synthesizeDigest(signals: SensorSignal[], diarize: Diarizer): SensorSignal[] {
  if (signals.length === 0) return [];
  return diarize(signals);
}
