import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem, FileWarning } from './backlog-parser.js';
import type { Registry } from './registry.js';
import type { SupervisedRun } from './supervision.js';

type WorkRunFixture = {
  runId: string;
  product: string;
  target: { kind: 'project' | 'bug'; slug: string };
  outcome: 'branch-complete' | 'partial' | 'dirty-uncommitted' | 'noop' | 'failed';
  endedAt: string;
  startedAt?: string;
  transcriptExists?: boolean;
};

type ProductBacklogFixture = {
  product: string;
  notRepoBacked: boolean;
  bugs: BacklogItem[];
  ideas: BacklogItem[];
  fileWarnings: FileWarning[];
};

const NOW_ISO = '2026-06-23T12:00:30.000Z';
const NOW_MS = Date.parse(NOW_ISO);

const registry: Registry = {
  version: 1,
  builtAt: '2026-06-23T00:00:00.000Z',
  products: [
    {
      name: 'aura',
      repoBacked: true,
      projects: [
        { slug: '01-mvp', status: 'active', progress: { done: 2, total: 5 } },
        { slug: '00-archive', status: 'done', progress: { done: 4, total: 4 } },
      ],
    },
    {
      name: 'relay',
      repoBacked: false,
      projects: [{ slug: '01-relay-core', status: 'active' }],
    },
  ],
};

function item(overrides: Partial<BacklogItem>): BacklogItem {
  return {
    id: 'b-open',
    kind: 'bugs',
    text: 'button crashes',
    status: 'open',
    body: [],
    source: { file: 'docs/projects/bugs.md', lineNumber: 1, raw: '- [ ] button crashes' },
    warnings: [],
    ...overrides,
  };
}

const auraBacklog: ProductBacklogFixture = {
  product: 'aura',
  notRepoBacked: false,
  bugs: [
    item({ id: 'b-open', kind: 'bugs', text: 'button crashes', status: 'open' }),
    item({ id: 'b-done', kind: 'bugs', text: 'already fixed', status: 'done' }),
  ],
  ideas: [
    item({
      id: 'i-open',
      kind: 'ideas',
      text: 'ship pulse view',
      status: 'open',
      section: 'user-authored',
      body: ['show active run'],
      source: { file: 'docs/projects/ideas.md', lineNumber: 1, raw: '- [ ] ship pulse view' },
    }),
  ],
  fileWarnings: [
    { file: 'docs/projects/ideas.md', lineNumber: 4, code: 'tab-indented', message: 'tab-indented bullet' },
  ],
};

const relayBacklog: ProductBacklogFixture = {
  product: 'relay',
  notRepoBacked: true,
  bugs: [],
  ideas: [],
  fileWarnings: [],
};

function run(overrides: Partial<SupervisedRun>): SupervisedRun {
  return {
    id: 'run-live',
    product: 'aura',
    project: '01-mvp',
    status: 'running',
    startedAt: '2026-06-23T12:00:00.000Z',
    lastHeartbeatAt: '2026-06-23T12:00:15.000Z',
    ...overrides,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    readRegistry: vi.fn(() => registry),
    readSupervisedRuns: vi.fn(() => [
      run({
        id: 'run-parked',
        product: 'aura',
        project: '01-mvp',
        status: 'blocked-on-human',
        startedAt: '2026-06-23T12:00:00.000Z',
        operatorWorktreePath: '/tmp/jarvis-aura-01-mvp',
      }),
    ]),
    readRecentWorkRuns: vi.fn((): WorkRunFixture[] => [
      {
        runId: 'run-failed',
        product: 'aura',
        target: { kind: 'project', slug: '01-mvp' },
        outcome: 'failed',
        endedAt: '2026-06-23T11:30:00.000Z',
        startedAt: '2026-06-23T11:00:00.000Z',
        transcriptExists: true,
      },
      {
        runId: 'run-noop',
        product: 'aura',
        target: { kind: 'project', slug: '00-archive' },
        outcome: 'noop',
        endedAt: '2026-06-23T10:30:00.000Z',
        startedAt: '2026-06-23T10:00:00.000Z',
        transcriptExists: false,
      },
    ]),
    readBacklogs: vi.fn(() => [auraBacklog, relayBacklog]),
    readTaskRunRecords: vi.fn(() => [{ rolesInvoked: ['qa', 'coder', 'reviewer'] }]),
    worktreePathFor: vi.fn((product: string, slug: string) => `/tmp/jarvis-${product}-${slug}`),
    now: vi.fn(() => NOW_MS),
    ...overrides,
  };
}

