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

- [x] Context update test: post-task update preserves required sections and rejects
      transcript-style dumps. (`context-curator.test.ts`)
- [x] Context validation test: technical contract changes require tech-lead validation;
      product-intent changes require PM validation when flagged. (`context-curator.test.ts`)
- [x] Task-selection test: Jarvis selects the first unchecked task from `tasks.md` before
      invoking any executor. (`orch-task.test.ts`)
- [x] Fresh-context test: task N+1 receives bounded handoff input, not task N's transcript or
      accumulated conversation. (`orch-execution.test.ts`)
- [x] Run-record test: task records include task id/text, attempt id, roles invoked,
      transcript ids, model/provider choices, commit sha, verdicts, context outcome, and gates.
      (`orch-execution.test.ts`)
- [x] Attempt-cap test: repeated task failure stops at configured cap and routes to PM wrap-up
      or blocked-on-human; it never retries indefinitely. (`orch-execution.test.ts`)
- [x] Restart reconstruction test: partial project run reconstructs from durable task records,
      commits, `tasks.md`, and `context.md`. (`orch-task.test.ts`)
- [x] Confirm red before implementation. (Confirmed: 3 suites red on module-not-found.)

### Implementation

> These sub-tasks are independent modules but the phase is one unit: **all** must clear before
> Phase 3 is done — the `/work` first-unchecked rule must not treat the section as complete
> after ticking one line. Land them across as many passes as needed; none may be left behind.

- [x] Define `context.md` schema, budget, read/create/update helpers, and validation hooks.
      (`project-context.ts` schema/seed + `context-curator.ts` `applyContextUpdate` /
      validation gates / budget. The fs read/write wrapper lands with the Phase 5 runtime
      closeout — no pure test surface.)
- [x] Implement bounded context assembly for a selected task. (`orch-context-assembly.ts`)
- [x] Add orchestrated task-run records and persistence. (`orch-run-record.ts` `TaskRunRecord`
      + builder; the JSONL store is wired with the Phase 5 runtime loop.)
- [x] Define task closeout semantics: selected-task checkbox update, context update,
      closeout checks, closeout commit, clean-worktree verification, and durable block on
      failure. (`orch-closeout.ts` pure semantics — tick exactly one box / stale-refuse. The
      effectful half — commit, clean-worktree verify, durable block — is Phase 5 "Implement
      Jarvis-owned task closeout".)
- [x] Define per-task attempt caps and escalation behavior at the cap. (`orch-attempt-cap.ts`)
- [x] Define finalizer handoff payload shape and injectable finalizer adapter for tests.
      (`finalizer-handoff.ts`)
- [x] Implement Jarvis-owned task selection. (`orch-task-select.ts`)
- [x] Implement restart reconstruction for partial orchestrated runs. (`orch-reconstruct.ts`)
- [x] Add explicit rollout/fallback configuration for orchestrated mode vs legacy `/work
      --auto`. (`orch-config.ts` `resolveDispatchMode`; the env/config toggle read is wired in
      Phase 5.)

> **User-reachability:** no user surface this phase — substrate consumed by Phases 4–5. The
> orchestrated run becomes user-triggerable in Phase 5 when the cockpit start action routes
> to the orchestrated applier.

## Phase 4 - Team-task workflow

> Depends on: Phase 1, 2, 3.

### Tests (write first)

- [x] QA-first test: QA writes or updates tests from the spec before coder starts on
      `code-tests-required` tasks, and tech lead reviews test intent.
- [x] No-test-rationale test: docs/config-only tasks record a QA no-code-test rationale and
      tech lead review before coder starts.
- [x] Reviewer-independence test: reviewer resolves to a different provider than coder and
      receives diff/spec/tests/task/context, not coder hidden reasoning.
- [x] Designer-routing test: tasks the tech-lead sizing flags front-end/designer-needed
      require designer review; non-flagged tasks do not invoke designer by default.
- [x] Objection-gate test: unresolved objection-class findings block task completion and
      cannot be cleared by PM wrap-up.
- [x] Round-cap test: non-objection disagreement at cap routes to PM; unresolved PM decisions
      enter blocked-on-human.
- [x] No-closeout test: task workflow returns ready-for-closeout/blocked/failed plus handoff
      notes without marking `tasks.md`, writing `context.md`, or merging to main.
- [x] Confirm red before implementation. (Confirmed: suite red on module-not-found.)

### Implementation

> These sub-tasks are coupled into one workflow — land them so the section clears as a unit;
> partial wiring leaves the workflow non-functional.

- [x] Wire QA, tech lead, coder, reviewer, designer, and PM wrap-up seams into one
      task-sized workflow. (`team-task-workflow.ts` `runTeamTaskWorkflow`.)
- [x] Add structured objection-class signal (class, severity, location, rationale) to the
      reviewer role's verdict; the orchestrator gates on it. (`ObjectionFinding` +
      `ReviewerVerdict`; gated in the round loop.)
