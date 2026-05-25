/**
 * Writer for the observation loop's interaction log — project 08
 * Phase 6 B1.1. Mirrors `src/utils/intent-log.ts` exactly: a single
 * `appendInteraction(record)` entry point that JSONL-appends to
 * `logs/observation-interactions.jsonl`.
 *
 * The entry type (`InteractionLogRecord`) is owned by the sensor module
 * `src/intent/observation-sensor.ts` — re-exported here so call sites
 * import the writer + the type from one place. The sensor reader
 * (`readInteractionSignals`) consumes the file this writer produces.
 *
 * Safety model (same as intent-log.ts):
 * 1. Jarvis is a single Node.js process — `appendFileSync` is synchronous,
 *    so concurrent handlers are serialized by the event loop. No
 *    interleaving is possible within this process.
 * 2. POSIX O_APPEND writes are atomic when the entry fits in PIPE_BUF
 *    (512 bytes on macOS, 4096 on Linux). Only relevant if a second
 *    writer process ever shares the file; not in use today.
 *
 * The JSDoc invariant on `InteractionLogRecord.detail` is enforced by
 * the call sites (B1.2–B1.5), not here — the writer is trusted with
 * whatever the structured caller passes.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import config from '../config.js';
import type { InteractionLogRecord } from '../intent/observation-sensor.js';

export const OBSERVATION_LOG_FILENAME = 'observation-interactions.jsonl';

/** Re-exported so call sites import the type and the writer from one
 *  place — mirrors how `IntentLogEntry` is co-located with `appendIntent`
 *  in `intent-log.ts`. The type itself lives in `observation-sensor.ts`
 *  because that's where the sensor reader consumes it. */
export type { InteractionLogRecord } from '../intent/observation-sensor.js';

export function observationLogPath(): string {
  return join(config.LOGS_DIR, OBSERVATION_LOG_FILENAME);
}

/** Append one `InteractionLogRecord` to `logs/observation-interactions.jsonl`.
 *  See module-level JSDoc for the safety model.
 *
 *  Callers must populate `detail` with **structured** content only — never
 *  raw user message text or vault content. The log lives on disk plaintext
 *  (gitignored but readable) and the sensor reader replays it; a leak here
 *  would surface user content into the observation loop's LLM context. */
export function appendInteraction(record: InteractionLogRecord): void {
  const path = observationLogPath();
  // logs/ is gitignored and may not exist on a fresh clone; ensure the dir.
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}
