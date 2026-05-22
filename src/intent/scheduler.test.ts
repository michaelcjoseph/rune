import { describe, it, expect } from 'vitest';

/*
 * Test-first suite for test-plan.md §15 — concurrency scheduler (08-intent-layer, Phase 4).
 *
 * Written BEFORE the implementation. `src/intent/scheduler.ts` ships as a contract stub
 * whose `schedule` throws 'not implemented', so every test here is RED. That is the
 * intended, correct state: this is a "Tests (write first)" task — the suite goes green when
 * the Phase 4 concurrency implementation task lands. Do not implement it to make these pass.
 *
 * Scope note: §15's "two projects on different products auto-merging at the same time each
 * land cleanly" is a property of separate repos having no shared main line — integration,
 * not unit-testable here. This suite pins the deterministic scheduling pass.
 */

import { schedule, type ScheduledProject } from './scheduler.js';

// --- Fixtures ---

/** A project for a product. */
function proj(product: string, project: string): ScheduledProject {
  return { product, project };
}

describe('concurrency scheduler — global cap (test-plan §15)', () => {
  it('starts nothing when the global cap is already reached', () => {
    const result = schedule([proj('aura', '01'), proj('relay', '01')], [proj('assay', '01')], 2);
    expect(result.started).toEqual([]);
    expect(result.queued).toEqual([proj('assay', '01')]);
  });

  it('starts up to the global cap, queuing the rest', () => {
    const result = schedule(
      [],
      [proj('aura', '01'), proj('relay', '01'), proj('assay', '01')],
      2,
    );
    // FIFO: the first two queued projects start, the third waits — order is pinned.
    expect(result.started).toEqual([proj('aura', '01'), proj('relay', '01')]);
    expect(result.queued).toEqual([proj('assay', '01')]);
  });

  it('rejects a global cap below one', () => {
    expect(() => schedule([], [], 0)).toThrow(/cap|positive/i);
  });
});

describe('concurrency scheduler — one project per product (test-plan §15)', () => {
  it('does not start a project for a product that already has a running project', () => {
    const result = schedule([proj('aura', '01')], [proj('aura', '02')], 5);
    expect(result.started).toEqual([]);
    expect(result.queued).toEqual([proj('aura', '02')]);
  });

  it('starts only one of two queued projects for the same product', () => {
    const result = schedule([], [proj('aura', '01'), proj('aura', '02')], 5);
    expect(result.started).toEqual([proj('aura', '01')]);
    expect(result.queued).toEqual([proj('aura', '02')]);
  });

  it('starts projects for distinct products in parallel up to the cap', () => {
    const result = schedule([], [proj('aura', '01'), proj('relay', '01')], 5);
    expect(result.started).toEqual([proj('aura', '01'), proj('relay', '01')]);
    expect(result.queued).toEqual([]);
  });
});

describe('concurrency scheduler — queue, never drop (test-plan §15)', () => {
  it('queues an (N+1)th project rather than dropping it', () => {
    const queue = [proj('aura', '01'), proj('relay', '01'), proj('assay', '01')];
    const result = schedule([], queue, 2);
    // Every queued project is accounted for — started or still queued, none lost.
    expect(result.started.length + result.queued.length).toBe(3);
    expect(result.started).toEqual([proj('aura', '01'), proj('relay', '01')]);
    expect(result.queued).toEqual([proj('assay', '01')]);
  });

  it('starts a queued project once a slot frees', () => {
    // One project running (aura) under a cap of 2 — a different-product project can start.
    const result = schedule([proj('aura', '01')], [proj('relay', '01')], 2);
    expect(result.started).toEqual([proj('relay', '01')]);
  });
});

describe('concurrency scheduler — queued-vs-running view (test-plan §15)', () => {
  it('reports the full running set after the pass — prior running plus newly started', () => {
    const result = schedule([proj('aura', '01')], [proj('relay', '01')], 3);
    // The cockpit reads `running` and `queued` to show queued-vs-running accurately.
    expect(result.running).toEqual([proj('aura', '01'), proj('relay', '01')]);
    expect(result.queued).toEqual([]);
  });
});
