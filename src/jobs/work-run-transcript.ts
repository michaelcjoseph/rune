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
 * Phase 1 is complete: the adapter pair (`parseStreamJsonLine` /
 * `streamJsonToDisplay`) and the durable sink trio (`redactSecrets`,
 * `createRingBuffer`, `createTranscriptSink`) are all implemented. Phase 2
 * wires the sink + ring buffer into `work-runner`'s stream loop and adds
 * classification/forensics around it.
 */

// NOTE: `tool-labels.ts` imports `../config.js`, which throws on missing env
// at import time — so any unit test loading this module must mock `config.js`
// (see work-run-transcript.test.ts). Kept here for the canonical activity-label
// formatter (`formatToolUse`) and path scrubbing (`scrubPathsInText`).
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { formatToolUse, scrubPathsInText } from '../ai/tool-labels.js';
import { VALID_SLUG } from '../intent/sandbox.js';

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
  /** Force-close the underlying stream without waiting for a flush. Idempotent
   *  and non-throwing — the crash path (run dies before `finish()`) calls this
   *  in a `finally` so the fd never leaks. After destroy, `append()` rejects. */
  destroy(): void;
}

export interface CreateTranscriptSinkOptions {
  /** Mutation/run id; becomes the per-run directory name. MUST be validated
   *  as a simple slug (VALID_SLUG, `src/intent/sandbox.ts`) before any `fs`
   *  call — a traversal id (`../escape`) must throw, never let the transcript
   *  escape `baseDir`. */
  runId: string;
  /** Base directory under which the per-run dir is created (production:
   *  `logs/work-runs`). Injected so tests can target a tmpdir. MUST be a
   *  trusted path (a config/constant), never derived from user input —
   *  `runId` is slug-validated, but `baseDir` is joined verbatim. */
  baseDir: string;
}

/**
 * Best-effort redaction of known secret/token patterns from a string before it
 * is persisted to the transcript. Covers at least credential-bearing URLs,
 * bearer tokens, and common API-key prefixes. Best-effort, not a guarantee —
 * the primary protection is gitignore + the authenticated route.
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // Credential-bearing URLs: https://user:pass@host -> https://<redacted>@host
  [/(https?:\/\/)[^\s/@]+@/gi, '$1<redacted>@'],
  // Authorization: Bearer <token> (hyphen first in the class to avoid an
  // ambiguous range)
  [/\bBearer\s+[-A-Za-z0-9._~+/=]+/gi, 'Bearer <redacted>'],
  // Common API-key prefixes (sk-, sk-proj-, …)
  [/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-<redacted>'],
  // Telegram bot token (numeric_id:35-char secret) — Jarvis's highest-value
  // secret; the backstop if a sandbox ever echoes its environment.
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '<tg-token-redacted>'],
  // GitHub tokens (PAT/OAuth/app) — most likely to appear via a git remote URL.
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g, '<gh-token-redacted>'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '<gh-token-redacted>'],
  // AWS access key id.
  [/\bAKIA[A-Z0-9]{16}\b/g, '<aws-key-redacted>'],
  // JWT (incl. bare ones not prefixed with Bearer, e.g. LENNY_MCP_TOKEN).
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt-redacted>'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, repl] of REDACTIONS) out = out.replace(re, repl);
  return out;
}

/**
 * Parse one line of `--output-format stream-json` output. Returns the parsed
 * envelope, or `null` for a blank/malformed/partial line. MUST NOT throw — a
 * torn JSON line is expected mid-stream and is routed to the stderr tail by
 * the caller, never crashing the run.
 */
export function parseStreamJsonLine(line: string): StreamJsonEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // malformed/partial line — caller routes it to the stderr tail
  }
  // Valid JSON that is not an envelope object (array, primitive, null) is not a
  // stream-json frame.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['type'] !== 'string') return null;
  return obj as StreamJsonEnvelope;
}

/**
 * Convert a parsed stream-json envelope into a human-readable display line for
 * the existing `output` MutationEvent (`data.line`). Returns `null` when the
 * envelope carries nothing worth showing in the drawer (e.g. a `system` init
 * frame). Assistant text renders as text; tool-use renders as a readable
 * marker — never the raw JSON.
 */
