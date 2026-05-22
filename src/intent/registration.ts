/**
 * Product registration — the propose-and-approve flow that brings a product into the
 * system. To register a product the intent layer creates its vault product file
 * (`projects/<product>.md`, the canonical declaration), adds a registry entry, creates
 * the product-overlay manifest, and links a code repo if one exists. A product with no
 * repo is still registered and tracked — just marked not-executable.
 *
 * Registration writes to the vault, so it is Regime A, **propose-and-approve**: planning
 * computes what *would* change (`planRegistration` / `planReconciliation`) and never
 * writes; only an explicit, post-approval `applyRegistration` performs the actions.
 *
 * The contract is pinned by the test-first suite in `registration.test.ts` (test-plan.md §2).
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Product registration"), test-plan.md (§2)}.
 */

/** One concrete change a registration would make, shown to the user before approval. */
export type RegistrationAction =
  | { kind: 'create-vault-file'; path: string }
  | { kind: 'add-registry-entry'; product: string }
  | { kind: 'create-overlay-manifest'; path: string }
  | { kind: 'link-repo'; repoPath: string };

/** The propose half of propose-and-approve: everything registering a product would do. */
export interface RegistrationPlan {
  product: string;
  /** True when the product has a code repo (executable); false when tracked-only. */
  executable: boolean;
  /** Ordered actions; empty when the product is already fully registered. */
  actions: RegistrationAction[];
  /**
   * Set when the source is a repo that does not clearly look like a product (e.g. tooling
   * such as `agent-coding-setup`) — the plan is surfaced for explicit confirmation rather
   * than applied as an ordinary registration.
   */
  needsProductConfirmation?: boolean;
}

/** Current known state of a product — the input to planning a registration. */
export interface RegistrationInput {
  product: string;
  /**
   * Absolute path of the product's code repo, or null when it has none. The orchestration
   * layer must validate this path is within the workspace before wiring the `linkRepo`
   * effect to a real implementation — this pure module forwards it verbatim.
   */
  repoPath: string | null;
  /** Whether `projects/<product>.md` already exists in the vault. */
  vaultFileExists: boolean;
  /** Whether the product already has a registry entry. */
  inRegistry: boolean;
  /** Whether the product already has an overlay manifest. */
  hasOverlayManifest: boolean;
  /** Whether the product's repo (if any) is already linked. Ignored when `repoPath` is null. */
  repoLinked: boolean;
}

/** A repo discovered on disk during a reconciliation scan. */
export interface DiscoveredRepo {
  name: string;
  path: string;
  /** Whether the repo looks like a real product (vs. tooling like `agent-coding-setup`). */
  looksLikeProduct: boolean;
}

/** Everything a reconciliation pass scans — the input to detecting product drift. */
export interface ReconciliationInput {
  /** Repos discovered on disk. */
  repos: DiscoveredRepo[];
  /**
   * Product names mentioned in recent journals, normalized to kebab-case so they match
   * `DiscoveredRepo.name` and registry product names directly.
   */
  journalMentions: string[];
  /** Products that already have a registry entry. */
  registered: string[];
  /** Products that already have a vault product file. */
  vaultFiles: string[];
  /** Products that already have an overlay manifest. */
  overlayManifests: string[];
}

/**
 * The side effects of applying a registration plan, injected so the apply step is
 * decoupled from the vault, registry, and overlay modules. The orchestration layer wires
 * these to the real writers; tests pass spies. Async because the real writers do I/O
 * (vault file writes, iCloud-synced).
 */
export interface RegistrationEffects {
  createVaultFile(path: string): Promise<void>;
  addRegistryEntry(product: string): Promise<void>;
  createOverlayManifest(path: string): Promise<void>;
  linkRepo(repoPath: string): Promise<void>;
}

/**
 * Whether a product name is a valid lowercase slug — 1–64 chars, no path separators and no
 * traversal segments, so it can never escape the `projects/` directory as a vault path.
 */
function isValidProductName(product: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(product);
}

/** Throw a clear error when a product name is not a valid slug (see `isValidProductName`). */
function assertValidProductName(product: string): void {
  if (!isValidProductName(product)) {
    throw new Error(
      `invalid product name '${product}' — must be a lowercase slug, 1–64 chars, ` +
        'starting with a letter or digit and containing only [a-z0-9-]',
    );
  }
}

