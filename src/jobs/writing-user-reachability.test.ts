import { describe, expect, it, vi } from 'vitest';

type TriggerSurface = 'telegram' | 'cockpit';

type TerminalRun = {
  runId: string;
  product: string;
  status: 'completed' | 'failed' | 'blocked-on-human';
  outcome?: string;
  branch?: string;
  target?: { kind: string; slug: string };
};

type ReachabilityDeps = {
  dispatchBlogCommand: (input: {
    surface: TriggerSurface;
    product: 'writing';
    text: string;
  }) => Promise<{ runId: string }>;
  observeTerminalRun: (input: {
    runId: string;
    timeoutMs: number;
  }) => Promise<TerminalRun>;
  readBranchFile: (input: {
    repo: 'michaelcjoseph.com';
    branch: string;
    path: string;
  }) => Promise<string>;
};

type ReachabilityResult = {
  ok: true;
  runId: string;
  product: 'writing';
  branch: string;
  slug: string;
  routePaths: ['/rune', `/rune/${string}`];
  pagePaths: ['src/app/rune/page.tsx', 'src/app/rune/[slug]/page.tsx'];
};

async function requireWritingReachability(): Promise<{
  runWritingUserReachabilityCheck: (
    input: {
      surface: TriggerSurface;
      topic: string;
      timeoutMs: number;
    },
    deps: ReachabilityDeps,
  ) => Promise<ReachabilityResult>;
}> {
  const specifier = './writing-user-reachability' + '.js';
  try {
    const mod = await import(/* @vite-ignore */ specifier) as Record<string, unknown>;
    if (typeof mod.runWritingUserReachabilityCheck === 'function') {
      return {
        runWritingUserReachabilityCheck: mod.runWritingUserReachabilityCheck as (
          input: {
            surface: TriggerSurface;
            topic: string;
            timeoutMs: number;
          },
          deps: ReachabilityDeps,
        ) => Promise<ReachabilityResult>,
      };
    }
  } catch {
    // Fall through to a clean assertion failure below.
  }
  expect.fail(
    'src/jobs/writing-user-reachability.ts must export runWritingUserReachabilityCheck for the Phase 6 user-reachability-check assertable half',
  );
}

function makeDeps(overrides: Partial<ReachabilityDeps> = {}): ReachabilityDeps {
  const deps: ReachabilityDeps = {
    dispatchBlogCommand: vi.fn(async () => ({ runId: 'writing-run-001' })),
    observeTerminalRun: vi.fn(async (): Promise<TerminalRun> => ({
      runId: 'writing-run-001',
      product: 'writing',
      status: 'completed',
      outcome: 'branch-complete',
      branch: 'rune-writing/operating-from-memory',
      target: { kind: 'writing-page', slug: 'operating-from-memory' },
    })),
    readBranchFile: vi.fn(async ({ path }) => {
      if (path === 'src/app/rune/page.tsx') return 'export default function RuneIndex() { return <main>Rune</main>; }';
      if (path === 'src/app/rune/[slug]/page.tsx') return 'export default function RuneTopicPage() { return <article>{slug}</article>; }';
      throw new Error(`unexpected branch file read: ${path}`);
    }),
    ...overrides,
  };
  return deps;
}

describe('writing user reachability assertable half', () => {
  it.each(['telegram', 'cockpit'] as const)(
    'triggers /blog from %s, waits for the writing run terminal, and verifies both required pages on the topic branch',
    async (surface) => {
      const { runWritingUserReachabilityCheck } = await requireWritingReachability();
      const deps = makeDeps();

      const result = await runWritingUserReachabilityCheck({
        surface,
        topic: 'Operating from memory',
        timeoutMs: 30_000,
      }, deps);

      expect(deps.dispatchBlogCommand).toHaveBeenCalledWith({
        surface,
        product: 'writing',
        text: '/blog Operating from memory',
      });
      expect(deps.observeTerminalRun).toHaveBeenCalledWith({
        runId: 'writing-run-001',
        timeoutMs: 30_000,
      });
      expect(deps.readBranchFile).toHaveBeenCalledWith({
        repo: 'michaelcjoseph.com',
        branch: 'rune-writing/operating-from-memory',
        path: 'src/app/rune/page.tsx',
      });
      expect(deps.readBranchFile).toHaveBeenCalledWith({
        repo: 'michaelcjoseph.com',
        branch: 'rune-writing/operating-from-memory',
        path: 'src/app/rune/[slug]/page.tsx',
      });
      expect(result).toEqual({
        ok: true,
        runId: 'writing-run-001',
        product: 'writing',
        branch: 'rune-writing/operating-from-memory',
        slug: 'operating-from-memory',
        routePaths: ['/rune', '/rune/operating-from-memory'],
        pagePaths: ['src/app/rune/page.tsx', 'src/app/rune/[slug]/page.tsx'],
      });
    },
  );

  it('rejects a terminal run that did not complete the writing branch for the requested topic', async () => {
    const { runWritingUserReachabilityCheck } = await requireWritingReachability();
    const deps = makeDeps({
      observeTerminalRun: vi.fn(async (): Promise<TerminalRun> => ({
        runId: 'writing-run-001',
        product: 'writing',
        status: 'failed',
        outcome: 'failed',
        branch: 'rune-writing/operating-from-memory',
        target: { kind: 'writing-page', slug: 'operating-from-memory' },
      })),
    });

    await expect(runWritingUserReachabilityCheck({
      surface: 'telegram',
      topic: 'Operating from memory',
      timeoutMs: 30_000,
    }, deps)).rejects.toThrow(/terminal|completed|branch-complete|failed/i);

    expect(deps.readBranchFile).not.toHaveBeenCalled();
  });

  it('rejects when the rune-writing/{slug} branch is missing either required page', async () => {
    const { runWritingUserReachabilityCheck } = await requireWritingReachability();
    const deps = makeDeps({
      readBranchFile: vi.fn(async ({ path }) => {
        if (path === 'src/app/rune/page.tsx') return 'export default function RuneIndex() { return <main>Rune</main>; }';
        throw new Error(`${path} missing from branch`);
      }),
    });

    await expect(runWritingUserReachabilityCheck({
      surface: 'cockpit',
      topic: 'Operating from memory',
      timeoutMs: 30_000,
    }, deps)).rejects.toThrow(/src\/app\/rune\/\[slug\]\/page\.tsx|missing|required page/i);
  });
});
