import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Test suite for the durable promotion job (09-expand-cockpit, Phase 4, written test-first).
 *
 * `promotions.ts` drives a backlog item through `planning-started → scaffolded → marked-source`,
 * persisting each transition to an append-only JSONL log so the chain survives a Jarvis restart.
 * Terminal states (`marked-source`, `planning-abandoned`, `scaffold-error`) never transition out;
 * `mark-source-error` is retryable with backoff up to a capped attempt count. On restart the log
 * is replayed: any promotion stuck at `scaffolded` (scaffold succeeded, mark-source didn't run) is
 * resumable.
 *
 * "Test suite as deliverable": stays RED until the Phase 4 build lands `promotions.ts`.
 */

import {
  createPromotion,
  transitionPromotion,
  isTerminalPromotion,
  appendPromotion,
  loadPromotions,
  resumablePromotions,
  canRetryMarkSource,
  MAX_MARK_SOURCE_ATTEMPTS,
  type Promotion,
} from './promotions.js';

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
function tmpLog(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'promotions-')));
  created.push(dir);
  return join(dir, 'promotions.jsonl');
}

function newPromotion(over: Partial<Promotion> = {}): Promotion {
  return createPromotion({
    id: 'promo-1',
    product: 'jarvis',
    backlogItemId: 'b-abc123',
    snapshotRaw: '- [ ] Cockpit shows wrong status',
    planningSessionId: 'sess-1',
    now: '2026-06-03T00:00:00.000Z',
    ...over,
  });
}

describe('promotions — createPromotion', () => {
  it('starts in planning-started with zero attempts and no slug', () => {
    const p = newPromotion();
    expect(p.state).toBe('planning-started');
    expect(p.attempts).toBe(0);
    expect(p.slug).toBeUndefined();
    expect(p.errors).toEqual([]);
    expect(p.product).toBe('jarvis');
    expect(p.backlogItemId).toBe('b-abc123');
  });
});

describe('promotions — transitionPromotion', () => {
  it('advances planning-started → scaffolded, capturing the slug', () => {
    const p = transitionPromotion(newPromotion(), 'scaffolded', { slug: '09-expand-cockpit', now: 'T1' });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.promotion.state).toBe('scaffolded');
      expect(p.promotion.slug).toBe('09-expand-cockpit');
      expect(p.promotion.updatedAt).toBe('T1');
    }
  });

  it('advances scaffolded → marked-source (terminal success)', () => {
    const scaffolded = transitionPromotion(newPromotion(), 'scaffolded', { slug: '09-x', now: 'T1' });
    expect(scaffolded.ok).toBe(true);
    if (!scaffolded.ok) return;
    const done = transitionPromotion(scaffolded.promotion, 'marked-source', { now: 'T2' });
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.promotion.state).toBe('marked-source');
  });

  it('advances planning-started → planning-abandoned', () => {
    const abandoned = transitionPromotion(newPromotion(), 'planning-abandoned', { now: 'T1' });
    expect(abandoned.ok).toBe(true);
    if (abandoned.ok) expect(abandoned.promotion.state).toBe('planning-abandoned');
  });

  it('records an error and increments attempts on mark-source-error', () => {
    const scaffolded = transitionPromotion(newPromotion(), 'scaffolded', { slug: '09-x', now: 'T1' });
    if (!scaffolded.ok) throw new Error('setup');
    const errored = transitionPromotion(scaffolded.promotion, 'mark-source-error', {
      error: 'no snapshot match',
      now: 'T2',
    });
    expect(errored.ok).toBe(true);
    if (errored.ok) {
      expect(errored.promotion.state).toBe('mark-source-error');
      expect(errored.promotion.attempts).toBe(1);
      expect(errored.promotion.errors).toContain('no snapshot match');
    }
  });

  it('refuses to transition out of a terminal state', () => {
    const scaffolded = transitionPromotion(newPromotion(), 'scaffolded', { slug: '09-x', now: 'T1' });
    if (!scaffolded.ok) throw new Error('setup');
    const done = transitionPromotion(scaffolded.promotion, 'marked-source', { now: 'T2' });
    if (!done.ok) throw new Error('setup');
    const reentered = transitionPromotion(done.promotion, 'scaffolded', { slug: 'x', now: 'T3' });
    expect(reentered.ok).toBe(false);
    if (!reentered.ok) expect(reentered.reason).toBe('terminal-state');
  });

  it('advances planning-started → scaffold-error (terminal) and refuses to leave it', () => {
    const errored = transitionPromotion(newPromotion(), 'scaffold-error', { error: 'no slug', now: 'T1' });
    expect(errored.ok).toBe(true);
    if (!errored.ok) return;
    expect(errored.promotion.state).toBe('scaffold-error');
    expect(errored.promotion.errors).toContain('no slug');
    const out = transitionPromotion(errored.promotion, 'scaffolded', { slug: 'x', now: 'T2' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('terminal-state');
  });

  it('advances a retryable mark-source-error → marked-source (retry success)', () => {
    const sc = transitionPromotion(newPromotion(), 'scaffolded', { slug: 'x', now: 'T1' });
    if (!sc.ok) throw new Error('setup');
    const e = transitionPromotion(sc.promotion, 'mark-source-error', { error: 'x', now: 'T2' });
    if (!e.ok) throw new Error('setup');
    const done = transitionPromotion(e.promotion, 'marked-source', { now: 'T3' });
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.promotion.state).toBe('marked-source');
  });

  it('rejects an illegal non-terminal edge (planning-started → mark-source-error)', () => {
    const bad = transitionPromotion(newPromotion(), 'mark-source-error', { error: 'x', now: 'T1' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('invalid-transition');
  });

  it('requires a slug for the scaffolded transition', () => {
    const noSlug = transitionPromotion(newPromotion(), 'scaffolded', { now: 'T1' });
    expect(noSlug.ok).toBe(false);
    if (!noSlug.ok) expect(noSlug.reason).toBe('missing-slug');
  });
});

describe('promotions — isTerminalPromotion', () => {
  it('treats marked-source, planning-abandoned, and scaffold-error as terminal', () => {
    expect(isTerminalPromotion('marked-source')).toBe(true);
    expect(isTerminalPromotion('planning-abandoned')).toBe(true);
    expect(isTerminalPromotion('scaffold-error')).toBe(true);
  });
  it('treats planning-started, scaffolded, and mark-source-error as non-terminal', () => {
    expect(isTerminalPromotion('planning-started')).toBe(false);
    expect(isTerminalPromotion('scaffolded')).toBe(false);
    expect(isTerminalPromotion('mark-source-error')).toBe(false);
  });
});

describe('promotions — persistence (append-only JSONL, replay last-write-wins)', () => {
  it('appends one JSON line per write and replays the latest state per id', () => {
    const log = tmpLog();
    const p = newPromotion();
    appendPromotion(log, p);
    const scaffolded = transitionPromotion(p, 'scaffolded', { slug: '09-x', now: 'T1' });
    if (!scaffolded.ok) throw new Error('setup');
    appendPromotion(log, scaffolded.promotion);

    // Two physical lines (append-only), one logical promotion at its latest state.
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2);
    const loaded = loadPromotions(log);
    expect(loaded.get('promo-1')?.state).toBe('scaffolded');
    expect(loaded.get('promo-1')?.slug).toBe('09-x');
  });

  it('replays independent promotions by id', () => {
    const log = tmpLog();
    appendPromotion(log, newPromotion({ id: 'a' }));
    appendPromotion(log, newPromotion({ id: 'b' }));
    const loaded = loadPromotions(log);
    expect([...loaded.keys()].sort()).toEqual(['a', 'b']);
  });

  it('returns an empty map for a missing log file', () => {
    expect(loadPromotions(join(tmpLog(), 'does-not-exist.jsonl')).size).toBe(0);
  });
});