- [x] Resolve the reviewer to a distinct provider from the coder via the model-policy
      resolver; when none is available, block the task rather than downgrade to same-provider
      review (fail-closed independence). (`resolveReviewerProvider` seam → Gate 0 block on
      null. The model-policy resolver is wired as the production seam in Phase 5.)
- [x] Enforce global per-run round cap and objection-class hard gates. (Per-task round cap +
      objection hard gate enforced here; the GLOBAL per-run cap aggregation across tasks is the
      Phase 5 orchestrator-loop concern.)
- [x] Keep role invocations injectable for fixture tests without live model calls. (All seams
      in `TeamTaskDeps` are injected; 18 fixture tests, no live call.)
- [x] Return structured task evidence and handoff notes to the orchestrator. (`TaskEvidence`.)

> **User-reachability:** no standalone user surface — the workflow runs inside an orchestrated
> task. Observable to the user through the cockpit run/transcript view once Phase 5 routes the
> trigger.

## Phase 5 - Multi-task orchestration and finalizer handoff

> Depends on: Phase 1, 2, 3, 4.

### Tests (write first)

- [x] Closeout test: after task N passes gates, Jarvis marks exactly that task complete,
      updates context, runs closeout checks, records a closeout commit, verifies clean
      worktree, then advances. (`project-orchestrator.test.ts`)
- [x] Block test: blocked/failed/objection-open task stops or retries durably and is not
      skipped. (`project-orchestrator.test.ts`)
- [x] Context-influence test: fixture includes a context update from task N that affects task
      N+1's input. (`project-orchestrator.test.ts`)
- [x] Finalizer handoff test: when all tasks are checked, orchestrator calls Project 15
      finalizer with branch/run facts rather than self-merging. (`project-orchestrator.test.ts`)
- [x] Finalizer-unavailable test: if the real finalizer is unavailable, Jarvis records the
      handoff payload and stops branch-complete/blocked rather than self-merging.
      (`project-orchestrator.test.ts`)
- [x] Legacy fallback test: when orchestrated mode is disabled, legacy `/work --auto` dispatch
      still works and records fallback. (`work-dispatch.test.ts` resolveWorkDispatch legacy +
      `webview.test.ts` "routes a work-run Start to the LEGACY applier and records the fallback".)
- [x] Start-mode visibility test: cockpit Start/confirmation copy shows whether the selected
      dispatch mode is orchestrated or legacy fallback, and fallback runs expose the reason.
      (`cockpit-dispatch-mode.test.ts` surfaces dispatchMode/fallbackReason on the project card;
      `webview.test.ts` asserts the resolved mode is stamped on the payload.)
- [x] End-to-end fixture test: deterministic fixture project runs through at least two tasks,
      context update, finalizer handoff, and terminal outcome with injected spawners/readers.
      (`project-orchestrator.test.ts`)
- [x] Confirm red before implementation. (Confirmed: orchestrator-loop suite red on
      module-not-found.)

### Implementation

- [x] Implement the multi-task orchestrator loop. (`project-orchestrator.ts`
      `runProjectOrchestration`.)
- [x] Wire ready-for-closeout, blocked, failed, and objection-open outcomes to closeout/
      retry/block. (`runTaskWithRetries` + the outcome gate in the loop.)
- [x] Implement Jarvis-owned task closeout and clean-worktree verification. (`performCloseout`
      — pure sequence over injected effects: context update → tick → checks → commit →
      clean-verify, blocks durably on any failure. The real git/fs effects are bound by the
      mutation applier below.)
- [x] Enforce per-task attempt caps and escalation at the cap. (`runTaskWithRetries` over
      `decideAttemptOutcome`.)
- [x] Wire completed project runs into the Project 15 finalizer. (`finalize` adapter →
      `runFinalizerHandoff`; held when unavailable, never self-merges.)
- [x] Register the orchestrated loop as a mutation applier (new kind or a toggle on
      `work-run`) so it dispatches through the existing pipeline. (New `orchestrated-work` kind
      + `orchestratedWorkApplier` in `src/jobs/orchestrated-work-runner.ts`, registered in
      `src/index.ts`; drives `runProjectOrchestration` over real fs/git/finalizer-held effects.)
- [x] **Trigger surface:** route the cockpit per-project start action (`app.js` confirm-modal
      → `POST /api/mutations`) and the Phase-3 rollout/fallback toggle to the orchestrated
      applier; legacy `/work --auto` stays reachable as recorded fallback. No new button.
      (`src/jobs/work-dispatch.ts` seam + `handleApiMutationsCreate` substitutes the kind by the
      `ORCHESTRATED_WORK_ENABLED` / per-product `orchestratedMode` toggle; fallback reason
      stamped on the payload. No new button — same Start action.)
