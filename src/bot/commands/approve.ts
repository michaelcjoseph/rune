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
import {
  runDownstreamPlan,
  type PlanningDownstreamErrorDetails,
  type PlanningProgress,
  type PlanningProgressStage,
} from '../../intent/planning-roles.js';
import { isPmSpecApprovalArtifact, type SpecArtifact } from '../../intent/planner.js';
import { isCancelled, registerOp, unregisterOp } from '../../transport/in-flight.js';
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

class PlanningApprovalCancelled extends Error {
  constructor() {
    super('Planning approval cancelled.');
  }
}

type PlanningApprovalStatus =
  | { status: 'success' }
  | { status: 'error'; error: string }
  | { status: 'cancelled' };

interface PlanningApprovalControl {
  opId?: string;
  terminalSent: boolean;
}

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
  if (!isPmSpecApprovalArtifact(session.planning.approvedSpec)) {
    await sender.send(
      userId,
      'This planning approval was created with a retired artifact shape. Please restart planning to produce a versioned pm-spec approval.',
    );
    return;
  }

  const op = registerOp({
    kind: 'agent',
    label: 'planning approval scaffold',
    userId,
    child: makeNoopChild(),
  });
  const control: PlanningApprovalControl = { opId: op?.opId, terminalSent: false };
  const status = await runPlanningApprovalPipeline(sender, userId, session, control);
  if (control.opId) {
    if (status.status === 'error') {
      unregisterOp(control.opId, 'error', status.error);
    } else {
      unregisterOp(control.opId, status.status);
    }
  }
}

async function runPlanningApprovalPipeline(
  sender: MessageSender,
  userId: number,
  session: StoredPlanningSession,
  control: PlanningApprovalControl,
): Promise<PlanningApprovalStatus> {
  try {
    const prepared = await prepareApprovedSessionForScaffold(sender, userId, session, control);
    if (!prepared) return { status: 'cancelled' };
    return await scaffoldAndDelete(sender, userId, prepared, control);
  } catch (err) {
    if (err instanceof PlanningApprovalCancelled) {
      return { status: 'cancelled' };
    }
    const failure = planningDownstreamFailure(err);
    const message = scrubAbsolutePaths((err as Error).message);
    log.error('planning approval failed', {
      userId,
      product: session.planning.product,
      stage: failure?.stage,
      retryable: failure?.retryable ?? true,
      error: message,
    });
    await sendTerminalOnce(sender, userId, control, message);
    if (isNonRetryablePmMismatch(failure)) {
      await sender.send(userId, formatNonRetryablePmMismatchMessage(failure));
    } else {
      await sender.send(
        userId,
        'Planning session is still approved — run /approve again to retry.',
      );
    }
    return { status: 'error', error: message };
  }
}

async function prepareApprovedSessionForScaffold(
  sender: MessageSender,
  userId: number,
  session: StoredPlanningSession,
  control: PlanningApprovalControl,
): Promise<StoredPlanningSession | null> {
  const approvedSpec = session.planning.approvedSpec;
  if (!isPmSpecApprovalArtifact(approvedSpec)) {
    await sender.send(
      userId,
      'This planning approval was created with a retired artifact shape. Please restart planning to produce a versioned pm-spec approval.',
    );
    return null;
  }
  if (session.planning.downstreamArtifact) {
    return session;
  }

  const downstreamArtifact = await runDownstreamPlan(approvedSpec, {
    progress: (event) => sendPlanningProgress(sender, userId, event, control),
  });
  updatePlanningSession(userId, (sess) => ({
    ...sess,
    planning: {
      ...sess.planning,
      downstreamArtifact,
    },
  }));
  await throwIfPlanningApprovalCancelled(sender, userId, control);
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
  control: PlanningApprovalControl,
): Promise<PlanningApprovalStatus> {
  log.info('Dispatching scaffold-approval', {
    userId,
    product: session.planning.product,
    promotionId: session.promotionId,
  });

  await sendPlanningProgress(sender, userId, { stage: 'scaffold' }, control);
  const outcome = await runScaffoldApproval(session);
  if (!outcome.ok) {
    log.error('scaffold-approval failed; session left approved for retry', {
      userId,
      reason: outcome.reason,
      message: outcome.message,
    });
    // Echo the agent's reply on a verify failure so the user sees what it said.
    const body = outcome.agentText
      ? `${scrubAbsolutePaths(outcome.message)}\n\nAgent reply:\n${scrubAbsolutePaths(outcome.agentText)}`
      : scrubAbsolutePaths(outcome.message);
    await sendTerminalOnce(sender, userId, control, `scaffold failed: ${outcome.message}`);
    await sender.send(
      userId,
      `Scaffolding failed: ${body}\n\n` +
        `Planning session is still approved — run /approve again to retry.`,
    );
    return { status: 'error', error: scrubAbsolutePaths(`scaffold failed: ${outcome.message}`) };
  }

  await sendPlanningProgress(sender, userId, {
    success: `${outcome.slug}: ${outcome.agentText}`,
  });
  let reply = scrubAbsolutePaths(outcome.agentText);
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
  return { status: 'success' };
}

