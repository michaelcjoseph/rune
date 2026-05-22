import { describe, it, expect } from 'vitest';

/*
 * Test-first suite for test-plan.md §3 — product-overlay index (08-intent-layer, Phase 1).
 *
 * Written BEFORE the overlay implementation. `src/intent/overlay.ts` currently ships as a
 * contract stub whose functions throw 'not implemented', so every test here is RED. That
 * is the intended, correct state: this is a "Tests (write first)" task — the suite goes
 * green when Phase 1's overlay-index implementation tasks land. Do not implement the
 * overlay to make these pass; that is a separate task.
 */

import {
  buildOverlayManifest,
  scopedRetrieval,
  findStalePointers,
  type OverlayCandidate,
  type OverlayManifest,
} from './overlay.js';

// --- Fixtures ---

/** Scanned vault slices for two products (Aura, Relay) across all four overlay kinds. */
function candidates(): OverlayCandidate[] {
  return [
    { pointer: { kind: 'journal', path: 'journals/2026_05_01.md' }, products: ['aura'] },
    {
      pointer: { kind: 'page', path: 'pages/playbook.md', anchor: 'aura-pricing-2026-05-01' },
      products: ['aura'],
    },
    {
      pointer: { kind: 'worldview-section', path: 'world-view/products.md', anchor: '2026_05_01' },
      products: ['aura'],
    },
    // A shared concept — relates to both products.
    {
      pointer: { kind: 'wiki-concept', path: 'knowledge/pricing-power.md', anchor: 'pricing-power' },
      products: ['aura', 'relay'],
    },
    { pointer: { kind: 'journal', path: 'journals/2026_04_20.md' }, products: ['relay'] },
    { pointer: { kind: 'page', path: 'pages/crm.json' }, products: ['relay'] },
  ];
}

/** A manifest literal — lets the retrieval and stale-pointer tests stand on their own. */
function auraManifest(): OverlayManifest {
  return {
    product: 'aura',
    pointers: [
      { kind: 'journal', path: 'journals/2026_05_01.md' },
      { kind: 'page', path: 'pages/playbook.md', anchor: 'aura-pricing-2026-05-01' },
      { kind: 'wiki-concept', path: 'knowledge/pricing-power.md', anchor: 'pricing-power' },
    ],
  };
}

/** A second product's manifest literal — its slices must never leak into Aura retrieval. */
function relayManifest(): OverlayManifest {
  return {
    product: 'relay',
    pointers: [
      { kind: 'journal', path: 'journals/2026_04_20.md' },
      { kind: 'page', path: 'pages/crm.json' },
    ],
  };
}

describe('product-overlay index — manifest contents (test-plan §3)', () => {
  it('a product manifest points at journal entries, pages, world-view sections, and wiki concepts', () => {
    const manifest = buildOverlayManifest('aura', candidates());
    const kinds = new Set(manifest.pointers.map((p) => p.kind));
    expect(kinds).toEqual(new Set(['journal', 'page', 'worldview-section', 'wiki-concept']));
  });

  it('world-view section and wiki-concept pointers carry an anchor into the file', () => {
    const manifest = buildOverlayManifest('aura', candidates());
    expect(manifest.pointers.find((p) => p.kind === 'worldview-section')?.anchor).toBeTruthy();
    expect(manifest.pointers.find((p) => p.kind === 'wiki-concept')?.anchor).toBeTruthy();
  });

  it('contains only the target product\'s slices — every pointer comes from an Aura-tagged candidate', () => {
    const source = candidates();
    const manifest = buildOverlayManifest('aura', source);
    const auraTagged = new Set(
      source.filter((c) => c.products.includes('aura')).map((c) => c.pointer.path),
    );
    for (const pointer of manifest.pointers) {
      expect(auraTagged.has(pointer.path), `${pointer.path} must be Aura-tagged`).toBe(true);
    }
    // Relay-exclusive slices never leak in.
    const paths = manifest.pointers.map((p) => p.path);
    expect(paths).not.toContain('journals/2026_04_20.md');
    expect(paths).not.toContain('pages/crm.json');
  });

  it('includes a slice shared between products in each related product\'s manifest', () => {
    const aura = buildOverlayManifest('aura', candidates());
    const relay = buildOverlayManifest('relay', candidates());
    expect(aura.pointers.some((p) => p.path === 'knowledge/pricing-power.md')).toBe(true);
    expect(relay.pointers.some((p) => p.path === 'knowledge/pricing-power.md')).toBe(true);
  });

  it('points at content in place — every manifest path is an existing vault slice, nothing relocated', () => {
    // test-plan §3: the vault is not moved or reorganized — the manifest only points into
    // the existing type-organized structure.
    const source = candidates();
    const sourcePaths = new Set(source.map((c) => c.pointer.path));
    const manifest = buildOverlayManifest('aura', source);
    for (const pointer of manifest.pointers) {
      expect(sourcePaths.has(pointer.path), `${pointer.path} must be a vault slice in place`).toBe(true);
    }
  });

  it('yields a small but valid manifest for a product with little vault content — not an error', () => {
    // Reaching the assertions at all proves the build did not error; Storytime relates to
    // none of the fixture slices, so its manifest is empty but valid.
    const manifest = buildOverlayManifest('storytime', candidates());
    expect(manifest.product).toBe('storytime');
    expect(manifest.pointers).toEqual([]);
  });
});

describe('product-overlay index — scoped retrieval (test-plan §3)', () => {
  it('returns only the target product\'s slices — planning an Aura project does not pull in Relay', () => {
    const retrieved = scopedRetrieval([auraManifest(), relayManifest()], 'aura');
    const auraPaths = new Set(auraManifest().pointers.map((p) => p.path));
    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved.every((p) => auraPaths.has(p.path))).toBe(true);
    expect(retrieved.some((p) => p.path === 'journals/2026_04_20.md')).toBe(false);
  });

  it('returns nothing for a product with no manifest — graceful, not an error', () => {
    expect(scopedRetrieval([auraManifest()], 'storytime')).toEqual([]);
  });
});

describe('product-overlay index — stale pointers (test-plan §3)', () => {
  it('detects a manifest pointer whose target file was deleted or renamed', () => {
    const gone = 'journals/2026_05_01.md';
    const stale = findStalePointers(auraManifest(), (path) => path !== gone);
    expect(stale.map((p) => p.path)).toContain(gone);
  });

  it('reports no stale pointers when every target still resolves', () => {
    expect(findStalePointers(auraManifest(), () => true)).toEqual([]);
  });
});
