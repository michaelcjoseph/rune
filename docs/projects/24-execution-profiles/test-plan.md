# Cockpit Execution Profiles: Real Acceptance Environments for Every Product Test Plan

Error handling checklist for the executionProfile lifecycle: repository identity and
leases, profile resolution and snapshotting, preflight, provisioning, network enforcement,
evidence, closeout, and the cockpit operator surface.

This project is **test-first**: each numbered section below is covered by the matching
task's test strategy in [tasks.md](tasks.md). For `code-tests-required` tasks, QA authors
the tests before coder implementation and closeout requires the suite to be green.
Manual/live gates are recorded with operator evidence, not automated.

> See also: [Cross-cutting test plan](../../tech/test-plan.md) for shared guidelines,
> monitoring, and security checks.

## Priority Levels

- 🔴 **Critical**: Blocks user progress, requires immediate attention
- 🟡 **High**: Degrades experience significantly, should be handled gracefully
- 🟢 **Low**: Non-blocking, can fail silently with logging

## 1. Repository identity, branches, and scope

### Canonical repository identity

- [ ] 🔴 Two product entries resolving to the same git common directory must share one base-branch lease key and contend; distinct repositories must not contend.
- [ ] 🔴 A worktree and its parent checkout must resolve to the same canonical repo id; git-common-dir realpath failure falls back deterministically to realpath(repoPath) without silently keying on product identity.
- [ ] 🟡 Concurrent-run facts keyed on the old product/baseBranch tuple must be migrated or read compatibly so a mixed-state restart does not double-key one repository.

### Branch namespacing

- [ ] 🔴 A new work branch is created as `rune-work/<sanitized-product>/<project>`; a legacy `rune-work/<project>` branch remains resumable and is not orphaned.
- [ ] 🟡 A namespace collision after product-name sanitization is rejected rather than silently reusing another product's branch.
- [ ] 🟢 GC handles both legacy and namespaced branch shapes without deleting an active run's branch.

### Scope boundary

- [ ] 🔴 A run whose changed paths (including renames, deletions, and symlink targets) fall outside declared scope roots fails closeout with a machine-readable scope-violation result carrying scrubbed offending relative paths.
- [ ] 🟡 Changed-path derivation uses the correct merge base so unrelated upstream changes are not attributed to the run.
- [ ] 🟡 A product with `scopePath` and no `scopeRoots` defaults its scope roots to that subtree; explicit `scopeRoots` are validated relative patterns.
- [ ] 🟢 The new scope-violation `GateFailReason` union member renders meaningfully through every consumer that branches on or displays the reason (note: no exhaustive switches exist today — reasons flow through alert callbacks and `gateHeldReason`).

## 2. Leases and resource scheduling

### FIFO acquisition and release

- [ ] 🔴 Concurrent acquirers of one resource are granted in FIFO order with observable holder and waiter identity.
- [ ] 🔴 A holder that throws releases its lease; no holder or waiter metadata is left behind.
- [ ] 🔴 A cancelled waiter and a timed-out wait both release cleanly and leave the queue consistent.
- [ ] 🟡 A resource is held only for its declared operation boundary and released on completion, failure, cancellation, timeout, or process shutdown.
- [ ] 🟢 Read-only introspection reports holders and ordered waiters without mutating lease state.

### Recovery and concurrency

- [ ] 🔴 After a daemon restart, a previously-waiting run reacquires through FIFO or becomes an actionable blocked-environment result when the resource no longer exists; it never assumes a pre-restart lease is still held.
- [ ] 🔴 A cancelled or crashed run leaves no lease holder and clears stale waiting metadata on recovery.
- [ ] 🟡 The existing global concurrency cap is unchanged by the lease scheduler.

## 3. Profile schema, resolution, and snapshotting

- [ ] 🔴 A string (shell) command anywhere in a profile is rejected at parse time; only argv arrays are accepted.
- [ ] 🔴 The fully resolved profile and a stable hash are persisted per run; a configuration change after the run starts does not alter the in-flight or recovered run.
- [ ] 🔴 A manual-live-tier check declared `required: true` is rejected at parse time.
- [ ] 🟡 Invalid resource references, invalid selectors, and unknown profile versions are rejected with actionable errors.
- [ ] 🟡 A product without an executionProfile retains legacy Node behavior.
- [ ] 🟢 Snapshot round-trips through persistence and restart without hash drift.

## 3b. Tier selection

