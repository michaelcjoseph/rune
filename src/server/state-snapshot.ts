import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';
import { getSession } from '../vault/sessions.js';
import { getActiveReviewSession } from '../reviews/session.js';
import { getQueue } from '../kb/queue.js';
import { getPendingPlaybookDrafts } from '../jobs/playbook-extract.js';
import { getPendingProposals } from '../jobs/proposal-queue.js';

export interface AgentRunEntry {
  agent: string;
  startedAt: string;
  durationMs: number;
  status: 'success' | 'error';
}

export interface StateSnapshot {
  version: 1;
  ready: boolean;
  activeSession: { sessionId: string; model: string; messageCount: number } | null;
  activeReview: { type: string; phase: string; targetDate: string } | null;
  ingestionQueueDepth: number;
  recentAgentRuns: AgentRunEntry[];
  pendingApprovals: { playbook: number; proposal: number };
  lastMorningPrepAt: string | null;
  lastNightlyAt: string | null;
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

  const session = getSession(userId);
  const review = getActiveReviewSession(userId);
  const schedulerState = readSchedulerState();

  const { runs: recentAgentRuns, warnings: runWarnings } = readRecentAgentRuns(10);
  warnings.push(...runWarnings);

  let playbookCount = 0;
  try { playbookCount = getPendingPlaybookDrafts().length; }
  catch { warnings.push('playbook-queue: read error'); }

  let proposalCount = 0;
  try { proposalCount = getPendingProposals().length; }
  catch { warnings.push('proposal-queue: read error'); }

  const morningTs = schedulerState['morning-prep'] ?? null;
  const nightlyTs = schedulerState['nightly'] ?? null;

  return {
    version: 1,
    ready: true,
    activeSession: session
      ? { sessionId: session.sessionId, model: session.model, messageCount: session.messageCount }
      : null,
    activeReview: review
      ? { type: review.type, phase: review.phase, targetDate: review.targetDate }
      : null,
    ingestionQueueDepth: getQueue().length,
    recentAgentRuns,
    pendingApprovals: { playbook: playbookCount, proposal: proposalCount },
    lastMorningPrepAt: morningTs ? new Date(morningTs).toISOString() : null,
    lastNightlyAt: nightlyTs ? new Date(nightlyTs).toISOString() : null,
    warnings,
  };
}
