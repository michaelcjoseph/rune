import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import config from '../config.js';

export const INTENT_LOG_FILENAME = 'intent-log.jsonl';

/** Outcome classifier for a resolver decision. */
export type IntentOutcome =
  | 'routed'          // resolver met the confidence threshold and the skill ran successfully
  | 'failed'          // resolver routed to a skill but the skill threw/returned an error
  | 'low_confidence'  // confidence < threshold → fell through to freeform
  | 'ambiguous'       // top-2 within 0.05 confidence → fell through with disambiguation note
  | 'skipped';        // resolver was not invoked (short message, slash command, active session)

export interface IntentLogEntry {
  /** UTC ISO 8601. */
  ts: string;
  /** The original user message that triggered resolver classification. */
  intent: string;
  /** Args the resolver extracted / passed to the routed skill (empty when none). */
  args: string;
  /** Resolver's confidence for the top-1 skill, in [0, 1]. */
  confidence: number;
  outcome: IntentOutcome;
  /** The skill name the resolver chose, or null when no skill was invoked. */
  skill_invoked: string | null;
}

export function intentLogPath(): string {
  return join(config.LOGS_DIR, INTENT_LOG_FILENAME);
}

/** Append one entry to logs/intent-log.jsonl.
 *  Safety model for concurrent TG messages:
 *   1. Primary guarantee — Rune is a single Node.js process and `appendFileSync`
 *      is synchronous, so calls from concurrent handlers are serialized by the
 *      event loop. No interleaving is possible within this process.
 *   2. Secondary OS-level guarantee — POSIX O_APPEND writes are atomic when the
 *      entry fits in PIPE_BUF (512 bytes on macOS, 4096 bytes on Linux). This
 *      only matters if a second writer process ever shares the file; not in
 *      use today.
 *  Malformed input is not validated — callers are trusted (the resolver is the
 *  only writer). */
export function appendIntent(entry: IntentLogEntry): void {
  const path = intentLogPath();
  // logs/ is gitignored and may not exist on a fresh clone; ensure the dir.
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}