describe('promotions — restart replay (resumable = scaffolded)', () => {
  it('selects scaffolded promotions (scaffold succeeded, mark-source pending) as resumable', () => {
    const log = tmpLog();
    // started: not resumable; scaffolded: resumable; marked-source: terminal, not resumable.
    appendPromotion(log, newPromotion({ id: 'started' }));
    const sc = transitionPromotion(newPromotion({ id: 'scaffolded' }), 'scaffolded', { slug: 'x', now: 'T1' });
    if (!sc.ok) throw new Error('setup');
    appendPromotion(log, sc.promotion);
    const done = transitionPromotion(sc.promotion, 'marked-source', { now: 'T2' });
    if (!done.ok) throw new Error('setup');
    appendPromotion(log, { ...done.promotion, id: 'done' });

    // A mark-source-error promotion is NOT restart-resumable (it's driven by explicit retry).
    const sc2 = transitionPromotion(newPromotion({ id: 'errored' }), 'scaffolded', { slug: 'x', now: 'T1' });
    if (!sc2.ok) throw new Error('setup');
    const er = transitionPromotion(sc2.promotion, 'mark-source-error', { error: 'x', now: 'T2' });
    if (!er.ok) throw new Error('setup');
    appendPromotion(log, er.promotion);

    const resumable = resumablePromotions(loadPromotions(log));
    expect(resumable.map((p) => p.id)).toEqual(['scaffolded']);
  });
});

describe('promotions — capped mark-source retry', () => {
  it('allows retry while attempts are below the cap, then refuses at the cap', () => {
    const sc = transitionPromotion(newPromotion(), 'scaffolded', { slug: 'x', now: 'T1' });
    if (!sc.ok) throw new Error('setup');
    let promotion = sc.promotion;
    // Each failed mark-source attempt re-enters mark-source-error and bumps attempts.
    for (let i = 1; i <= MAX_MARK_SOURCE_ATTEMPTS; i++) {
      const e = transitionPromotion(promotion, 'mark-source-error', { error: `attempt ${i}`, now: `T${i}` });
      if (!e.ok) throw new Error('setup');
      promotion = e.promotion;
      expect(promotion.attempts).toBe(i);
      // Retryable while below the cap; refused once attempts reach it.
      expect(canRetryMarkSource(promotion)).toBe(i < MAX_MARK_SOURCE_ATTEMPTS);
    }
    expect(promotion.attempts).toBe(MAX_MARK_SOURCE_ATTEMPTS);
    expect(canRetryMarkSource(promotion)).toBe(false);
    // The transition function ENFORCES the cap (the guard is not advisory-only).
    const past = transitionPromotion(promotion, 'mark-source-error', { error: 'over', now: 'TX' });
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.reason).toBe('cap-exceeded');
  });

  it('canRetryMarkSource is false for a non-error state', () => {
    expect(canRetryMarkSource(newPromotion())).toBe(false);
  });

  it('canRetryMarkSource is true for a mark-source-error under the cap', () => {
    const sc = transitionPromotion(newPromotion(), 'scaffolded', { slug: 'x', now: 'T1' });
    if (!sc.ok) throw new Error('setup');
    const e = transitionPromotion(sc.promotion, 'mark-source-error', { error: 'x', now: 'T2' });
    if (!e.ok) throw new Error('setup');
    expect(e.promotion.attempts).toBe(1);
    expect(canRetryMarkSource(e.promotion)).toBe(true);
  });
});
