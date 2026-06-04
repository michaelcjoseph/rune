import { describe, it, expect } from 'vitest';

/*
 * Integration suite for the promotion chain (09-expand-cockpit, Phase 4, written test-first).
 *
 * Stitches the pure modules end-to-end the way the Plan→approve flow does — append an idea, open
 * a promotion, capture the scaffold result, transition through the lifecycle, and mark the source
 * bullet promoted — asserting the final state is `marked-source` and the source file carries the
 * ` → <slug>` suffix. The retry/restart case re-applies mark-source against already-promoted
 * content using the promotion's stored snapshot and is a byte-equal no-op. The full HTTP wiring is
 * the Phase 5 tmpdir smoke test; this pins the module-level contract that the pieces compose.
 *
 * "Test suite as deliverable": stays RED until the Phase 4 build lands promotions.ts,
 * scaffold-result.ts, and backlog-mark-done.ts (backlog-append.ts already exists).
 */

import { appendIdea } from './backlog-append.js';
import { parseScaffoldResult, crossCheckScaffold } from './scaffold-result.js';
import {
  createPromotion,
  transitionPromotion,
  type Promotion,
} from './promotions.js';
import { markBacklogItemDone } from './backlog-mark-done.js';

/** Sound assertion-function narrowing for `{ ok: boolean }` discriminated unions. */
function assertOk<T extends { ok: boolean }>(r: T): asserts r is T & { ok: true } {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
}

const SLUG = '09-expand-cockpit';
// A realistic ideas file: User-authored section above the Loop-filed sentinel.
const IDEAS_BEFORE = '## User-authored\n- Existing idea\n\n## Loop-filed\n';
const SNAPSHOT = '- Expand the cockpit';

function scaffoldMsg(slug: string): string {
  return ['Scaffolded.', '```scaffold-result', JSON.stringify({ slug, filesCreated: [`docs/projects/${slug}/spec.md`] }), '```'].join('\n');
}

describe('plan-e2e — append → plan → scaffold → mark-source', () => {
  it('drives the full chain to marked-source with the source bullet promoted (sentinel preserved)', () => {
    // 1. Append an idea — inserts above the Loop-filed sentinel (primary path).
    const appended = appendIdea(IDEAS_BEFORE, 'Expand the cockpit');
    assertOk(appended);
    const ideasContent = appended.content;
    expect(ideasContent).toContain(SNAPSHOT);
    expect(ideasContent.indexOf(SNAPSHOT)).toBeLessThan(ideasContent.indexOf('## Loop-filed'));

    // 2. Plan click — create a Promotion linked to the appended bullet.
    let promotion: Promotion = createPromotion({
      id: 'promo-e2e', product: 'jarvis', backlogItemId: 'b-e2e',
      snapshotRaw: SNAPSHOT, planningSessionId: 'sess-e2e', now: 'T0',
    });
    expect(promotion.state).toBe('planning-started');

    // 3. Approve → parse the setup-writer's scaffold-result, cross-check against the repo diff.
    const parsed = parseScaffoldResult(scaffoldMsg(SLUG));
    expect(parsed?.slug).toBe(SLUG);
    const check = crossCheckScaffold(parsed, [SLUG]);
    assertOk(check);
    const scaffolded = transitionPromotion(promotion, 'scaffolded', { slug: check.slug, now: 'T1' });
    assertOk(scaffolded);
    promotion = scaffolded.promotion;
    expect(promotion.state).toBe('scaffolded');
    expect(promotion.slug).toBe(SLUG);

    // 4. Mark the source bullet promoted (snapshot match, append ` → slug`).
    const marked = markBacklogItemDone(ideasContent, 'ideas', promotion.snapshotRaw, promotion.slug!);
    expect(marked.matched).toBe(true);
    if (!marked.matched) return;
    expect(marked.newText).toContain(`- Expand the cockpit → ${SLUG}`);
    expect(marked.newText).toContain('- Existing idea'); // untouched
    expect(marked.newText).toContain('## Loop-filed'); // sentinel preserved

    // 5. Promotion reaches marked-source (terminal success).
    const done = transitionPromotion(promotion, 'marked-source', { now: 'T2' });
    assertOk(done);
    expect(done.promotion.state).toBe('marked-source');
  });

  it('retry/restart: re-marking already-promoted content via the promotion snapshot is a byte-equal no-op, and the promotion still completes', () => {
    // A promotion that scaffolded but whose mark-source transition didn't persist (the restart
    // case). Its stored snapshotRaw is the ORIGINAL bullet; the file already shows the promoted line.
    let promotion = createPromotion({
      id: 'promo-retry', product: 'jarvis', backlogItemId: 'b-retry',
      snapshotRaw: SNAPSHOT, planningSessionId: 'sess-retry', now: 'T0',
    });
    const scaffolded = transitionPromotion(promotion, 'scaffolded', { slug: SLUG, now: 'T1' });
    assertOk(scaffolded);
    promotion = scaffolded.promotion;

    const promotedContent = `## User-authored\n- Existing idea\n- Expand the cockpit → ${SLUG}\n\n## Loop-filed\n`;
    const marked = markBacklogItemDone(promotedContent, 'ideas', promotion.snapshotRaw, promotion.slug!);
    expect(marked.matched).toBe(true);
    if (marked.matched) expect(marked.newText).toBe(promotedContent); // byte-equal no-op

    const done = transitionPromotion(promotion, 'marked-source', { now: 'T2' });
    assertOk(done);
    expect(done.promotion.state).toBe('marked-source');
  });
});
