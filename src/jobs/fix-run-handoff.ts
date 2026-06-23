import type { BacklogItem } from '../intent/backlog-parser.js';
import type { BugScopingFacts } from './bug-fix-gate.js';

export interface FixRunScope {
  bug: BacklogItem;
  facts: BugScopingFacts;
}

export interface StartFixRunInput {
  product: string;
  bugId: string;
  scope: FixRunScope;
}

export type StartFixRunResult =
  | { accepted: true; runId: string }
  | { accepted: false; reason: string; detail?: string };

/**
 * Boundary to the deferred cross-repo autorun implementation. The cockpit owns
 * gating and durable attempt state; execution behind an approved gate plugs in here.
 */
export async function startFixRun(_input: StartFixRunInput): Promise<StartFixRunResult> {
  throw new Error('fix-run handoff unavailable');
}