describe('buildHomePulse - HomePulse projection (cockpit redesign Phase 1)', () => {
  it('returns an explicit unavailable shape when the registry read fails', async () => {
    const { buildHomePulse } = await import('./home-pulse.js');
    const pulse = buildHomePulse(
      deps({
        readRegistry: vi.fn(() => {
          throw new Error('registry not yet built');
        }),
      }),
    );

    expect(pulse).toMatchObject({
      available: false,
      products: [],
      unavailableReason: expect.stringContaining('registry not yet built'),
    });
  });

  it('aggregates counts, parked active-run state, terminal outcomes, and ordered attention signals per product', async () => {
    const { buildHomePulse } = await import('./home-pulse.js');
    const pulse = buildHomePulse(deps());

    expect(pulse.available).toBe(true);
    const aura = pulse.products.find((p: any) => p.name === 'aura');
    expect(aura).toMatchObject({
      name: 'aura',
      repoBacked: true,
      activeRun: {
        runId: 'run-parked',
        target: { kind: 'project', slug: '01-mvp' },
        state: 'parked',
        elapsedMs: 30_000,
      },
      counts: {
        activeProjects: 1,
        openBugs: 1,
        openIdeas: 1,
        backlogWarnings: 1,
      },
      mostRecentRun: {
        runId: 'run-failed',
        outcome: 'failed',
        endedAt: '2026-06-23T11:30:00.000Z',
      },
    });
    expect(aura.attention.map((s: any) => s.kind)).toEqual([
      'parked-run',
      'failed-run',
      'noop-run',
      'backlog-warning',
    ]);
    expect(aura.attention).toEqual([
      {
        kind: 'parked-run',
        runId: 'run-parked',
        target: { kind: 'project', slug: '01-mvp' },
      },
      {
        kind: 'failed-run',
        runId: 'run-failed',
        target: { kind: 'project', slug: '01-mvp' },
      },
      {
        kind: 'noop-run',
        runId: 'run-noop',
        target: { kind: 'project', slug: '00-archive' },
      },
      {
        kind: 'backlog-warning',
        count: 1,
      },
    ]);
  });

  it('degrades backlog-derived fields when the backlog store read fails instead of failing the pulse', async () => {
    const { buildHomePulse } = await import('./home-pulse.js');
    const pulse = buildHomePulse(
      deps({
        readBacklogs: vi.fn(() => {
          throw new Error('products config unreadable');
        }),
      }),
    );

    expect(pulse.available).toBe(true);
    const aura = pulse.products.find((p: any) => p.name === 'aura');
    expect(aura).toMatchObject({
      name: 'aura',
      repoBacked: true,
      counts: {
        activeProjects: 1,
        openBugs: 0,
        openIdeas: 0,
        backlogWarnings: 0,
      },
      activeRun: {
        runId: 'run-parked',
        state: 'parked',
      },
      mostRecentRun: {
        runId: 'run-failed',
        outcome: 'failed',
      },
    });
    expect(aura.attention.map((s: any) => s.kind)).toEqual(['parked-run', 'failed-run', 'noop-run']);
  });

  it.each([
    ['branch-complete', 'completed'],
    ['partial', 'partial'],
    ['dirty-uncommitted', 'partial'],
    ['noop', 'no-op'],
    ['failed', 'failed'],
  ] as const)('maps WorkRunSummary outcome %s to HomePulse outcome %s', async (storedOutcome, expected) => {
    const { buildHomePulse } = await import('./home-pulse.js');
    const pulse = buildHomePulse(
      deps({
        readSupervisedRuns: vi.fn(() => []),
        readRecentWorkRuns: vi.fn(() => [
          {
            runId: `run-${storedOutcome}`,
            product: 'aura',
            target: { kind: 'project', slug: '01-mvp' },
            outcome: storedOutcome,
            endedAt: '2026-06-23T11:30:00.000Z',
          },
        ]),
      }),
    );

    expect(pulse.products.find((p: any) => p.name === 'aura')?.mostRecentRun).toMatchObject({
      runId: `run-${storedOutcome}`,
      outcome: expected,
    });
  });

  it('surfaces a parked run only as active state and attention, never as a terminal outcome', async () => {
    const { buildHomePulse } = await import('./home-pulse.js');
    const pulse = buildHomePulse(
      deps({
        readSupervisedRuns: vi.fn(() => [
          run({
            id: 'run-awaiting-release',
            product: 'aura',
            project: '01-mvp',
            status: 'blocked-on-human',
            startedAt: '2026-06-23T12:00:00.000Z',
          }),
        ]),
        readRecentWorkRuns: vi.fn(() => []),
        readBacklogs: vi.fn(() => []),
      }),
    );

    const aura = pulse.products.find((p: any) => p.name === 'aura');
    expect(aura).toMatchObject({
      activeRun: {
        runId: 'run-awaiting-release',
        target: { kind: 'project', slug: '01-mvp' },
        state: 'parked',
        elapsedMs: 30_000,
      },
      attention: [
        {
          kind: 'parked-run',
          runId: 'run-awaiting-release',
          target: { kind: 'project', slug: '01-mvp' },
        },
      ],
    });
    expect(aura?.mostRecentRun).toBeUndefined();
    expect(aura?.attention.some((signal: any) => signal.kind === 'parked')).toBe(false);
  });

  it('keeps bug targets intact for recent-run outcomes and attention signals', async () => {
    const { buildHomePulse } = await import('./home-pulse.js');
    const pulse = buildHomePulse(
      deps({
        readSupervisedRuns: vi.fn(() => []),
        readBacklogs: vi.fn(() => []),
        readRecentWorkRuns: vi.fn(() => [
          {
            runId: 'run-bug-noop',
            product: 'aura',
            target: { kind: 'bug', slug: 'b-open' },
            outcome: 'noop',
            endedAt: '2026-06-23T11:30:00.000Z',
          },
        ]),
      }),
    );

    const aura = pulse.products.find((p: any) => p.name === 'aura');
    expect(aura?.mostRecentRun).toEqual({
      runId: 'run-bug-noop',
      outcome: 'no-op',
      endedAt: '2026-06-23T11:30:00.000Z',
    });
    expect(aura?.attention).toEqual([
      {
        kind: 'noop-run',
        runId: 'run-bug-noop',
        target: { kind: 'bug', slug: 'b-open' },
      },
    ]);
  });
});

