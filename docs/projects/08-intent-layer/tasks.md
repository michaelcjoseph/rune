# Intent Layer — Tasks

Not started. See [spec.md](spec.md) for architecture and [test-plan.md](test-plan.md) for verification.

> **Test-driven by default.** Every phase below opens with a **Tests (write first)** block.
> Those tests mirror the matching [test-plan.md](test-plan.md) sections and must fail (red)
> before any implementation task in the phase begins. A phase's implementation is done when
> its phase's test-plan sections pass. The first task of the project makes this the default
> for `/work` itself, so the discipline holds for every task after it.
>
> Granularity here is the meaningful deliverable. Per-task file layout, schemas, and
> signatures are settled in `/work`'s Plan phase, against the spec.

## Phase 1 — Foundational tier

> Depends on: nothing. Nothing else works without this (spec § Phasing and Sequencing).

### Execution discipline (do this first)

- [x] Make `/work` test-first: update `.claude/skills/work/SKILL.md` so the cycle writes failing tests before implementation (plan → write failing tests → implement → review → fix → simplify; the existing test rounds stay as regression checks). Hard stops and `--auto` semantics are preserved.
- [x] Update `docs/projects/templates/tasks.md` to carry a per-phase **Tests (write first)** block as the standard shape, and adjust `docs/projects/templates/spec.md` / `templates/test-plan.md` cross-reference wording to match.
- [x] Update `CLAUDE.md` (Jarvis) to document test-first as the default execution discipline for `/work` and for project task breakdowns.

### Tests (write first)

- [x] Write the test suite for the **product/project registry** — test-plan.md §1.
- [x] Write the test suite for **product registration** — test-plan.md §2.
- [x] Write the test suite for the **product-overlay index** — test-plan.md §3.
- [x] Write the test suite for **model-agnostic agent definitions** — test-plan.md §4.
- [x] Write the test suite for the **model selection policy** — test-plan.md §5.
- [x] Confirm every suite above fails (red) before starting the implementation blocks.

### Product/project registry

- [x] Build the registry data model: the uniform product → projects → lifecycle-status index, rebuildable from product repos + vault product files, holding lifecycle status only (not run-status).
- [x] Build the registry read/write module and a query API the cockpit consumes ("every project across every product and its status" in one call).

### Product registration

- [x] Implement the registration flow: create the vault product file `projects/<product>.md` if missing, add the registry entry, create the product-overlay manifest, link the repo if one exists — all propose-and-approve.
- [x] Implement the reconciliation pass: detect a product present as a repo, or referenced in journals, but missing its vault file or registry entry, and propose the missing pieces. Idempotent.
- [ ] Run the first reconciliation pass over the current products (Assay, Aura, Your Nanny, Storytime, family, health, Jarvis, Relay-as-tracked): create every missing vault product file and seed the registry + overlay manifests.

### Product-overlay index

- [ ] Build the per-product knowledge manifest pointing at the journal entries, pages, world-view sections, and wiki concepts relevant to a product. Overlay only — the vault does not move.
- [ ] Provide product-scoped retrieval for sub-agents (planning an Aura project pulls Aura context, not Relay).

### Model-agnostic agent definitions

- [ ] Define the neutral agent-definition representation (role, tools, constraints, declared capabilities) and a compiler to the Claude `.claude/agents/*.md` format. Codex/Gemini targets follow in Phase 4.
- [ ] Express the existing agents in the neutral format and verify the Claude compiler round-trips each one with no behavior change.

### Model selection policy

- [ ] Build the model registry as a declarative policy file: per-model alias, provider, agent-definition format, capability tags, cost tier, status (`preferred`/`active`/`deprecated`). Referenced by alias, not pinned ID.
- [ ] Add role-to-capability binding to agent definitions — roles declare needed capabilities; no model is named in an agent.
- [ ] Build the deterministic resolver: (role, capabilities, policy) → model, precedence pin → role-default → global-fallback, logging the chosen model and the rule that fired. Include the `evaluator.distinct_from: generator` constraint (exercised in Phase 4).
- [ ] Wire the resolver into `runAgent`, replacing the hardcoded `config.AGENT_MODEL` default while preserving today's effective model for every unchanged agent.

### Documentation

- [ ] Update `CLAUDE.md` and `docs/projects/index.md` for the new foundational modules.

## Phase 2 — Cockpit and journal intake

> Depends on: Phase 1 registry.

### Tests (write first)

- [ ] Write the test suite for the **product/project cockpit** — test-plan.md §6.
- [ ] Write the test suite for the **journal-to-intent flow** — test-plan.md §7.
- [ ] Confirm red before implementation.

### Cockpit

- [ ] Extend the webview 06-webview shipped into the full product/project cockpit reading the registry: every product, its projects, lifecycle status, run-status. 06-webview stays as the historical record; it is not retired or folded in.
- [ ] Add per-project start / continue / enter-planning-mode actions, each gated per-action.

### Journal-to-intent flow

