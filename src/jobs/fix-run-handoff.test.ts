import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../intent/backlog-parser.js';
import type { ProductConfig } from './sandbox-runtime.js';

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
