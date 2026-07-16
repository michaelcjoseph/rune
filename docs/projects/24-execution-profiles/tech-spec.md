# Tech Spec — Cockpit Execution Profiles

## Architecture

Profiled execution is a lifecycle, not only a new configuration field:

`resolve configuration → validate and snapshot profile → preflight capabilities → create worktree → provision → QA/coding → select required checks → acquire operation resources → validate → persist evidence → closeout`

A busy resource branches into a cancellable FIFO wait and resumes at the managed operation. A missing or unusable capability branches into durable `blocked-environment` before the first agent dispatch.

**Both runner paths honor profiles** — the legacy `work-runner` and the orchestrated `orchestrated-work-runner`. The lifecycle hooks in at their shared stages; "before QA dispatch" generalizes to "before the first agent dispatch" (QA in orchestrated runs, the work agent in legacy runs). Enabling a profile does not require `orchestratedMode`.

Legacy products continue through the existing path.

## Core data contracts

```ts
type NetworkMode =
  | "offline"
  | "local-fake"
  | "approved-egress"
  | "manual-live";

type Tier = "fast" | "native-compile" | "simulator" | "manual-live";

interface CommandSpec {
  id: string;
  argv: [string, ...string[]];
  cwd?: string; // contained, worktree-relative
  env?: Record<string, string>;
  network: NetworkMode;
  timeoutMs?: number;
  resources?: ResourceRequirement[];
}

interface ToolchainRequirement {
  kind: string;
  version: string;
  versionProbe: [string, ...string[]];
  packageManager?: { name: string; version?: string };
}

interface ProvisionStep {
  id: string;
  provisioner: string;
  config?: unknown;
  network: Exclude<NetworkMode, "manual-live">;
  resources?: ResourceRequirement[];
}

interface ValidationCheck extends CommandSpec {
  required: boolean;
  tier: Tier;
  artifacts?: ArtifactSpec[];
  retry?: { attempts: 1 | 2; reasons: ("timeout" | "known-flake")[] };
}

interface TierSelector {
  tier: Tier;
  changedPathGlobs?: string[];
  flowTags?: string[];
  always?: boolean;
}

interface ExecutionProfile {
  profileVersion: 1;
  toolchains: ToolchainRequirement[];
  env?: { required: string[]; optional?: string[] };
  provisioning: { steps: ProvisionStep[] };
  setup?: CommandSpec[];
  validation: {
    selectors: TierSelector[];
    checks: ValidationCheck[];
  };
}

interface ResolvedProfileSnapshot {
  profile: ExecutionProfile;
  profileHash: string;
  productId: string;
  resolvedAt: string;
}
```

The validator rejects:

