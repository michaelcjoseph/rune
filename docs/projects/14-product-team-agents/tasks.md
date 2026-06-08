# Product-Team Orchestrated Work - Tasks

See [spec.md](spec.md) for architecture and [test-plan.md](test-plan.md) for verification.

> **Test-first by default.** Every phase below opens with a **Tests (write first)** block.
> Those tests mirror the matching [test-plan.md](test-plan.md) sections and must fail (red)
> before any implementation task in the phase begins. A phase's implementation is done when
> its test-plan sections pass.
>
> This is the merged project formerly split between product-team role agents and
> Jarvis-orchestrated work. The deliverable is one coherent workflow: role substrate,
> planning, per-task orchestration, `context.md`, finalizer handoff, and learning loop.

## Phase 1 - Role substrate

> Depends on: nothing.

### Tests (write first)

- [x] Loader authority test: each role's `SOUL.md` is system-prompt authority and
      `memory.md` is low-authority reference; memory text is absent from the system prompt.
- [x] Cold-start test: empty `memory.md` yields a valid SOUL-only prompt, no error.
- [x] Budget test: over-budget `memory.md` truncates loaded reference context with a visible
      marker without deleting entries from disk.
- [x] Path test: loader reads `SOUL.md` and `memory.md` from `PROJECT_ROOT/agents/<role>/`,
      not the vault.
- [x] Charter test: PM, tech lead, QA, coder, reviewer, and designer each have a charter and
      memory file matching the spec's ownership table.
- [x] Confirm red before implementation. (Confirmed: suite red on module-not-found before
      `src/roles/loader.ts` existed.)

### Implementation

> Sub-tasks below are coupled — ship them together in a single `/work` pass (the loader, the
> charters it loads, and the registration the loop depends on land as one unit).

- [x] Generalize the Project 12 writer loader into a role loader keyed by role name.
      (`src/roles/loader.ts`)
- [x] Draft `agents/<role>/SOUL.md` (PROJECT_ROOT-relative, mirroring `agents/writer/`) for
      PM, tech lead, QA, coder, reviewer, and designer.
- [x] Create empty-or-seeded `memory.md` for each role. (Empty = cold start.)
- [x] Confirm Jarvis is registered as a product the loop can target; add only if absent.
      (Already present in `policies/products.json` with `validationCommands`.)

> **User-reachability:** no user surface this phase — substrate consumed by Phases 2–5.
> Surfaced to the user only once the orchestrated trigger lands in Phase 5.

## Phase 2 - Planner roles

> Depends on: Phase 1.

### Tests (write first)

- [x] Assumptions test: when PM judges a brief specified-enough, generated `spec.md` contains
      an **Assumptions** section enumerating calls PM resolved.
- [x] Interview-gate test: underspecified brief enters explicit PM-interview /
      blocked-on-human state rather than silent spec fabrication.
- [x] Spec-match test: PM reviews tech lead's tech spec against the product spec; mismatch is
      flagged, not passed.
- [x] Sizing test: tech lead emits task breakdown plus role-sizing and test-strategy metadata
      for later work, including an explicit front-end / designer-needed flag per task.
- [x] Context-seed test: completed planning creates initial `context.md` with required
      sections.
- [x] Confirm red before implementation. (Confirmed: both suites red on module-not-found.)

### Implementation

> Sub-tasks below are coupled — ship them together in a single `/work` pass; planning is one
> flow (PM → tech lead → PM review → context seed).

- [x] Wire PM and tech-lead role identities into the planner. (`planning-roles.ts` orchestration
      + `planning-roles-wiring.ts` bridge to the Phase 1 charters. NOTE: the live Socratic
      `planning-handler.ts` dispatch of these role prompts is staged for the Phase 3+ runtime
      wiring — mirrors Phase 1 substrate → Phase 5 user-reachability. Test-plan §2 acceptance
      (fixture decisions) is green.)
