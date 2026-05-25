/**
 * `/plan <product>` — start a Planner (Layer 1) conversation scoped to the
 * named product. Project 08-intent-layer Phase 6 A4.3 (also Track C4 — the
 * Telegram side of the planning surface).
 *
 * With a known product slug, creates a planning session via `createPlanningSession`
 * (A4.1) and replies with the kickoff prompt; subsequent messages route through
 * `handlePlanningTurn` (A4.2) via the active-planning-session check in
 * `dispatchText`. With an unknown or missing product, lists the registered
 * products from the registry — no session is created until the user picks one.
 *
 * Approval-on-spec-proposed (A4.4) and the inline-button round-trip (C6) land
 * in later tasks; until then the user can `/clear` or `/fresh` to abandon.
 */

import type { MessageSender } from '../../transport/sender.js';
import { readRegistry, type Registry } from '../../intent/registry.js';
import { createPlanningSession } from '../../reviews/planning.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-plan');

/**
 * Handle `/plan [product]`.
 *
 * - With a known product, creates a planning session and replies with the
 *   kickoff prompt asking the first scoping question.
 * - With an unknown product, lists the registered products (no session created).
 * - With no args, lists the registered products plus the usage hint.
 * - When the registry is unreadable, sends a clear error reply and does not
 *   create a session — planning needs a validated product slug.
 *
 * The planning session is always created with the `'chat'` surface today since
 * both Telegram and the webview chat panel drive turns through the same handler.
 */
export async function handlePlan(
  sender: MessageSender,
  userId: number,
  args: string,
): Promise<void> {
  const product = args.trim();

  // Resolve the registry first — both the unknown-product and listing paths
  // depend on it, and a missing/corrupt registry should be a single clear
  // failure mode rather than silently starting a session with an unverified
  // product.
  let registry: Registry;
  try {
    registry = readRegistry();
  } catch (err) {
    log.warn('readRegistry failed during /plan', { error: (err as Error).message });
    await sender.send(
      userId,
      `Couldn't read the product registry — planning needs a validated product. ` +
        `Run \`npm run dev\` once to rebuild the registry, then retry /plan.`,
    );
    return;
  }

  const productNames = registry.products.map((p) => p.name).sort();
  const formattedList = productNames.length === 0
    ? '_(no products registered)_'
    : productNames.map((name) => `- ${name}`).join('\n');

  // No-args path — list registered products and the usage hint. No session.
  if (product === '') {
    await sender.send(
      userId,
      `Which product? Registered products:\n\n${formattedList}\n\nUsage: \`/plan <product>\``,
    );
    return;
  }

  // Case-insensitive lookup — registry slugs are lowercase by convention, but
  // forgiving the user's capitalization avoids a confusing "not registered"
  // bounce on `/plan Aura`. The canonical name from the registry is what we
  // pass downstream so the planning session and follow-ups stay consistent.
  const canonical = productNames.find((name) => name.toLowerCase() === product.toLowerCase());
  if (!canonical) {
    await sender.send(
      userId,
      `No product named "${product}" is registered. Registered products:\n\n${formattedList}\n\nUsage: \`/plan <product>\``,
    );
    return;
  }

  // Known product — start the planning session and reply with the kickoff
  // prompt. The session is created with `idea: ''` (the user's next message
  // becomes the first scoping turn through `handlePlanningTurn`).
  createPlanningSession(userId, '', 'chat', canonical);
  log.info('Planning session started', { userId, product: canonical });
  await sender.send(
    userId,
    `Planning a project for ${canonical}. What user problem does this solve?\n\n— planning · /clear to abandon`,
  );
}
