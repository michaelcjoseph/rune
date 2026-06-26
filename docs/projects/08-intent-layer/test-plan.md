# Intent Layer Test Plan

Behavior and error-handling checklist for the intent-layer orchestrator: the foundational tier (registry, product registration, overlay index, agent definitions, model selection policy, escalation policy), the cockpit and journal intake, the five execution layers, and operational self-improvement.

> See also: existing tests under `src/` — `src/jobs/work-runner.test.ts`, `src/ai/claude.test.ts`, `src/server/webview.test.ts`, `src/server/state-snapshot.test.ts`, `src/bot/resolver.test.ts` — and the eval framework under `evals/`.

## Priority Levels

- 🔴 **Critical**: Breaks the engine, corrupts the vault or a product repo, or silently loses work.
- 🟡 **High**: Degrades the workflow — wrong routing, a missed approval, a stalled run going unnoticed.
- 🟢 **Low**: Cosmetic or rare — formatting, edge-case logging.

## How this maps to phases

Each numbered section is tagged with the phase that builds it. This project is **test-first**: a phase's "Tests (write first)" task in [tasks.md](tasks.md) writes every scenario in that phase's sections, and those tests must fail before the phase's implementation tasks begin. Implementation for a phase is done when its sections here pass.

| Phase | Sections |
|---|---|
| Phase 1 — Foundational tier | 1, 2, 3, 4, 5, 6 |
| Phase 2 — Cockpit and journal intake | 7, 8 |
| Phase 3 — Intent layer and v1 wedge core | 9, 10, 11, 12 |
| Phase 4 — Multi-model dispatch and cross-review | 13, 14, 15 |
| Phase 5 — Operational self-improvement | 16 |
| Cross-cutting | 17, 18 |
| Phase 6 Track C — user surfaces | 19, 20, 21 |

Every section below carries an **Integration verification** sub-bullet at the
end — per the user-reachability rule in
[`../templates/planning-checklist.md`](../templates/planning-checklist.md),
each section names the user-action that exercises the deterministic core
end-to-end. A section is not complete until both the unit-level bullets and
the integration scenario pass.

---

## 1. Product/project registry (Phase 1)

### Aggregation

- [ ] 🔴 The registry returns every product and its projects in one query, across all product repos and all vault product files.
- [ ] 🔴 A project's lifecycle status (planned / active / done) in the registry matches the Status column in its repo's project docs.
- [ ] 🔴 The registry is rebuildable: deleting it and regenerating from repos + vault product files yields an identical model.
- [ ] 🟡 A repo with no project docs surfaces as a product with zero projects, not an error.
- [ ] 🟡 The registry never reports run-status (running / blocked) — that lives in supervision (§10). Registry output carries lifecycle status only.
- [ ] 🟢 A cold-start registry build logs its timing and the count of products/projects scanned.

### Writes and corruption

- [ ] 🔴 A lifecycle-status change in a repo's project docs is reflected after the intent layer next writes the registry.
- [ ] 🟡 Two projects changing status at once do not produce a partial file — last-write-wins or a documented merge, never a torn write.
- [ ] 🟡 A malformed registry file fails fast on read with a clear error; it is not silently treated as an empty model.

**Integration verification:** opening the cockpit shows every product and
project from the registry; deleting `logs/registry.json` and refreshing the
cockpit rebuilds the view identically — confirming the registry is reachable
from the cockpit surface and is rebuildable in practice.

## 2. Product registration (Phase 1)

### Registering a product

- [ ] 🔴 Registering a product creates the vault product file `projects/<product>.md` if it is missing.
- [ ] 🔴 Registration adds the registry entry and creates the product-overlay manifest.
- [ ] 🔴 Registration links a code repo when one exists; a product with no repo is still registered and tracked, just marked not-executable.
- [ ] 🔴 Registration writes to the vault, so it is propose-and-approve — nothing lands without Michael's confirmation.
- [ ] 🟡 Registering a product that already has a vault file does not overwrite the file's contents; it only fills missing registry/manifest pieces.
- [ ] 🟢 The proposal shows Michael exactly which files/entries will be created before he approves.

