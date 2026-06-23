import type { BacklogItem, FileWarning } from './backlog-parser.js';
import type { Registry, RegistryProduct } from './registry.js';
import type { SupervisedRun } from './supervision.js';
import { computePlanAction, type BacklogItemAction } from '../server/backlog-actions.js';

export type ProductDeepViewOutcome = 'completed' | 'no-op' | 'partial' | 'failed';

export interface ProductDeepViewTarget {
  kind: 'project' | 'bug';
  slug: string;
}

export interface DeepProject {
  slug: string;
  lifecycle: 'active' | 'done';
  taskProgress: { done: number; total: number };
}

export interface RunSummaryRow {
  runId: string;
  target: ProductDeepViewTarget;
  outcome: ProductDeepViewOutcome;
  endedAt: string;
  transcriptUrl?: string;
}

export interface AgentOnRun {
  role: string;
  active: boolean;
}

export interface ActiveRunDetail {
  runId: string;
  target: ProductDeepViewTarget;
  state: 'running' | 'parked';
  startedAt: string;
  elapsedMs: number;
  worktreePath: string;
  agents: AgentOnRun[];
  transcriptUrl: string;
}

export interface BacklogItemWithActions extends BacklogItem {
  plan: BacklogItemAction;
}

export interface ProductDeepView {
  name: string;
  repoBacked: boolean;
  limitedReason?: string;
  projects: DeepProject[];
  backlog: {
    bugs: BacklogItemWithActions[];
    ideas: BacklogItemWithActions[];
    warnings: FileWarning[];
  };
  runs: RunSummaryRow[];
  activeRun?: ActiveRunDetail;
}

export interface ProductDeepViewBacklog {
  product: string;
  notRepoBacked: boolean;
  bugs: BacklogItem[];
  ideas: BacklogItem[];
  fileWarnings: FileWarning[];
}

export type StoredProductDeepViewOutcome =
  | 'branch-complete'
  | 'partial'
  | 'dirty-uncommitted'
  | 'noop'
  | 'failed';

export interface ProductDeepViewWorkRun {
  runId?: string;
  id?: string;
  product: string;
  project?: string;
  target?: ProductDeepViewTarget;
  outcome: StoredProductDeepViewOutcome;
  endedAt: string;
  transcriptExists?: boolean;
  transcriptUrl?: string | null;
}

export interface ProductDeepViewTaskRunRecord {
  rolesInvoked: string[];
}

export interface ProductDeepViewDeps {
  product: string;
  readRegistry: () => Registry;
  readSupervisedRuns: () => SupervisedRun[];
  readRecentWorkRuns: () => ProductDeepViewWorkRun[];
  readBacklogs: () => ProductDeepViewBacklog[];
  readTaskRunRecords?: (runId: string) => ProductDeepViewTaskRunRecord[];
  worktreePathFor?: (product: string, slug: string) => string;
  planningActive?: boolean;
  now?: () => number;
}

