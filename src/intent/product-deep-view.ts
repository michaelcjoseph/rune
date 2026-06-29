import type { BacklogItem, FileWarning } from './backlog-parser.js';
import type { ProductClass, ProductContainerCapabilities, Registry, RegistryProduct } from './registry.js';
import type { SupervisedRun } from './supervision.js';
import {
  computeFixAction,
  computePlanAction,
  type BacklogItemAction,
  type FixAction,
  type FixActionAttempt,
} from '../server/backlog-actions.js';

export type ProductDeepViewOutcome = 'completed' | 'no-op' | 'partial' | 'failed';

export interface ProductDeepViewTarget {
  kind: 'project' | 'bug';
  slug: string;
}

export interface DeepProject {
  slug: string;
  lifecycle: 'active' | 'done';
  taskProgress: { done: number; total: number };
  runControl: DeepProjectRunControl;
}

export interface DeepProjectRunControl {
  state: 'start' | 'cancel';
  mutationId?: string;
  dispatchMode?: string;
  fallbackReason?: string;
  error?: string;
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
  model?: string;
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
  fix?: FixAction;
}

export interface ProductDeepView {
  name: string;
  class?: ProductClass;
  scopePath?: string;
  containerCapabilities?: ProductContainerCapabilities;
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
  modelChoices?: Record<string, string>;
}

export interface ProductDeepViewActiveMutation {
  id: string;
  kind: string;
  status?: string;
  payload?: Record<string, unknown>;
}

export interface ProductDeepViewDispatchMode {
  mode: string;
  fallbackReason?: string;
}

export type ProductDeepViewFixAttempt = FixActionAttempt & {
  product?: string;
  bugId?: string;
};

