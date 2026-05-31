/**
 * Phase 1 test suite for `src/jobs/work-run-transcript.ts` — durable transcript
 * stream (test-plan §1, project 11 work-run-observability).
 *
 * This suite is written TEST-FIRST. The module under test exists as a scaffold
 * whose function bodies all throw `notImplemented(...)`. Every test here must
 * be RED (failing) until the Phase 1 implementation tasks are complete.
 *
 * Failure mode expected: "work-run-transcript: <fn> not implemented (project 11
 * Phase 1 pending)" — an assertion error or explicit not-implemented throw.
 * NOT a module-resolution error, NOT a syntax error.
 *
 * See: docs/projects/11-work-run-observability/test-plan.md §1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `streamJsonToDisplay` reuses `formatToolUse` (src/ai/tool-labels.ts) to
// render tool_use blocks, which transitively imports `../config.js` — and
// config throws on missing env at import time. Mock it (mirrors
// tool-labels.test.ts) so this pure suite loads without a real environment.
vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', WORKSPACE_DIR: '/test/workspace' },
  PROJECT_ROOT: '/test/project',
}));

import {
  redactSecrets,
  parseStreamJsonLine,
  streamJsonToDisplay,
  createRingBuffer,
  createTranscriptSink,
} from './work-run-transcript.js';

import type {
  StreamJsonEnvelope,
  RingBuffer,
  TranscriptSink,
} from './work-run-transcript.js';

// ---------------------------------------------------------------------------
// Temp dir management — real fs, one dir per test.
// We do NOT mock fs for sink tests; we want real WriteStream behavior.
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'work-run-transcript-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Read a transcript.jsonl and assert it holds exactly `events`, one JSON
 *  object per line, in order. */
function assertTranscript(path: string, events: object[]): void {
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  expect(lines).toHaveLength(events.length);
  for (let i = 0; i < events.length; i++) {
    expect(JSON.parse(lines[i]!)).toMatchObject(events[i]!);
  }
}

/** Call parseStreamJsonLine inside a not-throw guard and return its result —
 *  pins the "tolerant parse, never throws" contract in one place. */
function parseNoThrow(line: string): ReturnType<typeof parseStreamJsonLine> | undefined {
  let result: ReturnType<typeof parseStreamJsonLine> | undefined;
  expect(() => {
    result = parseStreamJsonLine(line);
  }).not.toThrow();
  return result;
}

// ---------------------------------------------------------------------------
// §1 Persistence — test-plan line 1
//
// "Every stream event is appended to <baseDir>/<runId>/transcript.jsonl
//  (drawer-independent)"
// ---------------------------------------------------------------------------