async function sendPlanningProgress(
  sender: MessageSender,
  userId: number,
  event: PlanningProgress,
  control?: PlanningApprovalControl,
): Promise<void> {
  if (event.stage && control?.opId && isCancelled(control.opId)) {
    await throwIfPlanningApprovalCancelled(sender, userId, control);
  }
  if (event.terminal && control) control.terminalSent = true;
  const message = formatPlanningProgress(event);
  if (!message) return;
  try {
    await sender.send(userId, scrubAbsolutePaths(message));
  } catch (err) {
    log.warn('Planning progress send failed', { userId, error: (err as Error).message });
  }
}

async function throwIfPlanningApprovalCancelled(
  sender: MessageSender,
  userId: number,
  control: PlanningApprovalControl,
): Promise<void> {
  if (!control.opId || !isCancelled(control.opId)) return;
  await sendTerminalOnce(sender, userId, control, 'planning approval cancelled');
  await sender.send(
    userId,
    'Planning session is still approved — run /approve again to retry.',
  );
  throw new PlanningApprovalCancelled();
}

async function sendTerminalOnce(
  sender: MessageSender,
  userId: number,
  control: PlanningApprovalControl,
  message: string,
): Promise<void> {
  if (control.terminalSent) return;
  control.terminalSent = true;
  await sendPlanningProgress(sender, userId, { terminal: message });
}

function makeNoopChild(): Parameters<typeof registerOp>[0]['child'] {
  return { kill: () => true } as unknown as Parameters<typeof registerOp>[0]['child'];
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

function planningDownstreamFailure(err: unknown): PlanningDownstreamErrorDetails | null {
  const candidate = err as Partial<PlanningDownstreamErrorDetails> | null;
  if (!candidate || typeof candidate !== 'object') return null;
  if (typeof candidate.stage !== 'string') return null;
  if (typeof candidate.reason !== 'string') return null;
  if (typeof candidate.retryable !== 'boolean') return null;
  return {
    stage: candidate.stage as PlanningProgressStage,
    reason: scrubAbsolutePaths(candidate.reason),
    ...(Array.isArray(candidate.mismatches)
      ? { mismatches: candidate.mismatches.map((mismatch) => scrubAbsolutePaths(String(mismatch))) }
      : {}),
    retryable: candidate.retryable,
  };
}

function isNonRetryablePmMismatch(
  failure: PlanningDownstreamErrorDetails | null,
): failure is PlanningDownstreamErrorDetails & { mismatches: string[] } {
  return failure?.stage === 'pm-review-match' && failure.retryable === false;
}

function formatNonRetryablePmMismatchMessage(
  failure: PlanningDownstreamErrorDetails & { mismatches?: string[] },
): string {
  const mismatches = failure.mismatches?.length
    ? failure.mismatches.map((mismatch) => `- ${mismatch}`).join('\n')
    : `- ${failure.reason}`;
  return [
    'Planning session is still approved, but PM review found a structural mismatch. A blind retry is unlikely to help.',
    '',
    'Mismatches:',
    mismatches,
    '',
    'Next steps: amend the spec/DoD, or approve/add a manual live release-gate task.',
  ].join('\n');
}