export interface ProductDeepViewDeps {
  product: string;
  readRegistry: () => Registry;
  readSupervisedRuns: () => SupervisedRun[];
  readRecentWorkRuns: () => ProductDeepViewWorkRun[];
  readBacklogs: () => ProductDeepViewBacklog[];
  readFixAttempts?: () => Map<string, ProductDeepViewFixAttempt>;
  readTaskRunRecords?: (runId: string) => ProductDeepViewTaskRunRecord[];
  readActiveMutations?: () => ProductDeepViewActiveMutation[];
  dispatchModes?: Record<string, ProductDeepViewDispatchMode>;
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

function resolveProductContainerCapabilities(
  product: Pick<RegistryProduct, 'name' | 'class' | 'containerCapabilities'>,
): ProductContainerCapabilities {
  if (product.containerCapabilities) return product.containerCapabilities;
  if (product.name === 'writing') {
    return {
      projects: false,
      bugs: false,
      ideas: true,
      runs: true,
      chat: true,
      monitoring: 'stubbed',
    };
  }
  return {
    projects: true,
    bugs: true,
    ideas: true,
    runs: true,
    chat: true,
    monitoring: product.class === 'internal' ? 'enabled' : 'stubbed',
  };
}

function isCancellableProjectMutation(mutation: ProductDeepViewActiveMutation, product: string, projectSlug: string): boolean {
  if (mutation.kind !== 'work-run' && mutation.kind !== 'orchestrated-work') return false;
  if (mutation.status === 'completed' || mutation.status === 'failed' || mutation.status === 'rejected') return false;
  const payload = mutation.payload ?? {};
  return payload['product'] === product && payload['projectSlug'] === projectSlug;
}

function runControlForProject(
  product: string,
  projectSlug: string,
  activeMutations: ProductDeepViewActiveMutation[],
  dispatchModes: Record<string, ProductDeepViewDispatchMode> = {},
): DeepProjectRunControl {
  const activeMutation = activeMutations.find((mutation) =>
    isCancellableProjectMutation(mutation, product, projectSlug),
  );
  const dispatch = dispatchModes[projectSlug];
  if (activeMutation) {
    const payload = activeMutation.payload ?? {};
    const control: DeepProjectRunControl = {
      state: 'cancel',
      mutationId: activeMutation.id,
    };
    const dispatchMode = typeof payload['dispatchMode'] === 'string'
      ? payload['dispatchMode']
      : undefined;
    const fallbackReason = typeof payload['fallbackReason'] === 'string'
      ? payload['fallbackReason']
      : undefined;
    if (dispatchMode !== undefined) control.dispatchMode = dispatchMode;
    if (fallbackReason !== undefined) control.fallbackReason = fallbackReason;
    return control;
  }

  return {
    state: 'start',
    ...(dispatch?.mode !== undefined ? { dispatchMode: dispatch.mode } : {}),
    ...(dispatch?.fallbackReason !== undefined ? { fallbackReason: dispatch.fallbackReason } : {}),
  };
}

function attemptKey(product: string, bugId: string): string {
  return `${product}:${bugId}`;
}

function readFixAttempts(deps: ProductDeepViewDeps): Map<string, ProductDeepViewFixAttempt> {
  if (!deps.readFixAttempts) return new Map();
  try {
    return deps.readFixAttempts();
  } catch {
    return new Map();
  }
}

function withBacklogActions(
  product: string,
  item: BacklogItem,
  planningActive: boolean,
  attempts: Map<string, ProductDeepViewFixAttempt>,
): BacklogItemWithActions {
  const projected: BacklogItemWithActions = {
    ...item,
    plan: computePlanAction(item, planningActive),
  };
  if (item.kind === 'bugs') {
    projected.fix = computeFixAction(item, attempts.get(attemptKey(product, item.id)));
  }
  return projected;
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
      const model = record.modelChoices?.[role];
      agents.push({
        role,
        active: true,
        ...(model !== undefined ? { model } : {}),
      });
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
      ...(product.class ? { class: product.class } : {}),
      ...(product.scopePath ? { scopePath: product.scopePath } : {}),
      containerCapabilities: resolveProductContainerCapabilities(product),
      repoBacked: false,
      limitedReason: 'product is not backed by a repo',
      projects: [],
      backlog: { bugs: [], ideas: [], warnings: [] },
      runs: [],
    };
  }

  const now = deps.now?.() ?? Date.now();
  const backlogs = readOrEmpty(deps.readBacklogs);
  const fixAttempts = readFixAttempts(deps);
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
  const activeMutations = deps.readActiveMutations ? readOrEmpty(deps.readActiveMutations) : [];
  const containerCapabilities = resolveProductContainerCapabilities(product);

  const view: ProductDeepView = {
    name: product.name,
    ...(product.class ? { class: product.class } : {}),
    ...(product.scopePath ? { scopePath: product.scopePath } : {}),
    containerCapabilities,
    repoBacked: true,
    projects: !containerCapabilities.projects
      ? []
      : product.projects
        .filter((project) => project.status !== 'done')
        .map((project) => ({
          slug: project.slug,
          lifecycle: projectLifecycle(project.status),
          taskProgress: project.progress ?? { done: 0, total: 0 },
          runControl: runControlForProject(product.name, project.slug, activeMutations, deps.dispatchModes),
        })),
    backlog: {
      bugs: !containerCapabilities.bugs
        ? []
        : (backlog?.bugs ?? [])
          .filter((item) => item.status !== 'done')
          .map((item) =>
            withBacklogActions(product.name, item, deps.planningActive ?? false, fixAttempts),
          ),
      ideas: containerCapabilities.ideas
        ? (backlog?.ideas ?? []).map((item) =>
          withBacklogActions(product.name, item, deps.planningActive ?? false, fixAttempts),
        )
        : [],
      warnings: backlog?.fileWarnings ?? [],
    },
    runs: containerCapabilities.runs ? recentRuns.map((run) => {
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
    }) : [],
  };

  const active = liveRuns[0];
  if (active && containerCapabilities.runs) {
    view.activeRun = activeRunDetail(active, deps, now);
  }

  return view;
}