### Reconciliation pass

- [ ] 🔴 A product present as a repo but with no vault product file is detected and its missing pieces proposed.
- [ ] 🔴 A product referenced in journals but absent from the registry is detected and proposed.
- [ ] 🔴 The first reconciliation pass over the current products creates a vault product file for every product that lacks one (family, health) and seeds the registry + overlay manifests, so the foundational tier starts complete.
- [ ] 🟡 The reconciliation pass is idempotent — a second run with nothing changed proposes nothing.
- [ ] 🟡 A repo present on disk but clearly not a product (e.g. `agent-coding-setup`) is not proposed as a product, or is proposed with a clear "confirm this is a product" prompt.

**Integration verification:** naming a new product in chat ("let's track a new
product called X") triggers the registration proposal flow on a surface the
user sees (cockpit approval inbox or Telegram inline-button message);
approving it creates the vault product file, registry entry, and overlay
manifest — all three visible on disk and in the next cockpit refresh.

## 3. Product-overlay index (Phase 1)

- [ ] 🔴 A product's manifest points at the journal entries, pages, world-view sections, and wiki concepts relevant to that product.
- [ ] 🔴 Product-scoped retrieval for a sub-agent returns only the target product's slices — planning an Aura project does not pull in Relay context.
- [ ] 🟡 The vault is not moved or reorganized — the manifest only points into the existing type-organized structure.
- [ ] 🟡 A manifest entry pointing at a file that was deleted or renamed is detected (stale-pointer handling, not a crash).
- [ ] 🟢 A product with very little vault content yields a small but valid manifest, not an error.

**Integration verification:** when the Planner (§9) runs for an Aura project,
its retrieved context contains only Aura-tagged sources — inspectable via the
spawn's input log or the agent's reported sources, confirming product-scoped
retrieval is reachable from the actual planning conversation surface.

## 4. Model-agnostic agent definitions (Phase 1)

- [ ] 🔴 The neutral agent-definition format captures role, tools, constraints, and declared capabilities.
- [ ] 🔴 The Claude compiler reproduces today's `.claude/agents/*.md` for every existing agent with no behavior change.
- [ ] 🔴 Every existing agent round-trips: existing definition → neutral format → Claude format produces an equivalent agent.
- [ ] 🟡 No model name is present in any agent definition — model choice is left to the policy (§5).
- [ ] 🟡 An agent definition missing a required field fails compilation with a clear error naming the field.
- [ ] 🟢 The Codex and Gemini compiler targets are stubbed/deferred to Phase 4 without breaking the Claude path.

**Integration verification:** every existing user-facing entry point that
spawns an agent (`/morning`, `/review`, `/workout`, `/syllabus`, the
content-triager, wiki-compiler nightly, etc.) keeps working unchanged after
the neutral-format compiler ships — verifiable by running each agent and
confirming output equivalence.

## 5. Model selection policy (Phase 1)

### Registry and resolver

- [ ] 🔴 The deterministic resolver maps (role, declared capabilities, policy) to a concrete model with no LLM call.
- [ ] 🔴 Selection precedence holds: an explicit pin beats the role default, which beats the global fallback.
- [ ] 🔴 The resolver picks only a model whose capability tags satisfy the role's declared needs.
- [ ] 🔴 Models are referenced by alias, never a pinned version ID.
- [ ] 🔴 Every resolution logs the chosen model and which precedence rule fired.
- [ ] 🟡 A role whose needs no `active`/`preferred` model satisfies fails loudly, naming the unmet capability — it does not silently fall back to an unfit model.

### Updating as models change

- [ ] 🔴 Adding a registry entry (new model, status `active`) makes it selectable with no code change.
- [ ] 🔴 Flipping a model to `preferred` for a role makes it that role's default on the next resolution.
- [ ] 🔴 A model set to `deprecated` is no longer selected; a dispatch that explicitly pinned it fails loudly rather than silently rerouting.
- [ ] 🟡 A malformed policy file fails fast at startup with a clear error, not a silent default.

### Cross-model adjudication constraint

- [ ] 🔴 With the `evaluator.distinct_from: generator` constraint set, the resolver never returns the same provider family for Evaluator and Generator.
- [ ] 🟡 If the constraint cannot be satisfied (only one provider family available), the resolver surfaces the conflict rather than silently violating it.

### Integration with `runAgent`

- [ ] 🔴 `runAgent` resolves its model through the policy; agents unchanged by this project keep their current effective model.
- [ ] 🟡 An agent's frontmatter `model:` override still wins, mapped onto the policy's explicit-pin precedence.

**Integration verification:** running any agent through a normal user flow
logs the chosen model + rule that fired in `logs/agent-runs.jsonl`; flipping
a model to `deprecated` in `policies/model-policy.json` and re-running an
agent that previously used it picks the next-best model on the next user
interaction (no restart needed if the policy cache invalidates).

## 6. Escalation policy (Phase 1)

- [ ] 🔴 The escalation policy is a declarative file, data not code — adding or changing a rule needs no code change or deploy.
- [ ] 🔴 Given a change the policy classifies as high-risk, the decision is "escalate to blocked-on-Michael"; given one that matches no condition, the decision is "proceed".
- [ ] 🔴 The decision is deterministic — the same inputs always yield the same escalate/proceed verdict, with no LLM call in the resolver.
- [ ] 🔴 A malformed or missing escalation policy fails closed: the engine escalates or halts, it never falls open to permissive auto-merge.
- [ ] 🔴 The policy covers all four escalation conditions from the spec — a high-risk change class, an unresolvable cross-model review, a run exceeding its bounds, and a self-generated spec too consequential to approve unattended.
- [ ] 🔴 Every escalation decision is logged with the condition or rule that fired (auditable).
- [ ] 🟡 A change matching no escalation condition resolves to "proceed" without consulting Michael.
- [ ] 🟢 An escalation surfaces in the supervision visibility surface (§10) and the cockpit as blocked-on-Michael.

**Integration verification:** a `gen-eval-loop` mutation that hits 3 failed
evaluator rounds surfaces in the cockpit approval inbox (§19) as
`blocked-on-human` with the escalation reason; deleting
`policies/escalation-policy.json` makes the next escalation decision
fail-closed (visible in `logs/jarvis.log` as an `error`-level entry).

## 7. Product/project cockpit (Phase 2)

- [ ] 🔴 The cockpit shows every product, its projects, and each project's lifecycle status, read from the registry.
- [ ] 🔴 The cockpit owns no state — deleting it and rebuilding from the registry + repos + vault loses nothing.
- [ ] 🔴 Start / continue / enter-planning-mode actions are gated per-action (each is an explicit click).
- [ ] 🔴 The cockpit shows run-status (running, blocked on Michael) from the supervision surface, distinct from lifecycle status.
- [ ] 🟡 06-webview's existing surface (localhost chat, Telegram session sharing, sidebar) keeps working unchanged.
- [ ] 🟡 The registry being briefly unavailable shows a clear "registry unavailable" state, not a blank or broken page.
- [ ] 🟢 A product with zero projects renders cleanly.

**Integration verification:** opening `http://127.0.0.1:3847/` in a browser
shows every product and project with current lifecycle and run-status; the
sidebar Start / Continue / Plan buttons gate per-click (a single click
surfaces a confirmation modal, no double-fire).

## 8. Journal-to-intent flow (Phase 2)

- [ ] 🔴 Raw notes about a product in the daily journal are synthesized into that product's vault file, propose-and-approve.
- [ ] 🔴 The flow never silently rewrites scope — Michael sees the inferred change and confirms it.
- [ ] 🔴 The actionable part of a vault product file is proposed as roadmap items into the correct product repo, propose-and-approve.
- [ ] 🟡 A note that mentions an unregistered product triggers product registration (§2) rather than being dropped.
- [ ] 🟡 An ambiguous note (could belong to two products) is surfaced for disambiguation, not guessed silently.
- [ ] 🟡 Intake proposals and carried-over roadmap items both surface for approval on Telegram and in the cockpit.
- [ ] 🟢 A journal day with no product-relevant notes produces no proposals and no noise.

**Integration verification:** see §21's end-to-end scenario — a product-tagged
journal note becomes a proposal visible in the cockpit approval inbox (§19),
approving it synthesizes the note into `projects/<product>.md` and carries
the roadmap item into the product repo. The integration here is exercised
by the same scenario.

## 9. Planner — Layer 1 (Phase 3)

- [ ] 🔴 The Planner turns a fuzzy idea into an approved spec through conversation — it asks questions and surfaces assumptions rather than accepting a one-line task.
- [ ] 🔴 Nothing is dispatched before the spec artifact is approved; for a Michael-initiated project, that approval is Michael's.
- [ ] 🔴 On approval, the artifact is scaffolded into `spec.md`, `tasks.md`, and `test-plan.md` via `project-setup-writer`, and the `tasks.md` carries the per-phase Tests block.
- [ ] 🟡 The Planner conversation works identically on chat and in the cockpit's planning mode.
- [ ] 🟡 An idea abandoned mid-scoping leaves no half-written project files.
- [ ] 🟢 Planner retrieval is product-scoped via the overlay index (§3).

**Integration verification:** the cockpit planning panel (§19) and Telegram
`/plan` command (§20) both drive a real scoping conversation through
`handlePlanningTurn`; approval scaffolds the project's `spec.md` /
`tasks.md` / `test-plan.md` into the product repo (verifiable on disk).

## 10. Supervision — Layer 3 (Phase 3)

- [ ] 🔴 A long-running run is dispatched in the background and tracked; the engine does not block on it.
- [ ] 🔴 The visibility surface correctly reports which runs are active and which are blocked on Michael.
- [ ] 🔴 A run that goes quiet past the heartbeat interval is flagged, not left silently stalled.
- [ ] 🔴 `/work --auto` remains directly invokable by Michael with unchanged behavior.
- [ ] 🟡 A crashed or killed run transitions to a terminal state in the visibility surface, never stuck "running" forever.
- [ ] 🟡 The visibility surface survives a Rune restart — in-flight runs are recovered or marked unknown, not lost.
- [ ] 🟢 Heartbeat checks are cheap and do not spam logs.

**Integration verification:** triggering a `gen-eval-loop` mutation produces
a `running` status on the cockpit's in-flight progress card (§19); killing
the Rune process mid-run and restarting flips the entry to `unknown` in
the same card on the next page load; a stall produces a Telegram nudge
within ~30s.

## 11. Sandboxing and security — Layer 4 (Phase 3)

- [ ] 🔴 Each project runs in its own git worktree; two concurrent projects cannot touch each other's working tree, branches, or build state.
- [ ] 🔴 Because only one project runs per product at a time, two runs never share a repo or its main line (see §15).
- [ ] 🔴 A run reaches only its own repo's scoped credentials — it cannot read another product's secrets.
- [ ] 🔴 Egress is allowlisted; a run cannot reach a host outside the allowlist.
- [ ] 🔴 Regime B execution writes only within its worktree and never to the vault; a change reaches the repo's main line only by passing the merge contract (cross-model review and tests) and clearing the escalation policy.
- [ ] 🟡 Untrusted inbound content (a fetched page, an issue body) cannot escalate a run's permissions — prompt-injection defense holds.
- [ ] 🟡 A worktree is cleaned up after its project finishes or is abandoned; worktrees do not accumulate.
- [ ] 🟢 A worktree-creation failure aborts the run cleanly with a clear error.

**Integration verification:** triggering a `gen-eval-loop` mutation creates
a worktree at `<WORKTREE_ROOT>/<product>/<project>` (verifiable on disk via
`git -C <repo> worktree list`); the run terminates and the worktree is
removed; a denied egress attempt during the run appears in
`logs/egress-denials.jsonl`.

## 12. Generator-Evaluator loop, single-model — Layer 2 (Phase 3)

- [ ] 🔴 The full loop runs end to end on one model against one repo-backed product: approved spec → `/work` Generator → `/review` Evaluator → result on a branch.
- [ ] 🔴 The Generator works test-first: tests mirroring `test-plan.md` are written and failing before implementation for a task begins.
- [ ] 🔴 The Evaluator is a separate, skeptical pass — it is not the Generator grading its own output.
- [ ] 🔴 The loop is bounded: after a few failed Evaluator rounds the run is escalated to blocked-on-Michael, not retried forever.
- [ ] 🔴 The Phase 3 single-model loop stops at a branch and never merges to main on its own — autonomous merge is held until Phase 4, when cross-model review exists.
- [ ] 🟡 The Evaluator runs as a step of every loop pass, establishing the loop shape that Phase 4's cross-model upgrade slots into.
- [ ] 🟡 A run that fails its own tests never reaches the Evaluator as "ready."

**Integration verification:** a user-triggered `gen-eval-loop` runs `/work
--auto` then `/review` per round; per-round `progress` events appear on the
cockpit project card (§19); a pass terminates on a branch (visible as a new
branch in the product repo, no merge); three failed evaluator rounds
escalate visibly in the cockpit approval inbox.

## 13. Multi-model dispatch — Layer 5 (Phase 4)

- [ ] 🔴 Codex is wired as a dispatchable executor; an agent definition compiles to the Codex target and runs.
- [ ] 🔴 A dispatch carries an explicit, structured handoff message — no reliance on in-place context compaction.
- [ ] 🔴 The same neutral agent definition produces an equivalent agent on both the Claude and Codex targets.
- [ ] 🟡 A model/provider being unavailable mid-dispatch fails the run cleanly with a clear error, leaving the worktree intact for retry.
- [ ] 🟢 Dispatch logs record which model and provider executed each run (for cost attribution).

**Integration verification:** a `gen-eval-loop` mutation in autonomous mode
dispatches the Generator to one provider and the Evaluator to a different
provider; both dispatches appear in `logs/dispatch-log.jsonl`; the cockpit
project card shows `gen: Claude · eval: Codex` (or the live values) on the
in-flight progress display.

## 14. Cross-model adjudication — Layer 2 upgrade (Phase 4)

- [ ] 🔴 For an autonomous engine run, the Evaluator resolves to a different provider family than the Generator, on every run — cross-model review is mandatory before every merge.
- [ ] 🔴 When cross-model review and the test suite pass and the escalation policy does not flag the change, Rune merges the result to the product repo's main line itself, with no human action.
- [ ] 🔴 Manual `/review` stays single-model by default; `/review --cross-model` opts into adjudication.
- [ ] 🔴 The single-model loop from Phase 3 still works — cross-model is an upgrade, not a replacement.
- [ ] 🔴 If the second provider is unavailable, the run cannot satisfy the merge contract — it escalates to blocked-on-Michael, it does not degrade to single-model and merge unreviewed.
- [ ] 🟢 The adjudication result records both models and the verdict.

**Integration verification:** an autonomous `gen-eval-loop` run that
produces a cross-model PASS auto-merges to the product repo's main line
(visible in the product repo's `main` branch and in the user's Telegram
notification `✅ <product>/<project> merged to main`); a FAIL escalates
to `blocked-on-human` (visible in the cockpit approval inbox + a Telegram
`⏸ blocked on you` message).

## 15. Concurrency scheduler (Phase 4)

- [ ] 🔴 The scheduler enforces a global cap of N concurrent projects across all products.
- [ ] 🔴 Only one project runs per product at a time — a second project for a product that already has an active project is queued, not started.
- [ ] 🔴 An (N+1)th project is queued, not dropped, and starts when a slot frees.
- [ ] 🟡 The scheduler generalizes `WORK_RUN_GLOBAL_CAP` and tightens the per-project cap into a per-product cap of one, rather than introducing a parallel concurrency model.
- [ ] 🟡 Two projects on different products auto-merging at the same time each land cleanly on their own repo — there is no shared main line to contend for.
- [ ] 🟢 The cockpit reflects queued-vs-running accurately.

**Integration verification:** triggering two `gen-eval-loop` mutations
concurrently for two different products shows both as `running` on their
respective cockpit project cards; triggering a third for an
already-running product surfaces a `queued` state on its card and starts
when a slot frees.

## 16. Operational self-improvement — observation loop (Phase 5)

- [ ] 🔴 The observation loop extends the existing Ask-Twice telemetry — it does not duplicate or break it.
- [ ] 🔴 The sensor layer ingests all three sources: vault signals, product telemetry, and logged Rune interactions.
- [ ] 🔴 Every Rune interaction is logged, successful or not; failed, mis-routed, and rephrased interactions are captured as signal, not only repeated questions.
- [ ] 🔴 The synthesis stage diarizes raw sensor signal into a compact, structured digest before the loop reasons over it — the loop never consumes raw logs directly.
- [ ] 🔴 The loop has a discard half: a friction signal not worth a project is dropped, not filed.
- [ ] 🔴 A friction signal worth acting on is filed as a project into `docs/projects/ideas.md`, and the loop dispatches the execution engine to run it, within the concurrency and escalation rules.
- [ ] 🔴 Execution uses the existing project-execution engine pointed at the Rune product — no new execution subsystem.
- [ ] 🔴 A low-risk self-generated project is specced and run unattended; a self-generated spec the escalation policy flags waits for Michael.
- [ ] 🟡 The loop de-dupes — the same friction observed repeatedly does not file a new project each time.
- [ ] 🟡 The loop runs nightly, extending the existing nightly vault review rather than as a separate job.
- [ ] 🟢 A quiet period with no friction files and runs nothing.

**Integration verification:** a week of normal Rune use grows
`logs/observation-interactions.jsonl` to a visible size; `docs/projects/ideas.md`
gains entries from real friction (inspectable via git diff); a low-risk
filed project is dispatched autonomously and the user receives its terminal
Telegram notification — confirming the loop is reachable end-to-end as a
running background process, not just as tested cores.

## 17. Two-regime safety and integration (cross-cutting)

- [ ] 🔴 Regime A (raw-note processing, KB, second-brain memory, reviews, morning prep) behaves exactly as before — this project does not change it.
- [ ] 🔴 The only Regime B → vault write is a generalizable lesson promoted to playbook/world-view, and it runs propose-and-approve.
- [ ] 🔴 Every vault write in the system (registration, journal-to-intent, lesson promotion) is propose-and-approve; none is silent.
- [ ] 🔴 No change reaches a product repo's main line without passing the merge contract (cross-model review and the test suite) and clearing the escalation policy; there is no ungated autonomous merge.
- [ ] 🟡 The five write rules in the spec's write-rules table each behave as the table specifies (direction and gate).
- [ ] 🟡 The existing skills `/work`, `/work --auto`, and `/review` remain directly invokable by Michael throughout all phases.
- [ ] 🟡 The test-first change to `/work` does not break its existing non-`--auto` and `--auto` flows.
- [ ] 🟢 Phase-to-phase: state created in an earlier phase (registry, manifests, policy) survives later phases without migration surprises.

## 18. Resilience (cross-cutting)

- [ ] 🔴 A failed execution run is discardable — it corrupts no vault state and no product-repo main line.
- [ ] 🔴 A Rune restart mid-run does not lose the registry, the policies, or a project's worktree; in-flight runs recover or are clearly marked unknown.
- [ ] 🟡 A model timeout or CLI crash surfaces as a clear run error, not a silent hang.
- [ ] 🟡 A corrupt registry, model policy, escalation policy, or manifest file fails fast with a clear error and does not overwrite the good file with empty state.
- [ ] 🟡 A change that merged but proves wrong can be reverted cleanly — autonomous merge does not preclude rollback.
- [ ] 🟡 An approval that is never answered leaves the proposal pending — it never auto-applies or auto-discards.
- [ ] 🟢 Disk-write failure on any state file surfaces the error and keeps in-memory state for manual recovery.

## 19. Cockpit UX (Phase 6 Track C)

### Planning panel

- [ ] 🔴 Clicking **Plan** on a project card opens the planning panel with the
  project's product/title in the header and a clean scoping state (empty
  transcript + reply textarea).
