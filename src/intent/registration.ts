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
 * STATUS: contract stub. The type surface and signatures below are the contract pinned by
 * the test-first suite in `registration.test.ts` (test-plan.md §2). The function bodies
 * are intentionally unimplemented — Phase 1's registration tasks fill them in. Until then
 * the suite is RED by design.
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
  /** Absolute path of the product's code repo, or null when it has none. */
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

const NOT_IMPLEMENTED =
  'registration: not implemented — Phase 1 registration tasks (docs/projects/08-intent-layer) fill this in';

/**
 * Compute the registration plan for a product. Pure — it computes what *would* change and
 * never writes. Applying the plan is a separate, post-approval step (`applyRegistration`).
 * The plan omits any action whose target already exists, so registering an
 * already-present product only fills the missing pieces. A `product` name that would
 * escape the `projects/` directory is rejected.
 */
export function planRegistration(_input: RegistrationInput): RegistrationPlan {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Detect product drift and propose the missing pieces — one plan per product that needs
 * registration work (a repo with no vault file, a journal-mentioned product absent from
 * the registry, and so on). Idempotent: when nothing is missing it proposes nothing
 * (`[]`). A repo that does not look like a product is excluded, or surfaced with
 * `needsProductConfirmation` rather than registered outright.
 */
export function planReconciliation(_input: ReconciliationInput): RegistrationPlan[] {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Apply an approved registration plan: perform every action via the injected effects.
 * Runs only after the user approves — the propose-and-approve gate is the boundary
 * between planning and applying.
 */
export async function applyRegistration(
  _plan: RegistrationPlan,
  _effects: RegistrationEffects,
): Promise<void> {
  throw new Error(NOT_IMPLEMENTED);
}