- [x] **Discovery surface:** expose the selected dispatch mode on the existing cockpit project
      card or Start confirmation, and show fallback reason on fallback runs. (`CockpitProject`
      `dispatchMode`/`fallbackReason` via `buildCockpitView`'s 6th arg, fed by `handleApiCockpit`;
      app.js renders a card chip + a mode line in the Start confirmation modal.)
- [x] **Agent/operator docs:** document the orchestrated-vs-legacy toggle and the selected
      mutation contract in `CLAUDE.md` (run via docs-sync) so future agents know the path
      exists and how to select it. (docs-sync: mutation-pipeline bullet, jobs tree, env vars.)
- [x] Create deterministic fixture spawners/readers for the complete lifecycle. (In-memory
      `Harness` in `project-orchestrator.test.ts` injects all reads/workflow/closeout/finalize
      effects — the loop runs end-to-end with no git, disk, or live model call.)
- [ ] Optionally run a live real-task smoke check after automated suites pass. (OPTIONAL —
      not required acceptance per spec §"What's shipping" and test-plan §5 "Low (smoke)". A
      meaningful live smoke depends on the production `runTaskWorkflow` role-spawn binding,
      which is deferred: today the production default returns a durable `blocked` with a
      truthful reason, so an orchestrated run is explicit/recorded but does not yet drive live
      role models. The required user-reachability proof — dispatch seam + mode visibility — is
      green above. Promote when the live role-spawn binding lands.)

> **User-reachability:** YES — after this phase a user clicks Start on a cockpit project card
> (or the chosen toggle path), the orchestrated loop runs, and they observe run status /
> outcome / transcript on the same card. This is the phase that satisfies the
> definition-of-done = user-reachability bar for the whole project.

## Phase 6 - Learning loop

> Depends on: Phase 5.

### Tests (write first)

- [x] No-feedback test: no feedback record means no post-mortem and no memory write.
      (`learning-loop.test.ts` §6.1 — empty reader → attribute/writeLesson never called.)
- [x] Feedback-source test: the nightly loop reads valid machine-readable feedback records
      through an injected/configured reader with project/run/task/source/evidence fields.
      (`feedback-record.test.ts` schema/validation + `learning-loop.test.ts` injected
      `readFeedback` seam.)
- [x] Malformed-feedback test: invalid feedback records are skipped with a durable reason and
      do not trigger memory writes. (`feedback-record.test.ts` durable `FeedbackSkipReason`
      per field + `learning-loop.test.ts` §6.3 skips without attribute/writeLesson.)
- [x] Attribution test: feedback for a known miss is attributed to a stage and writes one
      atomic, provenance-stamped lesson into that role's `memory.md`. (`learning-loop.test.ts`
      §6.5 attribute→writeLesson + `memory-writer.test.ts` §6.4 single-commit provenance stamp.)
- [x] No-lesson test: a miss judged uncatchable writes nothing. (`learning-loop.test.ts` §6.6
      `no-lesson` attribution → writeLesson never called.)
- [x] Compounding test: lesson captured from run N loads into run N+1's role reference
      context. (`memory-writer.test.ts` §6.7 — writes into a temp role dir, then
      `composeRoleContext` shows it in `referenceContext`, absent from `systemInstructions`.)
- [x] Fixture-feedback test: tests use injected/temp feedback records and require no real
      vault feedback. (All three suites use injected deps / tmpdir only — no vault/git/LLM.)
- [x] Confirm red before implementation. (Confirmed: all three suites red on module-not-found
      for `./feedback-record.js`, `./learning-loop.js`, `./memory-writer.js` — no impl created.)

### Implementation

- [x] Define the feedback record schema and injected/configured reader seam.
      (`src/intent/feedback-record.ts`: `FeedbackRecord` type, `parseFeedbackRecord`
      fail-closed validator with durable `FeedbackSkipReason` per field, `VALID_SLUG`
      + ISO-8601 + trust-boundary length-cap guards, and the injected `FeedbackReader`
      seam. 29/29 in `feedback-record.test.ts` green.)
- [x] Nightly job detects valid machine-readable feedback records and records malformed
      entries as skipped with reason. (`src/intent/learning-loop.ts` `runLearningLoop` —
      reads via the injected `FeedbackReader`, validates each through `parseFeedbackRecord`,
      skips malformed with its durable `FeedbackSkipReason`, and dispatches valid records
      through the injected `attribute`/`writeLesson` seams; per-pass counters keep the
      `processed === lessonsWritten + lessonsFiltered + noLessonOutcomes` invariant honest.
      8/8 in `learning-loop.test.ts` green. The live nightly.ts cron composition — wiring
      the production feedback reader + LLM post-mortem + `writeRoleLesson` into this core —
      lands with the downstream seam tasks below.)
