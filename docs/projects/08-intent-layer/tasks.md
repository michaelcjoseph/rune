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
- [x] **(agent)** Startup recovery in `src/index.ts` — walk the persisted runs, call `recoverRun` on each, persist back.
- [x] **(agent)** Periodic stall check (~30s interval) — `getVisibility` → emit a Telegram nudge for newly-stalled runs.
- [x] **(agent)** Replace `handleApiCockpit`'s inline `activeRuns` derivation with `getVisibility` over the supervised-run store, mapped to `RunStatusByProject`.

#### A3. Single-model Generator-Evaluator runner (Layer 2)

- [x] **(agent)** New `genEvalLoopApplier` in `src/jobs/gen-eval-loop-runner.ts`, registered in `src/transport/mutations.ts`. *Scaffold only; A3.2 lands the per-round loop body — placeholder `apply()` emits a structured 'not implemented' failure to surface the gap clearly.*
- [x] **(agent)** Per round: spawn `/work --auto`, parse exit, spawn `/review`, get verdict; build a `LoopRound` via `recordRound`; call `evaluateLoop`; act on the outcome (`on-branch` → emit `completed`; `escalated` → emit `failed` + supervision flag). *Orchestration tested via injected spawn primitives; default spawners drive Claude CLI with sandboxed env. Live verification will refine the `/review` verdict marker.*
- [x] **(agent)** Read `maxEvaluatorRounds` from `policies/escalation-policy.json`'s `evaluator-round-cap` rule so the loop and the policy share one cap.
- [x] **(agent)** Stream per-round progress via Mutation events (output + periodic `failedEvaluatorRounds`).

#### A4. Planner conversational orchestration (Layer 1)

- [x] **(agent)** `src/reviews/planning.ts` — planning-session state alongside the existing review sessions; JSON persistence under `logs/planning-sessions.json`.
- [x] **(agent)** Multi-turn Socratic handler — asks scoping questions, surfaces assumptions, proposes a `SpecArtifact` when the LLM judges scoping done. *Orchestration tested against mock scopingTurn; production `defaultScopingTurn` wraps askClaudeWithContext with a system prompt that asks for a question or a fenced spec-artifact JSON. Live verification refines the prompt + marker.*
- [x] **(agent)** `/plan` Telegram command + the cockpit's existing `enter-planning-mode` action.
- [x] **(agent)** On user approval, call `runAgent('project-setup-writer', buildSetupWriterBrief(session))` — scaffolds `docs/projects/<NN-slug>/{spec.md, tasks.md, test-plan.md}`.
- [x] **(agent)** `abandonPlan` on `/clear` or session expiry — scoping wrote no files, so cleanup is a state-machine transition.

#### A5. Codex executor integration (Layer 5)

- [x] **(agent)** `src/ai/codex.ts` mirroring `src/ai/claude.ts` — `CODEX_BIN` resolution, `runCodex(prompt, opts)` spawning `codex exec`, register/unregister-active-process hooks for graceful shutdown.
- [x] **(agent)** `dispatchToExecutor(handoff)` in `src/jobs/dispatch-runtime.ts` — compile the agent per target, spawn the executor, call `recordDispatch`, append to `logs/dispatch-log.jsonl`. *Lands in `src/jobs/` rather than `src/intent/`: per the established convention, runtime adapters that do I/O (spawn children, write logs) live in `src/jobs/`; `src/intent/` stays for pure decision modules.*
- [x] **(agent)** Provider-availability check — a `which codex` + login-status probe; on absence return a `{status:'failed', failureReason:'codex executor unavailable'}` `DispatchResult` so the merge contract's null-adjudication path applies cleanly.
- [ ] **(user)** Confirm `! codex login` is in place before the first cross-model run (linked from the User-side prerequisites above).

#### A6. Model policy — register Codex + enable the cross-model constraint

- [x] **(agent)** Add a `codex` alias to `policies/model-policy.json` (provider `openai`, capability `coding`, status `preferred`).
- [x] **(agent)** Set `roleDefaults.evaluator = "codex"` so an autonomous Evaluator picks a cross-provider model by default.
- [ ] **(agent + user)** Flip `evaluatorDistinctFromGenerator` to `true` — coordinated with the Codex executor going live (do this WITH step A5, not before, or the constraint blocks every existing autonomous review path). The user approves the cutover.

#### A7. Cross-model adjudication wiring (Layer 2 upgrade)

