# Intent Layer — Tasks

Phase 1 in progress. See [spec.md](spec.md) for architecture and [test-plan.md](test-plan.md) for verification.

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
- [x] Write the test suite for the **escalation policy** — test-plan.md §6.
- [x] Confirm every suite above fails (red) before starting the implementation blocks.

### Product/project registry

- [x] Build the registry data model: the uniform product → projects → lifecycle-status index, rebuildable from product repos + vault product files, holding lifecycle status only (not run-status).
- [x] Build the registry read/write module and a query API the cockpit consumes ("every project across every product and its status" in one call).

### Product registration

- [x] Implement the registration flow: create the vault product file `projects/<product>.md` if missing, add the registry entry, create the product-overlay manifest, link the repo if one exists — all propose-and-approve.
- [x] Implement the reconciliation pass: detect a product present as a repo, or referenced in journals, but missing its vault file or registry entry, and propose the missing pieces. Idempotent.
- [x] Run the first reconciliation pass over the current products (Assay, Aura, Jarvis, Relay-as-tracked, family, health, watt-data): create every missing vault product file and seed the registry + overlay manifests.

### Product-overlay index

- [x] Build the per-product knowledge manifest pointing at the journal entries, pages, world-view sections, and wiki concepts relevant to a product. Overlay only — the vault does not move.
- [x] Provide product-scoped retrieval for sub-agents (planning an Aura project pulls Aura context, not Relay).

### Model-agnostic agent definitions

- [x] Define the neutral agent-definition representation (role, tools, constraints, declared capabilities) and a compiler to the Claude `.claude/agents/*.md` format. Codex/Gemini targets follow in Phase 4.
- [x] Express the existing agents in the neutral format and verify the Claude compiler round-trips each one with no behavior change.

### Model selection policy

- [x] Build the model registry as a declarative policy file: per-model alias, provider, agent-definition format, capability tags, cost tier, status (`preferred`/`active`/`deprecated`). Referenced by alias, not pinned ID.
- [x] Add role-to-capability binding to agent definitions — roles declare needed capabilities; no model is named in an agent.
- [x] Build the deterministic resolver: (role, capabilities, policy) → model, precedence pin → role-default → global-fallback, logging the chosen model and the rule that fired. Include the `evaluator.distinct_from: generator` constraint (exercised in Phase 4).
- [x] Wire the resolver into `runAgent`, replacing the hardcoded `config.AGENT_MODEL` default while preserving today's effective model for every unchanged agent.

### Escalation policy

- [x] Build the escalation policy as a declarative file (data not code): the conditions under which Jarvis escalates to the blocked-on-Michael state rather than proceeding — a high-risk change class, an unresolvable cross-model review, a run exceeding its bounds, a self-generated spec too consequential to approve unattended.
- [x] Build the decision module that reads the policy and returns escalate/proceed for a given change, deterministically, logging the rule that fired. Fails closed on a malformed or missing policy.

### Documentation

- [x] Update `CLAUDE.md` and `docs/projects/index.md` for the new foundational modules.

## Phase 2 — Cockpit and journal intake

> Depends on: Phase 1 registry.

### Tests (write first)

- [x] Write the test suite for the **product/project cockpit** — test-plan.md §7.
- [x] Write the test suite for the **journal-to-intent flow** — test-plan.md §8.
- [x] Confirm red before implementation.

### Cockpit

- [x] Extend the webview 06-webview shipped into the full product/project cockpit reading the registry: every product, its projects, lifecycle status, run-status. 06-webview stays as the historical record; it is not retired or folded in.
- [x] Add per-project start / continue / enter-planning-mode actions, each gated per-action.

### Journal-to-intent flow

- [x] Build the flow that synthesizes journal raw notes into the right product's vault file, propose-and-approve, never silently rewriting scope.
- [x] Propose the actionable part of a vault product file as roadmap items into the correct product repo, propose-and-approve.
- [x] Surface intake proposals and carried-over roadmap items for approval on Telegram and in the cockpit.