- [x] PM writes spec, emits assumptions, or blocks for interview. (`runPlannerRoles` gate 1 +
      `withAssumptionsSection`.)
- [x] Tech lead writes tech spec, task breakdown, role sizing, per-task test strategy, and
      the explicit front-end/designer-needed flag. (`SizedTask.testStrategy` + `designerNeeded`.)
- [x] PM reviews spec/tech-spec match before planning completes. (`runPlannerRoles` gate 2.)
- [x] Seed `docs/projects/<project>/context.md` from spec, tasks, assumptions, and tech-lead
      sizing. (`seedProjectContext` / `project-context.ts`.)

> **User-reachability:** the existing `/plan <product>` trigger (Telegram + cockpit Plan
> button) now runs the role-enriched planner — a user can plan a project and observe the
> seeded `spec.md` / `tasks.md` / `context.md`. No new trigger; entry point unchanged.

## Phase 3 - Context and orchestrator substrate

> Depends on: Phase 1, 2.

### Tests (write first)

- [ ] Context update test: post-task update preserves required sections and rejects
      transcript-style dumps.
- [ ] Context validation test: technical contract changes require tech-lead validation;
      product-intent changes require PM validation when flagged.
- [ ] Task-selection test: Jarvis selects the first unchecked task from `tasks.md` before
      invoking any executor.
- [ ] Fresh-context test: task N+1 receives bounded handoff input, not task N's transcript or
      accumulated conversation.
- [ ] Run-record test: task records include task id/text, attempt id, roles invoked,
      transcript ids, model/provider choices, commit sha, verdicts, context outcome, and gates.
- [ ] Attempt-cap test: repeated task failure stops at configured cap and routes to PM wrap-up
      or blocked-on-human; it never retries indefinitely.
- [ ] Restart reconstruction test: partial project run reconstructs from durable task records,
      commits, `tasks.md`, and `context.md`.
- [ ] Confirm red before implementation.

### Implementation

> These sub-tasks are independent modules but the phase is one unit: **all** must clear before
> Phase 3 is done — the `/work` first-unchecked rule must not treat the section as complete
> after ticking one line. Land them across as many passes as needed; none may be left behind.

- [ ] Define `context.md` schema, budget, read/create/update helpers, and validation hooks.
- [ ] Implement bounded context assembly for a selected task.
- [ ] Add orchestrated task-run records and persistence.
- [ ] Define task closeout semantics: selected-task checkbox update, context update,
      closeout checks, closeout commit, clean-worktree verification, and durable block on
      failure.
- [ ] Define per-task attempt caps and escalation behavior at the cap.
- [ ] Define finalizer handoff payload shape and injectable finalizer adapter for tests.
- [ ] Implement Jarvis-owned task selection.
- [ ] Implement restart reconstruction for partial orchestrated runs.
- [ ] Add explicit rollout/fallback configuration for orchestrated mode vs legacy `/work
      --auto`.

> **User-reachability:** no user surface this phase — substrate consumed by Phases 4–5. The
> orchestrated run becomes user-triggerable in Phase 5 when the cockpit start action routes
> to the orchestrated applier.

## Phase 4 - Team-task workflow

> Depends on: Phase 1, 2, 3.

### Tests (write first)

- [ ] QA-first test: QA writes or updates tests from the spec before coder starts on
      `code-tests-required` tasks, and tech lead reviews test intent.
- [ ] No-test-rationale test: docs/config-only tasks record a QA no-code-test rationale and
      tech lead review before coder starts.
- [ ] Reviewer-independence test: reviewer resolves to a different provider than coder and
      receives diff/spec/tests/task/context, not coder hidden reasoning.
- [ ] Designer-routing test: tasks the tech-lead sizing flags front-end/designer-needed
      require designer review; non-flagged tasks do not invoke designer by default.
- [ ] Objection-gate test: unresolved objection-class findings block task completion and
      cannot be cleared by PM wrap-up.
