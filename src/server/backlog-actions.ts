/**
 * Server-computed backlog item actions (09-expand-cockpit, Phase 2).
 *
 * The parser produces a `BacklogItem` with no `actions` — action availability depends on
 * runtime state (an open planning session) that the pure parser can't see. This module is the
 * server-layer step that augments each item with its `actions`, computed from the item's own
 * state plus the product's planning state, for `GET /api/backlog/:product`.
 *
 * v1 offers exactly one action per item — `plan`. `disabledReason` precedence (first match
 * wins): planning-active > already-promoted > bug-done > loop-filed > parse-warning. Rationale:
 * planning-active is a transient global gate (a session is open, so nothing new may start); a
 * permanent promotion outranks a transient done checkbox; loop-filed and parse-warning are the
 * weakest, item-intrinsic reasons. (v2 adds a `fix` action for bugs.)
 */

import type { BacklogItem } from '../intent/backlog-parser.js';

export type BacklogDisabledReason =
  | 'already-promoted'
  | 'loop-filed'
  | 'planning-active'
  | 'bug-done'
  | 'parse-warning';

export interface BacklogItemAction {
  kind: 'plan';
  enabled: boolean;
  disabledReason?: BacklogDisabledReason;
}

/** A parsed item augmented with its server-computed actions — the drawer's row shape. */
export interface BacklogItemWithActions extends BacklogItem {
  actions: BacklogItemAction[];
}

/** Compute the single `plan` action for an item given whether the product has an open
 *  planning session. Pure. */
export function computePlanAction(item: BacklogItem, planningActive: boolean): BacklogItemAction {
  const disabled = (disabledReason: BacklogDisabledReason): BacklogItemAction => ({
    kind: 'plan',
    enabled: false,
    disabledReason,
  });
  if (planningActive) return disabled('planning-active');
  if (item.promotedTo) return disabled('already-promoted');
  if (item.kind === 'bugs' && item.status === 'done') return disabled('bug-done');
  if (item.section === 'loop-filed') return disabled('loop-filed');
  if (item.warnings.length > 0) return disabled('parse-warning');
  return { kind: 'plan', enabled: true };
}

/** Augment an item with its computed actions. */
export function withActions(item: BacklogItem, planningActive: boolean): BacklogItemWithActions {
  return { ...item, actions: [computePlanAction(item, planningActive)] };
}
