import { describe, it, expect } from 'vitest';

/*
 * Test suite for scaffold-target resolution (09-expand-cockpit, Phase 4, written test-first).
 *
 * When a planning session is approved, the scaffolder must write into the TARGET PRODUCT's repo,
 * not always Jarvis's. `resolveScaffoldTarget(product, registry, productsConfig)` rejects unknown
 * products (absent from the registry) and non-repo-backed products (in the registry but
 * `repoBacked: false`) BEFORE the setup writer runs, and otherwise resolves the repoPath from
 * `policies/products.json`. `scaffoldWriteScope(repoPath)` produces the runAgent write-scope so the
 * agent gets REAL write access to the target repo (cwd + a single allowed directory), not just the
 * path in prompt text. Jarvis is just another registry/products entry — never a hard-coded default.
 *
 * "Test suite as deliverable": stays RED until the Phase 4 build lands `scaffold-target.ts`.
 */

import {
  resolveScaffoldTarget,
  scaffoldWriteScope,
  type ScaffoldTarget,
} from './scaffold-target.js';

// Minimal shapes the resolver needs (a real Registry / products.json map is assignable).
type RegistryLike = { products: Array<{ name: string; repoBacked: boolean }> };
type ProductsConfigLike = Record<string, { repoPath: string }>;

const REGISTRY: RegistryLike = {
  products: [
    { name: 'jarvis', repoBacked: true },
    { name: 'aura', repoBacked: true },
    { name: 'relay', repoBacked: false }, // tracked-only — no repo
  ],
};
// products.json only lists repo-backed products (relay is absent — it has no repo).
const CONFIG: ProductsConfigLike = {
  jarvis: { repoPath: '/home/u/workspace/jarvis' },
  aura: { repoPath: '/home/u/workspace/aura' },
};

function okTarget(t: ScaffoldTarget): { product: string; repoPath: string } {
  if (!t.ok) throw new Error(`expected ok, got error ${t.error}`);
  return { product: t.product, repoPath: t.repoPath };
}

describe('scaffold-target — resolveScaffoldTarget', () => {
  it("resolves a repo-backed product's repoPath from products.json", () => {
    expect(okTarget(resolveScaffoldTarget('aura', REGISTRY, CONFIG))).toEqual({
      product: 'aura',
      repoPath: '/home/u/workspace/aura',
    });
  });

  it('treats jarvis as a normal product — its repoPath comes from config, not a hard-coded default', () => {
    expect(okTarget(resolveScaffoldTarget('jarvis', REGISTRY, CONFIG)).repoPath).toBe(
      '/home/u/workspace/jarvis',
    );
  });

  it('reads the jarvis repoPath from the supplied config, not any constant (custom path proves no hardcode)', () => {
    const customReg: RegistryLike = { products: [{ name: 'jarvis', repoBacked: true }] };
    const customCfg: ProductsConfigLike = { jarvis: { repoPath: '/custom/elsewhere/jarvis' } };
    expect(okTarget(resolveScaffoldTarget('jarvis', customReg, customCfg)).repoPath).toBe(
      '/custom/elsewhere/jarvis',
    );
  });

  it('rejects an unknown product (absent from the registry) with unknown-product', () => {
    const t = resolveScaffoldTarget('nope', REGISTRY, CONFIG);
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error).toBe('unknown-product');
  });

  it('rejects a non-repo-backed product (registry repoBacked:false) before any dispatch', () => {
    const t = resolveScaffoldTarget('relay', REGISTRY, CONFIG);
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error).toBe('not-repo-backed');
  });

  it('rejects a repo-backed product missing from products.json as not-repo-backed (config gap, can\'t resolve a repo)', () => {
    const reg: RegistryLike = { products: [{ name: 'ghost', repoBacked: true }] };
    const t = resolveScaffoldTarget('ghost', reg, {});
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.error).toBe('not-repo-backed');
  });
});

describe('scaffold-target — scaffoldWriteScope (real write access, not prompt text)', () => {
  it('makes the target repo the cwd and the single writable directory', () => {
    const scope = scaffoldWriteScope('/home/u/workspace/aura');
    expect(scope.cwd).toBe('/home/u/workspace/aura');
    expect(scope.writableDirs).toEqual(['/home/u/workspace/aura']); // exactly the target repo — no broader scope
  });

  it('scopes writes to the target repo, not Jarvis — a different product gets a different scope', () => {
    const aura = scaffoldWriteScope('/home/u/workspace/aura');
    const jarvis = scaffoldWriteScope('/home/u/workspace/jarvis');
    expect(aura.cwd).not.toBe(jarvis.cwd);
    expect(aura.writableDirs).not.toEqual(jarvis.writableDirs);
  });
});
