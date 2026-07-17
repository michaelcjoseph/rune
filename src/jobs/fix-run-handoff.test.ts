import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../intent/backlog-parser.js';
import type { ProductConfig } from './sandbox-runtime.js';

// startFixRun creates its logger at module load. Capture its structured records
// so these tests pin the diagnosis contract, not console formatting.
const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/logger.js', () => ({ createLogger: () => mockLog }));

beforeEach(() => {
  vi.clearAllMocks();
});

const bug: BacklogItem = {
  id: 'BUG-save-crash',
  kind: 'bugs',
  text: 'Saving settings crashes the app',
  status: 'open',
  body: ['Repro: open Settings and select Save.'],
  source: { file: 'docs/projects/bugs.md', lineNumber: 1, raw: '- [ ] Saving settings crashes the app' },
  warnings: [],
};

const repoBackedProduct: ProductConfig = {
  repoPath: '/workspace/rune',
  baseBranch: 'main',
  credentialsFile: '',
  egressAllowlist: [],
};

async function loadGuard(): Promise<{
  guardSingleProduct: (
    input: { product: string; bug: BacklogItem },
    deps: {
      products: Record<string, ProductConfig>;
      resolveDeliverableRepo: (bug: BacklogItem, product: string, products: Record<string, ProductConfig>) => string;
    },
  ) => { accepted: true; repoPath: string } | { accepted: false; reason: string; detail?: string };
}> {
  const mod = await import('./fix-run-handoff.js');
  expect(mod.guardSingleProduct, 'expected a reusable single-product guard export').toBeTypeOf('function');
  return mod as unknown as Awaited<ReturnType<typeof loadGuard>>;
}

type StartDeps = {
  products: Record<string, ProductConfig>;
  resolveDeliverableRepo: (bug: BacklogItem, product: string, products: Record<string, ProductConfig>) => string;
  scaffoldAndCommitFixProject: (input: {
    repoPath: string;
    baseBranch: string;
    product: string;
    bugId: string;
    bug: BacklogItem;
    facts: Record<string, unknown>;
  }) => Promise<{ ok: true; projectSlug: string; commitSha: string } | { ok: false; reason: 'scaffold-failed' | 'commit-failed'; detail?: string }>;
  createMutation: (kind: string, payload: Record<string, unknown>, source: string) => Promise<
    { ok: true; descriptor: { id: string } } | { ok: false; reason: string }
  >;
};

async function loadStart(): Promise<{
  startFixRun: (input: { product: string; bugId: string; scope: { bug: BacklogItem; facts: Record<string, unknown> } }, deps: StartDeps) => Promise<unknown>;
}> {
  const mod = await import('./fix-run-handoff.js');
  expect(mod.startFixRun, 'expected startFixRun to be exported').toBeTypeOf('function');
  return mod as unknown as Awaited<ReturnType<typeof loadStart>>;
}

function startDeps(overrides: Partial<StartDeps> = {}): StartDeps {
  return {
    products: { rune: repoBackedProduct },
    resolveDeliverableRepo: () => repoBackedProduct.repoPath,
    scaffoldAndCommitFixProject: vi.fn(async () => ({
      ok: true as const,
      projectSlug: '22-fix-bug-save-crash',
      commitSha: 'a'.repeat(40),
    })),
    createMutation: vi.fn(async () => ({ ok: true as const, descriptor: { id: 'fix-run-123' } })),
    ...overrides,
  };
}

describe('single-product fix-run guard', () => {
  it('accepts only when the resolved deliverable repo is the product mutation repo', async () => {
    const { guardSingleProduct } = await loadGuard();
    const resolveDeliverableRepo = vi.fn(() => '/workspace/rune');
    const products = { rune: repoBackedProduct };

    expect(guardSingleProduct({ product: 'rune', bug }, { products, resolveDeliverableRepo })).toEqual({
      accepted: true,
      repoPath: '/workspace/rune',
    });
    expect(resolveDeliverableRepo).toHaveBeenCalledWith(bug, 'rune', products);
  });

  it('fails closed for an unknown product without asking the deliverable resolver', async () => {
    const { guardSingleProduct } = await loadGuard();
    const resolveDeliverableRepo = vi.fn(() => '/workspace/rune');

    expect(guardSingleProduct({ product: 'missing', bug }, {
      products: { rune: repoBackedProduct },
      resolveDeliverableRepo,
    })).toMatchObject({ accepted: false, reason: 'unknown-product' });
    expect(resolveDeliverableRepo).not.toHaveBeenCalled();
  });

  it('fails closed for a known projection-only product without asking the deliverable resolver', async () => {
    const { guardSingleProduct } = await loadGuard();
    const resolveDeliverableRepo = vi.fn(() => '/workspace/rune');

    expect(guardSingleProduct({ product: 'projection', bug }, {
      products: {
        projection: { ...repoBackedProduct, repoPath: '' },
      },
      resolveDeliverableRepo,
    })).toMatchObject({ accepted: false, reason: 'not-repo-backed' });
    expect(resolveDeliverableRepo).not.toHaveBeenCalled();
  });

  it('rejects a divergent deliverable repo as a policy decline instead of allowing a cross-product mutation', async () => {
    const { guardSingleProduct } = await loadGuard();

    expect(guardSingleProduct({ product: 'rune', bug }, {
      products: { rune: repoBackedProduct },
      resolveDeliverableRepo: () => '/workspace/another-product',
    })).toMatchObject({ accepted: false, reason: 'not-single-product' });
  });
});

