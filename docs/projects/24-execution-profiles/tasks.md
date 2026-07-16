# Cockpit Execution Profiles: Real Acceptance Environments for Every Product — Tasks

Not started. See [spec.md](spec.md) for architecture and [test-plan.md](test-plan.md) for verification.

> **Test-first by default.** QA authors required tests at the start of each code task
> before coder work. Each task lands green before closeout; test strategy is tracked
> per task and mirrored in [test-plan.md](test-plan.md).
>
> Granularity here is the meaningful deliverable — not a granular sub-task. Per-task file
> layout, schemas, and signatures are settled in `/work`'s Plan phase, against the spec.
>
> **Manual-effort split.** Every task that needs operator action is split in two: an
> automatable task that authors a step-by-step runbook into
> [`manual/`](manual/README.md), then a `manual-live-gate` task that assumes those steps
> are complete and closes only on persisted evidence. No gate may be dispatched before
> its runbook task has landed.
>
> **Security review marker.** Tasks tagged `_(security review)_` receive a security-role
> review of the implementation diff as a closeout gate. The role, its marker parsing, and
> its workflow wiring are created by **security-role-integration** (Phase 1); that task
> must land before any security-tagged task is dispatched.

## Phase 1 — Repository identity, locking, and the security role

> Depends on: nothing.

### Implementation