- [x] **(agent)** Extend the gen-eval-loop runner — when `resolveReviewMode({autonomous: true, …}) === 'cross-model'`, Generator and Evaluator dispatches resolve to distinct providers via `resolveModel({evaluatorDistinctFromGenerator: true, generatorProvider})`. *Scope is the resolution path: the loop now emits a `progress` event of `{kind: 'resolution', mode, generator, evaluator}` at startup. A7.2 builds the Adjudication from the resolved pair + verdict; A7.3 wires the actual Codex Evaluator dispatch (the current `/review` still runs on Claude until A7.3 swaps the Evaluator's spawn path).*
- [x] **(agent)** Build an `Adjudication` from the resolved (model, provider) pair and the verdict; call `evaluateMergeContract`. *On `merge: true` the loop emits a `progress` event of `{kind: 'merge-ready', adjudication}` followed by `completed`. On `merge: false` it emits `failed` with `reason: 'merge contract held: <contract reason>'`. A7.3 swaps the placeholder `completed` for the actual `git merge --no-ff` against the product repo's main branch.*
- [x] **(agent)** On `merge: true` — `git -C <productRepo> merge --no-ff <branch>` and push (or open and auto-merge a PR per the product's flow). *Deterministic feature branch `jarvis-gen-eval/<short-mut-id>` is created by `createWorktree`; on the merge-ready event the runner spawns `git -C <productRepoPath> merge --no-ff <branch>` then `git push`, then `git branch -d <branch>` to clean up. Failures (sync throw, merge conflict, push failure) all surface as `failed` mutation events; credential URLs (`https://<token>@host`) are redacted from git stderr before reaching the log/user.*
- [x] **(agent)** On `merge: false` — surface via supervision as `blocked-on-human` with the contract's reason; never degrade to single-model + merge unreviewed. *The runner emits a `failed` mutation event with `reason: 'merge contract held: <contract reason>'`; the mutation pipeline's existing supervision hook flips the run to `blocked-on-human` on `failed`. No alternate path degrades the contract.*

#### A8. `/review --cross-model` second-pass dispatch

- [x] **(agent)** Update `.claude/skills/review/SKILL.md` step 1 to parse `--cross-model`; call `resolveReviewMode({autonomous: false, crossModelFlag})`. *SKILL.md gains a new step 1 "Parse args and resolve the review mode" that explicitly parses the flag and applies the same rule as `resolveReviewMode` (autonomous: false; mode = crossModelFlag ? cross-model : single-model). Subsequent steps renumbered 2/3/4; cross-references updated.*
- [x] **(agent)** When mode is `cross-model` — in parallel with the Claude reviewer panel, build a `DispatchHandoff` for each reviewer (target `'codex'`) and dispatch via `dispatchToExecutor`. *Implementation: new `scripts/dispatch-review.ts` (npm script `npm run dispatch-review`) wraps `dispatchToExecutor` with target `'codex'` so the markdown SKILL.md can spawn Codex via Bash. The SKILL.md's step 3 now tells Claude to write each reviewer's prompt to a tempfile and run `npm run dispatch-review -- <agent> <tempfile>` in parallel with the existing five Agent tool calls — 10 tool calls in one turn. Codex dispatcher failures (probe unavailable, spawn error) surface as exit-1 with a `DISPATCH-FAILED:` stderr line so the reviewer is marked `UNAVAILABLE` and the panel continues.*
- [x] **(agent)** Reconcile the two verdicts into the consolidated answer; show where Claude and Codex disagreed. *SKILL.md step 4 gains a "Cross-model reconciliation" subsection that normalizes both passes into the same finding stream, dedupes across providers with `[reviewer claude+codex]` tags on agreements and single-provider tags on disagreements. The overall verdict is computed union-style (anything either model flagged is in scope), reflecting the more-conservative posture appropriate for a manual review. A new "Cross-model" section in Per-agent results shows the disagreement counts (`N by Claude only, M by Codex only, K by both`) for the user's at-a-glance view.*
- [x] **(agent)** Drop the "pending Codex executor" paragraph from the SKILL.md Modes section. *Modes section now describes cross-model as a working feature: the panel runs on Claude AND Codex, two verdicts are reconciled. Replaced with a one-paragraph pointer to the dispatch wiring (`scripts/dispatch-review.ts` → `dispatchToExecutor`) and the same `resolveReviewMode`/autonomous-always-cross-model invariant.*

### Track B — observation loop (parallel-safe with Track A)

> Order: B1, B2, B3, B4 can land in any order; B5 closes them. The whole track is independent
> of Track A except that B2's telemetry reader naturally improves once Track A is generating
> real autonomous-run data to learn from.

#### B1. Per-call-site interaction logging

- [x] **(agent)** Writer `src/utils/observation-log.ts:appendInteraction(record)` — JSONL append to `logs/observation-interactions.jsonl`, mirroring `src/utils/intent-log.ts:appendIntent`. *Mirrors intent-log.ts exactly: `OBSERVATION_LOG_FILENAME` constant, `observationLogPath()`, `appendInteraction(record)` with the same mkdirSync + appendFileSync shape and the same single-process event-loop safety model. Re-exports `InteractionLogRecord` from `src/intent/observation-sensor.ts` so call sites import the writer + type from one place. The JSDoc invariant (detail carries only structured metadata, never raw user content) is enforced at the call sites (B1.2–B1.5), not in the writer.*
- [x] **(agent)** Wire into `src/bot/handlers/text.ts` — one record per inbound TG message; `detail` is `route=<skill> conf=<n>`, never the message body. *handleTextMessage now emits one InteractionLogRecord per authorized inbound message with `kind: 'tg-message'`, outcome derived from whether `dispatchText` returns cleanly, and `detail: route=<slash-name-or-conversation>`. Route is computed by a local `routeOf` helper that extracts the slash-prefix token only — never the message body. Unauthorized senders + empty text produce no record. Resolver confidence isn't captured here (the resolver outcome already lands in `logs/intent-log.jsonl` via appendIntent; the observation log is the "an interaction happened" layer above it).*
- [x] **(agent)** Wire into every `src/bot/commands/*.ts` — `kind: 'command'`, `detail` is the command name + structured result class. *Centralized via a `withCommandLog(name, fn)` wrapper in `dispatchText` that wraps every slash branch (~35 branches). Each command invocation emits one `{kind:'command', detail:'cmd=<name>', outcome}` record; outcome derives from whether the wrapped handler throws. The structured result class beyond success/failure is deferred — the per-command "what's the result code" judgment is a follow-up that can land per-command without changing this central path. The `cmd=<name>` detail carries only the structured command name, never the args.*
- [x] **(agent)** Wire into `src/ai/claude.ts:runAgent` — `kind: 'agent-call'`, `detail` is `agent=<name> dur=<ms>`. *Appends an InteractionLogRecord right after the existing `agent-runs.jsonl` write: `kind:'agent-call'`, `detail:'agent=<name> dur=<ms>'`, outcome mapped from the existing status (`success` vs `failure`). Distinct from `agent-runs.jsonl` (snapshot/visualization source); the observation log is the loop's sensor signal. Detail carries only agent name + duration — never the prompt body.*
- [x] **(agent)** Wire into the webview action handlers in `src/server/webview.ts`. *Centralized via a `logWebviewAction(action, outcome, extra?)` helper. Each of the three action handlers (`handleApiMutationsCreate`, `handleApiMutationsCancel`, `handleApiOpsCancel`) emits one `kind:'webview'` record at every exit path with `detail:'action=<name> [extra]'`. Outcome reflects whether the action's response was 2xx vs 4xx. Detail carries the action name + mutation `kind=` or failure reason — never the raw request body content.*
- [x] **(agent)** Strict-discipline review pass — confirm no call site puts raw user text or vault content into `detail` (the JSDoc invariant on `InteractionLogRecord.detail`). *security-auditor reviewed all four call sites — passed structurally. Two hardening fixes applied: (1) `routeOf` in text.ts caps the slash-token at 32 chars so a pathological input (e.g., a slash followed by a 10KB run of non-whitespace) can't blow up the detail field. (2) `body.kind` in webview's `handleApiMutationsCreate` is now validated against the known `MutationKind` set via `safeMutationKind()` before flowing into detail — unknown kinds log as `kind=unknown` rather than echoing arbitrary client strings. The auth gate already constrained who could reach the endpoint, but the structured-data invariant is now upheld at the language level rather than relying on client behavior.*

#### B2. Source readers — vault + telemetry

- [x] **(agent)** `src/intent/observation-sensor-readers.ts:readVaultSignals()` — scan recent journals (last 7 days) for `#friction` / `#bug` / `#stuck` tags and recent `world-view/*.md` changelog tension; return a capped `SensorSignal[]`. *New module shared with B2.2/B2.3. `readVaultSignals(opts)` walks lookback-day journals via an injected `readJournalFile` reader, regex-matches the three friction tags (anchored to whitespace/parens to avoid partial-word matches), and walks `world-view/*.md` for `### [[YYYY_MM_DD]]` changelog headings within the window. Returns a SensorSignal[] capped at 20 (FIFO, journal hits first then worldview) with `source:'vault'`. Injected readers keep the function unit-testable without disk; defaults wire `readVaultFile`/`listVaultFiles` and absorb errors so a missing file is a clean empty rather than a throw.*
- [x] **(agent)** `readTelemetrySignals()` — read `logs/agent-runs.jsonl` for failure-heavy windows and `logs/mutations.jsonl` for repeated `failed` work-runs on the same project slug. Per-product (Aura/Assay) telemetry is deferred — note in the module doc. *Added to `observation-sensor-readers.ts` alongside B2.1. Two scan paths: agent failure-heavy (groups error-status entries by agent, emits when count ≥ `agentFailureThreshold` default 3) and work-run repeat-failure (filters mutations to kind:work-run + status:failed, groups by project slug from `payload.projectSlug` falling back to `target.ref`, emits when count ≥ `workRunFailureThreshold` default 2). Both source readers absorb missing-file errors as clean empties. Malformed JSONL lines logged + skipped. Per-product (Aura/Assay) telemetry deferred — needs webhook/poll integration; documented in the module-level JSDoc.*
- [x] **(agent)** `readInteractionSignals()` (consumes the JSONL written in B1) — group the last N hours, return capped `SensorSignal[]`. *Added to observation-sensor-readers.ts. Reads `logs/observation-interactions.jsonl`, filters to outcome:failure within lookbackHours (default 24), groups by kind, emits one SensorSignal per kind whose failure count meets `failureThreshold` (default 3). Grouping by kind only — `detail` is structured but heterogeneous (route names vs agent names vs cmd names), so exact-match grouping would fragment buckets. Capped FIFO. Injectable reader; default wires `readFileSync` with missing-file → null fallback.*

#### B3. LLM callbacks — diarizer and triage agents

- [x] **(agent)** New agent `.claude/agents/observation-diarizer.md` — accepts raw `SensorSignal[]` JSON, returns a compact diarized `SensorSignal[]` JSON. Structured output; voice not opted in. *Tools allowlist empty (no fs/web access). Prompt enumerates: input JSON shape, output JSON shape (no markdown fences, no prose), compaction rules (group recurring friction, drop one-off noise, keep cross-product separate, never invent friction, cap 12 entries), empty/single-signal edge case, worked example. AGENT_LABELS entry added so the in-flight tracker UI renders "Diarizing observation signals" rather than the titlecased default.*
- [x] **(agent)** New agent `.claude/agents/observation-triage.md` — accepts one `SensorSignal`, returns a `TriageVerdict` JSON. The `idea.id` rule is a deterministic slug of the friction so dedupe is sound across passes. *Tools allowlist empty. Prompt covers: input shape, both TriageVerdict variants (file:true/file:false), what-to-file vs what-to-discard guidance with named discard reasons, the deterministic id construction rule (lowercase → replace non-alphanumeric runs with single hyphen → trim → cap 60 chars), title shape (action-shaped, ≤60 chars, no dates), two worked examples (file + discard). The id rule is spelled out literally so two passes on the same friction collapse via isDuplicate. AGENT_LABELS entry added.*
- [x] **(agent)** Adapters in `src/intent/observation-callbacks.ts` — `diarize` and `triage` callables that wrap `runAgent` + JSON parse. *Both adapters defend: `diarize` returns the input unchanged on agent error / malformed JSON / missing signals array / no shape-valid signals (the next pass can try again). `triage` returns a `{file:false, reason}` discard on any failure rather than silently filing a malformed idea. Both strip markdown fences if the LLM lapses. Shape-checks ensure each SensorSignal has source/content/ts and each ProjectIdea has non-empty title/friction/id. Short-circuits on empty diarize input.*

#### B4. `ideas.md` baseline + reader

- [x] **(agent)** Create `docs/projects/ideas.md` with a header and a placeholder for the loop's appended bullets. *File already existed with user-authored entries; added `# Project Ideas` header, organized existing entries under `## User-authored`, added `## Loop-filed` section with an HTML-comment marker the B4.2 reader will use to scope parsing — keeps user-authored ideas and loop-filed ideas in distinct sections so dedupe never confuses them.*
- [x] **(agent)** `src/intent/observation-ideas-io.ts:readFiledIdeas(): ProjectIdea[]` — regex-parse each bullet (matching `formatIdeasMarkdown`'s shape), derive `id` the same way the triage agent does so dedupe matches. *Scopes parse to lines BETWEEN `## Loop-filed` and the next H2, so user-authored bullets above the section are never read. Bullet regex pins the em-dash specifically (matches formatIdeasMarkdown's output, rejects hyphen-minus typos). `deriveIdeaId` is exported and applies the same construction rule as the triage agent prompt verbatim — lowercase, non-alphanumeric runs → single hyphen, trim, truncate to 60. Tests pin the rule with the same examples the agent prompt uses.*
- [x] **(agent)** `appendFiledIdeas(markdown)` — append `formatIdeasMarkdown`'s output to the file. *Append goes at the END of the `## Loop-filed` section (after any prior loop entries and the HTML-comment marker), so the section grows append-only. Empty markdown is a no-op (quiet-pass safety). Missing Loop-filed section throws — surfaces a misconfigured file rather than silently writing to an unstructured one.*

#### B5. Nightly observation step

- [x] **(agent)** Add `observationStep()` to `src/jobs/nightly.ts`, slotted after KB queue and before lint. Build the `NightlyObservationDeps` from the readers (B2), the callbacks (B3), `decideFailClosed({}, {specOrigin: 'self-generated', …})`, and `readFiledIdeas()` (B4). *Step lives between "KB queue" and "KB lint" as `'Observation loop'`. Reads `policies/escalation-policy.json` once per pass; `decideEscalation(idea)` calls `decideFailClosed({specOrigin: 'self-generated'}, rawPolicy).verdict` so a missing/malformed policy escalates rather than auto-proceeding.*
- [x] **(agent)** Handle the result — `appendFiledIdeas(result.ideasMarkdown)`; for each `dispatch` plan call `createMutation(...)` against the gen-eval-loop kind from A3; for each `await-approval` plan, send a Telegram approval prompt naming the idea and the escalation reason. *appendFiledIdeas is wrapped in try/catch (logged warn on failure). Dispatch plans create `gen-eval-loop` mutations with `{product:'jarvis', project:<slug>}` source `'cron'`; createMutation rejections accumulate in `dispatchFailures` and flip the step status to `error`. await-approval plans publish a Telegram message via the bus when present (the bus is now an optional `executeNightly` option threaded from `runNightly`).*
- [x] **(agent)** Log the pass summary (counts of filed / discarded / duplicate / quiet) — meta telemetry the next pass can observe. *`stepObservation pass summary` log entry includes filed/discarded/duplicate/quiet counts plus dispatched/awaitingApproval/dispatchFailures. The step's `detail` string surfaces the same counts in the Telegram nightly summary so the user sees them too.*

### Track C — user surfaces (parallel-safe with Tracks A and B)

> The work that makes Tracks A and B **user-reachable**, per the
> user-reachability definition-of-done from
> [`agent-lessons.md`](agent-lessons.md). Each surface is specified in
> spec.md §"Cockpit UX in Detail" and §"Telegram UX in Detail".
>
> Order: C1–C8 can land in any order; C1, C3, C5 unblock the Track A
> live-verification step at the bottom of this file.

#### Tests (write first)

- [x] Write the test suite for the **cockpit UX** — test-plan.md §19
  (planning panel state transitions, approval inbox behavior, in-flight
  run progress accuracy). *Test-suite-as-deliverable (deviation #1): `src/server/cockpit-ux.test.ts` written test-first ahead of C1/C2/C3 impls. Three describe blocks pin the C1 POST /api/planning/{start,turn,approve,abandon} endpoints, the C2 GET /api/approvals + POST /api/approvals/:id/{approve,reject} endpoints, and the C3 `CockpitProject.progress` shape. 11 tests fail cleanly (404 fallthrough for missing endpoints, undefined progress field) — red is the success condition until C1-C3 ship. The DOM-side rendering tests are out of scope for this unit suite; the integration-verification check at the bottom of test-plan §19 covers them.*
- [x] Write the test suite for the **Telegram UX** — test-plan.md §20
  (`/plan` command flow, engine notification format per terminal class,
  inline-button approval round-trip). *Test-suite-as-deliverable: `src/transport/telegram-ux.test.ts` written test-first ahead of C5/C6. Three describe blocks: /plan command (C4 — already shipped via A4.3, 6 rows marked as `.todo` documentation), engine notifications (C5 — gen-eval-loop terminal events emit structured ✅ merged / ⏸ blocked / 💥 failed messages with rounds + cross-model verdict + short id, distinct from the generic work-run summary), approval inline-buttons (C6 — `sender.send(userId, prompt, {approval: {...}})` renders as inline-keyboard via bot.sendMessage with reply_markup, each button's callback_data carries its option value). 5 red (C5 format + C6 keyboard render) until C5/C6 impls land.*
- [x] Write the test suite for **journal-to-intent end-to-end** —
  test-plan.md §21 (tagged journal note → proposal → approval →
  synthesis into vault product file + roadmap into product repo). *Test-suite-as-deliverable: `src/intent/journal-intent-e2e.test.ts` pins the C7 producer (`scanJournalForIntent`, `runJournalIntentProducer` with idempotency/dedupe by sourceNoteId) and C8 consumer (`actionApprovedIntentProposal` dispatching to invokeVaultUpdater / appendRoadmap / registerProduct per proposal kind; disambiguation produces no write). 11 red until C7/C8 land; cross-surface plumbing covered by §19/§20 suites.*
- [x] Confirm red before implementation. *All three Track C test suites confirmed red cleanly: cockpit-ux.test.ts (11 fail / 12 auth-pass / 0 syntax errors), telegram-ux.test.ts (5 fail / 3 pass / 6 todo / 0 syntax errors), journal-intent-e2e.test.ts (11 fail / 0 pass / 1 todo / 0 syntax errors). Total 27 expected-red tests vs 2694 passing baseline — failures are all missing-module or missing-endpoint, no infrastructure issues.*

#### C1. Cockpit planning panel

- [x] **(agent)** Add the planning panel to `src/server/static/` —
  HTML structure, JS state machine for `scoping` / `spec-proposed` /
  `approved` / `abandoned`, reply textarea, **Approve** / **Refine** /
  **Abandon** actions. Match the ASCII mockup in spec.md §"Cockpit UX
  in Detail". *Slide-in panel (right-side overlay, 480px wide) with header (title + status pill + close), scrollable transcript, scoping section (reply textarea + Cmd+Enter shortcut), and spec-proposed section (artifact preview with title/spec/tasks/test-plan in scrollable monospace blocks + Approve/Refine/Abandon row). Status pill color-coded per state (blue scoping / amber spec-proposed / green approved / red abandoned). State machine in app.js wires the four POST endpoints from C1.2; tries to parse the fenced ```spec-artifact JSON block from the assistant's reply so the artifact renders client-side without a separate fetch. `openPlanningPanel(product)` exposed on `window` for C1.3's Plan-button wiring. Toast on approve/abandon close.*
- [x] **(agent)** Add `POST /api/planning/turn` to `src/server/webview.ts`
  that calls `handlePlanningTurn` from A4.2; add `POST /api/planning/start`
  that calls `createPlanningSession`; add `POST /api/planning/approve` /
  `/abandon` that mutate the session and (on approve) call the
  scaffolding hook from A4.4. *Four handlers added to webview.ts wired into mountWebviewRoutes after the ops-cancel branches. Auth-gated via the shared verifyAuth path. start: 400 missing product, 200 with session id. turn: 400 missing text, 404 no-active-session, 200 with {reply, status}. approve: routes via approveActivePlanningSession → on `ok:true` calls runAgent('project-setup-writer', buildSetupWriterBrief) then deletePlanningSession; on `no-session` → 404, on `wrong-status` → 409, on agent failure → 500 (session stays approved for retry). abandon: idempotent 200. All 9 C1-targeted cockpit-ux tests now green.*
- [x] **(agent)** Wire the cockpit project card's existing **Plan**
  button to open the panel (replaces the current placeholder that
  stuffs text into the chat input). *`cockpitAction(slug, action, product)` for `enter-planning-mode` now calls `window.openPlanningPanel(product)` (exposed by C1.1 from the IIFE). Defensive fallback to the prior `sendMessage('/plan ${product}')` chat-dispatch path if the panel JS didn't load (partial reload, etc.) so the user can still start a planning session.*

#### C2. Cockpit approval inbox

- [ ] **(agent)** New sidebar panel in `src/server/static/` listing
  pending approvals from `intent-proposal-queue`, `playbook-queue`,
  `proposal-queue`, and the supervision-store's `blocked-on-human`
  runs. Each row renders product/project, type, summary, age, and
  **Approve** / **Reject** / **Open** buttons per the ASCII mockup.
- [x] **(agent)** REST endpoints in `src/server/webview.ts`:
  `GET /api/approvals` (list across all sources),
  `POST /api/approvals/:id/approve`, `POST /api/approvals/:id/reject`.
  Approve routes to the actioning path appropriate to the proposal
  type (see C8 for journal-intent). *Unified ApprovalRow shape across four sources (intent-proposal-queue, playbook-queue, ask-twice proposal-queue, supervision blocked-on-human). Composite id `<source>:<index|run-id>` so POST endpoints dispatch without an extra lookup. Approve/reject flips the queue entry's `status` field (the existing post-review/nightly actioning paths consume approved entries — that's C8 for journal-intent; playbook-updater + proposal-updater already handle the others). blocked-on-human rows surface in the list but return 404 on approve/reject (the user must take the underlying action via cancel or re-dispatch, not a queue-status flip). Both C2 cockpit-ux tests green.*

#### C3. Cockpit in-flight run progress

- [x] **(agent)** Extend `CockpitProject` (in `src/intent/cockpit.ts`)
  with optional `progress: { round, failedEvaluatorRounds, modelGen,
  modelEval, lastHeartbeatAt }` fields populated from the supervised-run
  store + the `progress` MutationEvents A3.4 emits. *Also added optional
  `mutationId` (so the Cancel button can route to
  `POST /api/mutations/<id>/cancel`) and `cap` (max evaluator rounds —
  enables the `round N / cap` display) — both optional and additive.
  `RunStatusByProject` widened to a union of bare `CockpitRunStatus`
  (legacy callers) or an entry object carrying `{status, progress?}`
  (C3 callers); `buildCockpitView` normalizes both. The narrow scope
  fix in `cockpit-run-status.ts` keeps the `'blocked-on-human' wins`
  guard a simple `===` check. The wiring from the gen-eval-loop
  runner's `progress` MutationEvents into the entry shape arrives in
  a follow-up — until then the field is shape-correct and idle.*
- [x] **(agent)** Update the project card render in
  `src/server/static/app.js` to display the round / failed-rounds /
  model / heartbeat-age line + a **Cancel** button when `progress` is
  present, per the ASCII mockup. *Two-line block: `round N [/cap] ·
  failed evaluator: M · Xs ago` then `gen: <model> · eval: <model>`
  when models are set, plus a Cancel button when `mutationId` is set.
  Heartbeat is amber when `now − lastHeartbeatAt ≥ STALL_THRESHOLD_MS`
  (mirroring `src/jobs/stall-check.ts`), or when the timestamp is
  non-parseable. Cancel POSTs to `/api/mutations/<id>/cancel` (the
  webview route now `decodeURIComponent`s its captured id for
  consistency with the approval routes).*

#### C4. Telegram `/plan` command

- [x] **(agent)** New `src/bot/commands/plan.ts` exporting
  `handlePlan(sender, userId, args)`. With a product slug, calls
  `createPlanningSession(userId, idea, 'chat', product)` from A4.1;
  without one, lists registered products and asks which. *Shipped
  during A4.3 as part of the multi-turn Socratic planning handler;
  file exists at `src/bot/commands/plan.ts` and dispatches through
  `createPlanningSession` with surface `'chat'`.*
- [x] **(agent)** Update `src/bot/handlers/text.ts` so an active
  planning session (from `getActivePlanningSession`) takes routing
  priority over the default conversation thread — analogous to how
  active review sessions are routed today. *Shipped during A4.3 —
  `text.ts:189-192` checks `getActivePlanningSession(userId)` before
  the default conversation route; `/plan`, `/clear`, `/fresh` and
  other slash commands short-circuit above this point so they reach
  their own handlers instead of being captured by the planning thread.*
- [x] **(agent)** Register `/plan` in `src/bot/skill-registry.ts`'s
  `SLASH_COMMAND_METADATA` so the resolver can route it. *Entry at
  `skill-registry.ts:168` with description and trigger phrases. The
  6 `.todo` rows in `src/transport/telegram-ux.test.ts` are
  documentation stand-ins — the routing path is exercised by the
  existing `handleTextMessage` tests, and the C4 sub-tasks above
  describe the contract.*

#### C5. Telegram engine notifications

- [x] **(agent)** Extend `TelegramSender.onMutationEvent()` to detect
  terminal events for `gen-eval-loop` mutations and emit user-friendly
  notification messages per the formats in spec.md §"Telegram UX in
  Detail" (✅ merged / ⏸ blocked on you / 💥 failed). The existing
  generic tracker message stays; this adds the structured terminal one.
  *Branches on `event.mutationKind === 'gen-eval-loop'` (new required
  field on `BusMutationEvent`, populated by `mutations.ts` from
  `descriptor.kind`). Three structured formats: completed → `✅
  <product>/<project> merged to main · N rounds · cross-model PASS ·
  id=<8>`; escalated failed (failedEvaluatorRounds + cap both set) →
  `⏸ blocked on you · N/cap failed evaluator rounds · <reason> ·
  id=<8>`; hard failed → `💥 failed · <reason> · id=<8>`. The
  gen-eval-loop runner now emits `product`, `project`, `cap`, and
  `adjudication` on its terminal events so the formatter renders the
  full structured message at runtime — the test fixtures already
  supplied these fields, but the runner wasn't, so without this fix
  the messages would have degraded to UUID-fragment-with-no-context
  in production. Non-gen-eval-loop mutations keep the legacy
  `/work --auto on <slug>` format (regression test green).*
- [ ] **(agent + user)** Live verification — run a gen-eval-loop
  end-to-end and confirm the notification format reads cleanly on the
  user's Telegram client; refine wording in this commit.

#### C6. Telegram approval inline-buttons

- [x] **(agent)** When the engine surfaces a propose-and-approve
  artifact for Telegram, call `sender.send(userId, prompt, { approval:
  { prompt, options: [...] } })` — the `SendOpts.approval` field
  already exists in `src/transport/sender.ts`. *`TelegramSender.send()`
  now detects `opts.approval` and renders one inline button per option
  via `bot.sendMessage(userId, text, { reply_markup: { inline_keyboard:
  [[buttons]] } })`; each button carries its option value as
  `callback_data`. Plain sends still go through `sendLongMessage`
  unchanged.*
- [x] **(agent)** Wire the bot's callback-query handler to route the
  inline-button payloads through the same actioning path the cockpit
  approval inbox uses (C2), so a proposal acted on in either surface
  is reflected in both. *Extracted `dispatchApprovalStatus`,
  `parseApprovalId`, and the per-source set-status helpers into a new
  `src/transport/approval-actions.ts` module so both the HTTP cockpit
  routes and the Telegram handler share one actioning path; module
  lives under `transport/` (not `server/`) because it's
  transport-agnostic. The new `callback_query` handler in
  `src/bot/telegram.ts` auth-gates by `TELEGRAM_USER_ID`, acks the
  query, then routes payloads:
    - `approve:<id>` / `reject:<id>` (or `approved:`/`rejected:`) —
      explicit status prefix, plus a bare composite-id that defaults
      to `approved`, all routed through `dispatchApprovalStatus`.
    - conversational values (`yes`, `cancel`, `approve`, `refine`,
      `abandon`) — fed via `dispatchText` so an active review/planning
      session sees them as the user's reply. Slash-prefixed values are
      rejected (a callback button should never trigger a destructive
      command).
  Hardening: `dispatchApprovalStatus` is wrapped in try/catch because
  it's called from an EventEmitter listener (a sync throw would crash
  the process); the underlying `safeWrite` traps disk-write failures
  into a three-valued result (`'ok'|'not-found'|'error'`) so the HTTP
  path can surface a 500 on disk error rather than a misleading 404.*

#### C7. Journal-to-intent producer

- [x] **(agent + user)** New nightly job step in `src/jobs/nightly.ts`
  that scans the day's journals for product-tagged notes (the convention
  already exists for `#playbook`, `#crm`, `#meeting`; extend with
  product slugs) and writes proposals to
  `logs/intent-proposal-queue.json` via the existing queue API. Live
  verification refines the scan heuristics. *Step
  `stepJournalIntentProducer(content)` inserted between Playbook extract
  and Journal ingest in `runNightly`. Reads the registry to fetch
  registered products (missing/malformed registry → empty list +
  warn-log, so every mention surfaces as a `register-product` proposal
  rather than silently dropping). Dedupes against the existing queue by
  `sourceNoteId`. `appendIntentProposals` is wrapped in try/catch so a
  disk-write failure surfaces as an error step with context, not a raw
  exception. Live verification (the heuristics-refinement subtask) is
  user-driven and stays open for a real-world journal pass.*
- [x] **(agent)** Pass each detected note through `planJournalIntent`
  (from `src/intent/journal-intent.ts`) to produce the structured
  `IntentProposal` before queueing. *`runJournalIntentProducer` is the
  unified entry point: it calls `scanJournalForIntent` to turn journal
  markdown into `JournalNote[]`, hands those to `planJournalIntent`,
  derives a stable SHA-256-prefix `sourceNoteId` per emitted proposal,
  drops anything already in `existingQueueEntries`, and returns the
  fresh entries for the caller to enqueue. The scanner skips a curated
  list of non-product tags (`#playbook`, `#crm`, `#meeting`, `#diet`,
  `#books`, `#study`, `#place`, `#priorities`, `#workouts`,
  `#applications`, `#investments`, etc.) so no journal-routing tag
  produces a spurious `register-product` proposal.*

#### C8. Journal-to-intent consumer

- [ ] **(agent + user)** Post-approval actioning: on approve (from
  cockpit C2 or Telegram C6), for an `IntentProposal` of kind
  `vault-intake`, synthesize the note into `projects/<product>.md`
  (propose-and-approve — uses an updater agent for the actual edit);
  for `roadmap`, append a roadmap item to the product repo's roadmap
  file; for `register-product`, run the registration flow from
  Phase 1.
- [ ] **(agent)** Update CLAUDE.md to drop the "The post-approval
  actioning path … is a later task" note (it lands here).

### Live verification → Done

- [ ] **(agent + user)** v1 wedge end-to-end against Aura (or Assay): a coding idea raised in chat → Planner conversation → approved spec → Jarvis spawns a sandboxed `/work --auto` against the worktree → cross-model `/review` adjudicates → the change auto-merges to the product's main line, no human action between spec approval and merge. (Agent drives the test setup; user observes a real run.)
- [ ] **(user)** Let Jarvis run a week. Confirm `logs/observation-interactions.jsonl` is growing, `docs/projects/ideas.md` is gaining entries from real friction, and a low-risk filed project gets dispatched and merges itself.
- [ ] **(user)** Flip the 08-intent-layer row in `docs/projects/index.md` from "In Progress" to "Done".