- [ ] 🔴 Sending a reply via the panel calls `POST /api/planning/turn` and
  appends both the user message and the assistant question to the transcript.
- [ ] 🔴 When the planning handler returns `spec-proposed`, the panel
  re-renders to show the proposed `SpecArtifact` (title, spec, tasks,
  test-plan) with **Approve** / **Refine** / **Abandon** buttons visible.
- [ ] 🔴 Clicking **Approve** calls the scaffold hook (A4.4) and the panel
  closes with a confirmation toast; the named files appear in the product
  repo.
- [ ] 🟡 Clicking **Refine** keeps the artifact visible above the reply
  textarea, lets the user request revisions, and re-enters scoping mode.
- [ ] 🟡 Clicking **Abandon** (or `/clear` from chat) transitions the
  session to `abandoned` and closes the panel; a future `/plan` for the
  same project starts a fresh session.
- [ ] 🟡 The status pill in the panel header (`scoping` / `spec-proposed` /
  `approved` / `abandoned`) always reflects the current
  `StoredPlanningSession.planning.status`.

### Approval inbox

- [ ] 🔴 The inbox lists every pending approval from `intent-proposal-queue`,
  `playbook-queue`, `proposal-queue`, and supervision's `blocked-on-human`
  runs, with product/project, type, summary, and age per row.
