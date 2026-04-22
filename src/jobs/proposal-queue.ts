import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '../config.js';

/** A proposal drafted by the Ask-Twice scan job. Either suggests a new skill
 *  (the user repeatedly asked for the same thing via resolver fallthrough) or
 *  a new cron (the user repeatedly asked for the same thing at a predictable
 *  cadence). The review interview surfaces pending proposals alongside
 *  playbook drafts; on approval, a post-review agent creates the skill file
 *  or registers the cron via frontmatter edit. */
export interface Proposal {
  /** UTC ISO 8601. */
  draftedAt: string;
  type: 'skill_or_cron';
  /** Short human-readable name for the proposed capability. */
  title: string;
  /** Why this pattern was selected — typically "Asked N times in M weeks". */
  rationale: string;
  /** Suggested skill body if the pattern deserves a new skill. Either this or
   *  `suggested_cron` (or both) must be non-empty. */
  suggested_skill?: string;
  /** Suggested cron expression if the pattern is time-predictable. Validated
   *  with node-cron at draft time; invalid expressions are dropped before
   *  the proposal lands in the queue. */
  suggested_cron?: string;
  status: 'pending' | 'approved' | 'rejected';
}

export function readProposalQueue(): Proposal[] {
  try {
    const data = readFileSync(config.PROPOSAL_QUEUE_FILE, 'utf8');
    const parsed = JSON.parse(data) as unknown;
    return Array.isArray(parsed) ? (parsed as Proposal[]) : [];
  } catch {
    return [];
  }
}

export function writeProposalQueue(entries: Proposal[]): void {
  mkdirSync(dirname(config.PROPOSAL_QUEUE_FILE), { recursive: true });
  writeFileSync(config.PROPOSAL_QUEUE_FILE, JSON.stringify(entries, null, 2));
}

export function getPendingProposals(): Proposal[] {
  return readProposalQueue().filter(p => p.status === 'pending');
}

/** Append new proposals to the queue. No dedup performed here — callers
 *  (e.g., intent-scan) are responsible for deduping against the skill
 *  registry and the existing queue before calling. */
export function appendProposals(proposals: Proposal[]): void {
  if (proposals.length === 0) return;
  writeProposalQueue([...readProposalQueue(), ...proposals]);
}

/** Drop proposals with `status: 'approved'` from the queue; retain pending
 *  and rejected. Called by the review post-agent flow after a proposal has
 *  been actioned (skill file created or cron registered). */
export function clearApprovedProposals(): void {
  writeProposalQueue(readProposalQueue().filter(p => p.status !== 'approved'));
}