- [ ] Round-cap test: non-objection disagreement at cap routes to PM; unresolved PM decisions
      enter blocked-on-human.
- [ ] No-closeout test: task workflow returns ready-for-closeout/blocked/failed plus handoff
      notes without marking `tasks.md`, writing `context.md`, or merging to main.
- [ ] Confirm red before implementation.

### Implementation

> These sub-tasks are coupled into one workflow — land them so the section clears as a unit;
> partial wiring leaves the workflow non-functional.

- [ ] Wire QA, tech lead, coder, reviewer, designer, and PM wrap-up seams into one
      task-sized workflow.
- [ ] Add structured objection-class signal (class, severity, location, rationale) to the
      reviewer role's verdict; the orchestrator gates on it. (Spec **Objection Classes**: this
      is the reviewer-role payload, not a change to the standalone `/review` skill.)
- [ ] Resolve the reviewer to a distinct provider from the coder via the model-policy
      resolver; when none is available, block the task rather than downgrade to same-provider
      review (fail-closed independence).
- [ ] Enforce global per-run round cap and objection-class hard gates.
- [ ] Keep role invocations injectable for fixture tests without live model calls.
- [ ] Return structured task evidence and handoff notes to the orchestrator.

> **User-reachability:** no standalone user surface — the workflow runs inside an orchestrated
> task. Observable to the user through the cockpit run/transcript view once Phase 5 routes the
> trigger.

## Phase 5 - Multi-task orchestration and finalizer handoff

> Depends on: Phase 1, 2, 3, 4.

### Tests (write first)

- [ ] Closeout test: after task N passes gates, Jarvis marks exactly that task complete,
      updates context, runs closeout checks, records a closeout commit, verifies clean
      worktree, then advances.
- [ ] Block test: blocked/failed/objection-open task stops or retries durably and is not
      skipped.
- [ ] Context-influence test: fixture includes a context update from task N that affects task
      N+1's input.
- [ ] Finalizer handoff test: when all tasks are checked, orchestrator calls Project 15
      finalizer with branch/run facts rather than self-merging.
- [ ] Finalizer-unavailable test: if the real finalizer is unavailable, Jarvis records the
      handoff payload and stops branch-complete/blocked rather than self-merging.
- [ ] Legacy fallback test: when orchestrated mode is disabled, legacy `/work --auto` dispatch
      still works and records fallback.
- [ ] Start-mode visibility test: cockpit Start/confirmation copy shows whether the selected
      dispatch mode is orchestrated or legacy fallback, and fallback runs expose the reason.
- [ ] End-to-end fixture test: deterministic fixture project runs through at least two tasks,
      context update, finalizer handoff, and terminal outcome with injected spawners/readers.
- [ ] Confirm red before implementation.

### Implementation

- [ ] Implement the multi-task orchestrator loop.
- [ ] Wire ready-for-closeout, blocked, failed, and objection-open outcomes to closeout/
      retry/block.
- [ ] Implement Jarvis-owned task closeout and clean-worktree verification.
- [ ] Enforce per-task attempt caps and escalation at the cap.
- [ ] Wire completed project runs into the Project 15 finalizer.
- [ ] Register the orchestrated loop as a mutation applier (new kind or a toggle on
      `work-run`) so it dispatches through the existing pipeline.
- [ ] **Trigger surface:** route the cockpit per-project start action (`app.js` confirm-modal
      → `POST /api/mutations`) and the Phase-3 rollout/fallback toggle to the orchestrated
      applier; legacy `/work --auto` stays reachable as recorded fallback. No new button.
- [ ] **Discovery surface:** expose the selected dispatch mode on the existing cockpit project
      card or Start confirmation, and show fallback reason on fallback runs.
- [ ] **Agent/operator docs:** document the orchestrated-vs-legacy toggle and the selected
      mutation contract in `CLAUDE.md` (run via docs-sync) so future agents know the path
      exists and how to select it.
