import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';
import { getSession } from '../vault/sessions.js';
import { getActiveReviewSession } from '../reviews/session.js';
import { getActivePlanningSession } from '../reviews/planning.js';
import { getQueue } from '../kb/queue.js';
import { getPendingPlaybookDrafts } from '../jobs/playbook-extract.js';
import { getPendingProposals } from '../jobs/proposal-queue.js';
import { getPendingIntentProposals } from '../intent/intent-proposal-queue.js';
import { readRecentMutations } from '../jobs/mutations-log.js';
import { activeRuns } from '../transport/mutations.js';
import { listOps } from '../transport/in-flight.js';
import type { InFlightOpPublic } from '../transport/in-flight.js';
import { getProjectSummaries } from './projects-snapshot.js';
import type { ProjectSummary } from './projects-snapshot.js';
import type { MutationDescriptor } from '../transport/mutations.js';

export interface AgentRunEntry {
  agent: string;
  startedAt: string;
  durationMs: number;
  status: 'success' | 'error';
}

export interface SessionSummary {
  sessionId: string;
  model: string;
  messageCount: number;
}

export interface StateSnapshot {
  version: 1;
  ready: boolean;
  /** Active chat threads, reported per transport. Each channel holds an
   *  independent session keyed `${transport}:${userId}`, so they surface
   *  separately rather than collapsing through a `webview ?? telegram`
   *  fallback. The old fallback let a Telegram thread show in the cockpit
   *  while `/clear` from the web view (webview-scoped) reported "nothing to
   *  clear" — you couldn't tell which thread you were looking at. See the
   *  2026-06-04 transport-scope fix. */
  sessions: { webview: SessionSummary | null; telegram: SessionSummary | null };
  activeReview: { type: string; phase: string; targetDate: string } | null;
  /** An in-flight planning conversation (scoping or spec-proposed). Free-form
   *  webview messages route to a planning session ahead of the chat path in
   *  dispatchText, so without surfacing it the cockpit reads "No active
   *  session" mid-plan — the confusion behind the original bug report. Null
   *  when no planning conversation is live. */
  activePlanning: { product: string; status: string; surface: string } | null;
  ingestionQueueDepth: number;
  recentAgentRuns: AgentRunEntry[];
  pendingApprovals: { playbook: number; proposal: number; intent: number };
  lastMorningPrepAt: string | null;
  lastNightlyAt: string | null;
  projects: ProjectSummary[];
  mutations: { active: MutationDescriptor[]; recent: MutationDescriptor[] };
  inFlight: InFlightOpPublic[];
  warnings: string[];
}

function readSchedulerState(): Record<string, number> {
  try {
    const raw = readFileSync(join(config.LOGS_DIR, 'scheduler-state.json'), 'utf8');
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}

function readRecentAgentRuns(n: number): { runs: AgentRunEntry[]; warnings: string[] } {
  const runs: AgentRunEntry[] = [];
  const warnings: string[] = [];
  const path = join(config.LOGS_DIR, 'agent-runs.jsonl');
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        runs.push(JSON.parse(line) as AgentRunEntry);
      } catch {
        warnings.push(`agent-runs.jsonl: skipped malformed line`);
      }
    }
  } catch {
    // File may not exist yet — not a warning
  }
  // Return last n entries in reverse-chronological order
  return { runs: runs.slice(-n).reverse(), warnings };
}

export function getStateSnapshot(): StateSnapshot {
  const userId = config.TELEGRAM_USER_ID;
  const warnings: string[] = [];

  // Report each transport's thread independently. Sessions are keyed per
  // transport, and `/clear` only clears the channel it was issued from, so
  // collapsing the two (the old `webview ?? telegram` fallback) hid which
  // thread was live and made cockpit `/clear` look like a no-op.
  const toSummary = (s: ReturnType<typeof getSession>): SessionSummary | null =>
    s ? { sessionId: s.sessionId, model: s.model, messageCount: s.messageCount } : null;
  const webviewSession = toSummary(getSession(userId, 'webview'));
  const telegramSession = toSummary(getSession(userId, 'telegram'));
  const review = getActiveReviewSession(userId);
  const planning = getActivePlanningSession(userId);
  const schedulerState = readSchedulerState();

  const { runs: recentAgentRuns, warnings: runWarnings } = readRecentAgentRuns(10);
  warnings.push(...runWarnings);

  let playbookCount = 0;
  try { playbookCount = getPendingPlaybookDrafts().length; }
  catch { warnings.push('playbook-queue: read error'); }

  let proposalCount = 0;
  try { proposalCount = getPendingProposals().length; }
  catch { warnings.push('proposal-queue: read error'); }

  let intentCount = 0;
  try { intentCount = getPendingIntentProposals().length; }
  catch { warnings.push('intent-proposal-queue: read error'); }

  const morningTs = schedulerState['morning-prep'] ?? null;
  const nightlyTs = schedulerState['nightly'] ?? null;

  let projects: ProjectSummary[] = [];
  try { projects = getProjectSummaries(); }
  catch { warnings.push('projects: read error'); }

  let recentMutations: MutationDescriptor[] = [];
  try { recentMutations = readRecentMutations(50); }
  catch { warnings.push('mutations.jsonl: read error'); }

  const activeMutations = [...activeRuns.values()].map(h => h.descriptor);

  return {
    version: 1,
    ready: true,
    sessions: { webview: webviewSession, telegram: telegramSession },
    activeReview: review
      ? { type: review.type, phase: review.phase, targetDate: review.targetDate }
      : null,
    activePlanning: planning
      ? {
          product: planning.planning.product,
          status: planning.planning.status,
          surface: planning.planning.surface,
        }
      : null,
    ingestionQueueDepth: getQueue().length,
    recentAgentRuns,
    pendingApprovals: { playbook: playbookCount, proposal: proposalCount, intent: intentCount },
    lastMorningPrepAt: morningTs ? new Date(morningTs).toISOString() : null,
    lastNightlyAt: nightlyTs ? new Date(nightlyTs).toISOString() : null,
    projects,
    mutations: { active: activeMutations, recent: recentMutations },
    inFlight: listOps(),
    warnings,
  };
}
