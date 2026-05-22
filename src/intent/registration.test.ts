import { describe, it, expect, vi } from 'vitest';

/*
 * Test-first suite for test-plan.md §2 — product registration (08-intent-layer, Phase 1).
 *
 * Written BEFORE the registration implementation. `src/intent/registration.ts` currently
 * ships as a contract stub whose functions throw 'not implemented', so every test here is
 * RED. That is the intended, correct state: this is a "Tests (write first)" task — the
 * suite goes green when Phase 1's registration implementation tasks land. Do not implement
 * registration to make these pass; that is a separate task.
 */

import {
  planRegistration,
  planReconciliation,
  applyRegistration,
  type RegistrationEffects,
  type RegistrationInput,
  type RegistrationPlan,
  type ReconciliationInput,
} from './registration.js';

// --- Fixtures ---

/** A product that is entirely new — nothing exists for it yet. */
function unregistered(overrides: Partial<RegistrationInput> = {}): RegistrationInput {
  return {
    product: 'aura',
    repoPath: '/repos/aura',
    vaultFileExists: false,
    inRegistry: false,
    hasOverlayManifest: false,
    repoLinked: false,
    ...overrides,
  };
}

/** Spy effects for the apply step — async, matching the real I/O-backed writers. */
function spyEffects(): RegistrationEffects {
  return {
    createVaultFile: vi.fn().mockResolvedValue(undefined),
    addRegistryEntry: vi.fn().mockResolvedValue(undefined),
    createOverlayManifest: vi.fn().mockResolvedValue(undefined),
    linkRepo: vi.fn().mockResolvedValue(undefined),
  };
}

/** A complete registration plan literal — lets the apply tests stand on their own. */
function fullPlan(): RegistrationPlan {
  return {
    product: 'aura',
    executable: true,
    actions: [
      { kind: 'create-vault-file', path: 'projects/aura.md' },
      { kind: 'add-registry-entry', product: 'aura' },
      { kind: 'create-overlay-manifest', path: 'projects/overlays/aura.json' },
      { kind: 'link-repo', repoPath: '/repos/aura' },
    ],
  };
}

function actionKinds(plan: { actions: Array<{ kind: string }> }): string[] {
  return plan.actions.map((a) => a.kind);
}

describe('product registration — registering a product (test-plan §2)', () => {
  it('proposes creating the vault product file when it is missing', () => {
    const plan = planRegistration(unregistered());
    const create = plan.actions.find((a) => a.kind === 'create-vault-file');
    expect(create).toBeDefined();
    // The canonical declaration lives at projects/<product>.md.
    expect((create as { path: string }).path).toMatch(/projects\/aura\.md$/);
  });

  it('proposes adding the registry entry and creating the overlay manifest', () => {
    const plan = planRegistration(unregistered());
    expect(actionKinds(plan)).toEqual(
      expect.arrayContaining(['add-registry-entry', 'create-overlay-manifest']),
    );
  });

  it('links a code repo when one exists and marks the product executable', () => {
    const plan = planRegistration(unregistered());
    expect(plan.executable).toBe(true);
    const link = plan.actions.find((a) => a.kind === 'link-repo');
    expect(link).toBeDefined();
    expect((link as { repoPath: string }).repoPath).toBe('/repos/aura');
  });

  it('registers a product with no repo — still tracked, but not executable', () => {
    const plan = planRegistration(unregistered({ repoPath: null }));
    expect(plan.executable).toBe(false);
    expect(actionKinds(plan)).not.toContain('link-repo');
    // ...but it is still registered: vault file, registry entry, overlay manifest.
    expect(actionKinds(plan)).toEqual(
      expect.arrayContaining(['create-vault-file', 'add-registry-entry', 'create-overlay-manifest']),
    );
  });

  it('propose-and-approve: planning proposes, only an explicit apply performs the writes', async () => {
    const effects = spyEffects();
    const plan = planRegistration(unregistered());
    // After planning there is a proposal to show the user — but nothing has been applied.
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(effects.createVaultFile).not.toHaveBeenCalled();
    // Only a separate, post-approval applyRegistration call performs the writes.
    await applyRegistration(plan, effects);
    expect(effects.createVaultFile).toHaveBeenCalled();
  });

  it('does not re-create a vault file that already exists — only fills the missing pieces', () => {
    const plan = planRegistration(
      unregistered({ vaultFileExists: true, inRegistry: false, hasOverlayManifest: false }),
    );
    expect(actionKinds(plan)).not.toContain('create-vault-file');
    expect(actionKinds(plan)).toEqual(
      expect.arrayContaining(['add-registry-entry', 'create-overlay-manifest']),
    );
  });

  it('proposes nothing for an already fully-registered, repo-linked product', () => {
    const plan = planRegistration(
      unregistered({
        vaultFileExists: true,
        inRegistry: true,
        hasOverlayManifest: true,
        repoPath: '/repos/aura',
        repoLinked: true,
      }),
    );
    expect(plan.actions).toEqual([]);
  });

  it('names a concrete target on every proposed action, so the proposal is reviewable', () => {
    const plan = planRegistration(unregistered());
    for (const action of plan.actions) {
      const target =
        'path' in action ? action.path : 'repoPath' in action ? action.repoPath : action.product;
      expect(typeof target).toBe('string');
      expect(target.length).toBeGreaterThan(0);
    }
  });

  it('does not let a product name escape the projects/ directory', () => {
    const malicious = unregistered({ product: '../../world-view/convictions' });
    let plan: RegistrationPlan | undefined;
    let error: Error | undefined;
    try {
      plan = planRegistration(malicious);
    } catch (e) {
      error = e as Error;
    }
    if (error) {
      // Acceptable outcome: rejected outright with a clear error about the unsafe name.
      expect(error.message).toMatch(/invalid|unsafe|product name|slug/i);
    } else {
      // Otherwise: a plan was produced and its vault path stays inside projects/.
      const create = plan!.actions.find((a) => a.kind === 'create-vault-file') as
        | { path: string }
        | undefined;
      expect(create).toBeDefined();
      expect(create!.path).toMatch(/^projects\/[^/]+\.md$/);
    }
  });
});

