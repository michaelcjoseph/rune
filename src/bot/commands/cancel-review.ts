import type { MessageSender } from '../../transport/sender.js';
import { getActiveReviewSession, deleteReviewSession } from '../../reviews/session.js';

/** /cancel-review — clear an active review session (e.g. an abandoned interview
 *  that never reached writeup). Reviews are normally deleted by the orchestrator
 *  at the end of writeup; this is the manual escape hatch when a session is
 *  stuck mid-phase and the cockpit keeps showing it as active. */
export async function handleCancelReview(sender: MessageSender, userId: number): Promise<void> {
  const session = getActiveReviewSession(userId);
  if (!session) {
    await sender.send(userId, 'No active review.');
    return;
  }
  const { type, phase, targetDate } = session;
  deleteReviewSession(userId);
  await sender.send(userId, `Cancelled ${type} review (${targetDate}, phase: ${phase}).`);
}
