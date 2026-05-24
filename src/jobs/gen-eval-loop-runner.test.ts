/**
 * Test suite for `src/jobs/gen-eval-loop-runner.ts` — the MutationApplier
 * scaffold for the single-model Generator-Evaluator loop (Phase 6 A3).
 *
 * Written test-first (A3.1); the implementation file does not exist yet —
 * every test must fail with a missing-module / missing-export error.
 *
 * Scope: A3.1 ships only the scaffold (validate path + applier registration
 * shape). The per-round loop body (`/work --auto` then `/review` then
 * `recordRound` + `evaluateLoop`) lands in A3.2 — until then the placeholder
 * `apply()` yields a structured 'not implemented' failed event so a caller
 * that triggers the run gets a clear signal instead of silent success.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Mocks (vi.mock is auto-hoisted above const declarations, so the
//     shared objects need vi.hoisted to be initialized in time). ---

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { mockActiveRuns, mockConfig } = vi.hoisted(() => ({
  // activeRuns is shared module state in mutations.ts; the applier consults
  // it for the per-product concurrency cap. Mutated per test.
  mockActiveRuns: new Map<
    string,
    { descriptor: { kind: string; status: string; payload: Record<string, unknown> } }
  >(),
  // config.PRODUCTS_CONFIG_FILE is read by the applier; the beforeEach
  // overwrites this to point at a fresh tmpdir-backed products.json.
  mockConfig: { PRODUCTS_CONFIG_FILE: '/test/products.json' },
}));

vi.mock('../transport/mutations.js', () => ({
  activeRuns: mockActiveRuns,
}));

vi.mock('../config.js', () => ({
  default: mockConfig,
}));

// --- Imports under test (after mocks) ---

import { genEvalLoopApplier } from './gen-eval-loop-runner.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-gel-runner-test-'));
  const productsPath = join(tmpDir, 'products.json');
  writeFileSync(productsPath, JSON.stringify({
    aura: {
      repoPath: '/fake/workspace/aura',
      baseBranch: 'main',
      credentialsFile: '/fake/aura.env',
      egressAllowlist: ['github.com'],
    },
    assay: {
      repoPath: '/fake/workspace/assay',
      baseBranch: 'main',
      credentialsFile: '/fake/assay.env',
      egressAllowlist: ['github.com'],
    },
  }));
  mockConfig.PRODUCTS_CONFIG_FILE = productsPath;
  mockActiveRuns.clear();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('genEvalLoopApplier — shape', () => {
  it('declares the kind "gen-eval-loop"', () => {
    expect(genEvalLoopApplier.kind).toBe('gen-eval-loop');
  });

  it('does NOT autoApprove — gen-eval-loop runs require explicit approval', () => {
    // The autonomous engine dispatches these via the future planner approval
    // flow, not bare createMutation. Defaulting to false avoids accidentally
    // firing a long run from a misroute.
    expect(genEvalLoopApplier.autoApprove).toBe(false);
  });
});

describe('genEvalLoopApplier — validate', () => {
  function validate(
    payload: Record<string, unknown>,
  ): { ok: true } | { ok: false; reason: string } {
    // The applier reads products.json from config.PRODUCTS_CONFIG_FILE; the
    // beforeEach above repoints that mock to a per-test tmp fixture.
    return genEvalLoopApplier.validate(payload as never);
  }

  it('accepts a valid payload', () => {
    const result = validate({ product: 'aura', project: '01-growth' });
    expect(result).toEqual({ ok: true });
  });

  it('accepts a valid payload with maxEvaluatorRounds override', () => {
    const result = validate({ product: 'aura', project: '01-growth', maxEvaluatorRounds: 5 });
    expect(result).toEqual({ ok: true });
  });

  it('rejects when product is missing', () => {
    const result = validate({ project: '01-growth' });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('product') });
  });

  it('rejects when project is missing', () => {
    const result = validate({ product: 'aura' });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('project') });
  });

  it('rejects when product slug is malformed (path traversal)', () => {
    const result = validate({ product: '../etc', project: '01-growth' });
    expect(result.ok).toBe(false);
  });

  it('rejects when project slug is malformed', () => {
    const result = validate({ product: 'aura', project: 'a/b' });
    expect(result.ok).toBe(false);
  });

  it('rejects when product is not in products.json', () => {
    const result = validate({ product: 'relay', project: '01-core' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('relay');
  });

  it('rejects when maxEvaluatorRounds is zero', () => {
    const result = validate({ product: 'aura', project: '01-growth', maxEvaluatorRounds: 0 });
    expect(result.ok).toBe(false);
  });

  it('rejects when maxEvaluatorRounds is negative', () => {
    const result = validate({ product: 'aura', project: '01-growth', maxEvaluatorRounds: -1 });
    expect(result.ok).toBe(false);
  });

  it('rejects when maxEvaluatorRounds is non-integer', () => {
    const result = validate({ product: 'aura', project: '01-growth', maxEvaluatorRounds: 1.5 });
    expect(result.ok).toBe(false);
  });

  it('rejects a duplicate per-product run (one gen-eval-loop per product at a time)', () => {
    mockActiveRuns.set('m1', {
      descriptor: {
        kind: 'gen-eval-loop',
        status: 'running',
        payload: { product: 'aura', project: '01-growth' },
      },
    });
    const result = validate({ product: 'aura', project: '02-other' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('aura');
  });

  it('allows a second run on a different product even when one is in flight', () => {
    mockActiveRuns.set('m1', {
      descriptor: {
        kind: 'gen-eval-loop',
        status: 'running',
        payload: { product: 'aura', project: '01-growth' },
      },
    });
    const result = validate({ product: 'assay', project: '01-core' });
    expect(result).toEqual({ ok: true });
  });
});

describe('genEvalLoopApplier — placeholder apply (A3.2 not yet built)', () => {
  it('yields a single failed event mentioning the unimplemented loop body', async () => {
    const events: Array<{ kind: string; data?: unknown }> = [];
    const descriptor = {
      id: 'desc-1',
      kind: 'gen-eval-loop' as const,
      source: 'webview' as const,
      target: { type: 'gen-eval-loop', ref: 'aura/01-growth' },
      preview: { summary: 'gen-eval-loop on aura/01-growth' },
      payload: { product: 'aura', project: '01-growth' },
      createdAt: new Date().toISOString(),
      status: 'running' as const,
    };
    const ctx = { bus: { publish: vi.fn(), on: vi.fn(), off: vi.fn() } as any, cancel: () => false };

    for await (const ev of genEvalLoopApplier.apply(descriptor as any, ctx)) {
      events.push({ kind: ev.kind, data: ev.data });
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('failed');
    const data = events[0]!.data as Record<string, unknown>;
    expect(String(data['reason'])).toMatch(/not.*implemented|A3\.2/i);
  });
});