- [ ] **repo-identity-lock-rekey** — Add canonical repository identity resolution using the realpath of git-common-dir, with a deterministic realpath(repoPath) fallback, and rekey every base-branch lock acquisition and concurrent-run fact from product/baseBranch to repoId/baseBranch. Acquisition sites span `work-runner.ts`, `orchestrated-work-runner.ts`, `work-run-release.ts`, and `recovery-finalize-runner.ts` (`withBaseBranchLock` + each runner's `hasConcurrentRun`); all must use one shared helper. Tests prove products sharing a repository contend (rune/rune-mcp; writing/brand) and distinct repositories do not.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **resource-lease-scheduler** — Introduce a typed FIFO resource-lease scheduler with holder and waiter identity, cancellation, bounded wait policies, release-on-throw, structured wait/grant/release logging, and read-only introspection. Wrap the canonical base-branch lock as the first lease type without changing the global concurrency cap. Tests cover FIFO order, cancellation, timeout, release-on-throw, and observable waiters.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **lease-lifecycle-recovery** — Integrate leases with run cancellation, supervision, restart recovery, and terminal cleanup. Persist waiting metadata in the run record while keeping in-process lease ownership authoritative; after restart, waiting runs must safely reacquire or become actionable blocked-environment results when the underlying resource no longer exists. Surface a minimal "waiting on \<resource\>" indicator in the active-run projection and run feed from the persisted waiting metadata, so queueing is operator-visible from Phase 1 (the full lease-queue panel lands in Phase 4). Tests prove cancelled and crashed runs leave no holder, stale waiting metadata clears, recovered runs do not bypass FIFO acquisition, and the waiting indicator renders.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **work-branch-namespacing** — Namespace new work branches as rune-work/<sanitized-product>/<project>. Preserve resumability of legacy rune-work/<project> branches, reject namespace collisions after sanitization, and keep GC safe for both shapes. Tests cover creation, collision rejection, legacy resume, and GC.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **security-role-integration** — Create the security product-team role so the security-review task marker is dispatchable: `agents/security/` SOUL and memory scaffold, extend `RoleName` in `src/roles/loader.ts`, add a `securityNeeded` flag to `SizedTask` parallel to `designerNeeded` (tech-lead sizing output, planning-artifact serialization of the marker, and re-parse — the marker literal is the italic "security review" tag used by later tasks in this file; marker detection must match only the trailing task-line tag, never a mention inside description prose), wire a security review gate into `team-task-workflow` invoked for flagged tasks, and add a model-policy entry. Tests cover loader round-trip, marker serialize/parse, workflow invocation on flagged tasks, and non-invocation on unflagged tasks.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **scope-boundary-gate** — Add validated scopeRoots to ProductConfig, derive changed paths against the correct merge base, reject traversal and symlink escapes, and fail closed with a machine-readable scope-violation gate result containing scrubbed offending relative paths. Reconcile with the existing `scopePath` field: the two stay distinct (working-directory scoping vs change validation); a product with `scopePath` and no `scopeRoots` defaults to that subtree; explicit `scopeRoots` are validated relative patterns. Update every consumer that branches on or renders `GateFailReason` — note no exhaustive switches exist today (reasons flow through alert callbacks and `gateHeldReason` strings), so the deliverable is proving the new member renders meaningfully end to end, not hunting for switch statements. Test allowed changes, violations, renames, deletions, symlinks, scopePath defaulting, and the new union member. _(security review)_
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, security, reviewer

## Phase 2 — Profile schema, preflight, evidence, and Node profiles

> Depends on: Phase 1.

### Implementation

- [ ] **execution-profile-schema** — Land the versioned executionProfile parser and types, including argv-only commands, toolchains, required environment-variable names, provision steps, validation checks, network policy, resource references, artifacts, and declarative tier selectors for changed paths and flow tags. Provision steps and checks must declare the resources they acquire and their lease scope. The validator rejects `required: true` on a manual-live-tier check (manual-live checks are release items, never autonomous acceptance). Persist the fully resolved profile and a stable hash in each run so configuration changes cannot alter an in-flight or recovered run. Products without a profile retain legacy behavior. Tests cover complete parsing, invalid references/selectors, string-command rejection, unknown versions, required-manual-live rejection, snapshot round-trip, and legacy fallback.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **argv-command-executor** — Make runValidationCommandArgv the single executor for profile commands, supporting relative contained cwd, scrubbed environment overlays, timeout and process-group reaping, bounded output capture, tool-version capture, and structured start/terminal/failure logging. Profile paths must never use whitespace splitting. Tests cover argv fidelity, cwd and environment containment, timeout reaping, output bounds, and failure logging. _(security review)_
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, security, reviewer
- [ ] **network-mode-enforcement** — Enforce phase-aware network policy at command execution under the pinned loopback boundary: offline and local-fake both deny external networking and both permit loopback **except** protected ports 3847/3848, which are denied per-port in the generated Seatbelt profile (per-port loopback *allowlisting* is explicitly not claimed — self-binding ephemeral test servers make it unenforceable; see spec.md "Network policy"). local-fake additionally provisions declared run-owned fake endpoints on ports from a minimal run-scoped allocator excluding 3847/3848 (generalized into full port-range lease types in Phase 4) and records them as run facts. The first deliverable is a platform capability probe proving the host Seatbelt can express per-port loopback denials; hosts where it cannot fail preflight rather than degrading to package-manager flags. approved-egress remains restricted to named setup/provision steps; manual-live is never auto-executed. Tests cover policy rejection, environment scrubbing, protected-port denial, allocator exclusions, and enforcement-capability failure. _(security review)_
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, security, reviewer
- [ ] **approved-egress-broker** — Implement approved egress for setup and provisioning through a supervised broker: the sandboxed child may reach only the local broker, direct external networking remains denied, and the broker permits only the product's allowlist while recording destination metadata without credentials or payloads. The broker consumes the **existing** per-product `egressAllowlist` (`policies/products.json`) through `isEgressAllowed` (`src/intent/sandbox.ts`) rather than introducing a second allowlist, and the same change flips `EGRESS_ENFORCEMENT_MODE` in `src/jobs/egress-policy.ts` from `'documented-gap'` to its enforced mode for brokered steps, updating the `checkEgress` call-site documentation and the deferral note it points to. Denied destinations fail with actionable evidence. Tests use local fake upstreams and prove allowlist enforcement, direct-network denial, audit redaction, cleanup, timeout behavior, and the mode flip. _(security review)_
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, security, reviewer
- [ ] **blocked-environment-status-unions** — Add the `blocked-environment` outcome and `blocked-on-environment` supervision status across every status/outcome union in one change: `WorkOutcome`, `WorkRunOutcome`, `StoredWorkRunOutcome`, `SupervisedRunStatus`, `CockpitRunStatus`, `BusRunOutcome`, and the run-feed client mirrors, plus their persistence, bus, feed, and cockpit consumers. Unknown stored future members remain fail-closed and render as an actionable unavailable state rather than throwing. Tests cover union totality per consumer, restart round-trip, and fail-closed unknown-member rendering.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **preflight-probe-engine** — Run preflight after resolving and snapshotting the profile but before the first agent dispatch in **both** runner paths (before QA dispatch in `orchestrated-work-runner`, before the work agent in the legacy `work-runner`; see the runner-integration decision in context.md). Probe tool versions, required environment-variable presence, cache/image/resource existence, and network-enforcement capability. A busy but existing resource must remain queued and must not become blocked; missing or unusable resources produce the durable blocked-environment outcome from blocked-environment-status-unions, with remediation. Tests cover probe evidence, both dispatch paths, queued-vs-blocked classification, and restart round-trip.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **provisioning-phase-node-provisioner** — Introduce the managed Provisioner interface and registry with deterministic cache keys, contained logs, timeouts, process cleanup, verification, and reproducibility metadata. Move Node link/copy/install behavior behind the Node provisioner for profiled runs while preserving the legacy path. Install mode must operate offline from a verified cache or block during preflight. Record provisioning input hashes (lockfile, toolchain versions) at provision time so closeout can detect mid-run dependency drift — validation runs against the worktree as it stands at closeout, including dependency changes the coder made during the run; drift is recorded as a run fact, never silently re-provisioned (see spec.md "Mid-run dependency changes"). Update every provisioning-stage union consumer. Tests cover modes, lockfile-key stability, cache miss behavior, drift recording, cleanup, verification, and failures.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **custom-hook-provisioner** — Add custom product hooks under the Provisioner interface. Hooks use argv commands, declared network policy and resources, contained cwd, scrubbed environment, deterministic inputs, timeouts, and cleanup; arbitrary shell strings are rejected. Tests cover successful execution, cache behavior, timeout reaping, network policy, and cause-preserving failure. _(security review)_
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, security, reviewer
- [ ] **evidence-store** — Implement the durable evidence store: atomic size-bounded writes, secret and host-path scrubbing before persistence, one record per check attempt, artifact paths that must exist and remain inside the run artifact root after realpath resolution, and file-count/size limits. Partial writes are detected and reported as corrupt, not read as success. Tests cover restart round-trip, redaction, traversal, symlink escape, oversized output/artifacts, and partial writes. _(security review)_
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, security, reviewer
- [ ] **evidence-artifact-api** — Add the authenticated cockpit API over the evidence store: it serves only authorized, realpath-contained artifacts, rejects traversal and symlink escape at the API layer independently of store-side checks, returns stable unavailable/corrupt states, and never exposes raw filesystem paths. Tests cover authorization, out-of-root rejection, unavailable/corrupt states, and path scrubbing. _(security review)_
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, security, reviewer
- [ ] **evidence-retention-gc** — Extend the existing work-run GC (count/bytes based) to cover evidence records and artifact bytes: retention bounds configurable alongside the existing `WORK_RUN_*` GC settings, never deleting an active or parked run's evidence, and deleting artifacts and their records together. Tests cover retention bounds, active-run protection, and record/artifact consistency after GC.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **evidence-closeout-gate** — Execute every selected required validation check through the profile executor, acquire and release each check's declared resources at its managed-operation boundary, and persist one evidence record per attempt. GateFacts consume validated evidence records; missing, corrupt, skipped, timed-out, or failed required evidence fails closeout, and narration or closeoutValidationStrategy cannot override it. Tier-selection results are persisted with their input facts (changed paths, flow tags) and included in closeout evidence. A selected manual-live check never executes and never produces evidence: it produces a persisted release item in the run record, surfaced in the cockpit, and is excluded from required-evidence coverage. The dependency-drift fact from provisioning is included in closeout evidence. Tests cover tier selection and its persisted facts, pass, failure, timeout, missing/corrupt evidence, explicit recorded retry, manual-live release items, drift inclusion, and lease release.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **cockpit-blocked-evidence-ui** — Add a blocked-environment badge and action-queue item with remediation, plus an accessible per-run evidence panel showing check status, argv, duration, attempts, tool versions, and authorized artifact links. Clearly distinguish missing evidence, failures, unavailable artifacts, and manual-live release items. Server-rendered and browser interaction tests use ephemeral ports and never contact live ports 3847/3848. _(designer review)_
  - Test strategy: `code-tests-required`
  - Roles: designer, qa, coder, reviewer
- [ ] **fixture-nextjs-roundtrip** — Introduce the fixture materialization helper (`scripts/fixtures/materialize.ts` — net-new; referenced by examples/qa.md but does not exist yet) and a materialized, git-backed Next.js fixture with an acceptance test covering profile parsing, preflight, Node copy provisioning, local-fake validation against a run-owned fake endpoint on an allocated port, evidence persistence, and closeout. Fixture locations are configurable and isolated under temporary roots; tests never use production product configuration or protected ports.
  - Test strategy: `tests-as-deliverable`
  - Roles: qa, coder, reviewer
- [ ] **rune-server-profile-roundtrip** — Give rune and rune-mcp profiled Node configurations sharing one canonical repository and add an acceptance test for their complete round-trip and lock contention. Rune's own checks (`npm run build`, `npm test`) bind ephemeral local test servers, which the pinned offline loopback boundary permits; they must never start, stop, or contact the production daemons on 3847/3848, and any test server uses an ephemeral port with only run-owned processes terminated.
  - Test strategy: `tests-as-deliverable`
  - Roles: qa, coder, reviewer
- [ ] **brand-profile-implementation** — Implement and validate Brand's profile and any required Brand-repository test-script changes. Declare offline typecheck/lint/unit/build checks, local-fake checks, and a separate manual integration environment for production-credential tests. External-repository changes are authored on a reviewable branch in the Brand repository and enumerated (branch, files, rationale) for the migration runbook — Rune-side policy changes must not silently stand in for them. Add parser/selection tests; do not treat configuration presence as live acceptance.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **brand-migration-runbook** — Author [`manual/brand-migration.md`](manual/): the operator steps for the Brand live proof — review and merge the Brand-repository branch from brand-profile-implementation, enable the profile in products.json, dispatch a real Brand task, the evidence checklist to verify (green offline and local-fake checks, recorded tool versions), how to confirm production-credential checks were neither inherited nor executed, and per-product rollback steps.
  - Test strategy: `docs-or-config-only`
  - Roles: coder, reviewer
- [ ] **brand-profile-migration** — Run a real Brand task branch through production Rune following manual/brand-migration.md (assumes its manual steps are complete) and retain green evidence for required offline and local-fake checks. Confirm production-credential checks were neither inherited nor executed. This manual gate closes only on persisted evidence from the real run. *(manual/live - not automatable)*
  - Test strategy: `manual-live-gate`
  - Roles: reviewer

## Phase 3 — Python

> Depends on: Phase 2.

### Implementation

- [ ] **python-host-prereqs-runbook** — Author [`manual/host-prerequisites-python.md`](manual/): the operator steps to prepare this host for Phase 3 — install uv and Python 3.12, prime the offline uv cache, the prebuilt-environment discovery convention (settled in this task's Plan phase and documented here), and the verification commands preflight will run. Subsequent Phase 3 tasks assume these steps are complete.
  - Test strategy: `docs-or-config-only`
  - Roles: coder, reviewer
- [ ] **python-uv-provisioner** — Add a Python/uv provisioner with a cache key based on Python version and uv.lock, source priority of prebuilt environment then verified offline cache then audited approved-egress bootstrap, and reproducibility metadata for Python, uv, and input hashes. Tests cover source selection, offline operation, brokered bootstrap, cleanup, and cause-preserving failures. _(security review)_
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, security, reviewer
- [ ] **fixture-uv-roundtrip** — Create a git-backed uv package fixture with a console entry point and acceptance tests for preflight, provisioning, five representative validation checks, evidence closeout, and a deliberately missing-uv blocked-environment result with remediation. Assumes the manual steps in manual/host-prerequisites-python.md are complete; when they are not, the harness reports a clear unmet acceptance prerequisite rather than a false pass.
  - Test strategy: `tests-as-deliverable`
  - Roles: qa, coder, reviewer
- [ ] **assay-profile-implementation** — Implement Assay's profile with Python 3.12, uv provisioning, and required argv checks for uv sync --all-groups, pytest, Ruff, uv lock --check, and assay --help. External-repository changes are authored on a reviewable branch in the Assay repository and enumerated for the migration runbook. Add profile and tier-selection tests.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **assay-migration-runbook** — Author [`manual/assay-migration.md`](manual/): review and merge the Assay-repository branch, enable the profile, dispatch a real Assay task, the evidence checklist for all five required checks including recorded Python and uv versions, and rollback steps.
  - Test strategy: `docs-or-config-only`
  - Roles: coder, reviewer
- [ ] **assay-profile-migration** — Run a real Assay task branch through production Rune following manual/assay-migration.md (assumes its manual steps are complete) and retain green evidence for all five required checks, including recorded Python and uv versions. This manual gate cannot close from configuration or fixture evidence. *(manual/live - not automatable)*
  - Test strategy: `manual-live-gate`
  - Roles: reviewer

## Phase 4 — Mobile

> Depends on: Phase 2 (leases from Phase 1).

### Implementation

- [ ] **mobile-host-prereqs-runbook** — Author [`manual/host-prerequisites-mobile.md`](manual/): the operator steps to prepare this host for Phase 4 — Xcode version and command-line tools, simulator runtimes, CocoaPods, Java, Android SDK and emulator images, license acceptances, and the verification probes preflight will run. Subsequent Phase 4 tasks assume these steps are complete.
  - Test strategy: `docs-or-config-only`
  - Roles: coder, reviewer
- [ ] **mobile-resource-leases** — Extend leases to iOS simulators, Android emulators, task-local port ranges, cache directories, heavyweight build capacity, and connected devices. Define canonical keys, capacity, resource-existence probes, command/provision-step acquisition boundaries, cancellation, and cleanup; generalize the Phase 2 minimal port allocator into the port-range lease type. The port allocator excludes 3847/3848. Tests cover FIFO contention, capacity, cancellation, missing resources, protected ports, and cleanup.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **flow-tag-plumbing** — Persist optional flow tags at task creation so tier selection has its declared input: tech-lead sizing output (`SizedTask`), planning-artifact tasks.md serialization and re-parse, and the backlog/cockpit task surfaces where tasks originate. Tags are deterministic run facts recorded into the run record and consumed by tier selection — never agent narration. Tests cover round-trip persistence through planning artifacts, run-record inclusion, and selection-input facts.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **cockpit-lease-queue-visibility** — Render lease holders and FIFO waiters for every lease type and correlate waiting runs to show 'waiting on <resource>' separately from blocked-environment, replacing the minimal Phase 1 indicator with the full panel. Include wait duration, holder run, cancellation state, and actionable stale-holder guidance without exposing host paths. Tests cover ordering, state transitions, empty/recovered state, accessibility, and ephemeral-port browser behavior. _(designer review)_
  - Test strategy: `code-tests-required`
  - Roles: designer, qa, coder, reviewer
- [ ] **ios-provisioner** — Add an iOS provisioner with Xcode and CocoaPods probes, Podfile.lock/Xcode cache keys, derived-data management under a cache-dir lease, timeouts, cleanup, and reproducibility metadata. Tests cover probes, cache keys, lease containment, timeout cleanup, and remediation-bearing failures without requiring a full build.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **android-provisioner** — Add an Android provisioner with Java, Gradle wrapper, SDK, and emulator-image probes; deterministic cache inputs; a leased Gradle cache; timeouts; cleanup; and reproducibility metadata. Missing SDKs or images must be preflight blocked-environment results, while execution failures remain provisioning failures. Tests cover both classifications, cache keys, leases, and cleanup.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **fixture-expo-simulator-smoke** — Create a materialized Expo/React Native fixture and environment-gated acceptance test for preflight, iOS provisioning, simulator lease acquisition, leased Metro port, install, launch, smoke assertion, screenshot evidence, and run-owned cleanup. Assumes the manual steps in manual/host-prerequisites-mobile.md are complete; when the required simulator environment is absent, the harness must report a clear unmet acceptance prerequisite rather than a false pass.
  - Test strategy: `tests-as-deliverable`
  - Roles: qa, coder, reviewer
- [ ] **aura-profile-implementation** — Implement Aura's native profile and declarative tier selectors: fast checks for every task, iOS and Android compile checks for native-path changes, simulator smoke for tagged user-visible flows, and manual-live only for signing, hardware, or store credentials (declared `required: false`, surfaced as release items). External-repository changes are authored on a reviewable branch in the Aura repository and enumerated for the migration runbook. Add parser and selector tests covering mixed changes, renames, no-match behavior, and mandatory-tier non-skipping.
  - Test strategy: `code-tests-required`
  - Roles: qa, coder, reviewer
- [ ] **aura-migration-runbook** — Author [`manual/aura-migration.md`](manual/): review and merge the Aura-repository branch, enable the profile, how to create and flow-tag tasks so each tier is exercised (fast on any change, native-compile on a native-path change, simulator smoke on a tagged flow), the evidence checklist per tier including the screenshot artifact, and rollback steps.
  - Test strategy: `docs-or-config-only`
  - Roles: coder, reviewer
- [ ] **aura-profile-acceptance-tiers** — Run real Aura task branches through production Rune following manual/aura-migration.md (assumes its manual steps are complete) to prove the fast, native-compile, and simulator tiers select and execute as declared, with green persisted evidence and a screenshot artifact for the simulator flow. This manual gate cannot close from profile configuration or fixture evidence. *(manual/live - not automatable)*
  - Test strategy: `manual-live-gate`
  - Roles: reviewer

## Phase 5 — Acceptance

> Depends on: Phases 1–4.

### Implementation

- [ ] **operator-runbook-and-docs-sync** — Document the executionProfile schema, lifecycle, network guarantees (including the pinned loopback boundary and its accepted limits), provisioner extension contract, evidence retention/redaction and the GC bounds, the egress-broker enforcement-mode flip, lease recovery and cancellation, fixture prerequisites, migration procedure (including the post-project path for relay and writing), and operator remediation steps; consolidate and cross-link the `manual/` runbooks. Update CLAUDE.md only where its module map or invariants changed, and run the required docs-sync review for all new modules, configuration, and scripts.
  - Test strategy: `docs-or-config-only`
  - Roles: coder, reviewer
- [ ] **parallel-collision-acceptance** — Deliver a stub-free environment-gated acceptance run in one session for the uv fixture, Next.js fixture, Rune server profile, and Expo fixture (assumes both host-prerequisite runbooks' manual steps are complete). Run two jobs sharing a canonical base branch and two jobs sharing one simulator, assert FIFO queueing through introspection and logs, cancel one queued run to prove cleanup, and force one blocked-environment outcome. Every completed run must traverse real preflight, provisioners, executor, evidence store, and closeout; unavailable native prerequisites must fail the gate clearly rather than skip it.
  - Test strategy: `tests-as-deliverable`
  - Roles: qa, coder, reviewer
- [ ] **production-release-runbook** — Author [`manual/production-release.md`](manual/): the operator's step-by-step script for the release gate — which real task to dispatch per product (Assay, Brand, Rune or Rune-MCP, Aura with a tagged simulator flow), how to arrange a real lease collision and observe it queue and proceed, how to cancel a queued run and verify cleanup, how to force a missing-dependency blocked-environment result, and exactly which run IDs, evidence references, and authenticated cockpit captures to retain.
  - Test strategy: `docs-or-config-only`
  - Roles: coder, reviewer
- [ ] **production-release-gate** — Operator-driven release gate following manual/production-release.md (assumes its manual steps are complete): complete a real production Rune task for Assay, Brand, Rune or Rune-MCP, and Aura; Aura must include a simulator smoke run. Confirm a real lease collision visibly queues and later proceeds, a queued cancellation cleans up, and a missing dependency produces an actionable blocked-environment result. Retain run IDs, persisted evidence references, and authenticated cockpit captures. relay and writing are not gated here; they migrate after release via the documented per-product procedure (the Phase 1 rekey's queueing behavior already applies to them and is observed through the collision proof). Fixtures, automated tests, or an authored checklist alone cannot close this gate. *(manual/live - not automatable)*
  - Test strategy: `manual-live-gate`
  - Roles: reviewer
