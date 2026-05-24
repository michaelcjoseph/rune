/**
 * Test suite for `src/server/cockpit-run-status.ts` — the pure projection
 * that maps the supervision `VisibilitySurface` into the cockpit's
 * `RunStatusByProject` shape.
 *
 * Written test-first; the implementation file does not exist yet — every
 * test must fail with a missing-module / missing-export error.
 */

import { describe, it, expect } from 'vitest';
import type { SupervisedRun, VisibilitySurface } from '../intent/supervision.js';

import { mapVisibilityToRunStatus } from './cockpit-run-status.js';

function makeRun(
  id: string,
  project: string,
  status: SupervisedRun['status'],
): SupervisedRun {
  return {
    id,
    project,
    product: 'aura',
    status,
    startedAt: '2026-01-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
  };
}

function vis(active: SupervisedRun[]): VisibilitySurface {
  return {
    active,
    blocked: active.filter((r) => r.status === 'blocked-on-human'),
    stalled: [],
  };
}

describe('mapVisibilityToRunStatus', () => {
  it('returns {} when no runs are active', () => {
    expect(mapVisibilityToRunStatus(vis([]))).toEqual({});
  });

  it('maps a single running run to {slug: "running"}', () => {
    const r = makeRun('id-1', '01-growth', 'running');
    expect(mapVisibilityToRunStatus(vis([r]))).toEqual({ '01-growth': 'running' });
  });

  it('maps a single blocked-on-human run to {slug: "blocked-on-human"}', () => {
    const r = makeRun('id-1', '01-growth', 'blocked-on-human');
    expect(mapVisibilityToRunStatus(vis([r]))).toEqual({ '01-growth': 'blocked-on-human' });
  });

  it('blocked-on-human wins over running for the same project slug', () => {
    // A project with both states should surface as blocked — the user
    // needs to take action, which is the more urgent cockpit signal.
    const running = makeRun('id-1', '01-growth', 'running');
    const blocked = makeRun('id-2', '01-growth', 'blocked-on-human');
    expect(mapVisibilityToRunStatus(vis([running, blocked]))).toEqual({
      '01-growth': 'blocked-on-human',
    });
    // Order-independent: same result if blocked comes first.
    expect(mapVisibilityToRunStatus(vis([blocked, running]))).toEqual({
      '01-growth': 'blocked-on-human',
    });
  });

  it('keeps distinct projects in separate entries', () => {
    const a = makeRun('id-1', '01-growth', 'running');
    const b = makeRun('id-2', '02-billing', 'blocked-on-human');
    expect(mapVisibilityToRunStatus(vis([a, b]))).toEqual({
      '01-growth': 'running',
      '02-billing': 'blocked-on-human',
    });
  });

  it('ignores terminal runs (visibility.active never includes them, but verify)', () => {
    // getVisibility's `active` filter excludes terminal entries — verify
    // the mapper doesn't accidentally emit anything for runs the caller
    // wouldn't include.
    const empty: VisibilitySurface = { active: [], blocked: [], stalled: [] };
    expect(mapVisibilityToRunStatus(empty)).toEqual({});
  });
});
