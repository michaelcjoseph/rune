# Cockpit Execution Profiles: Real Acceptance Environments for Every Product Specification

## Overview

Cockpit runs autonomous work against every registered product, but its acceptance
harness is Node-shaped. Provisioning assumes `node_modules`, legacy validation commands
are shell strings, the base-branch lock keys on product identity instead of repository
identity, and non-Node closeout can fall back to reviewer interpretation. A mobile build
can close without ever compiling, Python work can stop at an ambiguous missing-tool
judgment, and two runs that share a repository or a simulator can interfere with each
other.

This project makes each product declare a versioned, executable build contract — an
`executionProfile` — and makes Rune prove that contract before development starts and
again at closeout. The profile names toolchains, environment requirements, managed
provisioning, argv-only setup and validation commands, a network policy, resource
requirements, artifact declarations, and declarative tier selectors that map changed
paths or flow tags to the required checks. Rune resolves and snapshots that profile per
run, runs preflight before QA writes a line, queues on busy shared resources through
cancellable FIFO leases, executes every selected required check under a no-shell
executor, persists contained and redacted evidence, and gates closeout on that evidence
alone. Operators see the difference between a queue that will resolve and an environment
problem that needs a human.

A green result stays trustworthy only if the guarantees hold: network restrictions are
enforced rather than advisory, artifacts cannot escape their run directory, a profile
change cannot mutate an in-flight or recovered run, and a cancelled lease waiter cleans
up instead of wedging. Those guarantees are in scope.

### Core Value Proposition

Every product declares the environment and checks that constitute acceptance, and Rune
proves that contract with durable, contained evidence before development and at closeout.

### Goals

1. **Primary:** Add a versioned `executionProfile` (toolchains, environment
   requirements, managed provisioning, argv-only setup and validation commands, network
   policy, resource requirements, artifact declarations, declarative tier selectors),
   resolve and snapshot it per run, and gate closeout solely on persisted evidence for
   every selected required check.
2. **Secondary:** Schedule canonical base branches, simulators, emulators, ports, caches,
   heavyweight build capacity, and devices through cancellable FIFO leases integrated
   with supervision and restart recovery, so busy resources queue with visible ownership
   instead of interfering or failing.
3. **Tertiary:** Give operators authenticated, path-safe cockpit access to
   blocked-environment remediation, per-check evidence, artifacts, lease holders, and
   ordered waiters, so a failure is diagnosable without inspecting host files.

### Non-Goals

- Automated store submission, production code signing, hardware-only release approval, or
  unattended production-credential tests.
- Product feature development beyond the changes a product needs to expose deterministic
  validation commands.
- Cross-process distributed locking. Rune keeps its documented single-daemon ownership
  model; lease ownership stays in-process.
- Ambient validation egress. Automated validation is offline or local-fake only;
  `approved-egress` is limited to named setup or provisioning steps through a supervised
  broker.
- Treating an authored profile, a skipped native test, or agent narration as acceptance
  evidence.
- Auto-executing the `manual-live` policy. It is representable in the schema but never run
  automatically in any phase. A selected manual-live check produces a persisted release
  item, never evidence (see requirement 21).