describe('product registration — applying an approved plan (test-plan §2)', () => {
  it('performs exactly the actions in the plan, via the injected effects', async () => {
    const effects = spyEffects();
    await applyRegistration(fullPlan(), effects);
    expect(effects.createVaultFile).toHaveBeenCalledWith('projects/aura.md');
    expect(effects.addRegistryEntry).toHaveBeenCalledWith('aura');
    expect(effects.createOverlayManifest).toHaveBeenCalledWith('projects/overlays/aura.json');
    expect(effects.linkRepo).toHaveBeenCalledWith('/repos/aura');
  });

  it('does not touch the vault file when the plan has no create-vault-file action', async () => {
    const effects = spyEffects();
    const planWithoutVaultFile: RegistrationPlan = {
      product: 'aura',
      executable: false,
      actions: [{ kind: 'add-registry-entry', product: 'aura' }],
    };
    await applyRegistration(planWithoutVaultFile, effects);
    expect(effects.createVaultFile).not.toHaveBeenCalled();
    expect(effects.addRegistryEntry).toHaveBeenCalledWith('aura');
  });
});

describe('product registration — reconciliation pass (test-plan §2)', () => {
  /** A clean slate: nothing registered, nothing in the vault. */
  function emptyState(overrides: Partial<ReconciliationInput> = {}): ReconciliationInput {
    return {
      repos: [],
      journalMentions: [],
      registered: [],
      vaultFiles: [],
      overlayManifests: [],
      ...overrides,
    };
  }

  it('detects a repo with no vault product file and proposes the missing pieces', () => {
    const plans = planReconciliation(
      emptyState({ repos: [{ name: 'assay', path: '/repos/assay', looksLikeProduct: true }] }),
    );
    const assay = plans.find((p) => p.product === 'assay');
    expect(assay).toBeDefined();
    expect(actionKinds(assay!)).toContain('create-vault-file');
  });

  it('detects a journal-mentioned product absent from the registry', () => {
    const plans = planReconciliation(emptyState({ journalMentions: ['storytime'] }));
    expect(plans.some((p) => p.product === 'storytime')).toBe(true);
  });

  it('first pass proposes a vault product file for every product that lacks one', () => {
    const plans = planReconciliation(
      emptyState({
        repos: [
          { name: 'your-nanny', path: '/repos/your-nanny', looksLikeProduct: true },
          { name: 'storytime', path: '/repos/storytime', looksLikeProduct: true },
        ],
      }),
    );
    for (const product of ['your-nanny', 'storytime']) {
      const plan = plans.find((p) => p.product === product);
      expect(plan, `expected a plan for ${product}`).toBeDefined();
      expect(actionKinds(plan!)).toContain('create-vault-file');
    }
  });

  it('is idempotent — a second run with nothing missing proposes nothing', () => {
    const settled = emptyState({
      repos: [{ name: 'assay', path: '/repos/assay', looksLikeProduct: true }],
      journalMentions: ['assay'],
      registered: ['assay'],
      vaultFiles: ['assay'],
      overlayManifests: ['assay'],
    });
    expect(planReconciliation(settled)).toEqual([]);
  });

  it('does not propose a repo that is not clearly a product as an ordinary product', () => {
    const plans = planReconciliation(
      emptyState({
        repos: [{ name: 'agent-coding-setup', path: '/repos/agent-coding-setup', looksLikeProduct: false }],
      }),
    );
    const tooling = plans.find((p) => p.product === 'agent-coding-setup');
    // Either excluded entirely, or surfaced only for explicit confirmation — never
    // registered outright as an ordinary product.
    expect(tooling === undefined || tooling.needsProductConfirmation === true).toBe(true);
  });
});