### Documentation

- [x] Update `CLAUDE.md` and `docs/projects/index.md`.

## Phase 3 — Deliberative intent layer and v1 wedge core

> Depends on: Phase 1, Phase 2. Single-model execution end to end against one repo-backed product.

### Tests (write first)

- [x] Write the test suite for the **Planner (Layer 1)** — test-plan.md §9.
- [x] Write the test suite for **supervision (Layer 3)** — test-plan.md §10.
- [x] Write the test suite for **sandboxing and security (Layer 4)** — test-plan.md §11.
- [x] Write the test suite for the **single-model Generator-Evaluator loop (Layer 2)** — test-plan.md §12.
- [x] Confirm red before implementation.

### Layer 1 — Planner

- [x] Build the idea-to-spec conversation: asks questions, surfaces assumptions, scopes, produces a spec artifact that is approved before anything is dispatched. Works on chat and in the cockpit's planning mode.
- [x] Wire the approved artifact into `project-setup-writer` so it scaffolds `spec.md` / `tasks.md` / `test-plan.md`, with the per-phase Tests block baked into the generated `tasks.md`.

### Layer 3 — Supervision

- [x] Generalize the work-runner into background dispatch for long-running runs.
- [x] Build the visibility surface: which runs are active, which are blocked on Michael; feed it to the cockpit.
- [x] Add heartbeat check-ins so a quiet run is flagged rather than silently stalled.

### Layer 4 — Sandboxing and security

- [x] Git worktree per project; worktrees isolate products from each other, and the one-project-per-product rule means two runs never share a repo.
- [x] Per-repo scoped credentials and egress allowlists.
- [x] Untrusted-inbound / prompt-injection handling; enforce that Regime B writes only within its worktree and never to the vault — a change reaches a repo's main line only through the merge contract.

### Layer 2 — single-model Generator-Evaluator

- [x] Prove the loop end to end on one model against one repo-backed product (Assay or Aura): approved spec → `/work` Generator (test-first) → `/review` Evaluator → result on a branch. The single-model loop stops at a branch; autonomous merge is held until Phase 4, because cross-model review (the other half of the merge contract) does not exist yet.
- [x] Implement the bounded loop with escalation to the blocked-on-Michael state after N failed Evaluator rounds.

### Documentation

- [x] Update `CLAUDE.md` and `docs/projects/index.md`; move the index row to "In Progress".

## Phase 4 — Multi-model dispatch and cross-review

> Depends on: Phase 3. Completes the v1 wedge.

### Tests (write first)

- [x] Write the test suite for **multi-model dispatch (Layer 5)** — test-plan.md §13.
- [x] Write the test suite for **cross-model adjudication (Layer 2 upgrade)** — test-plan.md §14.
- [x] Write the test suite for the **concurrency scheduler** — test-plan.md §15.
- [x] Confirm red before implementation.

### Layer 5 — Multi-model dispatch

- [x] Wire Codex as a dispatchable executor; extend the agent-definition compiler to the Codex target.
- [x] Implement explicit, structured handoff messages for a dispatch (no in-place context compaction).

### Layer 2 — cross-model upgrade

