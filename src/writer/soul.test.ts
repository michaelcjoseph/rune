/**
 * Phase 1 charter check for `agents/writer/SOUL.md` (project 12, test-plan §1,
 * the 🟢 "SOUL references voice.md without duplicating" contract).
 *
 * Reads the real charter from the jarvis repo. No vault coupling: rather than
 * diff against the live voice.md, it asserts the charter points at voice.md and
 * does NOT inline voice.md's distinctive content (which would let the two drift).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WRITER_DIR, SOUL_FILENAME } from './memory.js';

// Read via WRITER_DIR (the module's own constant) so this test actually
// exercises that path — a wrong WRITER_DIR makes readFileSync throw here.
function readSoul(): string {
  return readFileSync(join(WRITER_DIR, SOUL_FILENAME), 'utf8');
}

describe('writer/SOUL.md — charter contract', () => {
  it('is readable from WRITER_DIR and is non-trivial', () => {
    expect(readSoul().length).toBeGreaterThan(200);
  });

  it('references writing/voice.md as the voice source of truth', () => {
    expect(readSoul()).toContain('voice.md');
  });

  it('does NOT duplicate voice.md content (deferral, not a copy)', () => {
    const soul = readSoul();
    // Distinctive lines/phrases owned by voice.md — their presence here would
    // mean the charter is a copy that can silently drift from the source.
    const voiceOwnedMarkers = [
      'Leave readers feeling',
      'Banned Phrases',
      'Delve into',
      'The team shipped the feature',
    ];
    for (const marker of voiceOwnedMarkers) {
      expect(soul).not.toContain(marker);
    }
  });

  it('asserts its own authority over memory (SOUL wins on conflict)', () => {
    expect(readSoul().toLowerCase()).toContain('charter wins');
  });
});