- [ ] Create deterministic fixture spawners/readers for the complete lifecycle.
- [ ] Optionally run a live real-task smoke check after automated suites pass.

> **User-reachability:** YES — after this phase a user clicks Start on a cockpit project card
> (or the chosen toggle path), the orchestrated loop runs, and they observe run status /
> outcome / transcript on the same card. This is the phase that satisfies the
> definition-of-done = user-reachability bar for the whole project.

## Phase 6 - Learning loop

> Depends on: Phase 5.

### Tests (write first)

- [ ] No-feedback test: no feedback record means no post-mortem and no memory write.
- [ ] Feedback-source test: the nightly loop reads valid machine-readable feedback records
      through an injected/configured reader with project/run/task/source/evidence fields.
- [ ] Malformed-feedback test: invalid feedback records are skipped with a durable reason and
      do not trigger memory writes.
- [ ] Attribution test: feedback for a known miss is attributed to a stage and writes one
      atomic, provenance-stamped lesson into that role's `memory.md`.
- [ ] No-lesson test: a miss judged uncatchable writes nothing.
- [ ] Compounding test: lesson captured from run N loads into run N+1's role reference
      context.
- [ ] Fixture-feedback test: tests use injected/temp feedback records and require no real
      vault feedback.
- [ ] Confirm red before implementation.

### Implementation

- [ ] Define the feedback record schema and injected/configured reader seam.
- [ ] Nightly job detects valid machine-readable feedback records and records malformed
      entries as skipped with reason.
- [ ] Jarvis-owned post-mortem interviews roles as witnesses and makes attribution decision.
- [ ] Memory writer appends one privacy-clean, provenance-stamped lesson atomically.
- [ ] Allow "no lesson warranted".
- [ ] Confirm compounding from one run into the next.
- [ ] **Discovery surface:** document the nightly post-mortem step and the feedback-record
      format in `CLAUDE.md` (which nightly slot, where feedback records live, lesson shape).

> **User-reachability:** the learning loop runs as a nightly cron (no interactive trigger by
> design); the user observes it through the committed `memory.md` diffs and the documented
> nightly step. Feedback records are the user's input surface.

## Phase 7 - Project closeout and checklist compliance

> Depends on: Phase 1, 2, 3, 4, 5, 6.

### Tests (write first)

- [ ] Deferral-ADR test: project closeout cannot pass unless the three deferral ADR files
      named in the spec exist and include status, context, decision, rationale, and trigger to
      promote.
- [ ] Agent-lessons test: project closeout writes `agent-lessons.md` with at least one
      checklist/skill/instruction propagation pointer, or an explicit "no new lessons"
      rationale.
- [ ] Final-completion test: closeout rechecks the Phase 5 trigger-surface dispatch seam and
      mode-visibility tests before marking Project 14 done.
- [ ] Confirm red before implementation.

### Implementation

> These sub-tasks are coupled as the project closeout gate — Project 14 is not done until all
> three are complete.

- [ ] Write the deferral ADRs named in the spec (`autonomous-dispatch-deferral.md`,
      `legacy-work-removal-deferral.md`, `quality-eval-deferral.md`) with promotion triggers.
- [ ] Write `agent-lessons.md` per the planning checklist, propagating lessons or recording an
      explicit no-new-lessons rationale.
- [ ] Run and record the final completion check that includes the Phase 5 user-triggerable
      dispatch and mode-visibility tests.

> **User-reachability:** no new runtime surface; this is the closeout guard that proves the
> user-reachable Phase 5 path stayed green before the project is marked done.

---

## Out of scope

- Roles beyond PM, tech lead, QA, coder, reviewer, and designer.
- A quality/engagement eval.
- Replacing Project 15's finalizer.
- Requiring live model calls, real Telegram interaction, real vault feedback, or production
  merge for automated acceptance.
- Fully autonomous scheduler dispatch.
- Removing legacy `/work --auto` before the orchestrated path is proven.
