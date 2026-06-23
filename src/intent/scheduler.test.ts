import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Test suite for test-plan.md §15 — concurrency scheduler (08-intent-layer, Phase 4).
 *
 * Written test-first; `src/intent/scheduler.ts` now implements `schedule`, so the suite is
 * green.
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

describe('concurrency scheduler — configured WORK_RUN_GLOBAL_CAP (project 17)', () => {
  const ORIGINAL_ENV = { ...process.env };
  const REQUIRED_ENV = {
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: '12345',
    VAULT_DIR: '/tmp/vault',
  };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, ...REQUIRED_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  async function loadWorkRunGlobalCap(): Promise<number> {
    const { default: config } = await import('../config.js');
    return config.WORK_RUN_GLOBAL_CAP;
  }

  function queueWithDuplicateFirstProduct(distinctProductCount: number): ScheduledProject[] {
    const products = Array.from({ length: distinctProductCount }, (_, i) => `product-${i + 1}`);
    return [
      proj(products[0], '01'),
      proj(products[0], '02'),
      ...products.slice(1).map((product) => proj(product, '01')),
    ];
  }

  it('runs N products in parallel under a raised cap while holding one per product', () => {
    const cap = 3;

    const sameProductSecondProject = proj('product-1', '02');
    const result = schedule([], queueWithDuplicateFirstProduct(cap), cap);

    expect(result.started).toHaveLength(cap);
    expect(new Set(result.started.map((p) => p.product)).size).toBe(cap);
    expect(result.started).not.toContainEqual(sameProductSecondProject);
    expect(result.queued).toEqual([sameProductSecondProject]);
  });

  it('honors a WORK_RUN_GLOBAL_CAP env override when deciding how many products start', async () => {
    process.env['WORK_RUN_GLOBAL_CAP'] = '5';
    const cap = await loadWorkRunGlobalCap();
    expect(cap).toBe(5);

    const sameProductSecondProject = proj('product-1', '02');
    const result = schedule([], queueWithDuplicateFirstProduct(cap), cap);

    expect(result.started).toEqual([
      proj('product-1', '01'),
      proj('product-2', '01'),
      proj('product-3', '01'),
      proj('product-4', '01'),
      proj('product-5', '01'),
    ]);
    expect(result.queued).toEqual([sameProductSecondProject]);
  });
});