export function streamJsonToDisplay(envelope: StreamJsonEnvelope): string | null {
  switch (envelope.type) {
    case 'assistant': {
      const message = envelope['message'];
      if (!message || typeof message !== 'object') return null;
      const content = (message as Record<string, unknown>)['content'];
      if (!Array.isArray(content)) return null;
      const parts: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          // Scrub absolute host paths from assistant prose, mirroring what
          // formatToolUse does for tool args, so the display/transcript path
          // doesn't leak the host directory layout.
          parts.push(scrubPathsInText(b['text']));
        } else if (b['type'] === 'tool_use') {
          // Reuse the webview activity-label formatter so the drawer shows
          // "Bash: …" / "Read: …" rather than the raw tool_use JSON.
          const name = typeof b['name'] === 'string' ? b['name'] : 'tool';
          parts.push(formatToolUse(name, b['input']));
        }
      }
      return parts.length > 0 ? parts.join('\n') : null;
    }
    case 'result':
      // The final result text (assistant's last turn). Surfaced as a readable
      // line (path-scrubbed); everything else (system init, user/tool_result
      // frames) renders nothing in the drawer.
      return typeof envelope['result'] === 'string' ? scrubPathsInText(envelope['result']).trimEnd() : null;
    default:
      return null;
  }
}

/**
 * Create a bounded ring buffer that keeps only the most recent `capacity`
 * items.
 */
export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`createRingBuffer: capacity must be an integer ≥ 1, got ${String(capacity)}`);
  }
  const buf: T[] = [];
  return {
    capacity,
    push(item: T): void {
      buf.push(item);
      if (buf.length > capacity) buf.shift();
    },
    // Fresh snapshot each call — callers may retain it across later pushes.
    items(): T[] {
      return buf.slice();
    },
  };
}

/**
 * Create a per-run durable transcript sink backed by a `WriteStream` to
 * `<baseDir>/<runId>/transcript.jsonl`. The per-run directory is created if
 * absent.
 */
export function createTranscriptSink(opts: CreateTranscriptSinkOptions): TranscriptSink {
  const { runId, baseDir } = opts;
  // Validate BEFORE any fs call: runId becomes a directory name, so a
  // traversal id (`../escape`, `a/b`) must never let the transcript escape
  // baseDir. VALID_SLUG is the project-wide boundary guard for this.
  if (!VALID_SLUG.test(runId)) {
    throw new Error(`createTranscriptSink: invalid runId (must be a slug): ${runId}`);
  }

  const dir = join(baseDir, runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'transcript.jsonl');
  const stream: WriteStream = createWriteStream(path, { flags: 'a' });

  // fs.WriteStream emits 'error' independently of the per-write callback (async
  // open failure, disk full, EACCES). An unhandled 'error' event would crash
  // the process, so capture it from the moment the stream exists; append() and
  // finish() surface it instead of relying on a per-call listener.
  let streamError: Error | null = null;
  stream.on('error', (err: Error) => { streamError = err; });

  let destroyed = false;

  return {
    path,
    append(event: unknown): Promise<void> {
      if (streamError) return Promise.reject(streamError);
      if (destroyed) return Promise.reject(new Error('createTranscriptSink: append after destroy'));
      // Redact secrets before persistence (best-effort), then write one JSONL
      // line. Resolve from the write callback — it fires once the chunk has
      // flushed (or errored), which subsumes backpressure (a caller awaiting
      // append() never outruns the sink) without the double-settle hazard of a
      // separate drain path, and rejects cleanly on a write error.
      const line = redactSecrets(JSON.stringify(event)) + '\n';
      return new Promise<void>((resolve, reject) => {
        stream.write(line, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    finish(): Promise<void> {
      // Resolve only after the stream's `finish` — all buffered writes have
      // flushed to disk — so callers can safely write summary.json / emit the
      // terminal event after this resolves. A pre-existing or end-time error
      // rejects rather than hanging (end()'s callback never fires on error).
      if (streamError) return Promise.reject(streamError);
      if (destroyed) return Promise.reject(new Error('createTranscriptSink: finish after destroy'));
      return new Promise<void>((resolve, reject) => {
        const onErr = (err: Error) => reject(err);
        // 'finish' is the canonical "all data flushed" signal; resolve on it
        // rather than the end() callback to avoid any ordering ambiguity with
        // the persistent error listener.
        stream.once('finish', () => {
          stream.removeListener('error', onErr);
          resolve();
        });
        stream.once('error', onErr);
        stream.end();
      });
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stream.destroy();
    },
  };
}
