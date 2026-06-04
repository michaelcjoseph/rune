/**
 * Deterministic backlog item id (09-expand-cockpit, Phase 1).
 *
 * One source of truth for a backlog item's id:
 *
 *   sha1(`${kind}:${repoRelativeFile}:${lineNumber}:${normalizedRaw}`).slice(0, 12)
 *
 * The id is intentionally UNSTABLE across line edits — a content edit changes the id, which
 * is how a stale Plan URL surfaces as `409 stale-item` and forces the cockpit to re-fetch
 * (see spec.md "Data model"). It is also intentionally PRODUCT-LOCAL: the formula carries no
 * product term, so two product repos can hold a byte-identical bullet at the same path+line
 * and collide on id string — disambiguation is the API route's `:product` segment, not the
 * id (see test-plan.md §2/§3).
 *
 * The contract is pinned by the test-first suite in `backlog-id.test.ts`.
 */

import { createHash } from 'node:crypto';

/** Which backlog file an item came from. */
export type BacklogKind = 'bugs' | 'ideas';

/** The four terms hashed into a backlog item's id. */
export interface BacklogIdInput {
  kind: BacklogKind;
  /** Repo-relative path of the source file, e.g. `docs/projects/bugs.md` — never absolute. */
  file: string;
  /** 1-based line number of the item's top-level line. */
  lineNumber: number;
  /** The raw source line; normalized via {@link normalizeBacklogRaw} before hashing. */
  raw: string;
}

/**
 * Normalize a raw source line before it enters the id hash: strip trailing whitespace and a
 * trailing carriage return (CRLF parity), preserving leading indentation and interior content.
 * Invisible trailing-whitespace edits therefore don't churn the id, while any visible content
 * change does.
 */
export function normalizeBacklogRaw(raw: string): string {
  return raw.trimEnd();
}

/** Compute the 12-char hex id for a backlog item. */
export function computeBacklogId(input: BacklogIdInput): string {
  const key = `${input.kind}:${input.file}:${input.lineNumber}:${normalizeBacklogRaw(input.raw)}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}
