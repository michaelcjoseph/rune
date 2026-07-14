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
        operatorWorktreePath: '/tmp/rune-aura-01-mvp',
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
    readFixAttempts: vi.fn(() => new Map()),
    readTaskRunRecords: vi.fn(() => [{ rolesInvoked: ['qa', 'coder', 'reviewer'] }]),
    worktreePathFor: vi.fn((product: string, slug: string) => `/tmp/rune-${product}-${slug}`),
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
    const aura = pulse.products.find((p: any) => p.name === 'aura')!;
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

  it('carries product class into HomePulse so the roster can render internal and external groups', async () => {
    const { buildHomePulse } = await import('./home-pulse.js');
    const classifiedRegistry = {
      version: 1,
      builtAt: '2026-06-23T00:00:00.000Z',
      products: [
        { name: 'rune', class: 'internal', repoBacked: true, projects: [] },
        { name: 'rune-mcp', class: 'internal', repoBacked: true, projects: [] },
        { name: 'aura', class: 'external', repoBacked: true, projects: [] },
        { name: 'assay', class: 'external', repoBacked: true, projects: [] },
        { name: 'relay', class: 'external', repoBacked: true, projects: [] },
        { name: 'writing', class: 'external', repoBacked: true, projects: [] },
        { name: 'brand', class: 'external', repoBacked: true, projects: [] },
      ],
    } as unknown as Registry;

    const pulse = buildHomePulse(deps({
      readRegistry: vi.fn(() => classifiedRegistry),
      readSupervisedRuns: vi.fn(() => []),
      readRecentWorkRuns: vi.fn(() => []),
      readBacklogs: vi.fn(() => []),
    }));

    const classesByProduct = Object.fromEntries(
      pulse.products.map((product: any) => [product.name, product.class]),
    );
    expect(classesByProduct).toEqual({
      rune: 'internal',
      'rune-mcp': 'internal',
      aura: 'external',
      assay: 'external',
      relay: 'external',
      writing: 'external',
      brand: 'external',
    });
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
    const aura = pulse.products.find((p: any) => p.name === 'aura')!;
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
      {
        slug: '01-mvp',
        lifecycle: 'active',
        taskProgress: { done: 2, total: 5 },
        runControl: { state: 'start' },
      },
    ]);
    expect(view.projects.some((project: any) => project.lifecycle === 'done')).toBe(false);
    expect(view.backlog.bugs.find((b: any) => b.id === 'b-open')).toMatchObject({
      id: 'b-open',
      plan: { kind: 'plan', enabled: true },
      fix: { kind: 'fix', state: 'available' },
    });
    expect(view.backlog.ideas.find((i: any) => i.id === 'i-open')).toMatchObject({
      id: 'i-open',
      body: ['show active run'],
      plan: { kind: 'plan', enabled: true },
    });
    expect(view.backlog.ideas.find((i: any) => i.id === 'i-open')?.fix).toBeUndefined();
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
      worktreePath: '/tmp/rune-aura-01-mvp',
      transcriptUrl: '/api/work-runs/run-parked/transcript',
      agents: [
        { role: 'qa', active: true },
        { role: 'coder', active: true },
        { role: 'reviewer', active: true },
      ],
    });
  });

  it('applies the writing product container contract: ideas and writing runs only, with no projects or bugs', async () => {
    const { buildProductDeepView } = await import('./product-deep-view.js');
    const writingRegistry: Registry = {
      version: 1,
      builtAt: '2026-06-23T00:00:00.000Z',
      products: [
        {
          name: 'writing',
          repoBacked: true,
          projects: [
            { slug: 'legacy-project-that-must-not-render', status: 'active', progress: { done: 0, total: 4 } },
          ],
        },
      ],
    };
    const writingIdea = item({
      id: 'idea-writing-1',
      kind: 'ideas',
      text: 'draft the first Rune essay',
      status: 'open',
      section: 'user-authored',
      source: { file: 'docs/rune/writing-ideas.md', lineNumber: 3, raw: '- [ ] draft the first Rune essay' },
    });
    const writingBug = item({
      id: 'bug-writing-1',
      kind: 'bugs',
      text: 'this bug should not be part of the writing work container',
      status: 'open',
    });

    const view = buildProductDeepView({
      product: 'writing',
      ...deps({
        readRegistry: vi.fn(() => writingRegistry),
        readBacklogs: vi.fn((): ProductBacklogFixture[] => [
          {
            product: 'writing',
            notRepoBacked: false,
            bugs: [writingBug],
            ideas: [writingIdea],
            fileWarnings: [],
          },
        ]),
        readSupervisedRuns: vi.fn(() => [
          run({
            id: 'run-writing-draft',
            product: 'writing',
            project: 'draft-the-first-rune-essay',
            status: 'running',
            startedAt: '2026-06-23T12:00:00.000Z',
          }),
        ]),
        readRecentWorkRuns: vi.fn((): WorkRunFixture[] => [
          {
            runId: 'run-writing-publish',
            product: 'writing',
            target: { kind: 'project', slug: 'draft-the-first-rune-essay' },
            outcome: 'branch-complete',
            endedAt: '2026-06-23T11:45:00.000Z',
            transcriptExists: true,
          },
        ]),
      }),
    });

    expect(view.name).toBe('writing');
    expect(view.projects).toEqual([]);
    expect(view.backlog.bugs).toEqual([]);
    expect(view.backlog.ideas.map((idea: any) => idea.id)).toEqual(['idea-writing-1']);
    expect(view.runs.map((row: any) => row.runId)).toEqual(['run-writing-publish']);
    expect(view.activeRun).toMatchObject({
      runId: 'run-writing-draft',
      state: 'running',
    });
  });

  it('projects writing run route, branch, and draft/publish stage metadata for the cockpit surface', async () => {
    const { buildProductDeepView } = await import('./product-deep-view.js');
    const writingRegistry = {
      version: 1,
      builtAt: '2026-06-23T00:00:00.000Z',
      products: [
        {
          name: 'writing',
          class: 'external',
          scopePath: 'docs/rune',
          repoBacked: true,
          containerCapabilities: {
            projects: false,
            bugs: false,
            ideas: true,
            runs: true,
            chat: true,
            monitoring: 'stubbed',
          },
          projects: [],
        },
      ],
    } as unknown as Registry;

    const view = buildProductDeepView({
      product: 'writing',
      ...deps({
        readRegistry: vi.fn(() => writingRegistry),
        readBacklogs: vi.fn((): ProductBacklogFixture[] => [
          {
            product: 'writing',
            notRepoBacked: false,
            bugs: [],
            ideas: [
              item({
                id: 'idea-writing-memory',
                kind: 'ideas',
                text: 'Operating from memory',
                status: 'open',
                section: 'user-authored',
                source: {
                  file: 'docs/rune/writing-ideas.md',
                  lineNumber: 3,
                  raw: '- [ ] Operating from memory',
                },
              }),
            ],
            fileWarnings: [],
          },
        ]),
        readSupervisedRuns: vi.fn(() => [
          {
            ...run({
              id: 'run-writing-draft',
              product: 'writing',
              project: 'operating-from-memory',
              status: 'running',
              startedAt: '2026-06-23T12:00:00.000Z',
            }),
            target: { kind: 'writing-page', slug: 'operating-from-memory' },
            branch: 'rune-writing/operating-from-memory',
            routePath: '/rune/operating-from-memory',
            writingStage: 'drafting',
          } as unknown as SupervisedRun,
        ]),
        readRecentWorkRuns: vi.fn((): WorkRunFixture[] => [
          {
            runId: 'run-writing-publish',
            product: 'writing',
            target: { kind: 'writing-page', slug: 'operating-from-memory' } as unknown as WorkRunFixture['target'],
            outcome: 'branch-complete',
            endedAt: '2026-06-23T11:45:00.000Z',
            transcriptExists: true,
            branch: 'rune-writing/operating-from-memory',
            routePath: '/rune/operating-from-memory',
            writingStage: 'committed',
          } as WorkRunFixture,
        ]),
      }),
    });

    expect(view).toMatchObject({
      name: 'writing',
      scopePath: 'docs/rune',
      projects: [],
      backlog: {
        bugs: [],
        ideas: [expect.objectContaining({ id: 'idea-writing-memory' })],
      },
      activeRun: expect.objectContaining({
        runId: 'run-writing-draft',
        target: { kind: 'writing-page', slug: 'operating-from-memory' },
        branch: 'rune-writing/operating-from-memory',
        routePath: '/rune/operating-from-memory',
        writingStage: 'drafting',
      }),
      runs: [
        expect.objectContaining({
          runId: 'run-writing-publish',
          target: { kind: 'writing-page', slug: 'operating-from-memory' },
          branch: 'rune-writing/operating-from-memory',
          routePath: '/rune/operating-from-memory',
          writingStage: 'committed',
        }),
      ],
    });
  });

  it('applies container capabilities from product metadata instead of hardcoded product names', async () => {
    const { buildProductDeepView } = await import('./product-deep-view.js');
    const registryWithCapabilities = {
      version: 1,
      builtAt: '2026-06-23T00:00:00.000Z',
      products: [
        {
          name: 'essay-lab',
          class: 'external',
          repoBacked: true,
          containerCapabilities: {
            projects: false,
            bugs: false,
            ideas: true,
            runs: true,
            chat: true,
            monitoring: 'stubbed',
          },
          projects: [
            { slug: 'legacy-project-that-must-not-render', status: 'active', progress: { done: 0, total: 3 } },
          ],
        },
      ],
    } as unknown as Registry;
    const idea = item({
      id: 'idea-essay-lab-1',
      kind: 'ideas',
      text: 'draft a product essay',
      status: 'open',
      section: 'user-authored',
      source: { file: 'docs/rune/writing-ideas.md', lineNumber: 8, raw: '- [ ] draft a product essay' },
    });
    const bug = item({
      id: 'bug-essay-lab-1',
      kind: 'bugs',
      text: 'this bug should not render when bug capability is disabled',
      status: 'open',
    });

    const view = buildProductDeepView({
      product: 'essay-lab',
      ...deps({
        readRegistry: vi.fn(() => registryWithCapabilities),
        readBacklogs: vi.fn((): ProductBacklogFixture[] => [
          {
            product: 'essay-lab',
            notRepoBacked: false,
            bugs: [bug],
            ideas: [idea],
            fileWarnings: [],
          },
        ]),
        readSupervisedRuns: vi.fn(() => []),
        readRecentWorkRuns: vi.fn(() => []),
      }),
    });

    expect((view as any).class).toBe('external');
    expect((view as any).containerCapabilities).toEqual({
      projects: false,
      bugs: false,
      ideas: true,
      runs: true,
      chat: true,
      monitoring: 'stubbed',
    });
    expect(view.projects).toEqual([]);
    expect(view.backlog.bugs).toEqual([]);
    expect(view.backlog.ideas.map((row: any) => row.id)).toEqual(['idea-essay-lab-1']);
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

  it('projects per-project Start or Cancel controls from active work mutations only', async () => {
    const { buildProductDeepView } = await import('./product-deep-view.js');
    const view = buildProductDeepView({
      product: 'aura',
      ...deps({
        readActiveMutations: vi.fn(() => [
          {
            id: 'mut-cancel-this',
            kind: 'orchestrated-work',
            status: 'running',
            recoverable: true,
            payload: {
              product: 'aura',
              projectSlug: '01-mvp',
              dispatchMode: 'orchestrated',
            },
          },
          {
            id: 'mut-other-project',
            kind: 'work-run',
            status: 'running',
            payload: { product: 'aura', projectSlug: 'other-project' },
          },
          {
            id: 'mut-other-product',
            kind: 'work-run',
            status: 'running',
            payload: { product: 'relay', projectSlug: '01-mvp' },
          },
        ]),
        dispatchModes: {
          '01-mvp': { mode: 'legacy', fallbackReason: 'operator override' },
        },
      }),
    });

    expect(view.projects).toEqual([
      {
        slug: '01-mvp',
        lifecycle: 'active',
        taskProgress: { done: 2, total: 5 },
        runControl: {
          state: 'cancel',
          mutationId: 'mut-cancel-this',
          recoverable: true,
          dispatchMode: 'orchestrated',
        },
      },
    ]);
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
      worktreePath: '/tmp/rune-aura-b-open',
      transcriptUrl: '/api/work-runs/run-bug-fix/transcript',
      agents: [
        { role: 'pm', active: true, model: 'claude' },
        { role: 'tech-lead', active: true, model: 'claude' },
        { role: 'coder', active: true, model: 'codex' },
      ],
    });
  });

  it('projects persisted FixAttempt state into each bug fix action and ignores stale attempts for deleted bugs', async () => {
    const { buildProductDeepView } = await import('./product-deep-view.js');
    const attempts = new Map([
      [
        'aura:b-open',
        {
          attemptId: 'attempt-gating',
          product: 'aura',
          bugId: 'b-open',
          state: 'gating',
          updatedAt: '2026-06-23T12:00:00.000Z',
        },
      ],
      [
        'aura:b-done',
        {
          attemptId: 'attempt-ignored',
          product: 'aura',
          bugId: 'b-done',
          state: 'proceeding',
          runId: 'run-ignored',
          updatedAt: '2026-06-23T12:01:00.000Z',
        },
      ],
      [
        'aura:b-deleted',
        {
          attemptId: 'attempt-stale',
          product: 'aura',
          bugId: 'b-deleted',
          state: 'declined',
          reason: 'pm-not-well-scoped',
          updatedAt: '2026-06-23T12:02:00.000Z',
        },
      ],
    ]);

    const view = buildProductDeepView({
      product: 'aura',
      ...deps({
        readFixAttempts: vi.fn(() => attempts),
      }),
    });

    expect(view.backlog.bugs.find((b: any) => b.id === 'b-open')).toMatchObject({
      id: 'b-open',
      fix: { kind: 'fix', state: 'gating' },
    });
    expect(view.backlog.bugs.some((b: any) => b.id === 'b-done')).toBe(false);
    expect(view.backlog.bugs.some((b: any) => b.id === 'b-deleted')).toBe(false);
  });
});