- [ ] 🔴 Clicking **Approve** on a row routes to the actioning path for the
  proposal's type and removes the row from the inbox on success.
- [ ] 🟡 Clicking **Reject** removes the row from the inbox (logged for
  telemetry); the proposal does not auto-action later.
- [ ] 🟡 The inbox count badge in the sidebar matches the row count and
  updates without a page refresh after any Approve/Reject.
- [ ] 🟢 An empty inbox renders "No approvals pending."

### In-flight run progress

- [ ] 🔴 A project with an active `gen-eval-loop` mutation displays
  `round N / cap`, `failedEvaluatorRounds: N`, model in use, and
  time-since-last-heartbeat on its project card.
- [ ] 🔴 Per-round progress updates without a page refresh as the
  gen-eval-loop emits A3.4's `progress` events.
- [ ] 🟡 The heartbeat-age field turns amber once it exceeds
  `STALL_THRESHOLD_MS` from `src/jobs/stall-check.ts`.
- [ ] 🟡 A **Cancel** button is present on running cards and calls
  `cancelMutation(id)` when clicked.
- [ ] 🟢 An `idle` project shows the existing Start / Continue / Plan
  actions, not the progress fields.

### Integration verification

A user clicks **Plan** on the Aura `02-growth` project card, has a
three-turn scoping conversation, the panel surfaces a proposed spec,
the user clicks **Approve**, the project files appear in the Aura repo,
and within seconds the same project card shows `round 1 / 3` with a
fresh heartbeat — confirming the planning panel, scaffold hook,
gen-eval-loop dispatch, and in-flight run progress are all reachable
end-to-end from the cockpit.

