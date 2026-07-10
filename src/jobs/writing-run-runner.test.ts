/**
 * The `writing` MutationApplier (src/jobs/writing-run-runner.ts) — validate
 * matrix + the full apply() flow against injected WritingRunnerDeps: event
 * ordering (start → state lines → terminal), stage-attributed + scrubbed
 * failure reasons, cooperative cancel, destroy-in-finally on success AND
 * failure, the repo-missing preflight, the duplicate-slug in-flight guard,
 * and the keep-alive ticker that protects a silent run from the quiet→cancel
 * backstop.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  writingRunApplier,
  runWritingMutation,
  type WritingRunPayload,
  type WritingRunnerDeps,
} from './writing-run-runner.js';
import type { ApplyContext, MutationDescriptor, MutationEvent, RunHandle } from '../transport/mutations.js';
import type { StartedWritingProductRun } from './writing-product-orchestration.js';
import type { SandboxSpec } from '../intent/sandbox.js';

const SLUG = 'operating-from-memory';
const BRANCH = `rune-writing/${SLUG}`;

function blogPayload(overrides: Partial<WritingRunPayload> = {}): WritingRunPayload {
  return {
    command: 'blog',
    chatId: 42,
    product: 'writing',
    projectSlug: SLUG,
    topic: 'Operating from memory',
    ...overrides,
  };
}

function descriptorFor(payload: WritingRunPayload): MutationDescriptor<WritingRunPayload> {
  return {
    id: 'wrt-mutation-0001',
    kind: 'writing',
    source: 'cli',
    target: { type: 'writing', ref: payload.projectSlug },
    preview: { summary: `writing on ${payload.projectSlug}` },
    payload,
    createdAt: new Date().toISOString(),
    status: 'running',
  };
}

function ctx(cancelValue = false): ApplyContext {
  return {
    bus: {} as ApplyContext['bus'],
    cancel: () => cancelValue,
  };
}

function startedRun(): StartedWritingProductRun {
  return {
    product: 'writing',
    topic: 'Operating from memory',
    slug: SLUG,
    branch: BRANCH,
    routePaths: ['/rune', `/rune/${SLUG}`],
    branchStatus: 'created',
    publish: { mode: 'branch-commit', externalDeployment: false, commitSha: 'abc1234567890def' },
  } as StartedWritingProductRun;
}

const SANDBOX: SandboxSpec = {
  product: 'writing',
  project: SLUG,
  worktree: `/tmp/worktrees/writing/${SLUG}`,
  egressAllowlist: [],
};

type StartHooks = Parameters<WritingRunnerDeps['buildStartDeps']>[0];

/** Injected runner deps. `hooks` captures what the runner passed to
 *  buildStartDeps so a test's startRun can drive emitRunState mid-run. */
function makeDeps(overrides: Partial<WritingRunnerDeps> = {}) {
  const destroy = vi.fn(async () => {});
  let sandbox: SandboxSpec | null = SANDBOX;
  const captured: { hooks: StartHooks | null } = { hooks: null };
  const deps: WritingRunnerDeps = {
    buildStartDeps: (hooks) => {
      captured.hooks = hooks;
      return {
        deps: {
          createWritingWorktree: vi.fn(async () => ({ worktree: SANDBOX.worktree, resumed: false })),
          runWritingPipeline: vi.fn(async () => ({ state: 'committed', committed: true, commitSha: 'abc', branch: BRANCH })),
        },
        getSandbox: () => sandbox,
        getFailure: () => null,
      };
    },
    startRun: vi.fn(async () => startedRun()),
    destroy,
    getProduct: vi.fn(() => ({
      repoPath: '/tmp/michaelcjoseph.com',
      baseBranch: 'main',
      credentialsFile: '',
      egressAllowlist: [],
      validationCommands: [],
    })),
    repoPresent: vi.fn(() => true),
    listActiveRuns: () => new Map<string, RunHandle>(),
    tickerMs: 60_000,
    ...overrides,
  };
  return { deps, destroy, captured, setSandbox: (s: SandboxSpec | null) => { sandbox = s; } };
}

