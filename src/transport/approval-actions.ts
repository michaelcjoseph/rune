/**
 * Approval-actions dispatch — shared between the webview HTTP handlers
 * (`POST /api/approvals/:id/{approve,reject}`) and the Telegram callback-query
 * handler (Phase 6 C6.2). Composite approval ids look like
 * `<source>:<payload>` (e.g. `intent-proposal:0`, `playbook:2`,
 * `ask-twice:1`, `blocked-on-human:<run-id>`); this module owns the parse,
 * the source-dispatch, and the queue mutations so the two surfaces can't
 * drift out of sync.
 *
 * Lives under `src/transport/` because it's a transport-agnostic actioning
 * primitive — both the HTTP server (in `src/server/webview.ts`) and the
 * Telegram bot (in `src/bot/telegram.ts`) import it. Keeping it here
 * avoids the awkward dependency direction of `bot/` reaching into
 * `server/` for shared logic.
 */

import {
  readIntentProposalQueue,
  writeIntentProposalQueue,
  clearApprovedIntentProposals,
} from '../intent/intent-proposal-queue.js';
import { readProposalQueue, writeProposalQueue } from '../jobs/proposal-queue.js';
import { readPlaybookQueue, writePlaybookQueue } from '../jobs/playbook-extract.js';
import { actionApprovedIntentProposal } from '../intent/journal-intent-consumer.js';
import { realConsumerDeps } from '../intent/journal-intent-actions.js';
import { requestWorkRunRelease, defaultReleaseRequestDeps } from '../jobs/work-run-release.js';
import { VALID_SLUG } from '../intent/sandbox.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('approval-actions');

// Internal — both types are consumed only inside this module. Keeping them
// unexported avoids a name clash with `DispatchResult` from
// `src/intent/dispatch.ts`, which is a completely different union.
type ApprovalStatus = 'approved' | 'rejected';
/** `ok` — successful pending→approved/rejected transition.
 *  `not-found` — id parse failed, queue index out of range, entry already
 *    actioned, or source is `blocked-on-human` (terminal, not queue-flippable).
 *  `error` — a disk-write failure (or other unexpected throw) from the
 *    queue mutator. The HTTP path maps this to a 500 so the caller can
 *    distinguish "entry not found" from "server failed to persist." */
export type ApprovalDispatchResult = 'ok' | 'not-found' | 'error';

/** Run a queue write and trap disk-write failures into a `'error'` result so
 *  a bad disk doesn't crash the caller (the Telegram callback_query handler
 *  is an EventEmitter listener — a sync throw there crashes the process).
 *  Both the HTTP and Telegram paths get a result they can surface cleanly
 *  rather than a propagated throw. */
function safeWrite(label: string, fn: () => void): 'ok' | 'error' {
  try {
    fn();
    return 'ok';
  } catch (err: unknown) {
    log.error(`${label} write failed`, { error: err instanceof Error ? err.message : String(err) });
    return 'error';
  }
}

/** Parse a composite approval id into (source, payload). Returns null on
 *  unknown source or malformed id. */
export function parseApprovalId(id: string): { source: string; payload: string } | null {
  const colonIdx = id.indexOf(':');
  if (colonIdx === -1) return null;
  const source = id.slice(0, colonIdx);
  const payload = id.slice(colonIdx + 1);
  if (!payload) return null;
  return { source, payload };
}

/** Each `set*Status` helper returns three-valued: `'ok'` on a successful
 *  transition, `'not-found'` on a missing or already-actioned entry,
 *  `'error'` on a disk-write failure. `dispatchApprovalStatus` plumbs the
 *  result through to the HTTP/Telegram caller so a write failure surfaces
 *  as a distinct response (500) rather than masquerading as a 404. */
/** Async — fire the consumer on approval, then flip + clear. Sequence:
 *  1) Look up the entry (still pending). 2) On 'rejected' just flip and
 *  write. 3) On 'approved' run the consumer first so a failed write side-
 *  effect leaves the entry pending for retry; if the consumer throws, the
 *  status stays pending and an `'error'` result surfaces to the caller.
 *  Successful consumer call → flip status to 'approved' + write +
 *  clearApprovedIntentProposals so the entry doesn't accumulate. */
