/**
 * Sensor layer for Phase 5's observation loop. The loop reasons over a digest of diarized
 * signals; this module is the layer that **produces** those signals from three sources:
 * vault signals, product telemetry, and logged Rune interactions (successful or not).
 *
 * `readSensors` is the deterministic composer — it fans the three source readers in a stable
 * order. The readers themselves (reading vault files, polling product repos, replaying the
 * interaction log) are integration that fills `SignalReader` in. The cross-cutting wiring
 * that appends an `InteractionLogRecord` from every Rune call site (Telegram handlers,
 * agent invocations, command dispatch) is separate, multi-file integration that this module
 * declares the shape for.
 *
 * STATUS: the composer is implemented; the source readers and the per-call-site interaction
 * logging are integration around this core.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Phase 5"), test-plan.md (§16)}.
 */

import type { SensorSignal } from './observation-loop.js';

/**
 * A log record for one Rune interaction — Telegram message, agent invocation, command
 * dispatch, webview action, etc. Every interaction (successful, failed, cancelled) is
 * appended so the sensor's `interactions` reader can replay them as signal.
 */
export interface InteractionLogRecord {
  /** ISO-8601 timestamp of the interaction. */
  ts: string;
  /** Which surface the interaction happened on. */
  kind: 'tg-message' | 'agent-call' | 'command' | 'webview' | 'other';
  /** Outcome — failures and cancellations are first-class signal, not only successes. */
  outcome: 'success' | 'failure' | 'cancelled';
  /** A short, **structured** description of what happened — e.g.
   *  `"agent=wiki-compiler status=success durMs=420"`. Call sites must not place raw user
   *  message text or vault content here; this record is appended to
   *  `logs/observation-interactions.jsonl`, which is gitignored but on-disk plaintext. */
  detail: string;
}

/** A reader that produces signals from one source. */
export type SignalReader = () => SensorSignal[];

/** The bag of source readers `readSensors` composes — one per sensor source. */
export interface SensorReaders {
  vault: SignalReader;
  telemetry: SignalReader;
  interactions: SignalReader;
}

/**
 * Compose the three source readers into one ingest pass. The readers are injected so the
 * composer is unit-testable; the actual file/repo/log reads are integration that fills
 * `vault`, `telemetry`, and `interactions` in. Signals are returned in source order — vault,
 * then telemetry, then interactions — and each reader's own order is preserved within its
 * block.
 */
export function readSensors(readers: SensorReaders): SensorSignal[] {
  return [...readers.vault(), ...readers.telemetry(), ...readers.interactions()];
}