async function collect(gen: AsyncIterable<MutationEvent>): Promise<MutationEvent[]> {
  const events: MutationEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('writingRunApplier.validate', () => {
  const valid = blogPayload();
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['unknown command', { ...valid, command: 'draft' }, /command/],
    ['non-finite chatId', { ...valid, chatId: Number.NaN }, /chatId/],
    ['wrong product', { ...valid, product: 'rune' }, /product/],
    ['invalid slug', { ...valid, projectSlug: 'Bad Slug' }, /slug/],
    ['blog without topic', { ...valid, topic: '   ' }, /topic/],
    [
      'critique without target',
      { ...valid, command: 'writing-critique', critiqueTarget: '', outputPath: 'docs/rune/critiques/x.md' },
      /critiqueTarget/,
    ],
    [
      'critique outputPath outside docs/rune/critiques/',
      { ...valid, command: 'writing-critique', critiqueTarget: 'x', outputPath: 'src/evil.md' },
      /outputPath/,
    ],
  ];

  it('accepts a valid blog payload and a valid critique payload', () => {
    expect(writingRunApplier.validate(valid)).toEqual({ ok: true });
    expect(
      writingRunApplier.validate({
        command: 'writing-critique',
        chatId: 42,
        product: 'writing',
        projectSlug: SLUG,
        critiqueTarget: 'docs/rune/Operating From Memory.md',
        outputPath: `docs/rune/critiques/${SLUG}.md`,
        revisionRequested: true,
      } as WritingRunPayload),
    ).toEqual({ ok: true });
  });

  for (const [name, payload, reasonRe] of cases) {
    it(`rejects ${name}`, () => {
      const result = writingRunApplier.validate(payload as WritingRunPayload);
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toMatch(reasonRe);
    });
  }
});