- [x] Make the Evaluator resolve to a different-provider model from the Generator for autonomous engine runs (the policy's `evaluator.distinct_from` constraint); cross-model review is mandatory before every merge.
- [x] Enable autonomous merge: with the full merge contract (cross-model review plus tests) in place and the escalation policy not flagging the change, the run merges to the product repo's main line itself.
- [x] Add the `/review --cross-model` opt-in flag for manual reviews; keep manual `/review` single-model by default.

### Concurrency

- [x] Build the scheduler: one project per product at a time, plus a global cap across all repo-backed products. Generalize `WORK_RUN_GLOBAL_CAP` and tighten the per-project cap into a per-product cap of one; queue work beyond a cap.
- [x] Verify the completed v1 wedge against spec § Definition of done (every line observable end to end).

### Documentation

- [x] Update `CLAUDE.md` and `docs/projects/index.md`.

## Phase 5 — Operational self-improvement

> Depends on: the engine from Phases 3 and 4.

### Tests (write first)

- [x] Write the test suite for the **observation loop** — test-plan.md §16.
- [x] Confirm red before implementation.

### Sensor layer and synthesis

- [x] Build the sensor layer: ingest vault signals, product telemetry, and logged Jarvis interactions (successful and failed). Log every Jarvis interaction.
- [x] Build the synthesis stage that diarizes raw sensor signal into a compact, structured digest the loop reasons over.

### Observation loop

- [x] Extend the existing Ask-Twice intent telemetry to also detect fixed bugs, recurring friction, and failed or mis-routed interactions, with de-duplication.
- [x] Triage detected items: file the worthwhile ones as projects into `docs/projects/ideas.md`, discard the rest.
- [x] Dispatch the existing project-execution engine at the Jarvis product to run filed projects, within the concurrency and escalation rules — no new execution subsystem. The escalation policy governs spec approval for self-generated projects.
- [x] Run the loop nightly, extending the existing nightly vault review.

### Documentation

- [x] Update `CLAUDE.md` and `docs/projects/index.md`; move the index row to "Done" once the v1 wedge and the observation loop run cleanly.

## Cross-cutting (verify throughout)

> Not a phase. These run against every phase as it lands — see test-plan.md §17–§18.

- [x] Two-regime safety: Regime A is unchanged; every vault write is propose-and-approve; the single Regime B → vault channel is generalizable lessons only.
- [x] Merge-contract safety: no change reaches a product repo's main line without passing the merge contract (cross-model review and the test suite) and clearing the escalation policy — there is no ungated autonomous merge.
- [x] The existing skills `/work`, `/work --auto`, and `/review` stay directly invokable by Michael through all phases.
- [x] Resilience: a failed run is discardable, a restart loses no foundational state, corrupt state files fail fast.

## Phase 6 — Live integration

> Depends on: Phases 1–5 (the deterministic foundation in `src/intent/` — shipped and
> tested, 2265 passing). This phase takes the engine and the observation loop from
> "implemented and tested" to "running cleanly" — the spec's Definition-of-done condition.
> Once both tracks land and live verification passes, the 08-intent-layer row in
> `docs/projects/index.md` moves to **Done**.
>
> Each task is tagged **(user)** for work only Michael can do, **(agent)** for work
> `/work --auto` (or any AI agent) can sweep, or **(agent + user)** for code an agent
> writes that requires a manual run, approval, or coordinated cutover before it counts.

### User-side prerequisites

- [x] **(user)** Run `! codex login` once on this machine so the Codex executor can spawn — gates Track A step 5. *Done; account is on the highest subscription tier.*
- [x] **(agent)** Capture per-product repo paths, base branches, and credential locations in `policies/products.json`. *Done; the repos are already at `~/workspace/<product>` and `policies/products.json` records that convention. The agent extends it as Aura/Assay-specific needs surface.*
- [x] **(agent)** Establish a narrow starter egress allowlist per product in `policies/products.json`. *Done; starter allows GitHub + the npm registry. Stack-specific hosts (Go's `proxy.golang.org` / `sum.golang.org`, Python's `pypi.org` / `files.pythonhosted.org`, Rust's `crates.io` / `static.crates.io`) get added per product if a run fails with a clear deny — the runtime surfaces the missing host, the agent appends it.*
- [ ] **(agent + user)** Cost-attribution for OpenAI/Codex spend — deferred. The agent prompts the user before the first cross-model autonomous run and before any per-run/per-day spend cap is wired in; the OpenAI dashboard's monthly cap is the safety net until then.

### Track A — autonomous engine (sequential)

> Order: 1 → 2 → 3 → 4, then 5 → 6 → 7 → 8. Sandbox and supervision are infrastructure
> under the loop runner; the planner can land at any point after the loop runner exists.

#### A1. Sandbox enforcement (Layer 4)

- [x] **(agent)** Build `src/jobs/sandbox-runtime.ts` — `createWorktree` / `destroyWorktree` shelling out to `git worktree add/remove`, plus a startup cleanup pass for orphan worktrees.
- [x] **(agent)** Per-product scoped credentials — a `.env.<product>` file pattern plus the spawn-time `env` injection that respects `canReachCredential`.
- [x] **(agent)** Egress enforcement — implement the per-run proxy that consults `isEgressAllowed` against each product's allowlist in `policies/products.json`, or — if deferred — document the gap explicitly. Policy is decided (narrow starter, expanded per stack as runs surface deny errors); only the enforcement mechanism choice remains. *Deferred per [egress-deferral.md](egress-deferral.md); audit-only `checkEgress` shipped with `EGRESS_ENFORCEMENT_MODE: 'documented-gap'`, telemetry-driven trigger to promote.*
- [x] **(agent)** Wrap fs writes with `isWriteAllowed` (or `cwd: sandbox.worktree` plus the path guard for absolute paths). Per the security note: resolve symlinks via `fs.realpathSync` before the containment check, or forbid symlinks in worktree init.

#### A2. Supervision wiring (Layer 3)

- [x] **(agent)** Persistent supervised-run store in `src/jobs/supervision-store.ts` — read/write `logs/supervised-runs.json`.
- [x] **(agent)** Hook the mutation event pipeline — `createMutation` → `upsertRun`, each `output` event → `recordHeartbeat`, `completed` / `failed` → status transition, `failed` → `markCrashed`.
- [ ] **(agent)** Startup recovery in `src/index.ts` — walk the persisted runs, call `recoverRun` on each, persist back.
- [ ] **(agent)** Periodic stall check (~30s interval) — `getVisibility` → emit a Telegram nudge for newly-stalled runs.
- [ ] **(agent)** Replace `handleApiCockpit`'s inline `activeRuns` derivation with `getVisibility` over the supervised-run store, mapped to `RunStatusByProject`.

#### A3. Single-model Generator-Evaluator runner (Layer 2)

- [ ] **(agent)** New `genEvalLoopApplier` in `src/jobs/gen-eval-loop-runner.ts`, registered in `src/transport/mutations.ts`.
- [ ] **(agent)** Per round: spawn `/work --auto`, parse exit, spawn `/review`, get verdict; build a `LoopRound` via `recordRound`; call `evaluateLoop`; act on the outcome (`on-branch` → emit `completed`; `escalated` → emit `failed` + supervision flag).
- [ ] **(agent)** Read `maxEvaluatorRounds` from `policies/escalation-policy.json`'s `evaluator-round-cap` rule so the loop and the policy share one cap.
- [ ] **(agent)** Stream per-round progress via Mutation events (output + periodic `failedEvaluatorRounds`).

#### A4. Planner conversational orchestration (Layer 1)

- [ ] **(agent)** `src/reviews/planning.ts` — planning-session state alongside the existing review sessions; JSON persistence under `logs/planning-sessions.json`.
- [ ] **(agent)** Multi-turn Socratic handler — asks scoping questions, surfaces assumptions, proposes a `SpecArtifact` when the LLM judges scoping done.
- [ ] **(agent)** `/plan` Telegram command + the cockpit's existing `enter-planning-mode` action.
- [ ] **(agent)** On user approval, call `runAgent('project-setup-writer', buildSetupWriterBrief(session))` — scaffolds `docs/projects/<NN-slug>/{spec.md, tasks.md, test-plan.md}`.
- [ ] **(agent)** `abandonPlan` on `/clear` or session expiry — scoping wrote no files, so cleanup is a state-machine transition.

#### A5. Codex executor integration (Layer 5)

- [ ] **(agent)** `src/ai/codex.ts` mirroring `src/ai/claude.ts` — `CODEX_BIN` resolution, `runCodex(prompt, opts)` spawning `codex exec`, register/unregister-active-process hooks for graceful shutdown.
- [ ] **(agent)** `dispatchToExecutor(handoff)` in `src/intent/dispatch-runtime.ts` — compile the agent per target, spawn the executor, call `recordDispatch`, append to `logs/dispatch-log.jsonl`.
- [ ] **(agent)** Provider-availability check — a `which codex` + login-status probe; on absence return a `{status:'failed', failureReason:'codex executor unavailable'}` `DispatchResult` so the merge contract's null-adjudication path applies cleanly.
- [ ] **(user)** Confirm `! codex login` is in place before the first cross-model run (linked from the User-side prerequisites above).

#### A6. Model policy — register Codex + enable the cross-model constraint

- [ ] **(agent)** Add a `codex` alias to `policies/model-policy.json` (provider `openai`, capability `coding`, status `preferred`).
- [ ] **(agent)** Set `roleDefaults.evaluator = "codex"` so an autonomous Evaluator picks a cross-provider model by default.
- [ ] **(agent + user)** Flip `evaluatorDistinctFromGenerator` to `true` — coordinated with the Codex executor going live (do this WITH step A5, not before, or the constraint blocks every existing autonomous review path). The user approves the cutover.

#### A7. Cross-model adjudication wiring (Layer 2 upgrade)

- [ ] **(agent)** Extend the gen-eval-loop runner — when `resolveReviewMode({autonomous: true, …}) === 'cross-model'`, Generator and Evaluator dispatches resolve to distinct providers via `resolveModel({evaluatorDistinctFromGenerator: true, generatorProvider})`.
- [ ] **(agent)** Build an `Adjudication` from the resolved (model, provider) pair and the verdict; call `evaluateMergeContract`.
- [ ] **(agent)** On `merge: true` — `git -C <productRepo> merge --no-ff <branch>` and push (or open and auto-merge a PR per the product's flow).
- [ ] **(agent)** On `merge: false` — surface via supervision as `blocked-on-human` with the contract's reason; never degrade to single-model + merge unreviewed.

#### A8. `/review --cross-model` second-pass dispatch

- [ ] **(agent)** Update `.claude/skills/review/SKILL.md` step 1 to parse `--cross-model`; call `resolveReviewMode({autonomous: false, crossModelFlag})`.
- [ ] **(agent)** When mode is `cross-model` — in parallel with the Claude reviewer panel, build a `DispatchHandoff` for each reviewer (target `'codex'`) and dispatch via `dispatchToExecutor`.
- [ ] **(agent)** Reconcile the two verdicts into the consolidated answer; show where Claude and Codex disagreed.
- [ ] **(agent)** Drop the "pending Codex executor" paragraph from the SKILL.md Modes section.

### Track B — observation loop (parallel-safe with Track A)

> Order: B1, B2, B3, B4 can land in any order; B5 closes them. The whole track is independent
> of Track A except that B2's telemetry reader naturally improves once Track A is generating
> real autonomous-run data to learn from.

#### B1. Per-call-site interaction logging

- [ ] **(agent)** Writer `src/utils/observation-log.ts:appendInteraction(record)` — JSONL append to `logs/observation-interactions.jsonl`, mirroring `src/utils/intent-log.ts:appendIntent`.
- [ ] **(agent)** Wire into `src/bot/handlers/text.ts` — one record per inbound TG message; `detail` is `route=<skill> conf=<n>`, never the message body.
- [ ] **(agent)** Wire into every `src/bot/commands/*.ts` — `kind: 'command'`, `detail` is the command name + structured result class.
- [ ] **(agent)** Wire into `src/ai/claude.ts:runAgent` — `kind: 'agent-call'`, `detail` is `agent=<name> dur=<ms>`.
- [ ] **(agent)** Wire into the webview action handlers in `src/server/webview.ts`.
- [ ] **(agent)** Strict-discipline review pass — confirm no call site puts raw user text or vault content into `detail` (the JSDoc invariant on `InteractionLogRecord.detail`).

#### B2. Source readers — vault + telemetry

- [ ] **(agent)** `src/intent/observation-sensor-readers.ts:readVaultSignals()` — scan recent journals (last 7 days) for `#friction` / `#bug` / `#stuck` tags and recent `world-view/*.md` changelog tension; return a capped `SensorSignal[]`.
- [ ] **(agent)** `readTelemetrySignals()` — read `logs/agent-runs.jsonl` for failure-heavy windows and `logs/mutations.jsonl` for repeated `failed` work-runs on the same project slug. Per-product (Aura/Assay) telemetry is deferred — note in the module doc.
- [ ] **(agent)** `readInteractionSignals()` (consumes the JSONL written in B1) — group the last N hours, return capped `SensorSignal[]`.

#### B3. LLM callbacks — diarizer and triage agents

- [ ] **(agent)** New agent `.claude/agents/observation-diarizer.md` — accepts raw `SensorSignal[]` JSON, returns a compact diarized `SensorSignal[]` JSON. Structured output; voice not opted in.
- [ ] **(agent)** New agent `.claude/agents/observation-triage.md` — accepts one `SensorSignal`, returns a `TriageVerdict` JSON. The `idea.id` rule is a deterministic slug of the friction so dedupe is sound across passes.
- [ ] **(agent)** Adapters in `src/intent/observation-callbacks.ts` — `diarize` and `triage` callables that wrap `runAgent` + JSON parse.

#### B4. `ideas.md` baseline + reader

- [ ] **(agent)** Create `docs/projects/ideas.md` with a header and a placeholder for the loop's appended bullets.
- [ ] **(agent)** `src/intent/observation-ideas-io.ts:readFiledIdeas(): ProjectIdea[]` — regex-parse each bullet (matching `formatIdeasMarkdown`'s shape), derive `id` the same way the triage agent does so dedupe matches.
- [ ] **(agent)** `appendFiledIdeas(markdown)` — append `formatIdeasMarkdown`'s output to the file.

#### B5. Nightly observation step

- [ ] **(agent)** Add `observationStep()` to `src/jobs/nightly.ts`, slotted after KB queue and before lint. Build the `NightlyObservationDeps` from the readers (B2), the callbacks (B3), `decideFailClosed({}, {specOrigin: 'self-generated', …})`, and `readFiledIdeas()` (B4).
- [ ] **(agent)** Handle the result — `appendFiledIdeas(result.ideasMarkdown)`; for each `dispatch` plan call `createMutation(...)` against the gen-eval-loop kind from A3; for each `await-approval` plan, send a Telegram approval prompt naming the idea and the escalation reason.
- [ ] **(agent)** Log the pass summary (counts of filed / discarded / duplicate / quiet) — meta telemetry the next pass can observe.

### Live verification → Done

- [ ] **(agent + user)** v1 wedge end-to-end against Aura (or Assay): a coding idea raised in chat → Planner conversation → approved spec → Jarvis spawns a sandboxed `/work --auto` against the worktree → cross-model `/review` adjudicates → the change auto-merges to the product's main line, no human action between spec approval and merge. (Agent drives the test setup; user observes a real run.)
- [ ] **(user)** Let Jarvis run a week. Confirm `logs/observation-interactions.jsonl` is growing, `docs/projects/ideas.md` is gaining entries from real friction, and a low-risk filed project gets dispatched and merges itself.
- [ ] **(user)** Flip the 08-intent-layer row in `docs/projects/index.md` from "In Progress" to "Done".