describe('startFixRun dispatch handoff', () => {
  const input = {
    product: 'rune',
    bugId: bug.id,
    scope: {
      bug,
      facts: {
        itemEligible: true,
        fieldsComplete: true,
        pmAssessed: true,
        pmWellScoped: true,
        techLeadReviewed: true,
      },
    },
  };

  it('scaffolds on the selected product base branch and immediately dispatches orchestrated-work', async () => {
    const { startFixRun } = await loadStart();
    const deps = startDeps();

    await expect(startFixRun(input, deps)).resolves.toEqual({ accepted: true, runId: 'fix-run-123' });
    expect(deps.scaffoldAndCommitFixProject).toHaveBeenCalledWith({
      repoPath: '/workspace/rune',
      baseBranch: 'main',
      product: 'rune',
      bugId: bug.id,
      bug,
      facts: input.scope.facts,
    });
    expect(deps.createMutation).toHaveBeenCalledWith(
      'orchestrated-work',
      { projectSlug: '22-fix-bug-save-crash', product: 'rune' },
      'webview',
    );
    expect(mockLog.info).toHaveBeenCalledWith('fix run dispatched', {
      product: 'rune',
      projectSlug: '22-fix-bug-save-crash',
      runId: 'fix-run-123',
      dispatchKind: 'orchestrated-work',
    });
  });

  it('logs an accepted guard with a stable reason before preparing the fix project', async () => {
    const { startFixRun } = await loadStart();

    await startFixRun(input, startDeps());

    expect(mockLog.info).toHaveBeenCalledWith('fix run guard accepted', {
      product: 'rune',
      reason: 'single-product',
    });
  });

  it.each([
    ['unknown product', startDeps({ products: {} }), 'unknown-product'],
    ['projection-only product', startDeps({ products: { rune: { ...repoBackedProduct, repoPath: '' } } }), 'not-repo-backed'],
    ['divergent deliverable repo', startDeps({ resolveDeliverableRepo: () => '/workspace/another-product' }), 'not-single-product'],
  ])('returns the stable %s guard reason without scaffolding or dispatching', async (_case, deps, reason) => {
    const { startFixRun } = await loadStart();

    await expect(startFixRun(input, deps)).resolves.toEqual({ accepted: false, reason });
    expect(deps.scaffoldAndCommitFixProject).not.toHaveBeenCalled();
    expect(deps.createMutation).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith('fix run guard rejected', {
      product: 'rune',
      reason,
    });
  });

  it.each([
    [{ ok: false as const, reason: 'scaffold-failed' as const, detail: 'path conflict' }, 'scaffold-failed'],
    [{ ok: false as const, reason: 'commit-failed' as const, detail: 'base branch is not checked out' }, 'commit-failed'],
  ])('preserves the typed %s result and never dispatches after scaffold/commit failure', async (scaffoldResult, reason) => {
    const { startFixRun } = await loadStart();
    const deps = startDeps({ scaffoldAndCommitFixProject: vi.fn(async () => scaffoldResult) });

    await expect(startFixRun(input, deps)).resolves.toEqual({ accepted: false, reason, detail: scaffoldResult.detail });
    expect(deps.createMutation).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith('fix run scaffold rejected', {
      product: 'rune',
      reason,
      detail: scaffoldResult.detail,
    });
  });

  it.each([
    ['scaffold', startDeps({ scaffoldAndCommitFixProject: vi.fn(async () => { throw new Error('unexpected infrastructure crash'); }) })],
    ['dispatch', startDeps({ createMutation: vi.fn(async () => { throw new Error('unexpected infrastructure crash'); }) })],
  ])('propagates an unexpected %s crash as a throw instead of swallowing it as a decline', async (_case, deps) => {
    const { startFixRun } = await loadStart();

    await expect(startFixRun(input, deps)).rejects.toThrow('unexpected infrastructure crash');
  });

  it('turns a rejected orchestrated-work mutation into the stable dispatch-rejected result', async () => {
    const { startFixRun } = await loadStart();
    const deps = startDeps({ createMutation: vi.fn(async () => ({ ok: false as const, reason: 'orchestrated work disabled' })) });

    await expect(startFixRun(input, deps)).resolves.toEqual({
      accepted: false,
      reason: 'dispatch-rejected',
      detail: 'orchestrated work disabled',
    });
    expect(mockLog.warn).toHaveBeenCalledWith('fix run dispatch rejected', {
      product: 'rune',
      projectSlug: '22-fix-bug-save-crash',
      reason: 'dispatch-rejected',
      detail: 'orchestrated work disabled',
    });
  });
});
