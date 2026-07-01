/**
 * `/approve` — approve a planning session's proposed spec and scaffold the
 * project. Project 08-intent-layer Phase 6 A4.4.
 *
 * Two entry conditions:
 * 1. Session in `spec-proposed` — normal path. Transitions `spec-proposed →
 *    approved` via the pure state machine (`approveActivePlanningSession`),
 *    then scaffolds via the `project-setup-writer` agent.
 * 2. Session already in `approved` — retry path. The previous /approve
 *    transitioned the lifecycle but the agent failed (network, CLI crash,
 *    etc.) leaving the session approved-but-unscaffolded. Pick it up from
 *    `getPlanningSession` (which doesn't filter terminal states like the
 *    routing-priority probe does) and re-run the scaffolding.
 *
 * The session is deleted on agent success; on agent failure the session
 * stays in `approved` so /approve can pick it up again without re-scoping.
 *
 * Inline-keyboard approval (Track C6) lands later. Until then, `/approve`
 * is the explicit slash gate the spec-proposed reply tells the user to use.
 * The command is intentionally not resolver-routable — approval is an
 * explicit gate, never inferred from free-form text.
 */

import type { MessageSender } from '../../transport/sender.js';
import { runScaffoldApproval } from '../../jobs/scaffold-approval.js';
import { runDownstreamPlan, type PlanningProgress, type PlanningProgressStage } from '../../intent/planning-roles.js';
import { isPmSpecApprovalArtifact, type SpecArtifact } from '../../intent/planner.js';
import { scrubAbsolutePaths } from '../../utils/sanitize-paths.js';
import {
  approveActivePlanningSession,
  deletePlanningSession,
  getPlanningSession,
  updatePlanningSession,
  type StoredPlanningSession,
} from '../../reviews/planning.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-approve');

export async function handleApprove(sender: MessageSender, userId: number): Promise<void> {
  // Retry path first — if a previous /approve left the session in `approved`
  // (scaffold failed mid-run), pick it up directly. getActivePlanningSession
  // filters terminal states, so we use the unfiltered getPlanningSession.
  const existing = getPlanningSession(userId);
  if (existing?.planning.status === 'approved') {
    log.info('Approve retry path — re-scaffolding already-approved session', { userId });
    await downstreamThenScaffoldAndDelete(sender, userId, existing);
    return;
  }

  // Normal path — transition spec-proposed → approved via the state machine.
  const result = approveActivePlanningSession(userId);
  if (!result.ok) {
    // The only status that reaches `wrong-status` is `'scoping'`: terminal
    // states (`approved` / `abandoned`) are filtered by
    // `getActivePlanningSession` inside `approveActivePlanningSession`, and
    // the `approved` retry path was handled above. The exhaustive switch
    // documents the invariant.
    switch (result.reason) {
      case 'no-session':
        await sender.send(userId, 'Nothing to approve — no active planning session.');
        return;
      case 'wrong-status':
        await sender.send(
          userId,
          'No spec proposed yet — keep scoping until Rune proposes one.',
        );
        return;
      case 'legacy-artifact':
        await sender.send(
          userId,
          'This planning approval was created with a retired artifact shape. Please restart planning to produce a versioned pm-spec approval.',
        );
        return;
    }
  }

  // spec-proposed → approved transition succeeded.
  await downstreamThenScaffoldAndDelete(sender, userId, result.session);
}

async function downstreamThenScaffoldAndDelete(
  sender: MessageSender,
  userId: number,
  session: StoredPlanningSession,
): Promise<void> {
  const prepared = await prepareApprovedSessionForScaffold(sender, userId, session);
  if (!prepared) return;
  await scaffoldAndDelete(sender, userId, prepared);
}