- Migrating **relay** and **writing** in-project. They follow the documented per-product
  migration procedure after release. Note the Phase 1 lock rekey and queueing behavior
  apply to them immediately (writing shares Brand's repository), which the production
  release gate observes through its collision proof.
- Per-port loopback *allowlisting* for validation children. Self-binding ephemeral test
  servers (`listen(0)`) make it unenforceable; the enforced boundary is
  external-deny + protected-port denial (see "Network policy" below).

---

## User Journey

### Happy Path

```
Product declares executionProfile → Rune resolves + snapshots + hashes it
              ↓
   Preflight (tools, env, caches, images, enforcement capability)
        ↓ present + usable            ↓ missing/unusable        ↓ busy but existing
   acquire leases (FIFO)          blocked-environment          queue (visible waiter)
        ↓
   provision → run selected required checks (no-shell, contained, evidence)
        ↓
   closeout gate reads persisted evidence → merge through the finalizer
```

1. **Product author declares a profile** — adds `executionProfile` to the product config
   with toolchains, provisioning, argv checks, network policy, resources, artifacts, and
   tier selectors.
2. **Rune runs a task** — resolves the profile, snapshots it with a stable hash into the
   run record, and runs preflight before the first agent dispatch (QA in orchestrated
   runs, the work agent in legacy runs — both paths honor profiles). A missing tool or
   SDK produces a durable `blocked-environment` result with remediation; a busy
   simulator or base branch queues.
3. **Execution and evidence** — provisioners run under the managed interface, each
   selected required check runs through the argv executor under its declared network mode,
   and one contained, redacted evidence record is written per attempt.
4. **Closeout** — the gate consumes only validated evidence; missing, corrupt, skipped,
   timed-out, or failed required evidence fails closeout. A clean run hands off to the
   Project 15 finalizer.
5. **Operator visibility** — the cockpit shows queued, blocked, failed, and completed
   runs distinctly, per-check evidence with artifact links, and lease holders with ordered
   waiters.

### Entry Points

- A product config declaring `executionProfile`; profiled runs take the new path,
  unprofiled products retain legacy Node behavior until migrated.
- The cockpit deep view (per-run evidence panel, blocked-environment action item, lease
  queue visibility).
- The environment-gated acceptance run driving the profiled fixtures in one session.

### Exit Points

- A finalizer-gated merge onto `main` with persisted evidence for every selected required
  check.
- A durable `blocked-environment` terminal with actionable remediation.
- A queued run that later proceeds when its resource frees, or a cancelled queued run that
  cleans up.

---

## Requirements

### Repository identity, branches, and scope

1. WHEN two product entries (or a product and a worktree) resolve to the same git common
   directory THEN they share one canonical base-branch lease key and contend for it.
2. WHEN distinct repositories run concurrently THEN their base-branch operations do not
   contend.
3. WHEN a new work branch is created THEN it is named `rune-work/<sanitized-product>/<project>`,
   collisions after sanitization are rejected, and legacy `rune-work/<project>` branches
   remain resumable and GC-safe.
4. WHEN a run's changed paths (including renames and symlink targets) fall outside the
   product's declared scope roots THEN closeout fails with a machine-readable
   scope-violation result carrying scrubbed offending relative paths.

### Leases and resource scheduling

5. WHEN more than one run needs a shared resource THEN acquisition is FIFO with visible
   holder and waiter identity, and a waiting run is queued, not blocked.
6. WHEN a lease waiter is cancelled, its wait times out, or its holder throws THEN the
   lease is released and no holder or waiter metadata is left behind.
7. WHEN a resource is acquired THEN it is held only for its declared operation boundary and
   released on completion, failure, cancellation, timeout, or process shutdown.
8. WHEN the daemon restarts THEN a previously-waiting run reacquires safely through FIFO or
   becomes an actionable `blocked-environment` result if the resource no longer exists; it
   never assumes a pre-restart lease is still held. The existing global concurrency cap is
   preserved.

### Profile schema, preflight, and provisioning

9. WHEN a product declares `executionProfile` THEN Rune validates it (argv-only commands,
   contained relative cwd, toolchains, required env-var names, provision/setup steps,
   validation checks with required/optional status and declared resources and tiers,
   network policy, artifacts, declarative selectors), rejects string commands and unknown
   versions, and persists the fully resolved profile plus a stable hash in the run.
10. WHEN a configuration change lands after a run starts THEN the run continues against its
    snapshot, not the new config.
11. WHEN preflight runs THEN it checks existence and usability (tool versions, required
    env-var presence, cache/image/resource existence, network-enforcement capability), not
    current idleness; a missing or unusable capability blocks, a busy-but-existing resource
    queues.
12. WHEN a run provisions THEN it uses a managed provisioner (Node link/copy/verified-offline
    install, custom hook, Python/uv, iOS, Android) with a deterministic cache key, bounded
    logs, a timeout, process cleanup, verification, and reproducibility metadata.

### Network policy and evidence

13. WHEN a validation check runs THEN only `offline` or `local-fake` is permitted. Both
    deny external networking and both permit loopback **except** the protected ports
    3847/3848, which are denied per-port; `local-fake` additionally provisions declared
    run-owned fake endpoints on run-allocated ports and records them as run facts.
    Per-port loopback allowlisting is explicitly not claimed (see Non-Goals).
14. WHEN `approved-egress` is declared THEN it is limited to named setup or provisioning
    steps and goes through a supervised allowlist broker; direct child egress stays denied.
15. WHEN a host cannot establish the declared isolation (deny-by-default external network,
    protected loopback ports) THEN preflight fails rather than silently degrading to
    package-manager flags. `manual-live` is representable but never auto-executed.
16. WHEN evidence is written THEN it is atomic, size-bounded, secret- and host-path-redacted,
    and contained within the run directory; artifact links are authenticated and reject
    traversal or symlink escape.
17. WHEN closeout runs THEN it fails if required evidence is missing, corrupt, skipped,
    timed out, or unsuccessful, and neither narration nor a closeout strategy flag can
    override it.

### Operator surface

18. WHEN a run is blocked on the environment THEN the cockpit shows a blocked-environment
    badge and an action-queue item with remediation.
19. WHEN an operator opens a run THEN an accessible evidence panel shows per-check status,
    argv, duration, attempts, tool versions, and authorized artifact links, distinguishing
    missing evidence, failures, and unavailable artifacts.
20. WHEN runs contend for a resource THEN the cockpit shows holders, FIFO waiters, wait
    duration, cancellation state, and stale-holder guidance, separate from
    `blocked-environment`, without exposing host paths. A minimal
    "waiting on \<resource\>" indicator ships with the Phase 1 lease integration so
    queueing is never operator-invisible; the full panel lands in Phase 4.

### Selection inputs, manual-live, and process

21. WHEN a selector selects a manual-live check THEN the check was validated as
    `required: false` at parse time (the validator rejects `required: true` on the
    manual-live tier), it is never executed, and closeout records a persisted release
    item in the run record — surfaced in the cockpit — excluded from required-evidence
    coverage.
22. WHEN a task is created THEN optional flow tags persist through the planning
    artifacts into the run record as deterministic run facts, and tier selection
    consumes only those facts plus normalized changed paths — never agent narration.
23. WHEN a task is tagged `_(security review)_` THEN the security product-team role
    reviews the implementation diff as a closeout gate, wired the same way as the
    designer review flag.
24. WHEN evidence and artifacts accumulate THEN retention GC bounds them by count and
    bytes alongside the existing work-run GC, never deleting an active or parked run's
    evidence.

---

## Technical Implementation

> Rune is TypeScript/Node ESM run through the local TS loader; there is no Convex or
> Next.js backend here. The templated database/API/component sections are replaced with the
> concrete module surface below. Autonomous work continues to flow through the mutation
> pipeline and the Project 15 finalizer; this project changes provisioning, validation, and
> closeout, not how `/work` dispatches.
>
> **Runner integration (decision):** `executionProfile` is honored by **both** runner
> paths — the legacy `work-runner` and the orchestrated `orchestrated-work-runner`.
> The profiled lifecycle hooks in at their shared stages: profile resolution/snapshot at
> run start, preflight before the first agent dispatch (QA in orchestrated runs, the
> work agent in legacy runs), provisioning at worktree setup, and evidence-gated
> validation at each path's existing gate. Base-branch lock acquisition sites span
> `work-runner.ts`, `orchestrated-work-runner.ts`, `work-run-release.ts`, and
> `recovery-finalize-runner.ts`; all rekey together. Enabling a product's profile does
> not require enabling `orchestratedMode`.

### Profile schema and resolution

- `executionProfile` types and a versioned parser (argv-only `string[]` commands,
  contained relative cwd, `toolchains`, `env` required-name list, `provision`/`setup`
  steps, `checks` with `required` status + `artifacts` + `resources` + `tiers`,
  `network` policy, `resources`, `selectors` mapping changed-path globs or flow tags to
  required tiers).
- A resolver that validates references and selectors, rejects string commands and unknown
  versions, computes a stable hash over the resolved profile, and persists both the
  resolved profile and hash into the run record for in-flight and recovery use.
- Legacy fallback: products without `executionProfile` keep the current Node path.

### Repository identity and leases

- Canonical repository identity from `realpath(git-common-dir)` with a deterministic
  `realpath(repoPath)` fallback; base-branch locks and concurrent-run facts rekey from
  `product/baseBranch` to `repoId/baseBranch`.
- A typed FIFO `ResourceLease` scheduler: holder/waiter identity, cancellation, bounded
  wait policy, release-on-throw, structured wait/grant/release logs, read-only
  introspection. Base branch is the first lease type; simulators, emulators, task-local
  port ranges, cache directories, heavyweight build capacity, and devices are added as
  their phases land. The port allocator excludes 3847/3848.
- Lease lifecycle integration with run cancellation, supervision, restart recovery, and
  terminal cleanup. Waiting metadata persists in the run record; ownership stays
  in-process and authoritative. A minimal "waiting on \<resource\>" indicator in the
  active-run projection ships with this integration (Phase 1).
- `scopeRoots` and the existing `scopePath` stay distinct: `scopePath` scopes the
  working directory a run operates in; `scopeRoots` validates what a run may change.
  A product with `scopePath` and no `scopeRoots` defaults its scope roots to that
  subtree; explicit declarations are validated relative patterns.

### Execution, network, and evidence

- `runValidationCommandArgv`: the single no-shell executor for profile commands —
  relative contained cwd, scrubbed environment overlay, timeout with process-group
  reaping, bounded output capture, tool-version capture, structured start/terminal/failure
  logging. No whitespace splitting of profile paths.
- Network enforcement at execution: `offline` / `local-fake` for validation under the
  pinned loopback boundary — external denied; loopback allowed except per-port denial of
  3847/3848; `local-fake` additionally provisions declared run-owned fake endpoints on
  ports from a minimal run-scoped allocator (Phase 2; generalized to port-range leases in
  Phase 4). A platform capability probe proves Seatbelt can express the per-port denials;
  hosts where it cannot fail preflight rather than degrading to package-manager flags.
  `manual-live` never auto-run.
- `approved-egress` only for named setup/provision steps via a supervised broker. The
  broker reuses the **existing** egress policy layer: per-product `egressAllowlist` in
  `policies/products.json` evaluated through `isEgressAllowed` (`src/intent/sandbox.ts`)
  — no second allowlist — and the same change flips `EGRESS_ENFORCEMENT_MODE`
  (`src/jobs/egress-policy.ts`) from `'documented-gap'` to its enforced mode for
  brokered steps. It records destination metadata without credentials or payloads.
- Managed `Provisioner` interface + registry (deterministic cache keys, contained logs,
  timeouts, cleanup, verification, reproducibility metadata). Node provisioner (link /
  copy / verified-offline install), custom-hook provisioner, Python/uv provisioner (source
  priority: prebuilt env → verified offline uv cache → audited brokered bootstrap), iOS
  provisioner (Xcode/CocoaPods probes, derived-data under a cache-dir lease), Android
  provisioner (Java/Gradle/SDK/emulator-image probes, leased Gradle cache).
- Durable evidence store + authenticated cockpit API (two deliverables): atomic
  size-bounded writes, secret/host-path redaction, one record per check attempt,
  realpath-contained artifact paths with file-count/size limits, stable
  unavailable/corrupt states. Retention GC extends the existing count/bytes work-run GC
  to evidence records and artifact bytes, never touching an active or parked run.
- **Mid-run dependency changes (decision):** validation runs against the worktree as it
  stands at closeout, including dependency changes the coder made during the run. The
  provisioner records input hashes (lockfile, toolchain versions) at provision time;
  evidence records them at validation time; drift is persisted as a run fact visible in
  closeout evidence. Closeout never silently re-provisions mid-run. (Strict
  re-provisioning could become a profile opt-in later; out of scope.)
- `blocked-environment` as a durable, restart-round-tripping outcome distinct from queued
  (queued is derived from lease state + persisted waiting metadata, never a terminal
  outcome). The union extension across every status/outcome consumer lands as its own
  deliverable before the preflight probe engine. Closeout `GateFacts` consume validated
  evidence records only; a selected manual-live check yields a persisted release item,
  never evidence, and is excluded from required coverage.

### Integration notes

- New `GateFailReason` union member for scope violations. Note: no exhaustive switches
  over this union exist today — reasons flow through alert callbacks and
  `gateHeldReason` strings — so the work is proving the new member renders meaningfully
  through every consumer that branches on or displays it, not updating switch
  statements. New provisioning-stage and run-status/outcome union members likewise.
- Product config gains validated `scopeRoots` and `executionProfile`.
- Supervision, bus, feed, cockpit, and persistence consumers must handle the new
  blocked-environment and waiting states.
- A new **security** product-team role (`agents/security/`, `RoleName`, a
  `securityNeeded` sizing flag serialized as `_(security review)_`, workflow gate wiring
  parallel to the designer flag) lands in Phase 1 before any security-tagged task.
- Flow tags are net-new: nothing resembling task tags exists today. The plumbing
  (tech-lead sizing output → planning artifact → run record → tier selection) is its own
  Phase 4 deliverable; the schema accepts `flowTags` selectors from Phase 2.

---

## UI/UX Design

### Key Screens

#### Per-run evidence panel (cockpit deep view)

- **Route:** per-product deep view → run detail.
- **States:** running, queued (waiting on resource), blocked-environment, failed,
  completed; per-check pass / fail / missing-evidence / unavailable-artifact.
- **Layout:** per-check rows showing status, argv, duration, attempt count, tool versions,
  and authenticated artifact links; missing evidence, failures, and unavailable artifacts
  are visually distinct; no host paths.

#### Blocked-environment action item

- **Route:** action queue / pending items.
- **States:** blocked-environment badge with remediation text and the missing capability.
- **Layout:** one action row per blocked run with the actionable next step.

#### Lease queue visibility

- **Route:** runs / operations surface.
- **States:** holder, FIFO waiters, wait duration, cancellation state, stale-holder
  guidance; distinct from blocked-environment.
- **Layout:** per-resource holder + ordered waiter list, correlated to waiting runs as
  "waiting on \<resource>".

### Visual Tokens

Reuse the existing cockpit patterns (badges, action-queue items, drawer/panel layout from
projects 09 and 17). Server-rendered and browser interaction tests use ephemeral ports and
never contact live ports 3847/3848.

---

## Implementation Phases

> The phase-by-phase task breakdown lives in [tasks.md](tasks.md) and the verification
> checklist in [test-plan.md](test-plan.md); both follow the phase structure below. The
> project is built **test-first** — QA authors required tests before coder implementation,
> and closeout requires the task's validation to pass.

### Phase 1: Repository identity, containment, leases, and the security role

> Depends on: nothing.

- [ ] Canonical repository identity from realpath of git-common-dir with a deterministic
  fallback; rekey every base-branch lock and concurrent-run fact to `repoId/baseBranch`.
- [ ] Typed FIFO resource-lease scheduler with holder/waiter identity, cancellation,
  bounded waits, release-on-throw, structured logging, and read-only introspection;
  base-branch lock wrapped as the first lease type; global concurrency cap preserved.
- [ ] Lease lifecycle integration with cancellation, supervision, restart recovery, and
  terminal cleanup; durable waiting metadata; safe reacquire-or-block after restart;
  minimal "waiting on \<resource\>" indicator in the active-run projection.
- [ ] `rune-work/<sanitized-product>/<project>` branch namespacing with legacy resume,
  collision rejection, and GC safety.
- [ ] Security product-team role (`agents/security/`, `RoleName`, `securityNeeded` flag,
  `_(security review)_` marker, workflow gate) so security-tagged tasks are dispatchable.
- [ ] Validated `scopeRoots` (reconciled with the existing `scopePath`), merge-base
  changed-path derivation, traversal/symlink-escape rejection, and a fail-closed
  scope-violation gate result.

### Phase 2: Schema, preflight, provisioning, evidence, and Node profiles

> Depends on: Phase 1.

- [ ] Versioned `executionProfile` parser and types with resolved-profile-plus-hash
  snapshotting, required-manual-live rejection, and legacy fallback.
- [ ] `runValidationCommandArgv` as the single no-shell executor (contained cwd, scrubbed
  env, timeout/process-group reaping, bounded output, tool-version capture, structured
  logs).
- [ ] Phase-aware network enforcement under the pinned loopback boundary (per-port denial
  of 3847/3848, Seatbelt capability probe, minimal run-scoped port allocator for
  local-fake endpoints, enforcement-capability preflight failure).
- [ ] Supervised approved-egress broker for named setup/provision steps reusing
  `egressAllowlist`/`isEgressAllowed` and flipping `EGRESS_ENFORCEMENT_MODE`, with
  direct-network denial, redacted audit, cleanup, and timeouts.
- [ ] `blocked-environment` / `blocked-on-environment` across every status/outcome union,
  persistence, bus, feed, and cockpit consumer (its own deliverable).
- [ ] Preflight probe engine after snapshot and before the first agent dispatch in both
  runner paths, producing durable `blocked-environment` for missing/unusable
  capabilities and queueing busy resources.
- [ ] Managed `Provisioner` interface + registry and the Node provisioner (link / copy /
  verified-offline install) behind it, with dependency-drift recording; legacy path
  preserved.
- [ ] Custom-hook provisioner under the same execution and isolation contracts.
- [ ] Durable evidence store; authenticated, traversal-safe cockpit artifact API; and
  evidence retention GC (three deliverables).
- [ ] Evidence-driven closeout gate over every selected required check, with persisted
  tier-selection facts and manual-live release items.
- [ ] Cockpit blocked-environment badge/action item and per-run evidence panel.
- [ ] Fixture materialization helper (net-new `scripts/fixtures/materialize.ts`), Next.js
  fixture round-trip, and rune / rune-mcp shared-repo profile round-trip.
- [ ] Brand profile implementation, its migration runbook (`manual/brand-migration.md`),
  and its production live proof (three deliverables).

### Phase 3: Python

> Depends on: Phase 2.

- [ ] Host-prerequisites runbook (`manual/host-prerequisites-python.md`) so the operator
  can prepare uv/Python before the environment-gated tasks.
- [ ] Python/uv provisioner (prebuilt env → verified offline cache → audited brokered
  bootstrap) with reproducibility metadata.
- [ ] uv fixture proving execution and a deliberate missing-tool block.
- [ ] Assay profile implementation (Python 3.12, uv, sync / pytest / Ruff / lock-check /
  entry-point checks), its migration runbook (`manual/assay-migration.md`), and its
  production live proof (three deliverables).

### Phase 4: Mobile

> Depends on: Phase 2 (leases from Phase 1).

- [ ] Host-prerequisites runbook (`manual/host-prerequisites-mobile.md`) covering Xcode,
  simulator runtimes, CocoaPods, Java, and the Android SDK/emulator images.
- [ ] Extend leases to iOS simulators, Android emulators, task-local port ranges (the
  Phase 2 minimal allocator generalized), cache directories, heavyweight build capacity,
  and connected devices; port allocator excludes 3847/3848.
- [ ] Flow-tag plumbing: optional tags at task creation, persisted through planning
  artifacts into the run record as deterministic tier-selection facts.
- [ ] Cockpit lease-queue visibility (holders, FIFO waiters, wait duration, stale-holder
  guidance), replacing the Phase 1 minimal indicator.
- [ ] iOS provisioner (Xcode/CocoaPods probes, leased derived-data) and Android provisioner
  (Java/Gradle/SDK/emulator-image probes, leased Gradle cache) with correct
  blocked-vs-failure classification.
- [ ] Expo fixture proving leased simulator startup, leased Metro port, launch, screenshot
  evidence, and cleanup.
- [ ] Aura native profile with deterministic tier selectors (fast checks always; iOS/Android
  compile on native changes; simulator smoke on tagged flows; manual-live only as
  non-required release items), its migration runbook (`manual/aura-migration.md`), and
  its live tier verification (three deliverables).

### Phase 5: Acceptance and operations

> Depends on: Phases 1–4.

- [ ] Operator runbook + docs-sync (schema authoring, migrations including the
  post-project relay/writing path, network guarantees and the loopback boundary,
  provisioner extension, evidence security and GC bounds, egress mode flip, lease
  recovery, native prerequisites, remediation; consolidates the `manual/` runbooks).
- [ ] Stub-free, environment-gated parallel acceptance run over the uv, Next.js, Rune
  server, and Expo targets proving base-branch and simulator contention, FIFO ordering,
  queued cancellation cleanup, a forced blocked-environment, and full traversal for
  completed runs.
- [ ] Production release runbook (`manual/production-release.md`) with the operator's
  step-by-step script, then the operator-driven production release gate: real tasks for
  Assay, Brand, Rune or Rune-MCP, and Aura (Aura with simulator smoke evidence).

---

## Success Metrics

### Core KPIs

| Metric | Target | How Measured |
| ------ | ------ | ------------ |
| Green profiled runs with complete evidence | 100% of selected required checks have a successful persisted evidence record | Evidence store inspection per run |
| Non-Node closeout correctness | 0 mobile/Python runs close without their required native/interpreter checks | Closeout gate + acceptance run |
| Resource-contention safety | Contending runs queue FIFO; 0 interference incidents | Lease introspection + acceptance collision test |
| Blocked-vs-queued clarity | Operators correctly distinguish queued, blocked, failed, completed | Acceptance run + cockpit review |
| Recovery durability | Snapshots, evidence, blocked outcomes, and waiting state survive restart/recovery | Restart round-trip tests |

### Run summary facts

Rune has no analytics system; the equivalent facts persist in the run summary
(`work-run-store`) and the mutation classification, both already durable:

```jsonc
{
  "repoId": "<scrubbed canonical id>",
  "product": "…", "project": "…",
  "profileHash": "…",
  "outcome": "completed | blocked-environment | failed | cancelled",
  "requiredChecks": 5, "passedChecks": 5,
  "queuedOnResource": "<resource key or null>",
  "dependencyDrift": false,
  "releaseItems": []
}
```

---

## Edge Cases & Error Handling

### Resource contention and leases

- A busy-but-existing resource must queue, never become `blocked-environment`.
- A cancelled queued run must release its waiter slot and leave no holder metadata.
- After restart, a run must not assume a pre-restart lease is still held; it reacquires
  FIFO or becomes an actionable blocked result if the resource is gone.
- Ports 3847 and 3848 are never allocated, bound, killed, or reused by project checks.

### Environment and preflight

- Missing tools, SDKs, images, caches, enforcement capabilities, or required env-var names
  produce a durable `blocked-environment` result with remediation.
- A host that cannot establish deny-by-default network or protected-port enforcement fails
  preflight rather than degrading to package-manager flags claiming hermeticity.
- Install mode with no verified cache blocks during preflight instead of reaching the
  network.

### Evidence and closeout

- Missing, corrupt, skipped, timed-out, or failed required evidence fails closeout;
  narration and closeout-strategy flags cannot override.
- Artifact paths must exist and resolve inside the run artifact root after realpath;
  traversal and symlink escapes are rejected; oversized output/artifacts are bounded.
- Only processes and simulator/emulator instances created or explicitly leased by a run may
  be stopped by that run.
- Simulator acceptance is environment-gated and may record one explicit retry; both
  attempts remain in evidence.
- A selected manual-live check is never a missing-evidence failure: the validator has
  already forced it non-required, and closeout records it as a release item.
- A lockfile or dependency change made by the coder mid-run does not invalidate the run:
  validation runs against the closeout worktree state and the drift is a persisted run
  fact, visible in evidence.
- Evidence GC never deletes an active or parked run's records; artifacts and their
  records are deleted together.

### Scope and identity

- Scope-boundary violations (renames, deletions, symlink escapes) fail the run rather than
  warn.
- Worktrees and multiple product entries for one repository share the canonical
  base-branch key.

---

## Open Questions

- [ ] Final canonical key formats for simulator, emulator, device, and heavyweight
  build-capacity leases (settled per provisioner in the `/work` Plan phase).
- [ ] Capacity model for heavyweight build capacity (single global vs per-host tunable).

### Resolved

- [x] Prebuilt-environment discovery convention for the Python provisioner — settled in
  python-host-prereqs-runbook's Plan phase and documented in
  `manual/host-prerequisites-python.md`.
- [x] Retention/GC policy for the evidence store — in scope as the evidence-retention-gc
  task, extending the existing count/bytes work-run GC; exact bounds settled in its Plan
  phase.
- [x] Approved-egress allowlist shape — the existing per-product `egressAllowlist` in
  `policies/products.json` (evaluated by `isEgressAllowed`) is the declaration; the
  broker consumes it rather than introducing a second allowlist. Changes to a product's
  allowlist are reviewed as products.json changes in this repository.
- [x] Loopback semantics for offline/local-fake — pinned: external denied; loopback
  allowed minus per-port denial of 3847/3848; per-port allowlisting explicitly not
  claimed (self-binding ephemeral test servers make it unenforceable). Accepted,
  operator-visible boundary softening; recorded in context.md Key Decisions and Known
  Risks.
- [x] Which runner paths honor profiles — both (see Runner integration decision).