- string commands, empty argv, absolute or escaping cwd values;
- duplicate IDs and references to unknown resources, checks, or tiers;
- `approved-egress` validation checks;
- automatic `manual-live` commands;
- `required: true` on a manual-live-tier check (manual-live checks are release items,
  never autonomous acceptance — this closes the contradiction between "selected required
  checks cannot be skipped" and "manual-live is never auto-executed");
- selectors that can leave the mandatory fast tier unselected;
- artifact paths outside the declared run artifact root;
- invalid lease scope or unsupported profile versions.

Each run persists its resolved snapshot before preflight. Recovery reads the snapshot, not current `products.json`.

## Repository identity and scope

`canonicalRepoId(repoPath)` resolves `git rev-parse --git-common-dir`, converts relative results against the repository, realpaths the common directory, and produces a stable internal identifier. Logs and user surfaces receive a scrubbed identifier rather than the host path.

The base-branch key is `(canonicalRepoId, baseBranch)`. All acquisition sites and the concurrent-run gate fact use the same helper.

Branch product components are normalized and collision-checked. Legacy branch lookup is read-compatible, while new writes use the namespaced form.

Scope validation compares committed and staged changes against the correct merge base. It handles additions, deletions, renames, submodules, and symlinks. `scopeRoots` are validated relative patterns; matching the link name is insufficient when a written symlink resolves outside the permitted root.

`scopeRoots` and the existing `scopePath` stay distinct: `scopePath` scopes the working directory a run operates in (e.g. writing's `docs/rune`); `scopeRoots` validates what a run may change. A product with `scopePath` and no `scopeRoots` defaults its scope roots to that subtree.

## Lease scheduler

```ts
type LeaseType =
  | "base-branch"
  | "ios-simulator"
  | "android-emulator"
  | "port-range"
  | "build-capacity"
  | "cache-dir"
  | "device";

interface LeaseRequest {
  type: LeaseType;
  key: string;
  holder: { runId: string; operationId: string };
  signal: AbortSignal;
  waitTimeoutMs?: number;
}

interface LeaseSnapshot {
  resource: { type: LeaseType; key: string; capacity: number };
  holders: LeaseParty[];
  waiters: Array<LeaseParty & { position: number; waitingSince: string }>;
}
```

The scheduler is FIFO per resource key and supports capacities greater than one for build capacity. Acquisition returns a handle with idempotent release. `withLease` releases on success, exception, abort, or timeout.

Lease ownership is intentionally process-local. Run records persist waiting metadata for diagnostics, not ownership. On restart:

1. pre-restart holders are discarded;
2. owned child processes and temporary resources are reaped by existing recovery mechanisms;
3. waiting or resumable runs re-enter normal acquisition;
4. resource probes determine whether the resource still exists;
5. missing resources become `blocked-environment`.

Base-branch leases cover shared base-branch operations, including integration/finalization. Simulator, emulator, cache, port, and capacity leases cover only the provision step or validation check that declares them.

A queued run is not blocked. Cancellation removes its waiter immediately and updates supervision.

## Preflight

Preflight runs before the first agent dispatch (QA in orchestrated runs, the work agent in legacy runs) and returns:

```ts
type PreflightResult =
  | { ok: true; probes: ProbeEvidence[] }
  | {
      ok: false;
      blocked: {
        kind: "environment";
        missing: MissingDependency[];
        probes: ProbeEvidence[];
      };
    };
```

Preflight checks:

- command-resolved tool versions;
- required environment-variable presence, logging names only;
- offline cache or prebuilt environment existence;
- SDK, simulator/emulator image, and device existence;
- configured resource capacity;
- platform network-enforcement capability;
- approved-egress broker readiness when required.

It does not require a resource to be idle. Resource contention is handled by lease acquisition later.

`blocked-on-environment` and `blocked-environment` are added to all status/outcome persistence and presentation unions in one change — its own deliverable (blocked-environment-status-unions), landed before the probe engine. The unions in play today: `WorkOutcome`, `WorkRunOutcome`, `StoredWorkRunOutcome`, `SupervisedRunStatus`, `CockpitRunStatus`, `BusRunOutcome`, and the run-feed client mirrors. Unknown stored future members remain fail-closed and render as an actionable unavailable state rather than throwing.

## Command and process execution

Profile commands call the argv executor directly. The executor:

- resolves executables through the controlled toolchain path;
- contains cwd under the worktree;
- applies the validation-isolation environment plus a permitted overlay;
- creates a process group and reaps it through SIGKILL on timeout;
- captures bounded stdout/stderr;
- records start and finish timestamps, exit code, timeout, and resolved versions;
- logs the underlying failure at its catch point;
- never invokes a shell or whitespace-splits input.

Legacy string validation remains isolated to the legacy path.

## Network enforcement

Validation checks may use only `offline` or `local-fake`.

**Pinned loopback boundary (decision):** both modes deny external networking, and both permit loopback **except** the protected ports 3847/3848, which are denied per-port in the generated Seatbelt profile. Per-port loopback *allowlisting* is explicitly not claimed: validation children legitimately bind ephemeral self-owned test servers (`listen(0)`), which no per-port allowlist can express. This softens the earlier "only declared endpoints" wording; the softening is an accepted, documented posture (single-user host), recorded in context.md Known Risks. Package-manager offline flags are defense in depth, not the enforcement boundary.

`local-fake` additionally provisions declared run-owned fake endpoints on ports from a minimal run-scoped allocator (Phase 2), which excludes 3847/3848 and is generalized into the port-range lease type in Phase 4. Declared endpoints are recorded as run facts.

A platform capability probe is the first deliverable of enforcement: it proves the host Seatbelt can express per-port loopback denials alongside `(allow … localhost:*)`. If the host mechanism cannot distinguish protected services, preflight blocks instead of weakening policy. (Non-macOS hosts have no enforcement mechanism today and always fail this probe.)

`approved-egress` is valid only for named setup or provisioning steps. The child has no direct external access. It communicates with a local supervised broker, which performs allowlist checks and records timestamp, step ID, destination host/port, decision, and byte counts. It never logs credentials, request bodies, response bodies, or proxy authorization.

**The broker reuses the existing egress layer** rather than adding a second allowlist: the per-product `egressAllowlist` in `policies/products.json`, evaluated through `isEgressAllowed` (`src/intent/sandbox.ts`). The same change flips `EGRESS_ENFORCEMENT_MODE` (`src/jobs/egress-policy.ts`) from `'documented-gap'` to its enforced mode for brokered steps and updates the `checkEgress` call-site docs and the project-08 deferral note.

`manual-live` produces a persisted release item in the run record (surfaced in the cockpit by the closeout gate) and is never spawned by autonomous execution.

## Provisioners

```ts
interface Provisioner {
  kind: string;
  cacheKey(
    profile: ResolvedProfileSnapshot,
    repoState: RepoState
  ): Promise<string>;
  provision(ctx: ProvisionContext): Promise<ProvisionOutcome>;
  cleanup(ctx: ProvisionContext): Promise<void>;
}
```

Provisioning has explicit stages: resolve, acquire resources, execute, verify, record, cleanup/release. Every terminal outcome records duration, cache status, log reference, tool versions, and input hashes.

Node modes:

- `link`: current symlink behavior where safe;
- `copy`: current copy-on-write behavior for frameworks requiring it;
- `install`: verified offline package-manager installation.

Python source order:

1. compatible prebuilt environment;
2. verified uv cache in offline mode;
3. brokered audited bootstrap.

iOS uses Podfile.lock and Xcode version in its key and holds a cache-dir lease around derived-data mutation. Android keys from wrapper, lock inputs, Java, and SDK versions and leases its build cache.

Missing prerequisites detected before execution are environment blocks. A provisioner command failing after valid preflight is a provisioning failure.

**Mid-run dependency changes (decision):** provisioning runs once, before QA/coding; coder agents may change dependencies during the run (their own network posture is unaffected by check network modes). Validation runs against the worktree as it stands at closeout. The provisioner records input hashes (lockfile, toolchain versions) at provision time, evidence records them at validation time, and drift is persisted as a run fact included in closeout evidence — never silently re-provisioned.

## Tier selection

Tier selection consumes the profile snapshot plus deterministic run facts:

- normalized changed paths, including renames;
- explicit flow tags supplied when the task is created.

It never consumes agent narration.

Flow tags are **net-new** — no task-tag concept exists today. The plumbing (tech-lead sizing output → planning-artifact serialization → run record → selection facts) is its own Phase 4 deliverable (flow-tag-plumbing); the schema accepts `flowTags` selectors from Phase 2.

`fast` is mandatory for all Aura runs. Native path selectors require both iOS and Android compile tiers unless the profile explicitly declares a platform-specific scope. User-visible flow tags require simulator checks. Selected required checks cannot be skipped by reviewer choice or legacy closeout strategy. A selected manual-live check (always `required: false` by validation) becomes a persisted release item, never evidence, and is excluded from required coverage.

Selection results are persisted with their input facts and included in closeout evidence.

## Evidence and artifacts

```ts
interface CheckEvidence {
  schemaVersion: 1;
  checkId: string;
  tier: Tier;
  attempt: number;
  argv: string[];
  cwd: string; // scrubbed relative form
  network: NetworkMode;
  toolVersions: Record<string, string>;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  artifactPaths: string[];
  startedAt: string;
  finishedAt: string;
}
```

Evidence is written atomically under the run directory. Before persistence:

- output passes secret and absolute-path scrubbing;
- tails, record size, artifact count, and artifact bytes are bounded;
- artifact paths are realpath-contained under a run-owned artifact root;
- missing, symlink-escaping, special-device, and oversized artifacts are rejected.

The cockpit API requires existing authentication and serves artifacts through containment checks; it does not expose raw filesystem paths.

Closeout validates evidence schema and selected-check coverage. Missing, corrupt, skipped, timed-out, or unsuccessful required records fail closeout. An allowed simulator retry creates two records; it never overwrites the first attempt.

Retention: the evidence-retention-gc deliverable extends the existing count/bytes work-run GC to evidence records and artifact bytes. GC never touches an active or parked run's evidence, and deletes artifacts and their records together.

## Cockpit behavior

Blocked-environment presentation includes dependency kind, wanted/found values, and remediation without environment values or host paths.

Evidence presentation includes the selected tier, check, attempt, argv, status, duration, tool versions, and safe artifact link.

Lease presentation includes resource type/key, holder, ordered waiters, wait duration, and cancellation/recovery state. Active-run projection correlates waiters to runs and displays `waiting on <resource>`. A minimal form of this indicator ships with the Phase 1 lease-lifecycle integration (queueing must never be operator-invisible); the full per-resource panel lands in Phase 4. This does not add a terminal run status.

UI tests use server-rendered fixtures and browser interactions on ephemeral ports. They never stop or connect to the live Rune daemons.

## Fixtures and acceptance

Fixtures are immutable templates materialized into isolated temporary git repositories. A generated products configuration points Rune to those repositories without mutating production configuration.

Acceptance layers are:

1. Unit and integration tests for parsers, selection, scheduling, containment, execution, provisioning, evidence, and UI.
2. Environment-gated fixture acceptance using real toolchains and provisioners. Missing native prerequisites fail the gate explicitly.
3. Manual production verification for actual products.

The parallel acceptance run uses real load-bearing components. Two runs target one canonical repository/base branch, and two simulator operations target one simulator key. Assertions cover FIFO wait visibility, eventual progress, cancellation cleanup, evidence-backed completion, and a forced environment block.

## Migration and repository ownership

Brand, Assay, and Aura each have separate implementation, migration-runbook, and live-verification tasks — every manual-effort task is split into an automatable runbook task (authored into `manual/`) plus a `manual-live-gate` that assumes the runbook's steps are complete. Any required modification in an external repository is authored on a reviewable branch there and enumerated in the runbook for operator review and merge; Rune-side policy changes do not silently stand in for those changes.

**relay and writing** are not migrated in-project; they follow the documented per-product procedure after release. The Phase 1 rekey and queueing behavior apply to them immediately (writing shares Brand's repository) and are observed via the release gate's collision proof.

Legacy behavior remains until a product profile is enabled. Rollback disables that product's profile and restores the legacy path without rewriting existing run snapshots; each migration runbook includes the product's rollback steps.

## Roles and review markers

A new **security** product-team role lands in Phase 1 (security-role-integration): `agents/security/` SOUL + memory, `RoleName` extension, a `securityNeeded` sizing flag serialized as the `_(security review)_` marker in tasks.md, and a security review gate in `team-task-workflow` wired parallel to the designer flag. Security-tagged tasks (scope gate, executor, network enforcement, egress broker, custom hooks, evidence store/API, Python provisioner) must not be dispatched before it lands.

## Documentation and operational constraints

New modules, scripts, configuration, and product commands require the repository's docs-sync workflow. Documentation must describe:

- schema and examples;
- profile snapshot and recovery semantics;
- network guarantees and platform prerequisites;
- provisioner development;
- evidence retention and security;
- lease cancellation and stale-holder remediation;
- fixture setup and native acceptance prerequisites;
- per-product migration and rollback.

No task may bind, kill, stop, or reuse ports 3847 or 3848. No cleanup routine may terminate a process or mobile resource it did not create or explicitly lease.