async function prepareApprovedSessionForScaffold(
  sender: MessageSender,
  userId: number,
  session: StoredPlanningSession,
): Promise<StoredPlanningSession | null> {
  if (!isPmSpecApprovalArtifact(session.planning.approvedSpec)) {
    await sender.send(
      userId,
      'This planning approval was created with a retired artifact shape. Please restart planning to produce a versioned pm-spec approval.',
    );
    return null;
  }

  if (session.planning.downstreamArtifact) {
    return session;
  }

  const downstreamArtifact = await runDownstreamPlan(session.planning.approvedSpec, {
    progress: (event) => sendPlanningProgress(sender, userId, event),
  });
  updatePlanningSession(userId, (sess) => ({
    ...sess,
    planning: {
      ...sess.planning,
      downstreamArtifact,
    },
  }));
  return withDownstreamArtifact(session, downstreamArtifact);
}

function withDownstreamArtifact(
  session: StoredPlanningSession,
  downstreamArtifact: SpecArtifact,
): StoredPlanningSession {
  return {
    ...session,
    planning: {
      ...session.planning,
      downstreamArtifact,
    },
  };
}

/** Run the scaffold-approval flow for an `approved` session and delete the
 *  session on success. On any failure (target resolution, agent, or
 *  scaffold-verification) the session is left intact so the retry path in
 *  `handleApprove` can pick it up — never lose the spec.
 *
 *  All the heavy lifting (resolve the target product repo, spawn the
 *  setup-writer scoped to it, cross-check the `scaffold-result` block
 *  against the on-disk diff, and drive any linked promotion job) lives in
 *  the shared `runScaffoldApproval` runtime so the Telegram and webview
 *  approval surfaces behave identically. */
async function scaffoldAndDelete(
  sender: MessageSender,
  userId: number,
  session: StoredPlanningSession,
): Promise<void> {
  log.info('Dispatching scaffold-approval', {
    userId,
    product: session.planning.product,
    promotionId: session.promotionId,
  });

  await sendPlanningProgress(sender, userId, { stage: 'scaffold' });
  const outcome = await runScaffoldApproval(session);
  if (!outcome.ok) {
    log.error('scaffold-approval failed; session left approved for retry', {
      userId,
      reason: outcome.reason,
      message: outcome.message,
    });
    // Echo the agent's reply on a verify failure so the user sees what it said.
    const body = outcome.agentText
      ? `${scrubAbsolutePaths(outcome.message)}\n\nAgent reply:\n${outcome.agentText}`
      : scrubAbsolutePaths(outcome.message);
    await sender.send(
      userId,
      `Scaffolding failed: ${body}\n\n` +
        `Planning session is still approved — run /approve again to retry.`,
    );
    return;
  }

  let reply = outcome.agentText;
  if (outcome.promotion === 'mark-source-error') {
    // The project scaffolded but the source bullet couldn't be marked — the promotion is in a
    // retryable error state. Tell the user; the project itself is fine.
    reply += `\n\n⚠️ Project ${outcome.slug} scaffolded, but the source backlog bullet couldn't be ` +
      `marked promoted — retry it from the cockpit's backlog drawer.`;
  }
  await sender.send(userId, reply);
  deletePlanningSession(userId);
  log.info('Project scaffolded; planning session deleted', {
    userId,
    slug: outcome.slug,
    promotion: outcome.promotion,
  });
}

async function sendPlanningProgress(
  sender: MessageSender,
  userId: number,
  event: PlanningProgress,
): Promise<void> {
  const message = formatPlanningProgress(event);
  if (!message) return;
  try {
    await sender.send(userId, scrubAbsolutePaths(message));
  } catch (err) {
    log.warn('Planning progress send failed', { userId, error: (err as Error).message });
  }
}

function formatPlanningProgress(event: PlanningProgress): string | null {
  if (event.warning) return `Planning warning: ${event.warning}`;
  if (event.terminal) return `Planning stopped: ${event.terminal}`;
  if (event.success) return `Planning succeeded: ${event.success}`;
  if (event.stage) return `Planning progress: ${planningStageLabel(event.stage)}.`;
  return null;
}

function planningStageLabel(stage: PlanningProgressStage): string {
  switch (stage) {
    case 'tech-lead-breakdown':
      return 'tech-lead breakdown';
    case 'pm-review-match':
      return 'PM review';
    case 'claude-critique':
      return 'Claude critique';
    case 'codex-critique':
      return 'Codex critique';
    case 'context-seed':
      return 'context seed';
    case 'scaffold':
      return 'scaffold';
  }
}