describe('buildProductDeepView - ProductDeepView projection (cockpit redesign Phase 1)', () => {
  it('returns the limited ProductDeepView shape for known non-repo-backed products', async () => {
    const { buildProductDeepView } = await import('./product-deep-view.js');
    const view = buildProductDeepView({ product: 'relay', ...deps() });

    expect(view).toMatchObject({
      name: 'relay',
      repoBacked: false,
      limitedReason: expect.any(String),
      projects: [],
      backlog: { bugs: [], ideas: [], warnings: [] },
      runs: [],
    });
    expect(view.activeRun).toBeUndefined();
  });

  it('projects repo-backed projects, backlog items with plan actions, run history, and active-run details', async () => {
    const { buildProductDeepView } = await import('./product-deep-view.js');
    const view = buildProductDeepView({ product: 'aura', ...deps() });

    expect(view.name).toBe('aura');
    expect(view.repoBacked).toBe(true);
    expect(view.projects).toEqual([
      { slug: '01-mvp', lifecycle: 'active', taskProgress: { done: 2, total: 5 } },
      { slug: '00-archive', lifecycle: 'done', taskProgress: { done: 4, total: 4 } },
    ]);
    expect(view.backlog.bugs.find((b: any) => b.id === 'b-open')).toMatchObject({
      id: 'b-open',
      plan: { kind: 'plan', enabled: true },
    });
    expect(view.backlog.ideas.find((i: any) => i.id === 'i-open')).toMatchObject({
      id: 'i-open',
      body: ['show active run'],
      plan: { kind: 'plan', enabled: true },
    });
    expect(view.backlog.warnings).toHaveLength(1);

    expect(view.runs).toEqual([
      {
        runId: 'run-failed',
        target: { kind: 'project', slug: '01-mvp' },
        outcome: 'failed',
        endedAt: '2026-06-23T11:30:00.000Z',
        transcriptUrl: '/api/work-runs/run-failed/transcript',
      },
      {
        runId: 'run-noop',
        target: { kind: 'project', slug: '00-archive' },
        outcome: 'no-op',
        endedAt: '2026-06-23T10:30:00.000Z',
      },
    ]);
    expect(view.activeRun).toMatchObject({
      runId: 'run-parked',
      target: { kind: 'project', slug: '01-mvp' },
      state: 'parked',
      startedAt: '2026-06-23T12:00:00.000Z',
      elapsedMs: 30_000,
      worktreePath: '/tmp/jarvis-aura-01-mvp',
      transcriptUrl: '/api/work-runs/run-parked/transcript',
      agents: [
        { role: 'qa', active: true },
        { role: 'coder', active: true },
        { role: 'reviewer', active: true },
      ],
    });
  });

  it('filters run history to the selected product, sorts most-recent first, maps outcomes, and preserves bug targets', async () => {
    const { buildProductDeepView } = await import('./product-deep-view.js');
    const view = buildProductDeepView({
      product: 'aura',
      ...deps({
        readSupervisedRuns: vi.fn(() => []),
        readRecentWorkRuns: vi.fn((): WorkRunFixture[] => [
          {
            runId: 'run-older-partial',
            product: 'aura',
            target: { kind: 'project', slug: '00-archive' },
            outcome: 'dirty-uncommitted',
            endedAt: '2026-06-23T09:30:00.000Z',
            transcriptExists: true,
          },
          {
            runId: 'run-other-product',
            product: 'relay',
            target: { kind: 'project', slug: '01-relay-core' },
            outcome: 'failed',
            endedAt: '2026-06-23T12:00:00.000Z',
            transcriptExists: true,
          },
          {
            runId: 'run-newer-bug',
            product: 'aura',
            target: { kind: 'bug', slug: 'b-open' },
            outcome: 'branch-complete',
            endedAt: '2026-06-23T11:45:00.000Z',
            transcriptExists: false,
          },
        ]),
      }),
    });

    expect(view.runs).toEqual([
      {
        runId: 'run-newer-bug',
        target: { kind: 'bug', slug: 'b-open' },
        outcome: 'completed',
        endedAt: '2026-06-23T11:45:00.000Z',
      },
      {
        runId: 'run-older-partial',
        target: { kind: 'project', slug: '00-archive' },
        outcome: 'partial',
        endedAt: '2026-06-23T09:30:00.000Z',
        transcriptUrl: '/api/work-runs/run-older-partial/transcript',
      },
    ]);
    expect(view.runs.some((row: any) => row.runId === 'run-other-product')).toBe(false);
  });

  it('projects a running bug active-run detail with computed worktree path and role records', async () => {
    const { buildProductDeepView } = await import('./product-deep-view.js');
    const view = buildProductDeepView({
      product: 'aura',
      ...deps({
        readSupervisedRuns: vi.fn(() => [
          {
            ...run({
              id: 'run-bug-fix',
              product: 'aura',
              project: 'b-open',
              status: 'running',
              startedAt: '2026-06-23T12:00:10.000Z',
            }),
            target: { kind: 'bug', slug: 'b-open' },
          },
        ]),
        readTaskRunRecords: vi.fn(() => [{
          rolesInvoked: ['pm', 'tech-lead', 'coder'],
          modelChoices: { pm: 'claude', 'tech-lead': 'claude', coder: 'codex' },
        }]),
      }),
    });

    expect(view.activeRun).toEqual({
      runId: 'run-bug-fix',
      target: { kind: 'bug', slug: 'b-open' },
      state: 'running',
      startedAt: '2026-06-23T12:00:10.000Z',
      elapsedMs: 20_000,
      worktreePath: '/tmp/jarvis-aura-b-open',
      transcriptUrl: '/api/work-runs/run-bug-fix/transcript',
      agents: [
        { role: 'pm', active: true, model: 'claude' },
        { role: 'tech-lead', active: true, model: 'claude' },
        { role: 'coder', active: true, model: 'codex' },
      ],
    });
  });
});