- [ ] 🔴 Selection is deterministic from the profile snapshot plus normalized changed paths (including renames) and flow tags — identical inputs produce identical selections; agent narration is never an input.
- [ ] 🔴 The mandatory fast tier cannot be left unselected by any selector combination; selected required checks cannot be skipped by reviewer choice or legacy closeout strategy.
- [ ] 🔴 A selected manual-live check produces a persisted release item (never evidence) and is excluded from required-evidence coverage.
- [ ] 🟡 Mixed changes, renames, and no-match inputs select the declared tiers; native-path changes require both iOS and Android compile tiers unless the profile declares a platform-specific scope.
- [ ] 🟡 Flow tags round-trip from task creation through planning artifacts into the run record and appear in the persisted selection facts.
- [ ] 🟢 Selection results are persisted with their input facts and included in closeout evidence.

## 4. Preflight and blocked-environment

- [ ] 🔴 Missing tools, SDKs, images, caches, enforcement capability, or required env-var names produce a durable blocked-environment result with remediation, surviving a restart round-trip.
- [ ] 🔴 A busy-but-existing resource remains queued and must not be reported as blocked-environment.
- [ ] 🟡 Preflight runs after profile snapshot and before the first agent dispatch in **both** runner paths — before QA in `orchestrated-work-runner` and before the work agent in the legacy `work-runner`; a failed preflight never dispatches agent work in either path.
- [ ] 🟢 All run-status, outcome, persistence, bus, feed, and cockpit consumers handle the new blocked-environment state (union totality); unknown stored future members render fail-closed as an actionable unavailable state.

## 5. Network policy enforcement

- [ ] 🔴 A validation check declaring anything other than offline or local-fake is rejected; approved-egress is permitted only on named setup/provision steps.
- [ ] 🔴 Under the pinned loopback boundary, an offline or local-fake child is denied external networking and denied per-port access to 3847/3848 while other loopback (including its own ephemeral test servers) works.
- [ ] 🔴 The Seatbelt capability probe proves per-port loopback denial is expressible; a host where it is not (including non-macOS) fails preflight instead of degrading to package-manager flags claiming hermeticity.
- [ ] 🔴 Ports 3847 and 3848 are never allocated, bound, killed, or reused by project checks or the run-scoped port allocator.
- [ ] 🟡 local-fake fake endpoints come from the run-scoped allocator and are recorded as run facts.
- [ ] 🟡 The approved-egress broker permits only the product's existing `egressAllowlist` (via `isEgressAllowed` — no second allowlist), denies direct external networking from the child, and records destination metadata without credentials or payloads; denied destinations fail with actionable evidence; `EGRESS_ENFORCEMENT_MODE` reflects the enforced mode for brokered steps.
- [ ] 🟢 manual-live is representable but never auto-executed.

## 6. Provisioning

### Node and custom hooks

- [ ] 🔴 Node install mode operates offline from a verified cache or blocks during preflight; it never reaches the network at execution.
- [ ] 🔴 Arbitrary shell strings in a custom hook are rejected; hooks run argv-only under contained cwd and scrubbed environment.
- [ ] 🟡 Deterministic cache keys are stable across runs for identical lockfile inputs and change when inputs change; cache miss is handled without corrupting the cache.
- [ ] 🟡 Provisioner timeouts reap the whole process group; cleanup removes only run-created resources; reproducibility metadata is recorded.
- [ ] 🟡 A lockfile/dependency change made mid-run (after provisioning) is recorded as a drift fact — validation still runs against the closeout worktree state and closeout does not silently re-provision.
- [ ] 🟢 Every provisioning-stage union consumer handles the new managed stages.

### Python, iOS, Android

- [ ] 🔴 The Python provisioner selects prebuilt environment, then verified offline cache, then audited brokered bootstrap in that order; a missing uv yields a blocked-environment result with remediation.
- [ ] 🔴 Android missing SDKs or emulator images are preflight blocked-environment results; a Gradle execution failure remains a provisioning failure (correct classification).
- [ ] 🟡 iOS Xcode/CocoaPods probes and derived-data management run under a cache-dir lease with timeout cleanup, without requiring a full build.
- [ ] 🟢 Reproducibility metadata (Python/uv/tool versions, input hashes) is captured for each provisioner.

## 7. Evidence storage and closeout

