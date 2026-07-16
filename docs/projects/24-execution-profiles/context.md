# Project Context: Cockpit execution profiles: real acceptance environments for every product

> Orchestration state for the `rune` project "Cockpit execution profiles: real acceptance environments for every product".
> Owned by Rune's context curator — roles read a bounded slice and emit handoff
> notes; they do not author this file directly.

## Current State

The project makes each product declare a versioned, executable build contract and makes Rune prove that contract before development and at closeout. A usable result must also manage scarce resources safely, preserve diagnosable evidence, recover from cancellation or restart, and show operators the difference between a queue that can resolve and an environment problem requiring action.

## Key Decisions

- Phase mapping for unassigned runtime work: the brief listed four phases but did not place every runtime change. Evidence-based closeout and network modes land in Phase 2; the managed provisioning phase, its pluggable interface, and the Node provisioner land in Phase 2, with Python joining in Phase 3 and iOS/Android in Phase 4; the base-branch lease lands in Phase 1 with the scheduler growing as new resource types appear; each fixture lands with its toolchain's phase.
- Products without an executionProfile keep the current Node-path behavior until migrated; migration is per-product, and Brand goes first as the Phase 2 proving ground.
- Scope-boundary violations (Rune-MCP editing unrelated Rune files) fail the run rather than warn; the brief said 'add a scope boundary' without specifying enforcement strength.
- Done includes at least one real production task for every product that adopts a profile in this project — Brand, Assay, Rune or Rune-MCP, and Aura. **relay and writing migrate after release** via the documented per-product procedure; the Phase 1 rekey/queueing behavior applies to them immediately and is observed through the release gate's collision proof.
- Brand's production-credential tests stay out of default validation permanently and run only under an explicitly provisioned integration environment.
- The manual-live release gate is representable in the schema but its execution stays out of scope for all four phases. The validator rejects `required: true` on manual-live-tier checks; a selected manual-live check produces a persisted release item (surfaced in the cockpit), never evidence, and is excluded from required coverage.
- **Runner integration:** both runner paths honor executionProfile — legacy `work-runner` and `orchestrated-work-runner`. Preflight runs before the first agent dispatch (QA in orchestrated runs, the work agent in legacy runs). Enabling a profile does not require `orchestratedMode`.
- **Loopback boundary (pinned):** offline and local-fake both deny external networking and both permit loopback except per-port denial of protected ports 3847/3848. Per-port loopback *allowlisting* is explicitly not claimed — self-binding ephemeral test servers (`listen(0)`, used by rune's own suite) make it unenforceable. Accepted, documented boundary softening on a single-user host; a Seatbelt capability probe gates enforcement and hosts that cannot express per-port denials fail preflight.
- **Egress reuse:** the approved-egress broker consumes the existing per-product `egressAllowlist` (`policies/products.json`) via `isEgressAllowed` (`src/intent/sandbox.ts`) — no second allowlist — and flips `EGRESS_ENFORCEMENT_MODE` (`src/jobs/egress-policy.ts`) from `'documented-gap'` to its enforced mode for brokered steps.
- **Mid-run dependency changes:** validation runs against the closeout worktree state; provisioning input hashes are recorded at provision time and validation time, and drift is a persisted run fact — closeout never silently re-provisions.
- **scopeRoots vs scopePath:** distinct fields (change validation vs working-directory scoping); a product with `scopePath` and no `scopeRoots` defaults its scope roots to that subtree.
- **Security role:** a new security product-team role (`agents/security/`, `RoleName`, `securityNeeded` flag, `_(security review)_` marker, workflow gate parallel to the designer flag) lands in Phase 1 before any security-tagged task is dispatched.
- **Manual-effort split:** every task needing operator action is split into an automatable runbook task (authored into `manual/`) plus a `manual-live-gate` task that assumes the runbook's steps are complete. Host prerequisites for Phases 3/4 (uv/Python; Xcode/CocoaPods/Java/Android SDK/emulator images) get their own runbooks at the start of those phases.
- **Queue visibility from day one:** a minimal "waiting on \<resource\>" indicator ships with the Phase 1 lease-lifecycle integration; the full lease-queue panel lands in Phase 4.
- **Evidence retention:** in scope as the evidence-retention-gc task, extending the existing count/bytes work-run GC to evidence records and artifact bytes.

## Interfaces & Contracts

Canonical interfaces, data contracts, and mechanics live in [tech-spec.md](tech-spec.md) — this file does not duplicate them (they previously drifted as an embedded copy). Roles needing the contract slice read that file directly. Headlines: `ExecutionProfile`/`ResolvedProfileSnapshot` with stable hash; `canonicalRepoId(repoPath)` and the `(canonicalRepoId, baseBranch)` lease key; the FIFO `LeaseRequest`/`LeaseSnapshot` scheduler with process-local ownership; `PreflightResult` with durable `blocked-environment`; the argv-only executor; the pinned loopback network boundary; the `Provisioner` interface; deterministic tier selection; and per-attempt `CheckEvidence` records.

## Known Risks

- **Seatbelt per-port capability is unproven.** The pinned loopback boundary requires the generated Seatbelt profile to express per-port denials of 3847/3848 alongside allow-all-loopback. The capability probe is the first deliverable of network-mode-enforcement; if macOS cannot express it, the enforcement design needs rework (preflight-blocking local-fake/offline everywhere is not shippable).
- **Loopback boundary is deliberately soft.** Validation children can reach non-protected local services (accepted single-user posture, mirroring the repo's product-chat stance). Do not "fix" silently — re-decide with the operator.
- **Host prerequisites gate Phases 3–4.** fixture-uv-roundtrip, fixture-expo-simulator-smoke, and the migration gates can only land green on a host with uv/Python 3.12 and Xcode/CocoaPods/Java/Android SDK installed; the host-prereqs runbooks exist to make this an explicit operator step instead of a silent block.
- **Simulator/Xcode build durations vs run ceilings.** Native compile and simulator tiers run long; check `timeoutMs` values and the `WORK_RUN_MAX_RUNTIME_MS` ceiling (default 8h) must be reconciled per profile during Plan phases.
- **Union extension blast radius.** `blocked-environment`/`blocked-on-environment` touch 7+ unions across persistence, bus, feed, and cockpit; landed as one dedicated task (blocked-environment-status-unions) to keep the change reviewable.

## Next Task Handoff

Start with: Add canonical repository identity resolution using the realpath of git-common-dir, with a deterministic realpath(repoPath) fallback, and rekey every base-branch lock acquisition and concurrent-run fact from product/baseBranch to repoId/baseBranch (acquisition sites: `work-runner.ts`, `orchestrated-work-runner.ts`, `work-run-release.ts`, `recovery-finalize-runner.ts`). Tests prove products sharing a repository contend (rune/rune-mcp; writing/brand) and distinct repositories do not. Note: security-role-integration must land before scope-boundary-gate (the first security-tagged task).
