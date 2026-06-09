/**
 * Project 13 Phase 1c — the Telegram `work-run-release:<id>` callback routing.
 *
 * Kept in its own light module (rather than inline in `telegram.ts`) so the
 * unit test imports just this + the mockable shared release runtime, not the
 * whole bot/handlers → ai/claude chain telegram.ts pulls in at load.
 *
 * Both the plain `work-run-release:<id>` and the `work-run-release-confirm:<id>`
 * (explicit dirty-discard) callbacks delegate to the ONE shared release runtime
 * (`requestWorkRunRelease`) the cockpit route and inbox row use, so the surfaces
 * can't drift.
 */

import {
  requestWorkRunRelease,
  formatReleaseRequestReply,
  defaultReleaseRequestDeps,
  type ReleaseRequestDeps,
} from '../jobs/work-run-release.js';
import { VALID_SLUG } from '../intent/sandbox.js';

/**
 * Parse a `work-run-release:<id>` / `work-run-release-confirm:<id>` callback
 * payload. The `-confirm` variant carries the operator's explicit dirty-discard
 * confirmation. Returns null for any other payload so the caller falls through
 * to the existing approval/conversational routing.
 */
export function parseWorkRunReleaseCallback(
  data: string,
): { runId: string; confirmDirty: boolean } | null {
  const CONFIRM = 'work-run-release-confirm:';
  const PLAIN = 'work-run-release:';
  if (data.startsWith(CONFIRM)) {
    const runId = data.slice(CONFIRM.length);
    return VALID_SLUG.test(runId) ? { runId, confirmDirty: true } : null;
  }
  if (data.startsWith(PLAIN)) {
    const runId = data.slice(PLAIN.length);
    return VALID_SLUG.test(runId) ? { runId, confirmDirty: false } : null;
  }
  return null;
}

/**
 * Handle a Telegram `work-run-release:<id>` callback by routing through the
 * shared release runtime and replying with the mapped outcome. Injectable for
 * the unit test.
 */
export async function dispatchTelegramWorkRunRelease(
  send: (userId: number, text: string) => Promise<unknown>,
  userId: number,
  data: string,
  deps: ReleaseRequestDeps = defaultReleaseRequestDeps('webview'),
): Promise<void> {
  const parsed = parseWorkRunReleaseCallback(data);
  if (!parsed) return; // not a release callback — caller routes elsewhere
  const outcome = await requestWorkRunRelease(parsed.runId, { confirmDirty: parsed.confirmDirty }, deps);
  await send(userId, formatReleaseRequestReply(outcome));
}
