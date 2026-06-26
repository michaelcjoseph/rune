/**
 * Phase 7 closeout-gate suite (project 14, test-plan §7).
 *
 * This is the closeout guard: Project 14 cannot be marked done until (a) the three
 * deferral ADRs named in the spec exist with the required sections, (b) `agent-lessons.md`
 * exists with a propagation pointer or an explicit "no new lessons" rationale, and (c) the
 * Phase 5 user-reachability proof — the dispatch seam + the cockpit mode-visibility seam —
 * still holds. (c) re-checks the actual Phase 5 contracts inline so closeout cannot pass
 * while orchestrated work silently regressed to non-user-reachable.
 *
 * TEST-FIRST: the ADR + agent-lessons assertions are RED until the Phase 7 docs are
 * written; the final-completion re-checks are green (Phase 5 shipped). The phase is done
 * when the whole suite is green.
 *
 * See: docs/projects/14-product-team-agents/test-plan.md §7
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveWorkDispatch,
  ORCHESTRATED_WORK_KIND,
  LEGACY_WORK_KIND,
} from '../jobs/work-dispatch.js';
import { buildCockpitView } from './cockpit.js';
import type { Registry } from './registry.js';

// src/intent/ → repo root → docs/projects/14-product-team-agents
const PROJECT_DOCS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'projects',
  '14-product-team-agents',
);

function readDoc(name: string): string {
  return readFileSync(join(PROJECT_DOCS_DIR, name), 'utf8');
}

// ---------------------------------------------------------------------------
// §7 — Deferral ADRs exist with the required sections
// ---------------------------------------------------------------------------

const DEFERRAL_ADRS = [
  'autonomous-dispatch-deferral.md',
  'legacy-work-removal-deferral.md',
  'quality-eval-deferral.md',
];

// Required ADR sections (case-insensitive substring match against the doc body).
const REQUIRED_ADR_SECTIONS = ['status', 'context', 'decision', 'rationale', 'trigger to promote'];

describe('project-14 closeout — deferral ADRs (§7)', () => {
  for (const adr of DEFERRAL_ADRS) {
    it(`${adr} exists`, () => {
      expect(existsSync(join(PROJECT_DOCS_DIR, adr))).toBe(true);
    });

    it(`${adr} includes status, context, decision, rationale, and trigger-to-promote`, () => {
      const body = readDoc(adr).toLowerCase();
      for (const section of REQUIRED_ADR_SECTIONS) {
        expect(body).toContain(section);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// §7 — agent-lessons.md exists with propagation pointers or "no new lessons"
// ---------------------------------------------------------------------------

describe('project-14 closeout — agent-lessons.md (§7)', () => {
  it('exists', () => {
    expect(existsSync(join(PROJECT_DOCS_DIR, 'agent-lessons.md'))).toBe(true);
  });

  it('records at least one propagation pointer or an explicit "no new lessons" rationale', () => {
    const body = readDoc('agent-lessons.md');
    expect(body.trim().length).toBeGreaterThan(0);
    const hasNoLessons = /no new lessons/i.test(body);
    // A propagation pointer names a durable surface to update: the planning checklist,
    // a skill, a .claude agent, CLAUDE.md, or an explicit propagation/TODO marker.
    const hasPropagationPointer =
      /planning-checklist|CLAUDE\.md|\.claude\/|\bskill\b|propagat|TODO/i.test(body);
    expect(hasNoLessons || hasPropagationPointer).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §7 — Final-completion: re-check the Phase 5 user-reachability proof
// (dispatch seam + cockpit mode visibility). These are green already.
// ---------------------------------------------------------------------------

function registry(): Registry {
  return {
    version: 1,
    builtAt: '2026-01-15T00:00:00.000Z',
    products: [
      {
        name: 'rune',
        repoBacked: true,
        projects: [
          { slug: '14-product-team-agents', status: 'active' },
          { slug: '11-work-runs', status: 'active' },
        ],
      },
    ],
  };
}

describe('project-14 closeout — final-completion recheck of the Phase 5 dispatch seam (§7)', () => {
  it('orchestrated toggle dispatches the orchestrated applier with no fallback reason', () => {
    const res = resolveWorkDispatch({ orchestratedEnabled: true });
    expect(res.kind).toBe(ORCHESTRATED_WORK_KIND);
    expect(res.mode).toBe('orchestrated');
    expect(res.fallbackReason).toBeUndefined();
  });

  it('disabled toggle dispatches the legacy applier and records a fallback reason', () => {
    const res = resolveWorkDispatch({ orchestratedEnabled: false });
    expect(res.kind).toBe(LEGACY_WORK_KIND);
    expect(res.mode).toBe('legacy');
    expect(res.fallbackReason).toBeTruthy();
  });

  it('operator force-legacy dispatches the legacy applier with the forced reason', () => {
    const res = resolveWorkDispatch({
      orchestratedEnabled: true,
      forceLegacy: true,
      forceLegacyReason: 'operator override',
    });
    expect(res.kind).toBe(LEGACY_WORK_KIND);
    expect(res.mode).toBe('legacy');
    expect(res.fallbackReason).toBeTruthy();
  });
});

describe('project-14 closeout — final-completion recheck of the cockpit mode visibility (§7)', () => {
  it('surfaces the orchestrated dispatch mode on the project card (no fallback reason)', () => {
    const view = buildCockpitView(registry(), {}, undefined, undefined, undefined, {
      '14-product-team-agents': { mode: 'orchestrated' },
    });
    const proj = view.products[0]!.projects.find((p) => p.slug === '14-product-team-agents')!;
    expect(proj.dispatchMode).toBe('orchestrated');
    expect(proj.fallbackReason).toBeUndefined();
  });

  it('surfaces a legacy fallback mode WITH its reason so the Start surface is truthful', () => {
    const view = buildCockpitView(registry(), {}, undefined, undefined, undefined, {
      '11-work-runs': { mode: 'legacy', fallbackReason: 'orchestrated mode disabled' },
    });
    const proj = view.products[0]!.projects.find((p) => p.slug === '11-work-runs')!;
    expect(proj.dispatchMode).toBe('legacy');
    expect(proj.fallbackReason).toBe('orchestrated mode disabled');
  });
});