- [ ] 🔴 Missing, corrupt, skipped, timed-out, or failed required evidence fails closeout; narration and closeout-strategy flags cannot override it.
- [ ] 🔴 Artifact paths must exist and resolve inside the run artifact root after realpath; traversal and symlink escapes are rejected by the store and the API.
- [ ] 🔴 The artifact API serves only authorized, contained artifacts; unauthenticated or out-of-root requests are denied.
- [ ] 🟡 Evidence writes are atomic and size-bounded; a partial write is detected and reported as corrupt, not read as success; oversized output and artifacts are bounded.
- [ ] 🟡 Evidence output is scrubbed for secrets and host paths before persistence; evidence stores environment-variable names only.
- [ ] 🟡 Each check's declared resources are acquired and released at its managed-operation boundary; one evidence record is persisted per attempt, including an explicit recorded retry (both attempts retained).
- [ ] 🟡 Evidence retention GC bounds records and artifact bytes alongside the existing work-run GC, never deletes an active or parked run's evidence, and deletes artifacts and their records together.
- [ ] 🟢 Evidence survives a restart round-trip and returns stable unavailable/corrupt states when a file is missing.

## 8. Cockpit operator surface

- [ ] 🔴 A blocked-environment run shows a badge and an action-queue item with remediation, distinct from a queued run.
- [ ] 🟡 From Phase 1, a run waiting on a lease shows a minimal "waiting on \<resource\>" indicator in the active-run projection/run feed (queueing is never operator-invisible before the Phase 4 panel).
- [ ] 🟡 The per-run evidence panel shows per-check status, argv, duration, attempts, tool versions, and authorized artifact links, distinguishing missing evidence, failures, unavailable artifacts, and manual-live release items.
- [ ] 🟡 Lease queue visibility shows holders, FIFO waiters, wait duration, holder run, cancellation state, and stale-holder guidance, separate from blocked-environment and without exposing host paths.
- [ ] 🟢 Server-rendered and browser interaction tests use ephemeral ports and never contact live ports 3847/3848; empty and recovered states render; accessibility checks pass.

## 9. Cross-cutting failure modes

### Agent / Claude CLI failures

- [ ] 🔴 A provisioner or check spawned via the executor that hangs is reaped at its timeout through SIGKILL of the whole process group before returning.
- [ ] 🟡 A profile executor failure preserves its cause in structured logs rather than collapsing to a generic error.

### Missing or malformed inputs

- [ ] 🔴 A malformed executionProfile aborts the run at resolution with an actionable error; it never reaches provisioning.
- [ ] 🟢 Absent optional profile fields fall back to documented defaults without failing resolution.

### Vault / file writability

- [ ] 🔴 Validation isolation never receives Rune or integration secrets; evidence and provisioning caches write only within their contained roots.
- [ ] 🟢 An unwritable evidence or artifact root fails the run with a clear error rather than a silent skip.

### Concurrent session conflicts

- [ ] 🔴 Two runs sharing a canonical base branch queue FIFO and neither corrupts the base; two runs sharing one simulator queue rather than interfere.
- [ ] 🟡 A queued run cancelled while waiting cleans up its waiter slot and any partially-acquired resources.

### Git commit / finalizer failures

- [ ] 🔴 A scope-violation or missing-required-evidence run does not reach the finalizer merge; only a clean, fully-evidenced run merges through the Project 15 gate.
- [ ] 🟡 A finalizer or push failure after evidence persistence leaves the evidence and blocked/queued state durable for recovery, with no double-terminal record.

### Roles and process

- [ ] 🔴 A task flagged `_(security review)_` invokes the security role's review gate in `team-task-workflow`; an unflagged task does not; the marker round-trips through planning-artifact serialization and re-parse.
- [ ] 🟡 The security role loads through `agents/security/` like the other six roles (loader round-trip, model-policy resolution).

## 10. Environment-gated acceptance

- [ ] 🔴 The stub-free parallel acceptance run drives the uv, Next.js, Rune server, and Expo targets in one session; every completed run traverses real preflight, provisioners, executor, evidence store, and closeout with no load-bearing stubs.
- [ ] 🔴 The acceptance run proves base-branch contention queues, simulator contention queues, FIFO ordering is observable, a queued cancellation cleans up, and a missing dependency becomes blocked-environment.
- [ ] 🔴 Missing native prerequisites fail the acceptance gate explicitly; they are never reported as skipped success (the host-prerequisites runbooks in `manual/` are the operator's remediation).
- [ ] 🟡 Manual/live gates (Brand, Assay, Aura, and the production release gate) close only on persisted evidence from a real production Rune run, not on configuration or fixture evidence.
- [ ] 🟡 Every manual/live gate has its runbook (`manual/*.md`) landed before the gate is dispatched, and the gate's retained evidence matches the runbook's checklist.
