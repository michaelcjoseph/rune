/**
 * Journal-to-intent proposal queue — persists the proposals produced by the journal-to-
 * intent flow (`planJournalIntent`) so they surface for approval (test-plan §8). Pending
 * entries show in the cockpit's Pending Approvals panel (via the state snapshot) and in the
 * prep context of the next dynamic review (a Telegram conversation).
 *
 * Mirrors `src/jobs/proposal-queue.ts` — the same shape used for Ask-Twice proposals.
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Journal-to-intent flow"), test-plan.md (§8)}.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '../config.js';
import type { IntentProposal } from './journal-intent.js';

/** A journal-to-intent proposal queued for approval. */
export interface QueuedIntentProposal {
  /** UTC ISO 8601 — when the journal-to-intent scan queued this proposal. */
  queuedAt: string;
  /** The proposal — vault-intake, roadmap, register-product, or disambiguation. */
  proposal: IntentProposal;
  status: 'pending' | 'approved' | 'rejected';
}

/** Read the queue; a missing or malformed file yields an empty queue. */
export function readIntentProposalQueue(): QueuedIntentProposal[] {
  try {
    const parsed = JSON.parse(readFileSync(config.INTENT_PROPOSAL_QUEUE_FILE, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as QueuedIntentProposal[]) : [];
  } catch {
    return [];
  }
}

/** Persist the queue, creating the logs directory if needed. */
export function writeIntentProposalQueue(entries: QueuedIntentProposal[]): void {
  mkdirSync(dirname(config.INTENT_PROPOSAL_QUEUE_FILE), { recursive: true });
  writeFileSync(config.INTENT_PROPOSAL_QUEUE_FILE, JSON.stringify(entries, null, 2));
}

/** The pending entries — surfaced in the cockpit and in review prep. */
export function getPendingIntentProposals(): QueuedIntentProposal[] {
  return readIntentProposalQueue().filter((entry) => entry.status === 'pending');
}

/** Append entries to the queue. No dedup — the caller dedups before calling. */
export function appendIntentProposals(entries: QueuedIntentProposal[]): void {
  if (entries.length === 0) return;
  writeIntentProposalQueue([...readIntentProposalQueue(), ...entries]);
}

/** Drop `approved` entries; retain pending and rejected. Called after approved proposals
 *  have been actioned (the proposal synthesized into the vault / repo). */
export function clearApprovedIntentProposals(): void {
  writeIntentProposalQueue(readIntentProposalQueue().filter((entry) => entry.status !== 'approved'));
}

/** Re-export so callers can build queue entries without importing journal-intent directly. */
export type { IntentProposal };
