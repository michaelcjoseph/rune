/**
 * Phase 3 loop-closure gate for project 12 (test-plan §3).
 *
 * THE GATE: a lesson captured on piece N is stored and then loaded into piece
 * N+1's `referenceContext`. This is the one thing v1 must prove — that the loop
 * closes — NOT that the writing got better (that's the engagement phase).
 *
 * Unlike the Phase 1/2 red suites, these pass GREEN: capture → store → load is
 * fully implemented. The verification is purely mechanical — a marker string put
 * in via `captureLessons` and read back out of `composeWriterContext` over real
 * temp files. No Telegram, no real post, no LLM call, no prose-quality judgment.
 *
 * See: docs/projects/12-writer-memory/test-plan.md §3
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeWriterContext, MEMORY_FILENAME, SOUL_FILENAME } from './memory.js';
import { captureLessons, CANDIDATE_FENCE } from './capture.js';

let dir: string;

const SOUL_BODY = 'WRITER CHARTER. Defer to writing/voice.md. This charter wins.';

function fencedBlock(obj: unknown): string {
  return ['```' + CANDIDATE_FENCE, JSON.stringify(obj), '```'].join('\n');
}

// Real temp files for the store/load round-trip; git commit is mocked because the
// gate is file-append → file-read, independent of whether the commit lands. The
// write path uses the SAME MEMORY_FILENAME composeWriterContext reads, so a rename
// can't silently split the two paths and make the gate tautological.
function tempDeps() {
  return {
    readMemory: () => {
      try {
        return readFileSync(join(dir, MEMORY_FILENAME), 'utf8');
      } catch {
        return '';
      }
    },
    appendLine: (line: string) => appendFileSync(join(dir, MEMORY_FILENAME), `${line}\n`),
    commit: async () => ({ committed: true, sha: 'deadbee' }),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'writer-closure-'));
  writeFileSync(join(dir, SOUL_FILENAME), SOUL_BODY);
  writeFileSync(join(dir, MEMORY_FILENAME), '# Writer Memory\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writer/loop-closure — the gate', () => {
  it('a lesson captured on piece N is loaded into piece N+1 referenceContext', async () => {
    const marker = 'LOOPMARKERZZZ';
    const block = fencedBlock({
      sourceSlug: 'blog-2026-06-05-closure',
      feedbackSeen: true,
      lessons: [`Open on ${marker} tension before naming the abstraction.`],
    });

    // Piece N — capture the marked lesson into the temp memory.md.
    const result = await captureLessons({
      assistantText: `Revised to your feedback.\n\n${block}`,
      date: '2026-06-05',
      privateNames: [],
      ...tempDeps(),
    });
    expect(result.captured).toHaveLength(1);
    expect(result.committed).toBe(true);

    // Piece N+1 — a fresh compose loads the lesson as low-authority reference.
    const ctx = composeWriterContext('BASE BLOG INSTRUCTIONS', { dir });
    expect(ctx.referenceContext).toContain(marker); // loop closed
    // And it stays on the low-authority channel, never the system prompt. The
    // positive SOUL check guards against a no-op compose passing the negative one.
    expect(ctx.systemInstructions).toContain('WRITER CHARTER');
    expect(ctx.systemInstructions).not.toContain(marker);
  });

  it('verifies closure mechanically — capture is the only thing that puts a marker in N+1', async () => {
    // Negative control: with no feedback block there is no capture, so the marker
    // never reaches N+1. This proves the gate measures actual capture (a content
    // round-trip), not a coincidental constant — and it does so with pure string
    // membership over temp files: no sender, no bot, no real post, no LLM call.
    const marker = 'NOLEAKMARKER';
    const result = await captureLessons({
      assistantText: `I would store ${marker} but there is no candidate block this round.`,
      date: '2026-06-05',
      privateNames: [],
      ...tempDeps(),
    });
    expect(result.captured).toHaveLength(0);
    expect(result.skipReason).toBe('no-block'); // explicit: nothing parseable to capture

    const ctx = composeWriterContext('BASE', { dir });
    expect(ctx.referenceContext).not.toContain(marker);
  });
});