## 20. Telegram UX (Phase 6 Track C)

### `/plan <product>` command

- [ ] 🔴 `/plan aura` creates a planning session for the `aura` product
  scoped to the calling user and replies with the first scoping question.
- [ ] 🔴 Subsequent messages from the same user route through
  `handlePlanningTurn` instead of the default conversation thread, until
  the session terminates.
- [ ] 🔴 When the handler returns `spec-proposed`, Rune sends an
  inline-keyboard approval message (see §"Approval inline-buttons" below).
- [ ] 🟡 `/plan` with no product lists registered products and waits for
  the user's choice before starting the session.
- [ ] 🟡 `/clear` or `/fresh` during a planning session abandons it; the
  user's next non-slash message routes to the default conversation thread.
- [ ] 🟢 A planning session active for one user does not affect routing
  for other users.

### Engine notifications

- [ ] 🔴 A gen-eval-loop completion sends a `✅ <product>/<project>
  merged to main · N rounds · cross-model PASS · id=<short>` message to
  the user once the mutation terminates as `completed`.
- [ ] 🔴 A gen-eval-loop escalation sends a `⏸ <product>/<project>
  blocked on you · N/M failed evaluator rounds · id=<short>` message
  with a one-line reason and a cockpit URL.
- [ ] 🔴 A gen-eval-loop hard failure (worktree create failure, applier
  crash) sends a `💥 <product>/<project> failed · <reason> · id=<short>`
  message.