describe('runWritingMutation', () => {
  it('yields start → pipeline state lines → completed with branch-complete outcome, and destroys the worktree', async () => {
    const { deps, destroy, captured } = makeDeps();
    deps.startRun = vi.fn(async (input) => {
      expect(input).toEqual({ command: 'blog', chatId: 42, topic: 'Operating from memory' });
      // Emit two pipeline states through the bridge mid-run.
      captured.hooks!.emitRunState({ state: 'researching', product: 'writing', target: { kind: 'writing-page', slug: SLUG }, branch: BRANCH });
      captured.hooks!.emitRunState({ state: 'drafting', product: 'writing', target: { kind: 'writing-page', slug: SLUG }, branch: BRANCH });
      return startedRun();
    });

    const events = await collect(runWritingMutation(descriptorFor(blogPayload()), ctx(), deps));

    expect(events.map((e) => e.kind)).toEqual(['start', 'output', 'output', 'completed']);
    expect((events[0]!.data as Record<string, unknown>)['branch']).toBe(BRANCH);
    expect((events[1]!.data as Record<string, unknown>)['line']).toBe('writing: researching');
    expect((events[2]!.data as Record<string, unknown>)['line']).toBe('writing: drafting');
    expect(events[3]!.data).toMatchObject({
      outcome: 'branch-complete',
      command: 'blog',
      topic: 'Operating from memory',
      slug: SLUG,
      branch: BRANCH,
      branchStatus: 'created',
      commitSha: 'abc1234567890def',
      routePath: `/rune/${SLUG}`,
    });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith(SANDBOX);
  });

  it('a critique payload threads target/outputPath/revision into the orchestrator input and terminal', async () => {
    const { deps } = makeDeps();
    const startRun = vi.fn(async () => startedRun());
    deps.startRun = startRun;
    const payload = blogPayload({
      command: 'writing-critique',
      critiqueTarget: 'docs/rune/Operating From Memory.md',
      outputPath: `docs/rune/critiques/${SLUG}.md`,
      revisionRequested: true,
    });
    delete (payload as Record<string, unknown>)['topic'];

    const events = await collect(runWritingMutation(descriptorFor(payload), ctx(), deps));

    expect(startRun).toHaveBeenCalledWith(
      {
        command: 'writing-critique',
        chatId: 42,
        target: 'docs/rune/Operating From Memory.md',
        outputPath: `docs/rune/critiques/${SLUG}.md`,
        revisionRequested: true,
      },
      expect.anything(),
    );
    const terminal = events.at(-1)!;
    expect(terminal.kind).toBe('completed');
    expect(terminal.data).toMatchObject({
      command: 'writing-critique',
      critiqueTarget: 'docs/rune/Operating From Memory.md',
      outputPath: `docs/rune/critiques/${SLUG}.md`,
    });
  });

  it('surfaces a stage-attributed failure with absolute paths scrubbed, and still destroys the worktree', async () => {
    const { deps, destroy } = makeDeps();
    deps.startRun = vi.fn(async () => {
      throw new Error('writing pipeline failed at commit: fatal: could not write /tmp/rune-test-vault/secret');
    });

    const events = await collect(runWritingMutation(descriptorFor(blogPayload()), ctx(), deps));

    const terminal = events.at(-1)!;
    expect(terminal.kind).toBe('failed');
    const reason = (terminal.data as Record<string, unknown>)['reason'] as string;
    expect(reason).toContain('failed at commit');
    expect(reason).toContain('<vault>/secret');
    expect(reason).not.toContain('/tmp/rune-test-vault');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('does not attempt teardown when the worktree was never created', async () => {
    const { deps, destroy, setSandbox } = makeDeps();
    setSandbox(null);
    deps.startRun = vi.fn(async () => {
      throw new Error('createWorktree: git worktree add failed');
    });

    const events = await collect(runWritingMutation(descriptorFor(blogPayload()), ctx(), deps));

    expect(events.at(-1)!.kind).toBe('failed');
    expect(destroy).not.toHaveBeenCalled();
  });

  it('marks a cancelled run on the failed terminal', async () => {
    const { deps } = makeDeps();
    deps.startRun = vi.fn(async () => {
      throw new Error('cancelled by user before draft');
    });

    const events = await collect(runWritingMutation(descriptorFor(blogPayload()), ctx(true), deps));

    const terminal = events.at(-1)!;
    expect(terminal.kind).toBe('failed');
    expect((terminal.data as Record<string, unknown>)['cancelled']).toBe(true);
  });

  it('preflights the writing repo: missing checkout fails fast without running anything', async () => {
    const { deps, destroy } = makeDeps();
    deps.repoPresent = vi.fn(() => false);
    const startRun = vi.fn();
    deps.startRun = startRun as unknown as WritingRunnerDeps['startRun'];

    const events = await collect(runWritingMutation(descriptorFor(blogPayload()), ctx(), deps));

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('failed');
    expect((events[0]!.data as Record<string, unknown>)['reason']).toMatch(/checkout is missing/);
    expect(startRun).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it('refuses a second concurrent run on the same slug (shared worktree path)', async () => {
    const { deps } = makeDeps();
    const other: RunHandle = {
      descriptor: descriptorFor(blogPayload()),
      cancel: () => {},
    };
    other.descriptor.id = 'other-run-9999';
    deps.listActiveRuns = () => new Map([[other.descriptor.id, other]]);
    const startRun = vi.fn();
    deps.startRun = startRun as unknown as WritingRunnerDeps['startRun'];

    const events = await collect(runWritingMutation(descriptorFor(blogPayload()), ctx(), deps));

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('failed');
    expect((events[0]!.data as Record<string, unknown>)['reason']).toMatch(/already in flight/);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('emits keep-alive + activity ticker events while the run is silent (quiet-cancel protection)', async () => {
    const { deps } = makeDeps({ tickerMs: 10 });
    deps.startRun = vi.fn(
      () => new Promise<StartedWritingProductRun>((resolve) => setTimeout(() => resolve(startedRun()), 60)),
    );

    const events = await collect(runWritingMutation(descriptorFor(blogPayload()), ctx(), deps));

    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'keep-alive').length).toBeGreaterThanOrEqual(1);
    expect(kinds.filter((k) => k === 'activity').length).toBeGreaterThanOrEqual(1);
    expect(kinds.at(-1)).toBe('completed');
  });
});