async function setIntentProposalStatus(idx: number, status: ApprovalStatus): Promise<ApprovalDispatchResult> {
  const queue = readIntentProposalQueue();
  const entry = queue[idx];
  if (!entry || entry.status !== 'pending') return 'not-found';
  if (status === 'rejected') {
    entry.status = 'rejected';
    return safeWrite('intent-proposal-queue', () => writeIntentProposalQueue(queue));
  }
  // status === 'approved': run the consumer first; only flip+clear on success.
  try {
    await actionApprovedIntentProposal(entry.proposal, realConsumerDeps);
  } catch (err: unknown) {
    log.error('actionApprovedIntentProposal failed; leaving entry pending', {
      kind: entry.proposal.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'error';
  }
  entry.status = 'approved';
  const writeResult = safeWrite('intent-proposal-queue', () => writeIntentProposalQueue(queue));
  if (writeResult !== 'ok') return writeResult;
  // Prune approved entries so the queue stays focused on pending +
  // rejected. clearApprovedIntentProposals is best-effort — a failure
  // doesn't undo the consumer's already-applied side-effect.
  try {
    clearApprovedIntentProposals();
  } catch (err: unknown) {
    log.warn('clearApprovedIntentProposals failed (consumer already ran)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return 'ok';
}

function setPlaybookStatus(idx: number, status: ApprovalStatus): ApprovalDispatchResult {
  const queue = readPlaybookQueue();
  const entry = queue[idx];
  if (!entry || entry.status !== 'pending') return 'not-found';
  entry.status = status;
  return safeWrite('playbook-queue', () => writePlaybookQueue(queue));
}

function setAskTwiceStatus(idx: number, status: ApprovalStatus): ApprovalDispatchResult {
  const queue = readProposalQueue();
  const entry = queue[idx];
  if (!entry || entry.status !== 'pending') return 'not-found';
  entry.status = status;
  return safeWrite('ask-twice-queue', () => writeProposalQueue(queue));
}

/**
 * Dispatch an approval action to the correct queue based on the composite id.
 * Returns `'ok'` on a successful pending→approved/rejected transition,
 * `'not-found'` when the id is malformed, the queue index is out of range,
 * the entry is already non-pending, or the source is `blocked-on-human`
 * (those rows are not queue entries the cockpit can flip — the user must
 * take the underlying action).
 */
export async function dispatchApprovalStatus(id: string, status: ApprovalStatus): Promise<ApprovalDispatchResult> {
  const parsed = parseApprovalId(id);
  if (!parsed) return 'not-found';
  const idx = Number(parsed.payload);
  // Reject NaN, infinities, floats, negatives, and overflowed integers in
  // one guard — `Number.isSafeInteger` covers Infinity/NaN/floats, and the
  // `>= 0` clause covers the negative-index case (`queue[-1]` is silently
  // `undefined` today, but accepting it is misleading). The blocked-on-human
  // branch is the only source that doesn't consume idx, and it's terminal
  // (always returns 'not-found') — so the early guard is safe to hoist.
  if (parsed.source !== 'blocked-on-human' && (!Number.isSafeInteger(idx) || idx < 0)) {
    return 'not-found';
  }
  switch (parsed.source) {
    case 'intent-proposal': return setIntentProposalStatus(idx, status);
    case 'playbook':        return setPlaybookStatus(idx, status);
    case 'ask-twice':       return setAskTwiceStatus(idx, status);
    case 'blocked-on-human':
      // Project 13 Phase 1c: a `blocked-on-human` row is a PARKED work-run, made
      // actionable here. Approve/Release routes to the shared release runtime (a
      // clean parked run → creates the cold-finalize mutation → 'ok'); Reject
      // (or a not-parked / dirty / failed release) leaves the parked run
      // untouched and returns 'not-found' so the row stays put. A dirty worktree
      // is NOT confirm-discarded from the inbox — that requires the explicit
      // release endpoint/callback carrying confirmDirty=true (the inbox Approve
      // is a clean-release quick-action only).
      if (status !== 'approved') return 'not-found';
      // Guard the id at the trust boundary (consistent with the HTTP route),
      // even though readParkedRun does a pure store lookup with no path join.
      if (!VALID_SLUG.test(parsed.payload)) return 'not-found';
      try {
        const outcome = await requestWorkRunRelease(parsed.payload, {}, defaultReleaseRequestDeps('webview'));
        // 'created' → 'ok'; an internal release error surfaces honestly as
        // 'error' (HTTP 500) rather than masquerading as 'not-found' (404); a
        // not-parked / dirty-confirm result leaves the row put ('not-found').
        if (outcome.kind === 'created') return 'ok';
        if (outcome.kind === 'error') return 'error';
        return 'not-found';
      } catch (err: unknown) {
        log.error('blocked-on-human release failed', {
          runId: parsed.payload,
          error: err instanceof Error ? err.message : String(err),
        });
        return 'error';
      }
    default:
      return 'not-found';
  }
}