function mapOutcome(outcome: StoredProductDeepViewOutcome): ProductDeepViewOutcome {
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

function runId(run: ProductDeepViewWorkRun): string {
  return run.runId ?? run.id ?? '';
}

function targetFromWorkRun(run: ProductDeepViewWorkRun): ProductDeepViewTarget {
  return run.target ?? { kind: 'project', slug: run.project ?? '' };
}

function targetFromSupervisedRun(run: SupervisedRun): ProductDeepViewTarget {
  const maybeTarget = (run as SupervisedRun & { target?: ProductDeepViewTarget }).target;
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

function compareEndedDesc(a: ProductDeepViewWorkRun, b: ProductDeepViewWorkRun): number {
  return Date.parse(b.endedAt) - Date.parse(a.endedAt);
}

function projectLifecycle(status: RegistryProduct['projects'][number]['status']): 'active' | 'done' {
  return status === 'done' ? 'done' : 'active';
}

function withPlan(item: BacklogItem, planningActive: boolean): BacklogItemWithActions {
  return { ...item, plan: computePlanAction(item, planningActive) };
}

function transcriptUrlForRun(run: ProductDeepViewWorkRun, id: string): string | undefined {
  if (typeof run.transcriptUrl === 'string') return run.transcriptUrl;
  if (run.transcriptExists) return `/api/work-runs/${id}/transcript`;
  return undefined;
}

function agentsFromRecords(records: ProductDeepViewTaskRunRecord[]): AgentOnRun[] {
  const seen = new Set<string>();
  const agents: AgentOnRun[] = [];
  for (const record of records) {
    for (const role of record.rolesInvoked) {
      if (seen.has(role)) continue;
      seen.add(role);
      agents.push({ role, active: true });
    }
  }
  return agents;
}

function readTaskRunRecords(deps: ProductDeepViewDeps, runId: string): ProductDeepViewTaskRunRecord[] {
  if (!deps.readTaskRunRecords) return [];
  try {
    return deps.readTaskRunRecords(runId);
  } catch {
    return [];
  }
}

function resolveWorktreePath(deps: ProductDeepViewDeps, run: SupervisedRun, target: ProductDeepViewTarget): string {
  if (run.operatorWorktreePath) return run.operatorWorktreePath;
  if (!deps.worktreePathFor) return '';
  try {
    return deps.worktreePathFor(run.product, target.slug);
  } catch {
    return '';
  }
}

function activeRunDetail(
  run: SupervisedRun,
  deps: ProductDeepViewDeps,
  now: number,
): ActiveRunDetail {
  const target = targetFromSupervisedRun(run);
  const records = readTaskRunRecords(deps, run.id);
  const agents = agentsFromRecords(records);

  return {
    runId: run.id,
    target,
    state: run.status === 'blocked-on-human' ? 'parked' : 'running',
    startedAt: run.startedAt,
    elapsedMs: elapsedMs(run.startedAt, now),
    worktreePath: resolveWorktreePath(deps, run, target),
    agents: agents.length > 0 ? agents : [{ role: 'coder', active: true }],
    transcriptUrl: `/api/work-runs/${run.id}/transcript`,
  };
}

/**
 * Build one product's deep cockpit view. This is a pure projection over injected
 * registry, backlog, run-history, supervision, and task-run-record readers.
 */
export function buildProductDeepView(deps: ProductDeepViewDeps): ProductDeepView {
  const registry = deps.readRegistry();
  const product = registry.products.find((candidate) => candidate.name === deps.product);
  if (!product) {
    throw new Error(`unknown product: ${deps.product}`);
  }

  if (!product.repoBacked) {
    return {
      name: product.name,
      repoBacked: false,
      limitedReason: 'product is not backed by a repo',
      projects: [],
      backlog: { bugs: [], ideas: [], warnings: [] },
      runs: [],
    };
  }

  const now = deps.now?.() ?? Date.now();
  const backlogs = readOrEmpty(deps.readBacklogs);
  const backlog = backlogs.find((entry) => entry.product === product.name);
  const recentRuns = readOrEmpty(deps.readRecentWorkRuns)
    .filter((run) => run.product === product.name && runId(run) && run.endedAt)
    .sort(compareEndedDesc);
  const liveRuns = readOrEmpty(deps.readSupervisedRuns)
    .filter((run) => run.product === product.name && isLive(run))
    .sort((a, b) => {
      if (a.status === 'blocked-on-human' && b.status !== 'blocked-on-human') return -1;
      if (a.status !== 'blocked-on-human' && b.status === 'blocked-on-human') return 1;
      return compareStartedDesc(a, b);
    });

  const view: ProductDeepView = {
    name: product.name,
    repoBacked: true,
    projects: product.projects.map((project) => ({
      slug: project.slug,
      lifecycle: projectLifecycle(project.status),
      taskProgress: project.progress ?? { done: 0, total: 0 },
    })),
    backlog: {
      bugs: (backlog?.bugs ?? []).map((item) => withPlan(item, deps.planningActive ?? false)),
      ideas: (backlog?.ideas ?? []).map((item) => withPlan(item, deps.planningActive ?? false)),
      warnings: backlog?.fileWarnings ?? [],
    },
    runs: recentRuns.map((run) => {
      const id = runId(run);
      const row: RunSummaryRow = {
        runId: id,
        target: targetFromWorkRun(run),
        outcome: mapOutcome(run.outcome),
        endedAt: run.endedAt,
      };
      const transcriptUrl = transcriptUrlForRun(run, id);
      if (transcriptUrl) row.transcriptUrl = transcriptUrl;
      return row;
    }),
  };

  const active = liveRuns[0];
  if (active) {
    view.activeRun = activeRunDetail(active, deps, now);
  }

  return view;
}
