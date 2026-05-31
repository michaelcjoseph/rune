/**
 * Work-run durable transcript machinery (project 11, Phase 1).
 *
 * This module owns the four pieces of Phase 1's "durable transcript stream":
 *
 *   1. `redactSecrets`        — best-effort secret/token redaction applied
 *                               before any stream event is persisted.
 *   2. `parseStreamJsonLine`  — tolerant parse of one `--output-format
 *                               stream-json` line (null on malformed input;
 *                               never throws, so a torn line can be routed to
 *                               the stderr tail instead of crashing the run).
 *   3. `streamJsonToDisplay`  — convert a parsed stream-json envelope into the
 *                               existing human-readable `output` MutationEvent
 *                               line (drawer back-compat), not raw JSON.
 *   4. `createRingBuffer`     — bounded last-N buffer backing the run record's
 *                               stdout ring buffer and stderr tail.
 *   5. `createTranscriptSink` — per-run `WriteStream` to
 *                               `logs/work-runs/<id>/transcript.jsonl` with
 *                               backpressure handling and an awaited `finish`,
 *                               independent of cockpit drawer state.
 *
 * SCAFFOLD: signatures and types are settled here so the Phase 1 test suite
 * (`work-run-transcript.test.ts`) can pin the contract test-first. The bodies
 * are intentionally unimplemented — the Phase 1 implementation tasks
 * ("Stream spawn + convert", "Durable sink") fill them in. Until then the
 * suite is red by design.
 */

/** A parsed `--output-format stream-json` envelope. The CLI emits one JSON
 *  object per line; common `type`s are `system`, `assistant`, `user`, and
 *  `result`. Only the fields the adapter reads are named; the rest ride on the
 *  index signature. */
export interface StreamJsonEnvelope {
  type: string;
  [key: string]: unknown;
}

/** Bounded FIFO buffer that retains only the most recent `capacity` items.
 *  Backs both the last-N stdout ring buffer and the stderr tail on the run
 *  record. */
export interface RingBuffer<T> {
  /** Append an item, evicting the oldest if at capacity. */
  push(item: T): void;
  /** Current contents, oldest-first, length ≤ capacity. Returns a fresh
   *  snapshot — mutating the result or pushing afterward must not alter it. */
  items(): T[];
  /** Maximum retained items. Contract: capacity ≥ 1. */
  readonly capacity: number;
}

/** A per-run durable transcript sink. Writes redacted stream events as JSONL
 *  to `<baseDir>/<runId>/transcript.jsonl` via a `WriteStream`, honoring
 *  backpressure, and exposes an awaitable `finish` so callers can flush before
 *  writing `summary.json` and emitting the terminal event. */
export interface TranscriptSink {
  /** Absolute path of the per-run transcript file. */
  readonly path: string;
  /** Append one stream event. Resolves once the write is accepted (awaiting a
   *  `drain` first if the stream is backpressured), so no event is dropped. */
  append(event: unknown): Promise<void>;
  /** End the stream and resolve only after its `finish` event — i.e. after all
   *  buffered writes have flushed to disk. */
  finish(): Promise<void>;
}

export interface CreateTranscriptSinkOptions {
  /** Mutation/run id; becomes the per-run directory name. MUST be validated
   *  as a simple slug (VALID_SLUG, `src/intent/sandbox.ts`) before any `fs`
   *  call — a traversal id (`../escape`) must throw, never let the transcript
   *  escape `baseDir`. */
  runId: string;
  /** Base directory under which the per-run dir is created (production:
   *  `logs/work-runs`). Injected so tests can target a tmpdir. */
  baseDir: string;
}

function notImplemented(fn: string): never {
  throw new Error(`work-run-transcript: ${fn} not implemented (project 11 Phase 1 pending)`);
}

/**
 * Best-effort redaction of known secret/token patterns from a string before it
 * is persisted to the transcript. Covers at least credential-bearing URLs,
 * bearer tokens, and common API-key prefixes. Best-effort, not a guarantee —
 * the primary protection is gitignore + the authenticated route.
 */
export function redactSecrets(_text: string): string {
  notImplemented('redactSecrets');
}

/**
 * Parse one line of `--output-format stream-json` output. Returns the parsed
 * envelope, or `null` for a blank/malformed/partial line. MUST NOT throw — a
 * torn JSON line is expected mid-stream and is routed to the stderr tail by
 * the caller, never crashing the run.
 */
export function parseStreamJsonLine(_line: string): StreamJsonEnvelope | null {
  notImplemented('parseStreamJsonLine');
}

/**
 * Convert a parsed stream-json envelope into a human-readable display line for
 * the existing `output` MutationEvent (`data.line`). Returns `null` when the
 * envelope carries nothing worth showing in the drawer (e.g. a `system` init
 * frame). Assistant text renders as text; tool-use renders as a readable
 * marker — never the raw JSON.
 */
export function streamJsonToDisplay(_envelope: StreamJsonEnvelope): string | null {
  notImplemented('streamJsonToDisplay');
}

/**
 * Create a bounded ring buffer that keeps only the most recent `capacity`
 * items.
 */
export function createRingBuffer<T>(_capacity: number): RingBuffer<T> {
  notImplemented('createRingBuffer');
}

/**
 * Create a per-run durable transcript sink backed by a `WriteStream` to
 * `<baseDir>/<runId>/transcript.jsonl`. The per-run directory is created if
 * absent.
 */
export function createTranscriptSink(_opts: CreateTranscriptSinkOptions): TranscriptSink {
  notImplemented('createTranscriptSink');
}