- [ ] Build the flow that synthesizes journal raw notes into the right product's vault file, propose-and-approve, never silently rewriting scope.
- [ ] Propose the actionable part of a vault product file as roadmap items into the correct product repo, propose-and-approve.
- [ ] Surface intake proposals and carried-over roadmap items for approval on Telegram and in the cockpit.

### Documentation

- [ ] Update `CLAUDE.md` and `docs/projects/index.md`.

## Phase 3 — Deliberative intent layer and v1 wedge core

> Depends on: Phase 1, Phase 2. Single-model execution end to end against one repo-backed product.

### Tests (write first)

- [ ] Write the test suite for the **Planner (Layer 1)** — test-plan.md §8.
- [ ] Write the test suite for **supervision (Layer 3)** — test-plan.md §9.
- [ ] Write the test suite for **sandboxing and security (Layer 4)** — test-plan.md §10.
- [ ] Write the test suite for the **single-model Generator-Evaluator loop (Layer 2)** — test-plan.md §11.
- [ ] Confirm red before implementation.

### Layer 1 — Planner

- [ ] Build the idea-to-spec conversation: asks questions, surfaces assumptions, scopes, produces a spec artifact Michael approves before anything is dispatched. Works on chat and in the cockpit's planning mode.
- [ ] Wire the approved artifact into `project-setup-writer` so it scaffolds `spec.md` / `tasks.md` / `test-plan.md`, with the per-phase Tests block baked into the generated `tasks.md`.

### Layer 3 — Supervision

- [ ] Generalize the work-runner into background dispatch for long-running runs.
- [ ] Build the visibility surface: which runs are active, which are blocked on Michael; feed it to the cockpit.
- [ ] Add heartbeat check-ins so a quiet run is flagged rather than silently stalled.

### Layer 4 — Sandboxing and security

- [ ] Git worktree per project; separate worktrees even for two projects on the same product repo.
- [ ] Per-repo scoped credentials and egress allowlists.
- [ ] Untrusted-inbound / prompt-injection handling; enforce that Regime B writes to a branch/worktree only, never the vault or a repo's main line.

### Layer 2 — single-model Generator-Evaluator

- [ ] Prove the loop end to end on one model against one repo-backed product (Assay or Aura): approved spec → `/work` Generator (test-first) → `/review` Evaluator → result on a branch, merge gate held for Michael.
- [ ] Implement the bounded loop with escalation to the blocked-on-Michael state after N failed Evaluator rounds.

### Documentation

- [ ] Update `CLAUDE.md` and `docs/projects/index.md`; move the index row to "In Progress".

## Phase 4 — Multi-model dispatch and cross-review

> Depends on: Phase 3. Completes the v1 wedge.

### Tests (write first)

- [ ] Write the test suite for **multi-model dispatch (Layer 5)** — test-plan.md §12.
- [ ] Write the test suite for **cross-model adjudication (Layer 2 upgrade)** — test-plan.md §13.
- [ ] Write the test suite for the **concurrency scheduler** — test-plan.md §14.
- [ ] Confirm red before implementation.

### Layer 5 — Multi-model dispatch

- [ ] Wire Codex as a dispatchable executor; extend the agent-definition compiler to the Codex target.
- [ ] Implement explicit, structured handoff messages for a dispatch (no in-place context compaction).

### Layer 2 — cross-model upgrade

- [ ] Make the Evaluator resolve to a different-provider model from the Generator for autonomous engine runs (the policy's `evaluator.distinct_from` constraint).
- [ ] Add the `/review --cross-model` opt-in flag for manual reviews; keep manual `/review` single-model by default.

### Concurrency

- [ ] Build the global N-project scheduler across all repo-backed products, generalizing `WORK_RUN_GLOBAL_CAP` and the per-project cap; queue work beyond N.
- [ ] Verify the completed v1 wedge against spec § Definition of done (every line observable end to end).

### Documentation

- [ ] Update `CLAUDE.md` and `docs/projects/index.md`.

## Phase 5 — Operational self-improvement

> Depends on: the engine from Phases 3 and 4.

### Tests (write first)

- [ ] Write the test suite for the **observation loop** — test-plan.md §15.
- [ ] Confirm red before implementation.

### Observation loop

- [ ] Extend the existing Ask-Twice intent telemetry to also detect fixed bugs and recurring friction, with de-duplication.
- [ ] File detected items as proposed projects into `docs/projects/ideas.md`, for Michael's approval.
- [ ] Point the existing project-execution engine at the Jarvis product — no new execution subsystem.

### Documentation

- [ ] Update `CLAUDE.md` and `docs/projects/index.md`; move the index row to "Done" once the v1 wedge and the observation loop run cleanly.

## Cross-cutting (verify throughout)

> Not a phase. These run against every phase as it lands — see test-plan.md §16–§17.

- [ ] Two-regime safety: Regime A is unchanged; every vault write is propose-and-approve; the single Regime B → vault channel is generalizable lessons only.
- [ ] The existing skills `/work`, `/work --auto`, and `/review` stay directly invokable by Michael through all phases.
- [ ] Resilience: a failed run is discardable, a restart loses no foundational state, corrupt state files fail fast.
