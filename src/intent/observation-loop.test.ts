import { describe, it, expect } from 'vitest';

/*
 * Test-first suite for test-plan.md §16 — observation loop (08-intent-layer, Phase 5).
 *
 * Written BEFORE the implementation. `src/intent/observation-loop.ts` ships as a contract
 * stub whose functions throw 'not implemented', so every test here is RED. That is the
 * intended, correct state: this is a "Tests (write first)" task — the suite goes green
 * when the Phase 5 observation-loop implementation task lands. Do not implement it to make
 * these pass.
 *
 * Scope note: §16's "extends Ask-Twice telemetry rather than duplicating it", "every
 * Jarvis interaction is logged", "synthesis diarizes before the loop reasons", "runs
 * nightly", and "uses the existing project-execution engine" are integration concerns —
 * the loop's wiring into nightly + sensor + engine. This suite pins the deterministic
 * core: the triage walk with an injected callback, dedupe, and the quiet-period gate.
 */

import {
  isDuplicate,
  runObservationLoop,
  type SensorSignal,
  type ProjectIdea,
  type TriageVerdict,
} from './observation-loop.js';

// --- Fixtures ---

function signal(overrides: Partial<SensorSignal> = {}): SensorSignal {
  return {
    source: 'interaction',
    content: 'a friction signal',
    ts: '2026-01-15T00:00:00.000Z',
    ...overrides,
  };
}

function idea(overrides: Partial<ProjectIdea> = {}): ProjectIdea {
  return {
    title: 'Fix the friction',
    friction: 'the friction',
    id: 'fix-the-friction',
    ...overrides,
  };
}

/** A mock triage that always files the same idea — used to exercise the file path. */
const alwaysFile = (i: ProjectIdea) => (_: SensorSignal): TriageVerdict => ({ file: true, idea: i });
/** A mock triage that always discards with a given reason. */
const alwaysDiscard = (reason: string) => (_: SensorSignal): TriageVerdict => ({ file: false, reason });

// §16's "the sensor layer ingests all three sources" is a property of the `SensorSource`
// union type itself (`'vault' | 'telemetry' | 'interaction'`) — a runtime test would just
// re-state the type, so it is not exercised separately here.

describe('observation loop — the quiet half (test-plan §16)', () => {
  it('reports `quiet` for an empty batch — files and runs nothing', () => {
    expect(runObservationLoop([], [], alwaysFile(idea()))).toEqual([{ kind: 'quiet' }]);
  });
});

describe('observation loop — the discard half (test-plan §16)', () => {
  it('discards a signal the triage rejects, with the triage reason', () => {
    const outcomes = runObservationLoop([signal()], [], alwaysDiscard('not worth a project'));
    expect(outcomes).toEqual([{ kind: 'discarded', reason: 'not worth a project' }]);
  });
});

describe('observation loop — filing a worthwhile signal (test-plan §16)', () => {
  it('files the idea when the triage decides it is worth a project', () => {
    const i = idea();
    const outcomes = runObservationLoop([signal()], [], alwaysFile(i));
    expect(outcomes).toEqual([{ kind: 'filed', idea: i }]);
  });
});

describe('observation loop — de-dupe (test-plan §16)', () => {
  it('isDuplicate matches an existing idea by id', () => {
    expect(isDuplicate(idea({ id: 'x' }), [idea({ id: 'y' }), idea({ id: 'x' })])).toBe(true);
  });

  it('isDuplicate returns false when no existing id matches', () => {
    expect(isDuplicate(idea({ id: 'x' }), [idea({ id: 'y' })])).toBe(false);
  });

  it('does not file a duplicate of an existing idea — reports `duplicate`', () => {
    const existing = idea({ id: 'fix-the-friction' });
    const outcomes = runObservationLoop([signal()], [existing], alwaysFile(idea()));
    expect(outcomes).toEqual([{ kind: 'duplicate', existingId: 'fix-the-friction' }]);
  });

  it('dedupes in-batch — two signals diarizing to the same idea file once, not twice', () => {
    // Both signals triage to the same idea; the second is a duplicate of the first this pass.
    const outcomes = runObservationLoop([signal(), signal()], [], alwaysFile(idea()));
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]!).toEqual({ kind: 'filed', idea: idea() });
    expect(outcomes[1]!).toEqual({ kind: 'duplicate', existingId: 'fix-the-friction' });
  });
});
