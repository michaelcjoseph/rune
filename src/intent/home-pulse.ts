import type { BacklogItem, FileWarning } from './backlog-parser.js';
import type { Registry } from './registry.js';
import type { SupervisedRun } from './supervision.js';

export type HomePulseOutcome = 'completed' | 'no-op' | 'partial' | 'failed';

export interface HomeRunTarget {
  kind: 'project' | 'bug';
  slug: string;
}

export interface HomeActiveRun {
  runId: string;
  target: HomeRunTarget;
  state: 'running' | 'parked';
  elapsedMs: number;
}

export interface HomeMostRecentRun {
  runId: string;
  outcome: HomePulseOutcome;
  endedAt: string;
}

export type AttentionSignal =
  | { kind: 'parked-run'; runId: string; target: HomeRunTarget }
  | { kind: 'failed-run'; runId: string; target: HomeRunTarget }
  | { kind: 'noop-run'; runId: string; target: HomeRunTarget }
  | { kind: 'backlog-warning'; count: number };

export interface HomeProductPulse {
  name: string;
  repoBacked: boolean;
  activeRun?: HomeActiveRun;
  counts: {
    activeProjects: number;
    openBugs: number;
    openIdeas: number;
    backlogWarnings: number;
  };
  mostRecentRun?: HomeMostRecentRun;
  attention: AttentionSignal[];
}

export interface HomePulse {
  available: boolean;
  products: HomeProductPulse[];
  unavailableReason?: string;
}

export interface HomePulseBacklog {
  product: string;
  notRepoBacked: boolean;
  bugs: BacklogItem[];
  ideas: BacklogItem[];
  fileWarnings: FileWarning[];
}

export type StoredWorkRunOutcome =
  | 'branch-complete'
  | 'partial'
  | 'dirty-uncommitted'
  | 'noop'
  | 'failed';

export interface HomePulseWorkRun {
  runId?: string;
  id?: string;
  product: string;
  project?: string;
  target?: HomeRunTarget;
  outcome: StoredWorkRunOutcome;
  endedAt: string;
}

export interface HomePulseDeps {
  readRegistry: () => Registry;
  readSupervisedRuns: () => SupervisedRun[];
  readRecentWorkRuns: () => HomePulseWorkRun[];
  readBacklogs: () => HomePulseBacklog[];
  now?: () => number;
}

function unavailableReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mapOutcome(outcome: StoredWorkRunOutcome): HomePulseOutcome {
  switch (outcome) {
    case 'branch-complete':
      return 'completed';
    case 'dirty-uncommitted':
    case 'partial':
      return 'partial';
    case 'noop':
      return 'no-op';
    case 'failed':
      return 'failed';
  }
}

function runId(run: HomePulseWorkRun): string {
  return run.runId ?? run.id ?? '';
}

function targetFromWorkRun(run: HomePulseWorkRun): HomeRunTarget {
  return run.target ?? { kind: 'project', slug: run.project ?? '' };
}

function targetFromSupervisedRun(run: SupervisedRun): HomeRunTarget {
  const maybeTarget = (run as SupervisedRun & { target?: HomeRunTarget }).target;
  return maybeTarget ?? { kind: 'project', slug: run.project };
}

function elapsedMs(startedAt: string, now: number): number {
  const parsed = Date.parse(startedAt);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, now - parsed);
}

function readOrEmpty<T>(read: () => T[]): T[] {
  try {
    return read();
  } catch {
    return [];
  }
}

function isLive(run: SupervisedRun): boolean {
  return run.status === 'running' || run.status === 'blocked-on-human';
}

function compareStartedDesc(a: SupervisedRun, b: SupervisedRun): number {
  return Date.parse(b.startedAt) - Date.parse(a.startedAt);
}

function compareEndedDesc(a: HomePulseWorkRun, b: HomePulseWorkRun): number {
  return Date.parse(b.endedAt) - Date.parse(a.endedAt);
}

/**
 * Build the cross-product Home pulse. Pure projection: every source is injected,
 * and this module owns no state. Registry read failure is the only unavailable
 * state; the other stores degrade to their empty contribution so the home view
 * can still render the product list.
 */
export function buildHomePulse(deps: HomePulseDeps): HomePulse {
  let registry: Registry;
  try {
    registry = deps.readRegistry();
  } catch (err) {
    return {
      available: false,
      products: [],
      unavailableReason: unavailableReason(err),
    };
  }

  const now = deps.now?.() ?? Date.now();
  const supervisedRuns = readOrEmpty(deps.readSupervisedRuns);
  const recentRuns = readOrEmpty(deps.readRecentWorkRuns)
    .filter((run) => run.product && runId(run) && run.endedAt)
    .sort(compareEndedDesc);
  const backlogs = readOrEmpty(deps.readBacklogs);
  const backlogByProduct = new Map(backlogs.map((backlog) => [backlog.product, backlog]));

  const products: HomeProductPulse[] = registry.products.map((product) => {
    const backlog = backlogByProduct.get(product.name);
    const liveRuns = supervisedRuns
      .filter((run) => run.product === product.name && isLive(run))
      .sort((a, b) => {
        if (a.status === 'blocked-on-human' && b.status !== 'blocked-on-human') return -1;
        if (a.status !== 'blocked-on-human' && b.status === 'blocked-on-human') return 1;
        return compareStartedDesc(a, b);
      });
    const active = liveRuns[0];
    const productRuns = recentRuns.filter((run) => run.product === product.name);
    const latest = productRuns[0];
    const openBugs = backlog?.bugs.filter((item) => item.status === 'open').length ?? 0;
    const openIdeas = backlog?.ideas.filter((item) => item.status === 'open').length ?? 0;
    const backlogWarnings = backlog?.fileWarnings.length ?? 0;

    const attention: AttentionSignal[] = [];
    if (active?.status === 'blocked-on-human') {
      attention.push({
        kind: 'parked-run',
        runId: active.id,
        target: targetFromSupervisedRun(active),
      });
    }
    for (const run of productRuns) {
      const outcome = mapOutcome(run.outcome);
      if (outcome === 'failed') {
        attention.push({ kind: 'failed-run', runId: runId(run), target: targetFromWorkRun(run) });
      } else if (outcome === 'no-op') {
        attention.push({ kind: 'noop-run', runId: runId(run), target: targetFromWorkRun(run) });
      }
    }
    if (backlogWarnings > 0) attention.push({ kind: 'backlog-warning', count: backlogWarnings });

    const pulse: HomeProductPulse = {
      name: product.name,
      repoBacked: product.repoBacked,
      counts: {
        activeProjects: product.projects.filter((project) => project.status === 'active').length,
        openBugs,
        openIdeas,
        backlogWarnings,
      },
      attention,
    };

    if (active) {
      pulse.activeRun = {
        runId: active.id,
        target: targetFromSupervisedRun(active),
        state: active.status === 'blocked-on-human' ? 'parked' : 'running',
        elapsedMs: elapsedMs(active.startedAt, now),
      };
    }

    if (latest) {
      pulse.mostRecentRun = {
        runId: runId(latest),
        outcome: mapOutcome(latest.outcome),
        endedAt: latest.endedAt,
      };
    }

    return pulse;
  });

  return { available: true, products };
}