/**
 * Compute the registration plan for a product. Pure — it computes what *would* change and
 * never writes. Applying the plan is a separate, post-approval step (`applyRegistration`).
 * The plan omits any action whose target already exists, so registering an
 * already-present product only fills the missing pieces. A `product` name that would
 * escape the `projects/` directory is rejected.
 */
export function planRegistration(input: RegistrationInput): RegistrationPlan {
  assertValidProductName(input.product);
  const actions: RegistrationAction[] = [];
  if (!input.vaultFileExists) {
    actions.push({ kind: 'create-vault-file', path: `projects/${input.product}.md` });
  }
  if (!input.inRegistry) {
    actions.push({ kind: 'add-registry-entry', product: input.product });
  }
  if (!input.hasOverlayManifest) {
    actions.push({ kind: 'create-overlay-manifest', path: `projects/overlays/${input.product}.json` });
  }
  if (input.repoPath !== null && !input.repoLinked) {
    actions.push({ kind: 'link-repo', repoPath: input.repoPath });
  }
  return { product: input.product, executable: input.repoPath !== null, actions };
}

/**
 * Detect product drift and propose the missing pieces — one plan per product that needs
 * registration work (a repo with no vault file, a journal-mentioned product absent from
 * the registry, and so on). Idempotent: when nothing is missing it proposes nothing
 * (`[]`). A repo that does not look like a product is excluded, or surfaced with
 * `needsProductConfirmation` rather than registered outright.
 */
export function planReconciliation(input: ReconciliationInput): RegistrationPlan[] {
  const { repos, journalMentions, registered, vaultFiles, overlayManifests } = input;
  const reposByName = new Map(repos.map((repo) => [repo.name, repo]));
  // Every candidate product, from discovered repos and journal mentions, de-duplicated.
  const candidates = new Set<string>([...reposByName.keys(), ...journalMentions]);

  const plans: RegistrationPlan[] = [];
  for (const product of candidates) {
    // A candidate whose name is not a valid slug is skipped, not crashed on.
    if (!isValidProductName(product)) continue;
    const repo = reposByName.get(product);
    // Reconciliation has no finer signal than the registry entry, so a registered
    // product's repo is treated as already linked. This can miss a registered product
    // whose repo link was later dropped, but it never proposes a spurious link-repo
    // action — a future ReconciliationInput.linkedRepos field would close the gap.
    const isRegistered = registered.includes(product);
    const plan = planRegistration({
      product,
      repoPath: repo ? repo.path : null,
      vaultFileExists: vaultFiles.includes(product),
      inRegistry: isRegistered,
      hasOverlayManifest: overlayManifests.includes(product),
      repoLinked: isRegistered,
    });
    // Nothing missing — idempotent: a settled product proposes nothing.
    if (plan.actions.length === 0) continue;
    // A repo that does not clearly look like a product is surfaced for confirmation
    // rather than registered outright.
    if (repo && !repo.looksLikeProduct) plan.needsProductConfirmation = true;
    plans.push(plan);
  }
  return plans;
}

/**
 * Apply an approved registration plan: perform every action via the injected effects.
 * Runs only after the user approves — the propose-and-approve gate is the boundary
 * between planning and applying. Effects run sequentially; a rejection halts the rest.
 * Re-applying a partially-applied plan is safe only when every `RegistrationEffects`
 * implementation is idempotent.
 */
export async function applyRegistration(
  plan: RegistrationPlan,
  effects: RegistrationEffects,
): Promise<void> {
  for (const action of plan.actions) {
    switch (action.kind) {
      case 'create-vault-file':
        await effects.createVaultFile(action.path);
        break;
      case 'add-registry-entry':
        await effects.addRegistryEntry(action.product);
        break;
      case 'create-overlay-manifest':
        await effects.createOverlayManifest(action.path);
        break;
      case 'link-repo':
        await effects.linkRepo(action.repoPath);
        break;
      default: {
        const exhaustive: never = action;
        throw new Error(`applyRegistration: unhandled action kind ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}