- [ ] 🟡 Notifications do not duplicate — one terminal event sends one
  message (the existing tracker message is replaced on terminal, not
  added to).
- [ ] 🟢 The existing A2.4 stall nudge (`⚠️ Run stalled …`) is still
  sent independently of these terminal-event notifications.

### Approval inline-buttons

- [ ] 🔴 A `sender.send(userId, prompt, { approval: { prompt, options }})`
  call from any actioning path renders as a Telegram inline-keyboard
  message with one button per option.
- [ ] 🔴 Clicking an inline button routes the callback to the same
  actioning path the cockpit approval inbox uses, so the artifact's
  state is reflected in both surfaces.
- [ ] 🟡 The webview ignores `opts.approval` per the existing
  `MessageSender` contract — the same artifact does not double-action.

### Integration verification

A user runs `/plan aura` on Telegram, answers four scoping questions,
receives the spec-proposed message with **Approve / Refine / Abandon**
inline buttons, taps **Approve**, the project files appear in the Aura
repo, the gen-eval-loop starts and (after some minutes of real run) the
user receives a `✅ aura/03-onboarding merged to main` notification —
confirming the `/plan` command, the planning handler, the inline-button
approval round-trip, and the engine notification format are all
reachable end-to-end from Telegram.

## 21. Journal-to-intent end-to-end (Phase 6 Track C)