describe('TranscriptSink — persistence', () => {
  it(
    // test-plan §1 Persistence line 1: every stream event appended,
    // drawer-independent, order preserved, N lines = N appended events.
    'appends every event to <baseDir>/<runId>/transcript.jsonl; N events → N JSONL lines (order preserved)',
    async () => {
      const runId = 'run-persist-01';
      const sink: TranscriptSink = createTranscriptSink({ runId, baseDir: tmpDir });

      // Confirm the path contract: <baseDir>/<runId>/transcript.jsonl
      expect(sink.path).toBe(join(tmpDir, runId, 'transcript.jsonl'));

      const events = [
        { type: 'assistant', seq: 1, text: 'alpha' },
        { type: 'assistant', seq: 2, text: 'beta' },
        { type: 'result',    seq: 3, result: 'done' },
      ];

      for (const ev of events) {
        await sink.append(ev);
      }
      await sink.finish();

      // Exactly N lines, each round-tripping to the source event (order preserved)
      assertTranscript(sink.path, events);
    },
  );

  it(
    // test-plan §1 Persistence line 2: transcript survives a failed run;
    // finish() flushes so every appended event is on disk after it resolves.
    //
    // NOTE: the "summary.json written only after finish()" half of this
    // test-plan line is asserted in Phase 2's suite — summary.json is a
    // Phase 2 artifact. This Phase-1 test scopes to transcript durability
    // and finish-flush ordering only.
    'finish() flushes all buffered events to disk (survive-failure + flush ordering)',
    async () => {
      const runId = 'run-flush-02';
      const sink: TranscriptSink = createTranscriptSink({ runId, baseDir: tmpDir });

      const events = [
        { type: 'assistant', text: 'before failure 1' },
        { type: 'assistant', text: 'before failure 2' },
        { type: 'system',    subtype: 'init' },
      ];

      for (const ev of events) {
        await sink.append(ev);
      }

      // finish() must flush — assert AFTER it resolves
      await sink.finish();

      // All events must be on disk now (transcript survives even a failed run)
      expect(existsSync(sink.path)).toBe(true);

      // Every appended event is present after finish() resolves
      assertTranscript(sink.path, events);
    },
  );

  it(
    // test-plan §1 Persistence line 3 (🟡): backpressure / no events dropped
    // under a fast stream.
    //
    // Contract under test: the observable "nothing dropped". Drain mechanics
    // are an implementation detail; we only assert the outcome.
    'no events dropped under a large burst (5000 sequential appends, order preserved)',
    async () => {
      const runId = 'run-burst-03';
      const BURST = 5000;
      const sink: TranscriptSink = createTranscriptSink({ runId, baseDir: tmpDir });

      for (let i = 0; i < BURST; i++) {
        await sink.append({ type: 'assistant', seq: i, text: `line-${i}` });
      }
      await sink.finish();

      const raw = readFileSync(sink.path, 'utf8').trimEnd();
      const lines = raw.split('\n');

      // All 5000 present
      expect(lines).toHaveLength(BURST);

      // Order preserved: check a sample (first, last, and a middle entry)
      expect(JSON.parse(lines[0]!)).toMatchObject({ seq: 0 });
      expect(JSON.parse(lines[BURST - 1]!)).toMatchObject({ seq: BURST - 1 });
      expect(JSON.parse(lines[2500]!)).toMatchObject({ seq: 2500 });
    },
    // Allow extra time for the burst write under slow CI
    20_000,
  );

  it(
    // Security contract: `runId` becomes a directory name under baseDir, so a
    // traversal id (`../escape`) must not let the transcript escape baseDir.
    // The implementation must validate runId (VALID_SLUG, src/intent/sandbox.ts)
    // and throw BEFORE any fs call. Pinned test-first so the durable-sink task
    // cannot land without honoring it.
    'rejects a path-traversal runId before touching the filesystem',
    () => {
      // Match a validation-specific message (not the bare scaffold
      // not-implemented throw) so this is genuinely RED today and only goes
      // green when the implementation actually rejects the traversal id.
      for (const runId of ['../escape', '../../etc', 'a/b', 'foo/../bar']) {
        expect(() => createTranscriptSink({ runId, baseDir: tmpDir })).toThrow(
          /runId|traversal|invalid|slug/i,
        );
      }
    },
  );

  it('destroy() is idempotent and append after destroy rejects (crash-path cleanup)', async () => {
    const sink: TranscriptSink = createTranscriptSink({ runId: 'run-destroy-01', baseDir: tmpDir });
    expect(() => {
      sink.destroy();
      sink.destroy();
    }).not.toThrow();
    await expect(sink.append({ type: 'assistant', text: 'too late' })).rejects.toThrow();
    // finish() after destroy must reject, not hang (end() never fires its
    // callback on a destroyed stream).
    await expect(sink.finish()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// §1 Ring buffer + stderr tail — test-plan line (🟡 last-N ring buffer)
// ---------------------------------------------------------------------------

describe('createRingBuffer', () => {
  it(
    // test-plan §1 "Last-N ring buffer and stderr tail are populated on the run
    // record." — the primitive backing both fields.
    //
    // Framing: one ring buffer represents the stdout last-N ring; another
    // represents the stderr tail. Same primitive, per the run-record fields.
    'retains only the last-N items when more than capacity are pushed (oldest evicted)',
    () => {
      const CAPACITY = 5;
      // Stdout last-N ring
      const stdoutRing: RingBuffer<string> = createRingBuffer<string>(CAPACITY);

      // Push more than capacity
      for (let i = 0; i < 10; i++) {
        stdoutRing.push(`line-${i}`);
      }

      const items = stdoutRing.items();

      // Exactly capacity items retained
      expect(items).toHaveLength(CAPACITY);

      // Oldest-first — last 5 pushes were line-5 through line-9
      expect(items).toEqual(['line-5', 'line-6', 'line-7', 'line-8', 'line-9']);

      // capacity property is correct
      expect(stdoutRing.capacity).toBe(CAPACITY);
    },
  );

  it('retains all items when fewer than capacity are pushed (no eviction)', () => {
    const CAPACITY = 10;
    const stderrTail: RingBuffer<string> = createRingBuffer<string>(CAPACITY);

    stderrTail.push('err-a');
    stderrTail.push('err-b');
    stderrTail.push('err-c');

    const items = stderrTail.items();
    expect(items).toHaveLength(3);
    expect(items).toEqual(['err-a', 'err-b', 'err-c']);
    expect(stderrTail.capacity).toBe(CAPACITY);
  });

  it('throws on a non-positive or non-integer capacity', () => {
    expect(() => createRingBuffer<string>(0)).toThrow();
    expect(() => createRingBuffer<string>(-1)).toThrow();
    expect(() => createRingBuffer<string>(1.5)).toThrow();
  });

  it('capacity-1 ring retains only the most recent item (boundary)', () => {
    // Lower-bound edge case: a cap-1 ring is the tightest "last-N". A modular
    // or off-by-one implementation can get this wrong without any cap-3/5/10
    // test catching it. The interface contract is capacity ≥ 1.
    const ring: RingBuffer<string> = createRingBuffer<string>(1);
    ring.push('first');
    ring.push('second');
    expect(ring.items()).toEqual(['second']);
    expect(ring.capacity).toBe(1);
  });

  it('handles exactly-capacity pushes (no eviction at boundary)', () => {
    const CAPACITY = 3;
    const ring: RingBuffer<number> = createRingBuffer<number>(CAPACITY);

    ring.push(10);
    ring.push(20);
    ring.push(30);

    expect(ring.items()).toEqual([10, 20, 30]);
  });

  it('items() returns a snapshot — pushing after a prior items() call does not mutate the earlier snapshot', () => {
    const ring: RingBuffer<number> = createRingBuffer<number>(3);
    ring.push(1);
    ring.push(2);
    const snapshot = ring.items();
    ring.push(3); // may evict 1 if capacity were 2, but here cap=3 so no eviction
    // snapshot must not have changed
    expect(snapshot).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// §1 Adapter — test-plan line (🟡 stream-json envelopes render human-readable)
// ---------------------------------------------------------------------------

describe('streamJsonToDisplay', () => {
  it(
    // test-plan §1: assistant envelope with text content renders the text,
    // NOT raw JSON braces.
    'renders assistant text content as human-readable (not raw JSON)',
    () => {
      const envelope: StreamJsonEnvelope = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello world' }],
        },
      };
      const display = streamJsonToDisplay(envelope);

      expect(display).not.toBeNull();
      expect(display).toContain('Hello world');
      // Must NOT be the raw JSON envelope. Assert against the envelope's
      // structural key rather than a bare `{` so the check stays valid even
      // if assistant text itself ever contains a brace (spec intent: "not the
      // raw JSON envelope", not "never a curly brace").
      expect(display).not.toContain('"type":"assistant"');
    },
  );

  it(
    // test-plan §1: tool_use content block names the tool, not raw JSON.
    'renders tool_use content block mentioning the tool name (not raw JSON)',
    () => {
      const envelope: StreamJsonEnvelope = {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }],
        },
      };
      const display = streamJsonToDisplay(envelope);

      expect(display).not.toBeNull();
      expect(display).toContain('Bash');
      // Must not be raw JSON braces of the full envelope
      expect(display).not.toContain('"type":"assistant"');
    },
  );

  it(
    // test-plan §1: result envelope surfaces the result text.
    'renders result envelope surfacing the result text',
    () => {
      const envelope: StreamJsonEnvelope = {
        type: 'result',
        result: 'final text here',
      };
      const display = streamJsonToDisplay(envelope);

      expect(display).not.toBeNull();
      expect(display).toContain('final text here');
      // Guard against a naive `JSON.stringify(envelope)` implementation, which
      // would also "contain" the result text — mirror the assistant/tool_use
      // negative assertions so the result type is held to the same bar.
      expect(display).not.toContain('"type":"result"');
    },
  );

  it(
    // test-plan §1: system init envelope returns null (nothing to show).
    'returns null for system init envelope (nothing to show in drawer)',
    () => {
      const envelope: StreamJsonEnvelope = {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-abc',
      };
      expect(streamJsonToDisplay(envelope)).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// §1 Redaction — test-plan line (🟡 known secret/token patterns redacted)
// ---------------------------------------------------------------------------

describe('redactSecrets', () => {
  it(
    // test-plan §1: credential-bearing URL — tok must be removed.
    'redacts credential-bearing URL (https://user:tok@host)',
    () => {
      const input = 'clone from https://user:tok@github.com/repo.git';
      const result = redactSecrets(input);
      // The token must not appear in plaintext
      expect(result).not.toContain('tok@');
    },
  );

  it(
    // test-plan §1: Bearer token in Authorization header.
    'redacts Bearer token in Authorization header',
    () => {
      const input = 'Authorization: Bearer sk-abc123LONGTOKEN';
      const result = redactSecrets(input);
      expect(result).not.toContain('sk-abc123LONGTOKEN');
    },
  );

  it(
    // test-plan §1: common API-key prefix sk-...
    'redacts common sk- API key prefix values',
    () => {
      const input = 'api_key=sk-projXXXXXXXXXXXXXXXXXXXXXXXX';
      const result = redactSecrets(input);
      expect(result).not.toContain('sk-projXXXXXXXXXXXXXXXXXXXXXXXX');
    },
  );

  it('redacts a Telegram bot token (numeric_id:35-char secret)', () => {
    const token = `123456789:${'a'.repeat(35)}`;
    const result = redactSecrets(`config: ${token}`);
    expect(result).not.toContain(token);
  });

  it('redacts a GitHub personal-access token (ghp_…)', () => {
    const token = `ghp_${'A'.repeat(36)}`;
    const result = redactSecrets(`remote https://${token}@github.com/x.git`);
    expect(result).not.toContain(token);
  });

  it('leaves ordinary text unchanged', () => {
    const safe = 'Running tests in src/jobs/work-runner.ts — no secrets here.';
    const result = redactSecrets(safe);
    expect(result).toBe(safe);
  });

  it(
    // test-plan §1: sink-level redaction — persisted bytes must not contain
    // the raw secret.
    'sink persists the redacted form, not the raw secret, when an event contains a secret',
    async () => {
      const runId = 'run-redact-01';
      const sink: TranscriptSink = createTranscriptSink({ runId, baseDir: tmpDir });

      const rawSecret = 'sk-secretTOKEN9999';
      await sink.append({
        type: 'assistant',
        text: `Authorization: Bearer ${rawSecret}`,
      });
      await sink.finish();

      const persisted = readFileSync(sink.path, 'utf8');
      // Raw secret must NOT appear in the file
      expect(persisted).not.toContain(rawSecret);
    },
  );
});

// ---------------------------------------------------------------------------
// §1 Adapter — parseStreamJsonLine tolerant parsing
// ---------------------------------------------------------------------------

describe('parseStreamJsonLine', () => {
  it(
    // test-plan §1: malformed/partial JSON returns null and does NOT throw.
    //
    // NOTE: the "logged to stderr tail" half is wired at the work-runner
    // integration layer (Phase 2). The unit contract here is:
    //   tolerant parse — null on bad input, never throws.
    'returns null for a partial JSON line without throwing',
    () => {
      expect(parseNoThrow('{"type":"assist')).toBeNull();
    },
  );

  it('returns null for completely non-JSON input without throwing', () => {
    expect(parseNoThrow('not json at all')).toBeNull();
  });

  it('returns null for an empty string without throwing', () => {
    expect(parseNoThrow('')).toBeNull();
  });

  it('returns null for a whitespace-only line without throwing', () => {
    expect(parseNoThrow('   \n')).toBeNull();
  });

  it('returns null for valid JSON that is not an object (array/primitive) without throwing', () => {
    // A `JSON.parse` without an object-type guard would return the array or
    // primitive and silently violate the `StreamJsonEnvelope | null` contract.
    // Valid-but-non-object JSON must parse to null, not an envelope.
    for (const line of ['[1,2,3]', '"a bare string"', '42', 'true', 'null']) {
      expect(parseNoThrow(line)).toBeNull();
    }
  });

  it('parses a well-formed stream-json line to the envelope', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [] } });
    const result = parseStreamJsonLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('assistant');
  });

  it('parses a result envelope correctly', () => {
    const line = JSON.stringify({ type: 'result', result: 'some output', session_id: 'abc' });
    const result = parseStreamJsonLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('result');
    expect(result!['result']).toBe('some output');
  });
});