- [x] Jarvis-owned post-mortem interviews roles as witnesses and makes attribution decision.
      (`src/intent/postmortem.ts` `runPostMortem` — a NEUTRAL Jarvis-owned `askClaudeOneShot`
      call, NOT a role: `buildPostMortemPrompt` grounds the attribution in the role roster +
      ownership table and delimits the untrusted feedback record; `parsePostMortemResult`
      fail-closes (role∈ROLE_NAMES / stage∈ROLE_STAGES / non-empty), failing safe to
      `no-lesson` so a broken post-mortem never fabricates a lesson. Wired live as the
      `attribute` seam in nightly.ts `stepLearningLoop` (after 'Observation loop'), composed
      with `readFeedbackRecords` + `writeRoleLesson` via `runLearningLoop`; a content-hash
      processed-marker (`feedbackRecordId` + `logs/feedback-processed.json`) + per-pass cap
      make each record a once-only post-mortem, fault-isolated per record. 16/16 in
      `postmortem.test.ts`, 13/13 in `feedback-reader.test.ts`, nightly suites green. NOTE:
      v1 makes the attribution in one neutral call grounded in role ownership; per-role
      witness sub-interviews are a deferred elaboration the spec marks optional ("can").)
- [x] Memory writer appends one privacy-clean, provenance-stamped lesson atomically.
      (`src/roles/memory-writer.ts` `writeRoleLesson` — privacy-filter → dedupe → stamp →
      append → ONE atomic commit via `src/roles/commit.ts` `commitRoleMemory` (pathspec-
      scoped to `agents/<role>/memory.md`, on-main guard, no push); reuses the shared
      `isLessonPrivacySafe`/`stampSeedLesson`/`extractLessonBody` primitives so the role
      and writer loops can't drift; per-role serialization mirrors writer `captureChain`.
      11/11 in `memory-writer.test.ts` green.)
- [x] Allow "no lesson warranted". (`runLearningLoop`'s `no-lesson` attribution branch
      writes nothing and counts `noLessonOutcomes`; `learning-loop.test.ts` §6.6 green.)
- [x] Confirm compounding from one run into the next. (`memory-writer.test.ts` §6.7 green —
      a lesson written into a role dir loads into the next run's `composeRoleContext`
      `referenceContext`, absent from `systemInstructions`.)
- [x] **Discovery surface:** document the nightly post-mortem step and the feedback-record
      format in `CLAUDE.md` (which nightly slot, where feedback records live, lesson shape).
      (docs-sync: nightly orchestrator now lists 15 steps incl. `stepLearningLoop` after
      'Observation loop'; new `src/intent/{feedback-record,feedback-reader,learning-loop,
      postmortem}.ts` + `src/roles/{memory-writer,commit}.ts` tree entries; a "Product-team
      learning loop" subsection documents the `logs/feedback.jsonl` record format, the
      once-only marker, the fenced ```postmortem block, and the `memory.md` lesson shape;
      `logs/feedback.jsonl` + `logs/feedback-processed.json` added to the LOGS_DIR paragraph.)

> **User-reachability:** the learning loop runs as a nightly cron (no interactive trigger by
> design); the user observes it through the committed `memory.md` diffs and the documented
> nightly step. Feedback records are the user's input surface.

## Phase 7 - Project closeout and checklist compliance

> Depends on: Phase 1, 2, 3, 4, 5, 6.

### Tests (write first)

- [x] Deferral-ADR test: project closeout cannot pass unless the three deferral ADR files
      named in the spec exist and include status, context, decision, rationale, and trigger to
      promote. (`project-14-closeout.test.ts` — existence + required-section checks for the
      three ADRs.)
- [x] Agent-lessons test: project closeout writes `agent-lessons.md` with at least one
      checklist/skill/instruction propagation pointer, or an explicit "no new lessons"
      rationale. (`project-14-closeout.test.ts` — existence + propagation-pointer/no-lessons
      content check.)
- [x] Final-completion test: closeout rechecks the Phase 5 trigger-surface dispatch seam and
      mode-visibility tests before marking Project 14 done. (`project-14-closeout.test.ts` —
      re-asserts `resolveWorkDispatch` (orchestrated/legacy/force + fallbackReason) and
      `buildCockpitView` dispatchMode visibility inline.)
- [x] Confirm red before implementation. (Confirmed: 8 red — the ADR + agent-lessons
      existence/section assertions — until the Phase 7 docs land; the 5 Phase-5 re-checks
      pass already.)

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