- [ ] 🔴 A product-tagged note in today's journal (e.g.
  `#aura investigate caching layer`) is detected by the nightly
  producer (C7) and written as a `vault-intake` or `roadmap`
  `IntentProposal` to `logs/intent-proposal-queue.json`.
- [ ] 🔴 The proposal surfaces in the cockpit approval inbox (§19) and
  optionally as a Telegram inline-button message (§20).
- [ ] 🔴 An approved `vault-intake` proposal synthesizes the note into
  `projects/<product>.md` via an updater agent; the file diff is
  visible in the vault git log.
- [ ] 🔴 An approved `roadmap` proposal appends a roadmap item to the
  product repo's roadmap file; the file diff is visible in the product
  repo's git log.
- [ ] 🟡 A rejected proposal is removed from the queue and not re-proposed
  on subsequent nightly runs for the same source note (dedupe by source
  note id).
- [ ] 🟡 The nightly producer is idempotent — running it twice on the
  same journal does not enqueue duplicate proposals.
- [ ] 🟢 A registered product the note targets but that doesn't exist
  yet generates a `register-product` `IntentProposal` instead of
  silently dropping the note.

### Integration verification

The user writes `#aura "morning thought: should we add a caching layer
to the API gateway?"` in today's journal. The nightly job runs.
Tomorrow morning the cockpit approval inbox shows the synthesized
proposal; the user clicks **Approve**; the note appears in
`projects/aura.md` and a roadmap item appears in the Aura repo — all
without any further user action — confirming the journal → producer →
queue → cockpit → consumer → vault/repo path is reachable end-to-end.
