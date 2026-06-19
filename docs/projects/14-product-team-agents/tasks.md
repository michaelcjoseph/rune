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
>
> **Autonomy rule for reopened phases:** Phases 10-15 must be runnable by `/work --auto`
> without human choices, manual repo setup, production push credentials in tests, or
> interactive approval. If a task needs a choice, the default and fallback are named here.
>
> **Execution sequencing (decided 2026-06-15):** Phase 11A (gate-rejection feedback retries) ships
> FIRST and OUT OF BAND — a direct `/work` run in the CLI (codex or claude), not the orchestrator —
> because it is the retry resilience the orchestrator itself lacks. Building it through the
> orchestrator hits the one-shot-gate deadlock it fixes: a mid-build gate rejection is terminal, and
> a blind restart re-runs identical inputs with no feedback. Once 11A lands on main, the orchestrator
> runs the rest in order: Phase 10 → Phase 11B → Phase 12 → Phase 13 → Phase 14 → Phase 15. Only
> Phases 10, 11B, 12, 13, 14, and 15 are `/work --auto` targets; do not point `--auto` at 11A.

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
- [x] ~~Optionally run a live real-task smoke check after automated suites pass.~~ **PROMOTED
      to Phase 8 (reopened 2026-06-10).** This was the load-bearing gap, not an optional extra:
      the production `runTaskWorkflow` binding was stubbed to a durable `blocked`, so no
      orchestrated run does real work. Live execution is no longer optional — it is required
      for completion. See Phase 8.

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

- [x] Write the deferral ADRs named in the spec (`autonomous-dispatch-deferral.md`,
      `legacy-work-removal-deferral.md`, `quality-eval-deferral.md`) with promotion triggers.
      (All three written under `docs/projects/14-product-team-agents/`, following the
      `08-intent-layer/egress-deferral.md` template — Status / Context / Decision / Rationale /
      Trigger-to-promote, grounded in what shipped; the 6 deferral-ADR closeout assertions
      pass.)
- [x] Write `agent-lessons.md` per the planning checklist, propagating lessons or recording an
      explicit no-new-lessons rationale. (Three lessons, each with an `Applied at:` pointer:
      L1 nightly-step cross-cutting test change → folded a caveat into this repo's `CLAUDE.md`
      + queued in the checklist `TODO(propagation)`; L2 trust-boundary review budget for
      untrusted→LLM→commit paths → queued in `TODO(propagation)`; L3 don't background a
      state-restoring command → already propagated to the `git-stash-pop…` auto-memory. The 2
      agent-lessons closeout assertions pass.)
- [x] Run and record the final completion check that includes the Phase 5 user-triggerable
      dispatch and mode-visibility tests. (Recorded 2026-06-08: the Phase 5 dispatch seam +
      cockpit mode-visibility + the closeout suite pass — `work-dispatch.test.ts`,
      `cockpit-dispatch-mode.test.ts`, `webview.test.ts`, `project-14-closeout.test.ts` =
      71/71 green; full suite 3608 passed, only 2 pre-existing/unrelated failures
      (`claude.test.ts` WORKSPACE_DIR env-passthrough, `ideas-promoted.test.ts` vault content)
      that predate this project and touch none of its files. The Phase 5 user-reachable
      orchestrated dispatch path stayed green through closeout.)

> **User-reachability:** no new runtime surface; this is the closeout guard that proves the
> user-reachable Phase 5 path stayed green before the project is marked done.

## Phase 8 - Live execution binding (reopened 2026-06-10)

> Depends on: Phase 1, 2, 3, 4, 5. Reopens the project — Phases 1-7 shipped the scaffolding
> and a reachable dispatch path, but the per-task workflow's production seams were stubbed
> (`orchestrated-work-runner.ts:169` returns a hardcoded `blocked`; `:215` reports the
> finalizer `unavailable`). This phase makes orchestrated `/work` do real work.

### Tests (write first)

- [x] Production `TeamTaskDeps` factory test: the production factory binds all eight role
      seams — none left as the `blocked` stub — and coder/reviewer resolve to different
      providers through the model-policy resolver (fail-closed when only a same-provider model
      is available). Model call injected; asserts wiring, not live output.
      (`team-task-deps.test.ts`)
- [x] Execution-agent diff-capture test: given a controlled temp git worktree, the execution
      primitive applies the agent's edits and returns the exact `git diff`; a no-op task yields
      an empty diff; a tool/agent error yields structured `failed` evidence, never an unhandled
      throw. (`execution-agent.test.ts`)
- [x] Model-map test: `roleDefaults` resolves pm/tech-lead/reviewer/designer → `opus`
      (anthropic, Opus 4.8) and qa/coder → `gpt-5.5` (openai); the registry contains both aliases; the
      coder and reviewer providers differ. (`team-task-deps.test.ts` model-map describe.)
- [x] No-stub regression test: the orchestrated applier's production `runTaskWorkflow` calls
      through to `runTeamTaskWorkflow` — the hardcoded "orchestrated role execution not yet
      wired" `blocked` path is gone and cannot reappear without failing this test.
      (`team-task-deps.test.ts` no-stub describe: identity-asserts the runtime seam binding +
      drives the production runner to ready-for-closeout on injected seams.)
- [x] **Live acceptance (required, non-fixture, fully agent-run).** A real orchestrated run on
      a small real task drives QA → coder → review to a real `git diff`. This makes live model
      calls by design and is REQUIRED for phase completion — the stub-free proof the original
      closeout lacked. Per the PM/tech-lead/QA charter lessons, a fixture-green suite is not
      sufficient. It must run end-to-end with **zero human intervention**: no operator merge,
      no manual repo setup, no interactive approval. Build it as a checked-in, self-verifying
      acceptance harness (`src/jobs/__acceptance__/orchestrated-live.acceptance.ts` + a thin
      `acceptance:orchestrated` npm script) that an agent `/work` run invokes and reads a
      pass/fail exit code from. (DONE 2026-06-13: harness landed; `npm run acceptance:orchestrated`
      exited 0 — run `6abf35cf`, proof at `live-acceptance-6abf35cf.md`. The run drove the real
      `sum` task QA → coder → review to a real diff in ~72s with live Opus 4.8 + GPT-5.5/Codex,
      branch-complete held, QA test green against the coder diff. Unblocked by the Codex
      login-probe fix — the CLI now writes "Logged in" to stderr, which `isCodexLoggedIn` had
      ignored.) Land the sub-tasks below as one unit:

  - [x] **Provider preflight (fail-loud, not fail-silent).** Before any orchestrated call, probe
        both executors and assert reachability: `claude --model opus` (Opus 4.8) returns a
        completion, and `probeCodexProvider` reports `codex exec -m gpt-5.5` available. If
        either is unreachable, the harness exits non-zero with the resolved model id and the
        executor error — never the silent stall that killed the 2026-06-10 `run2.log` (it
        resolved all six roles then died at the first live call with no diagnostic). This step
        is the regression guard for that exact failure. (DONE: `preflight()` probes both; the
        live run logged "claude opus OK" + "codex available" before any role call.)
  - [x] **Ephemeral fixture repo + product, no shared state.** The harness creates a throwaway
        git repo in an OS temp dir seeded with one small real task (an absent function plus a
        spec/README describing it and an intentionally failing or missing test), `git init`s it,
        and registers an ephemeral orchestrated-mode product entry pointed at it via the
        `WORKTREE_ROOT` / products-config env redirection the `/tmp/p14-accept/driver.mts`
        spike already proved. No `policies/products.json` edit, no `.worktrees` of the real repo
        touched. Teardown removes the temp repo, its worktrees, and the temp product entry in a
        `finally` so a failed run leaves no residue. (DONE: `makeFixture()` seeds a temp repo +
        temp products.json; redirect via the new `PRODUCTS_CONFIG_FILE` + getter-ized
        `WORKTREE_ROOT` env vars; `finally` removes the temp root. The live run logged
        "removed temp root".)
  - [x] **Drive the production applier end-to-end.** Resolve dispatch with the global default
        OFF and the per-product opt-in ON (asserting it routes `mode: orchestrated`), then run
        `orchestratedWorkApplier.apply()` to completion, capturing the streamed events. Real
        worktree, real task selection, real role model calls (opus judgment, gpt-5.5 artifact),
        real closeout — no injected seams anywhere in this path. (DONE: `driveApplier()` asserts
        `mode=orchestrated` then runs the production applier; the live run resolved all six roles
        through the real model policy and reached the `completed`/held terminal.)
  - [x] **Assert real work, self-verified (this replaces operator merge).** The harness itself
        checks, and exits non-zero on any miss: (a) the captured `git diff` is non-empty and
        touches the seeded task's target file; (b) the QA-authored test now exists and, applied
        to the worktree, **passes against the coder's diff** (run the temp repo's test command in
        the worktree); (c) the reviewer verdict is a structured pass; (d) the run reaches its
        terminal orchestrated outcome — `branch-complete` with a well-formed handoff payload
        (per spec req 17 orchestrated runs never self-merge) — and the harness validates the
        payload shape and the branch's diff directly rather than waiting for a human to merge.
        Success is these assertions passing on the throwaway repo, which is then discarded.
        (DONE: `verify()` asserts (a) diff touches `impl/sum.mjs`, (b) `node impl/sum.test.mjs`
        passes in a verify worktree on the branch, (c) reviewer-pass is transitive — held
        branch-complete is unreachable if any gate fails, (d) terminal `completed`+`held:true`
        with branch + taskCount≥1. All green on run `6abf35cf`.)
  - [x] **Emit a durable proof artifact.** On success, write the run transcript + diffstat +
        asserted-outcome summary to `docs/projects/14-product-team-agents/live-acceptance-<run-id>.md`
        so the stub-free proof is recorded in-repo, not only in `/tmp`. Retire the
        `/tmp/p14-accept/` spike and the `accept-demo` placeholder in `policies/products.json`
        (currently marked `TEMPORARY ... REMOVE before commit`) once the checked-in harness lands.
        (DONE: `emitProof()` writes a scrubbed `live-acceptance-6abf35cf.md`; the `accept-demo`
        placeholder was removed from `policies/products.json`; the `/tmp/p14-accept/` spike was
        already gone.)
- [x] Confirm red before implementation. (Confirmed 2026-06-10: both suites red on
      module-not-found for `./execution-agent.js` / `./team-task-deps.js` — no implementation
      created; the model-policy entries and the runner's `createTaskWorkflowRunner` seam are
      likewise still absent, which the suites also pin.)

### Implementation

> The artifact-role execution primitive (sub-task 1) is the unlock; the rest is wiring and
> config around it. The phase is not done until the live acceptance above is green.

- [x] Build the production execution-agent primitive: a tool-using, worktree-scoped session
      (reuse the legacy `/work` work-runner spawn machinery) that takes a selected task plus
      the resolved model and returns a captured `git diff`. Backs the artifact roles (coder,
      QA test authoring). (`src/jobs/execution-agent.ts` — `runExecutionAgent` with injected
      `{spawnAgent, runGit, buildEnv}` IO; codex → `runCodex` workspace-write, claude →
      CLAUDE_BIN worktree spawn w/ MCP isolation + SIGTERM→SIGKILL escalation; stage-then-diff
      capture; secrets/paths scrubbed; `execution-agent.test.ts` 5/5 green.)
- [x] Build the production `TeamTaskDeps` factory: bind coder + QA-write-tests to the
      execution-agent primitive; bind the judgment seams (tech-lead test/diff review, reviewer
      verdict, designer, PM wrap-up) to the `defaultRoleModelCall` text round-trip from
      `/plan`; bind `resolveReviewerProvider` to the model-policy resolver.
      (`src/jobs/team-task-deps.ts` — `resolveTeamRoleModels` fail-closed null reviewer on
      same-provider; charter-composed two-channel prompts for judgment AND artifact roles;
      fenced-JSON fail-closed verdict parsers; `createProductionTaskWorkflowRunner` blocks
      durably on missing policy/failed resolution.)
- [x] Bind judgment roles to `opus` (anthropic/claude, Opus 4.8) and add the `gpt-5.5`
      (openai/codex) artifact-role entry in `policies/model-policy.json`, and populate
      `roleDefaults` for all six roles per the spec Phase 8 table. (Done — model-map tests in
      `team-task-deps.test.ts` pin it.)
- [x] Replace the `runTaskWorkflow` stub (`orchestrated-work-runner.ts:169`) to call
      `runTeamTaskWorkflow` with the production `TeamTaskDeps`. (Stub gone —
      `createTaskWorkflowRunner` runtime seam, production = `createProductionTaskWorkflowRunner`;
      identity-pinned by the no-stub regression test.)
- [x] Wire the Project 15 finalizer in place of the `finalize` stub (`:215`), or keep the
      durable branch-complete hold if Project 15 remains unwired — record which, and why.
      (DECISION 2026-06-10: keep the durable hold. Project 15's `runFinalizer` is live for
      `work-run` mutations but its gated-merge pipeline requires the work-run artifact
      substrate — transcript sink, summary.json, work-product classification, gate runtime +
      merge lock — which orchestrated runs do not produce yet. The adapter reports
      `unavailable` with that reason recorded; the run holds branch-complete with the handoff
      payload for operator merge, never a self-merge (spec req 17). Wiring the finalizer for
      orchestrated runs needs that substrate first — a follow-on, not a stub.)

> **User-reachability:** YES — after this phase, clicking Start with orchestrated mode on drives
> a real task to a real diff that lands or durably holds, observable on the cockpit card. This
> is the corrected definition of done: a non-fixture run does real work, not a durable `blocked`.

## Phase 9 - Planning critique pass

> Depends on: Phase 2. Net-new enhancement to the planner: a cross-model critique that hardens
> the assembled plan (goal↔scope coherence, task-list completeness for done-and-usable, then a
> spec/tasks critique) before the human approval gate. Sequential Claude→Codex, single pass
> each, degrades to Claude alone when Codex is unavailable. See spec.md §"Planning critique
> pass" and requirements 8a–8c.

### Tests (write first)

- [x] Sequential-order test: the critique runs Claude (Opus 4.8) first over the assembled
      spec/tech-spec/tasks, then Codex (GPT-5.5) over Claude's revised output; the Codex seam
      receives the Claude-revised artifacts, not the originals. Model calls injected.
      (`planning-critique.test.ts` "sequential cross-model order".)
- [x] Single-pass test: each model is invoked exactly once — the pass does not loop to
      convergence. (`planning-critique.test.ts` "invokes each model exactly once".)
- [x] Codex-degrade test: when `probeCodexProvider` reports unavailable, the critique runs the
      Claude pass alone, records that the Codex pass was skipped, and returns the Claude-revised
      plan; planning does not block. (`planning-critique.test.ts` "Codex degrade".)
- [x] Order-in-flow test: the critique runs after the PM spec/tech-spec match gate and before
      `context.md` is seeded, over the same in-memory artifacts. (`planning-critique.test.ts`
      "runPlannerRoles integration" — runs after gate 2, NOT on gate-1/gate-2 exits.)
- [x] No-op / fail-closed test: a critique that yields no change returns the assembled plan
      unchanged and still seeds context; an unparseable critic reply falls back to the
      pre-critique plan rather than dropping content. (`planning-critique.test.ts` "no-op and
      fail-closed" + the bounded-parser "NO block bleed-through" / nested-fence tests.)
- [x] Approval-gate test: critique-introduced changes are present in the artifact the human
      approval surface renders, so every change is human-gated before scaffold.
      (`planning-critique.test.ts` integration — the `planned` outcome spec/techSpec carry the
      critique revision.)
- [x] Confirm red before implementation. (Confirmed 2026-06-13: suite red on module-not-found
      for `./planning-critique.js` before the module existed.)

### Implementation

- [x] Add a `critiquePlan({spec, techSpec, tasks})` seam to the planner-role deps returning
      revised `{spec, techSpec, tasks}`, injected like the other role seams so the flow stays
      fixture-testable with no live model call. (Optional `critiquePlan?` on `PlanningRoleDeps`;
      pure `runPlanningCritique` core in `planning-critique.ts`.)
- [x] Wire the sequential two-model run: Claude (Opus 4.8) critique+revise, then Codex
      (GPT-5.5) critique+revise over Claude's output, reusing the `defaultRoleModelCall` text
      round-trip and the `runCodex` / `probeCodexProvider` availability gate from `src/ai/codex.ts`.
      (`buildProductionCritiquePlan` in `planning-roles-wiring.ts` — both seams fail-closed /
      non-throwing so a critic miss degrades to the pre-critique plan.)
- [x] Author the critique instruction prompt (restate goal → scope-achieves-goal + fix →
      task-list-comprehensive-for-done-and-usable + add → critique spec/tasks + fix), parsed
      into revised artifacts and fail-closed to the pre-critique plan on an unparseable reply.
      (`CRITIQUE_SYSTEM`/`CRITIQUE_INSTRUCTION` + `parseCritiqueReply` with bounded fenced-block
      extraction so the tech-spec can't bleed into the spec.)
- [x] Insert the pass into `runPlannerRoles` after the PM spec/tech-spec match gate (gate 2)
      and before the context seed; the revised artifacts feed both the seed and the approval
      surface. (Wired; live via `planning-handler.ts` → `defaultPlanningRoleDeps()`.)
- [x] Degrade to the Claude-only pass when Codex is unavailable and record the skipped Codex
      pass on the planning record. (`codexSkipped` → `codexCritiqueSkipped` on the `planned`
      outcome.)
- [x] Re-enable orchestrated mode (`ORCHESTRATED_WORK_ENABLED` / per-product `orchestratedMode`)
      after the Phase 8 live-acceptance harness exited green.
      Reverses the 2026-06-11 `e8424bd` revert to legacy `/work`.
      (DONE 2026-06-13: operator took the go-live decision. `ORCHESTRATED_WORK_ENABLED=true`
      in `.env.local` and `orchestratedMode: true` restored on the `jarvis` product in
      `policies/products.json`. The earlier block — the confirmation target
      `18-agent-activity-label` living only on a feature branch — is moot: that project was
      retired, and the live-acceptance proof `live-acceptance-6abf35cf.md` stands as the green
      gate. Orchestrated runs still hold at branch-complete for operator merge — enabling the
      flag does not let them self-land on main.)

> **User-reachability:** the existing `/plan <product>` trigger now runs the critique before
> surfacing the plan for approval — the user sees a sharper spec/tasks at the same approval
> gate, no new trigger.

## Phase 11A - Gate-rejection feedback retries (reopened 2026-06-14) — BUILD FIRST, OUT OF BAND

> **Sequencing:** 11A is built BEFORE Phase 10 and NOT through the orchestrator — it ships via a
> direct `/work` run in the CLI (codex or claude), or by hand. It is the retry-with-feedback the
> orchestrator itself lacks; building it through the orchestrator hits the one-shot-gate deadlock it
> fixes (any tech-lead/reviewer rejection mid-build is terminal, and a blind restart re-runs the same
> inputs with no feedback — it won't converge). Land it on main, then the orchestrator can run Phase
> 10 → 11B → 12 with gate rejections becoming corrective retries. Do NOT point `/work --auto` here.
>
> Depends on: Phase 5, 8 (no dependency on Phase 10). Triggered by the project-17 run AND the
> 2026-06-14 Phase 10 run, both of which died on a one-shot tech-lead test-intent rejection
> (`team-task-workflow.ts:195`): the feedback that would fix the test was recorded in `blockedReason`,
> then thrown away, and the whole run blocked. See spec.md §"Phase 11A" and requirements 47-49.

### Tests (write first)

- [x] Feedback-carried test: a gate rejection surfaces structured feedback (rejecting role,
      what it rejected, actionable notes) in the task evidence, not just a `blockedReason` string.
      (`team-task-workflow.test.ts`; confirmed red, then green with `GateRejectionFeedback`.)
- [x] QA-rewrite-loop test: a tech-lead test-intent rejection re-invokes `qaWriteTests` WITH the
      tech-lead's notes, bounded by a small cap, before the task escalates — not a one-shot block.
      (`team-task-workflow.test.ts`; confirmed red: current workflow returns `blocked` after the
      first tech-lead rejection instead of a second QA invocation.)
- [x] Coder-feedback test: a non-objection reviewer/tech-lead-diff rejection re-invokes the coder
      WITH the reviewer + tech-lead notes from the failed round, not identical inputs.
      (`team-task-workflow.test.ts`; confirmed red: current retry calls the coder a second time,
      but the second input has no reviewer/tech-lead rejection feedback.)
- [x] No-blind-redo regression: no retry path re-runs a role with identical inputs and no
      feedback (the project-17 defect) — must fail on today's `team-task-workflow.ts`.
      (`team-task-workflow.test.ts`; confirmed red: current coder retry repeats the same stable
      task/spec/context/tests payload with no feedback.)
- [x] Park-not-kill test: a task that exhausts its feedback-retry cap parks blocked-on-human with
      the worktree preserved; the project run holds at that task and does not discard the branch.
      (`project-orchestrator.test.ts`; confirmed red: current blocked result holds the task but
      has no parked payload preserving branch/worktree.)
- [x] Confirm red before implementation. (Confirmed via
      `node --env-file-if-exists=.env.local ./node_modules/vitest/vitest.mjs run
      src/intent/team-task-workflow.test.ts src/intent/project-orchestrator.test.ts -t
      "re-invokes QA with tech-lead feedback|re-invokes the coder with reviewer|does not
      blindly redo|parks blocked-on-human" --reporter=verbose`: 4 expected failures,
      26 skipped.)

### Implementation

> Lives entirely in the team-task workflow / retry path — no dependency on Phase 10's streaming. The
> phase is done when a corrective (non-blind) retry passes and an exhausted task parks instead of
> killing the run.

- [x] Carry structured rejection feedback in `TaskEvidence` and thread it back through
      `runTaskWithRetries` → `runTaskWorkflow` into the retrying role's input.
      (`project-orchestrator.ts`, `team-task-workflow.ts`, `team-task-deps.ts`; focused
      retry-threading test green; production task binding suite green.)
- [x] Add the bounded QA → tech-lead test-intent rewrite loop (mirror the coder→reviewer round
      loop) so QA revises against feedback before escalating.
      (`team-task-workflow.ts`; focused QA rewrite tests green; relevant suites now show only
      the expected coder-feedback/no-blind-redo/park-not-kill reds.)
- [x] Pass reviewer + tech-lead-diff notes into the coder's retry within the round loop.
      (`team-task-workflow.ts`, `team-task-deps.ts`; coder-feedback and no-blind-redo tests
      green; relevant suites now show only the expected park-not-kill red.)
- [x] On exhausted feedback-retries, park the task blocked-on-human with the worktree preserved
      (reuse the Project 13 parked-run machinery); hold the project run at that task.
      (`project-orchestrator.ts`, `orchestrated-work-runner.ts`, `mutations.ts`; relevant
      Phase 11A/orchestrated-runner/mutation tests green.)

> **User-reachability:** YES — after this phase, a gate rejection becomes a corrective retry (QA/coder
> revise WITH the rejecting role's notes), and a genuinely-stuck task parks for the operator with its
> work intact instead of ending the run. This is the prerequisite that lets every later orchestrated
> phase survive a gate rejection.

## Phase 10 - Execution observability parity (reopened 2026-06-14)

> Depends on: Phase 5, 8; runs via the orchestrator AFTER Phase 11A has landed, so a gate rejection
> here becomes a corrective retry instead of a terminal block. Reopens the project. Phase 8 made
> orchestrated `/work` do real
> work; Phase 10 makes that work observable. Today the applier emits only a "starting" `log`
> (`orchestrated-work-runner.ts:347`) and one terminal event (`:373`), with the whole loop
> inside one `await runOrchestration` — so codex/claude role activity never reaches the
> cockpit stream and the heartbeat goes stale mid-run (it advances only on `output`/`activity`
> events, `transport/mutations.ts:364`). Two goals: (1) stream role activity and advance the
> heartbeat for BOTH executors at first-class parity with the legacy work-runner
> (`work-runner.ts:1284-1313`); (2) reuse that stream as the durable transcript so a clean
> orchestrated run auto-merges through the Project 15 gated finalizer instead of holding for an
> operator — reversing the Phase 8 deliberate hold. See spec.md §"Phase 10" and requirements
> 36-46.

### Tests (write first)

- [x] Active-harm probe test: assert whether a working orchestrated run (no `output`/`activity`
      for the quiet window) is currently cancelled/nudged by the quiet→cancel / quiet-nudge
      backstop. Pins the finding so the fix is regression-guarded either way.
- [x] Sink-pump test: the orchestrated applier's `apply()` yields ≥1 `activity`/`output` event
      BETWEEN the "starting" event and the terminal event when the injected workflow reports
      role activity — the regression guard against the current two-event gap (it must fail on
      today's runner).
- [x] Heartbeat-advance test: a long-running injected role session advances
      `lastHeartbeatAt`/`lastOutputAt` mid-run; supervision never reads the working run as quiet.
- [x] Codex-stream test: `runCodex` with an injected `onStdout`/`onEvent` callback fires
      per-line as data arrives (not only at `close`); an empty run fires none; `codex exec
      --json` events map to display lines, and malformed/unsupported JSONL falls back to
      scrubbed raw-line streaming with fallback metadata.
- [x] Claude-artifact-stream test: `spawnClaudeAgent` forwards stream-json envelopes as
      `output`/`activity` through the shared `streamJsonToDisplay` mapping — parity with the
      legacy work-runner, no plain-stdout accumulation.
- [x] Role-transition test: `runTeamTaskWorkflow` emits a labeled event per role stage
      (QA → tech-lead review → coder → reviewer → designer → PM wrap-up) and per verdict/objection.
- [x] Provider-attribution test: every emitted activity line carries role + provider + model
      alias and is path/secret-scrubbed.
- [x] Quiet-backstop-safe test: an orchestrated run that is genuinely working (streaming
      activity) is NOT tripped by the quiet-nudge / quiet→cancel backstop — streaming makes the
      active-harm probe test (above) go green.
- [x] Substrate test: a completed orchestrated run writes `transcript.jsonl`, `summary.json`
      (well-formed `WorkRunSummary`), and a computed work-product classification under
      `WORK_RUNS_DIR/<runId>/`.
- [x] Classification test: `computeWorkProduct`/`classifyWorkProduct` over an orchestrated
      branch with commits and `tasksRemaining == 0` yields `branch-complete`; a remaining task
      yields `partial`; a clean tree yields `noop`.
- [x] Auto-merge test: a clean `branch-complete` orchestrated run invokes `runFinalizer`
      (`gated-merge`), the gate passes, and the branch merges `--no-ff` + pushes under the
      per-base merge lock — no operator hold.
- [x] Gate-hold test: a gate-failing run holds branch-complete, records the gate reason, and
      does NOT touch the base branch.
- [x] Objection-hold test: an open high/critical objection-class finding holds the branch with
      the handoff payload recorded and never merges (reqs 17, 25, 63-70).
- [x] No-stub regression test: the orchestrated `finalize` `unavailable` stub
      (`orchestrated-work-runner.ts:234`) is gone and cannot reappear without failing.
- [x] Confirm red before implementation.

### Implementation

> The event sink is the spine; the executor-streaming items are what put live codex/claude
> activity on it, AND they double as the transcript source the finalizer needs — so streaming
> and auto-merge share one foundation. Land the section as a unit (partial wiring leaves the
> stream half-dark or the run stuck on an operator hold). The phase is not done until the live
> acceptance below proves BOTH a non-stale heartbeat and a clean run merging through the gate.

- [x] Verify the active-harm hypothesis and record it (spec Phase 10 work item 1): can the
      quiet→cancel backstop kill a working orchestrated run today? Reframes priority if yes.
- [x] Add an injected `emit(event)` sink to `OrchestrationDeps`; convert the applier's single
      `await runOrchestration` into a queue-drained pump (`apply()` races the orchestration
      promise and yields queued events — mirror the work-runner `enqueue`/generator pattern).
      Thread `emit` through `runProjectOrchestration` and `runTeamTaskWorkflow`.
- [x] Emit orchestration-granularity events: task selected, attempt start/retry, closeout
      commit sha, finalizer handoff/hold, block reason.
- [x] Emit role-transition + verdict/objection events from the team-task workflow.
- [x] Stream the codex executor: add an incremental `onStdout`/`onEvent` callback to `runCodex`.
      Implement `codex exec --json` + a `streamJsonToDisplay` analog as the default; if the
      installed CLI lacks `--json` or emits malformed JSONL, automatically fall back to
      scrubbed raw-line streaming and record that fallback in run metadata. No human decision.
- [x] Stream the claude artifact path: route `spawnClaudeAgent` through
      `--output-format stream-json --verbose` + the shared display mapping for parity.
- [x] Add an `onActivity` callback to `ExecutionAgentIO` so per-session incremental output flows
      up as `activity`/`output` while the session is alive (keeps the heartbeat advancing).
- [x] Attribute every emitted line with role + provider + model, scrubbed via the existing
      `tool-labels`/`redactSecrets` path.
- [x] Verify the cockpit projection (`server/webview.ts`) populates the orchestrated run's
      `lastOutput`/transcript tail and the project card renders role activity.
- [x] Persist the streamed events to a durable transcript sink (`createTranscriptSink` →
      `WORK_RUNS_DIR/<runId>/transcript.jsonl`), mirroring `work-runner.ts:399`.
- [x] Produce work-product classification over the orchestrated branch (`computeWorkProduct` +
      `classifyWorkProduct`) and write `summary.json` (`buildSummary` → `WorkRunSummary`).
- [x] Wire `runFinalizer` in `gated-merge` mode (`work-run-finalizer.ts:283`), replacing the
      `unavailable` stub: bind `classify`/`flushTranscript`/`writeSummary`/`appendIndexRow`/
      `recordPhase`/`readLastPhase` and `gate` = `withBaseBranchLock` + `runGate` over the
      product's `validationCommands`, plus `mergeBranch`/`pushBranch`/`deleteBranch`.
- [x] Preserve the invariants: failed gate or open high/critical objection holds
      branch-complete with the handoff payload recorded; merge only ever through the
      finalizer's gates (reqs 17, 25, 63-70).
- [x] **Live acceptance:** extend `__acceptance__/orchestrated-live.acceptance.ts` to assert (a)
      ≥N intermediate stream events from BOTH executors and `lastHeartbeatAt` advanced during
      execution; (b) a clean run drives all the way to a MERGED base branch (gated); (c) a
      deliberately gate-failing run records a hold. Use a self-contained temp repo and local
      bare remote for merge/push assertions, so the harness needs no production credentials or
      operator action. Supersedes the Phase 8 branch-complete-held acceptance — stub-free proof
      both the observability and auto-merge gaps are closed.
- [x] Record the transcript/finalizer-substrate decisions at closeout (e.g. the WORK_RUNS_DIR
      layout reuse and any orchestrated-specific gate config), and reverse the Phase 8
      deliberate-hold ADR note.

> **User-reachability:** YES — after this phase, an orchestrated run streams live role activity
> (codex AND claude, attributed) to the cockpit card, keeps the heartbeat alive, and — when
> clean — lands on its base branch through the same gated finalizer a legacy `/work` run uses,
> with no operator merge step.

## Phase 11B - Crash recovery & resumable runs (reopened 2026-06-14)

> Runs via the orchestrator AFTER Phase 10 (it reuses Phase 10's durable transcript) and after Phase
> 11A has landed (so a gate rejection during this build is corrective, not terminal). The
> feedback-retry half of the original Phase 11 moved to **Phase 11A** above. Depends on: Phase 5, 8,
> 10. Triggered by the overnight project-17 run (see spec.md §"Phase 11B" and requirements 50-53): a
> server restart orphaned the run (`reconcileOrphans`, `mutations-log.ts:45`) instead of resuming it
> — the Phase 3 `reconstructRun` is dead code and `TaskRunRecord`s are never persisted — and left a
> double-terminal record.

### Tests (write first)

- [x] Record-persistence test: `TaskRunRecord`s + a run cursor are written to a durable store and
      read back to reconstruct a partial run; the resume marker carries product, branch, base,
      worktree, and task-cursor data needed for autonomous *task-level* restart. (Resume is
      task-granular: intra-task convergence state — the Phase 14 findings ledger and round history —
      is in-memory and rebuilt by re-running the interrupted task, so it is deliberately NOT in the
      cursor. Phase 14 also removes the persisted `attemptCap` cursor field; resume stays
      backward-tolerant of an older cursor that still carries it.)
- [x] Resume test: a still-`running` orchestrated mutation at boot is reconstructed
      (`reconstructRun`) and re-dispatched against its existing branch, resuming from the first
      unchecked task — not flipped to `failed/orphaned`; a single-run lease prevents two
      processes from resuming the same mutation concurrently.
- [x] No-double-terminal test: crash recovery never writes a terminal for a run that will resume,
      and the pipeline never lands two terminal records for one id (skip-if-terminal guard).
- [x] Worktree-preserve test: the orphan-worktree sweep skips a run marked for resume (or the
      branch-resume path rebuilds it on re-dispatch).
- [x] Confirm red before implementation.

### Implementation

> Lands via the orchestrator as a single unit. Not done until the live acceptance proves a mid-run
> restart resumes to a single clean terminal.

- [x] Build the `TaskRunRecord` JSONL store + run cursor + resume marker (the persistence layer
      `orch-run-record.ts` promises); reuse Phase 10's transcript as part of the record set.
- [x] Wire `reconstructRun` into the boot path: reconstruct + re-dispatch a still-`running`
      or `resumable` orchestrated mutation against its branch instead of the blind
      `reconcileOrphans` flip; guard with a single-run lease.
- [x] Make `reconcileOrphans` orchestration-aware + idempotent (never terminal-write a
      resumable run; skip-if-already-terminal), and add a graceful-shutdown drain that marks
      in-flight orchestrated runs `resumable` rather than leaving a bare `running` line.
- [x] Make `cleanupOrphanWorktrees` skip a resume-marked run's worktree.
- [x] **Live acceptance:** a restart injected mid-run resumes to completion (no orphaned record,
      exactly one terminal); a forced gate rejection drives a corrective QA retry that PASSES on
      the feedback. Stub-free proof both failure modes are closed.

> **User-reachability:** YES — after this phase, an orchestrated run survives a mid-run server
> restart (resumes instead of dying) rather than orphaning, with exactly one terminal record,
> observable on the cockpit card.

## Phase 12 - Role learning & exemplars (reopened 2026-06-14)

> Depends on: Phase 4, 6 (reuses the `writeRoleLesson` + `runPostMortem` machinery), and the
> Phase 11A gate-rejection feedback object. Triggered by the project-17 run, which exposed that
> the team has no memory and no model of "good": all six role memories are cold-start, no role
> gets an exemplar of good output, and a gate block leaves zero durable lesson (the learning
> loop is nightly + explicit-feedback-only, `feedback-record.ts:5`). Where Phase 11A makes a
> rejection fix the current attempt, Phase 12 makes it teach the next. See spec.md §"Phase 12"
> and requirements 54-62.

### Tests (write first)

**A. Role exemplars**

- [x] Exemplar-channel test: `composeRoleContext` includes an exemplars channel (baseline +
      per-project) as low-authority reference, alongside SOUL and memory, budget-bounded.
- [x] Baseline test: each role has a permanent `agents/<role>/examples/` baseline; QA's includes
      a correctly-pinned redaction test (real token in, raw token asserted absent).
- [x] Per-project exemplar test: the tech-lead planning output emits per-project exemplars,
      persisted with the project and surfaced to the relevant role's context.
- [x] Exemplar-fail-safe test: missing or over-budget exemplar files degrade to a visible
      low-authority note and do not block role invocation.

**B. Gate-triggered learning**

- [x] Gate-record test: each gate block in `team-task-workflow.ts` emits a structured rejection
      record (rejecting role, counterpart, what failed, notes) — the same object Phase 11A threads.
- [x] Draft-then-validate test: the rejecting role drafts a candidate lesson; a neutral Jarvis
      pass (`runPostMortem` model) privacy-filters, dedupes, attributes, and fails safe to
      no-lesson before any write — roles never write memory directly.
- [x] Gate-time-write test: a passing validation writes the lesson to the COUNTERPART's memory
      via `writeRoleLesson`, synchronously at gate-time (not deferred to nightly).
- [x] Compounding test: a gate-time lesson loads into the counterpart role's next invocation
      reference context (the Phase 6 compounding path).
- [x] No-double-write test: the nightly loop and the gate-time path share one write path and do
      not double-write the same lesson (the `memory-writer.ts` dedupe is the guard).
- [x] Learning-fail-safe test: lesson drafting, validation, or memory-write failure records a
      durable skip/error and does not block the current corrective retry path.
- [x] Confirm red before implementation.

### Implementation

> Part A (exemplars) and Part B (gate-triggered learning) are independent; land each as a unit.
> Part B reuses the existing `writeRoleLesson` + `runPostMortem` seams — it adds a gate-time
> trigger and a role-drafted candidate, not a new memory-write path. The phase is not done until
> the live acceptance shows a re-run passing on a lesson + exemplar a prior gate failure produced.

**A. Role exemplars**

- [x] Author the permanent per-role exemplar baseline under `agents/<role>/examples/`, starting
      with QA (a correctly-pinned redaction/security-boundary test).
- [x] Extend the tech-lead planning output to emit per-project exemplars (alongside test
      strategy), persisted with the project.
- [x] Add the exemplar channel to `composeRoleContext` (`loader.ts`): charter + memory +
      exemplars, budget-bounded as low-authority reference; missing/invalid exemplars degrade
      visibly and never block a role call.

**B. Gate-triggered learning**

- [x] Emit the structured gate-rejection record at each gate block in `team-task-workflow.ts`,
      shared with the Phase 11A feedback object.
- [x] Have the rejecting role draft a candidate lesson from that record.
- [x] Run the neutral Jarvis validation (`runPostMortem` model) synchronously at gate-time and
      write via `writeRoleLesson` into the counterpart's memory; fail safe to no-lesson.
- [x] Confirm the gate-time path and nightly loop share one write path without double-writing.
- [x] Record durable skip/error metadata when drafting, validation, or memory writing fails, and
      keep the Phase 11 corrective retry path moving.
- [x] **Live acceptance:** a forced QA→tech-lead redaction rejection writes a validated QA lesson
      and leaves the exemplar; a re-run loads both and the QA output passes the gate.

> **User-reachability:** YES — after this phase, a gate failure makes the team permanently
> smarter: the rejected role gains a memory lesson and reference exemplars, observable in the
> committed `memory.md` / `examples/` diffs, and the next run on a similar task passes where this
> one blocked.

---

## Phase 13 - Outcome gating: pass / pass-with-warnings / fail / block (reopened 2026-06-16)

> Triggered by the 2026-06-15 Codex-stream failure: one reviewer objection (a redaction artifact,
> not a real defect) short-circuited retries and discarded a complete run. The binary objection
> gate has two flaws — severity is captured but unused (any objection hard-blocks regardless of
> severity), and a block maps to `failed` with the worktree destroyed instead of parking for a
> human. This phase makes severity gate, adds a `pass-with-warnings` outcome, gives blocks one
> corrective round before parking, and aligns the terminal with the spec's blocked-on-human
> intent. See spec.md §"Outcome gating" and requirements 63-70.
>
> **Sequencing:** runs via the orchestrator AFTER Phases 10 / 11B / 12. Depends on Phase 4
> (team-task workflow) and Phase 11A (reuses the already-built `GateRejectionFeedback`). A
> `/work --auto` target — no operator decisions in the automated path; the human override surface
> is exercised through an injected seam.

### Red tests (confirm red before implementation)

- [x] Outcome-enum test: a reviewing role's verdict carries exactly one of
      `pass`/`pass-with-warnings`/`fail`/`block` as a structured field; a bare boolean is
      normalized/rejected, never silently coerced.
- [x] Severity-mapping test: `critical`/`high` objection → `block`; `medium` → `fail`; `low` →
      `pass-with-warnings`. A `low`/`medium` finding can never produce `block`, and multiple
      findings resolve to the strictest mapped outcome.
- [x] Warnings-recorded test: a `pass-with-warnings` outcome proceeds and the warnings land in the
      `TaskRunRecord` and the finalizer handoff.
- [x] Fail-retry test: a `fail` threads feedback to the coder and retries within the round cap; at
      the cap it routes to PM wrap-up.
- [x] Block-one-round test: a reviewer-produced `block` delivers its feedback to the coder for
      exactly one corrective round from the dedicated block-correction budget before parking; it
      does not short-circuit with zero corrective attempts.
- [x] Block-parks-not-fails test: a surviving `block` parks `blocked-on-human` with worktree +
      branch preserved; an open blocking objection is NEVER mapped to `failed` with a destroyed
      worktree (regression for the `maybeParkedRun` `objectionOpen` exclusion +
      `mapResultToTerminal` blocked→failed mapping).
- [x] Accept-with-rationale test: an injected human/PM acceptance requires a rationale, records
      it in the task/run record, and the task proceeds as `pass-with-warnings`.
- [x] Fail-safe test: a malformed severity or a recording failure degrades to an operational
      `block`, records a durable reason, and parks without consuming a coder corrective round.
- [x] Confirm red before implementation.

### Implementation

- [x] Add a structured `outcome` field (`pass`/`pass-with-warnings`/`fail`/`block`) to
      a shared `GateVerdict` contract used by reviewer, tech-lead diff, and designer gates.
      Normalize existing boolean adapters at their boundary, then migrate orchestration callers
      off the bare `pass` boolean + `objections.length > 0` branch (`team-task-workflow.ts`).
- [x] Add a single severity→outcome mapping function (one source of truth) and route every gate
      through it instead of the `objections.length > 0` hard branch; choose the strictest mapped
      outcome when a verdict carries multiple findings.
- [x] Replace the one-shot reviewer objection block: deliver the already-built
      `GateRejectionFeedback`, allow one corrective coder round from the dedicated
      block-correction budget, then park. Operational fail-safe blocks park immediately.
- [x] Fix `maybeParkedRun` to park objection-open blocks (drop the `objectionOpen` exclusion) and
      `mapResultToTerminal` to map a surviving block to a parked/`blocked-on-human` terminal, not
      `failed` (`project-orchestrator.ts`, `orchestrated-work-runner.ts`).
- [x] Thread `pass-with-warnings` findings + accepted-block rationales into the `TaskRunRecord` and
      finalizer handoff.
- [x] Add an accept-with-rationale core override seam (injected for tests) that requires a
      rationale, records it durably, and resumes the task as `pass-with-warnings`; real
      cockpit/Telegram inbox wiring can be its own task.
- [x] Retire the Phase 13 Objection-Classes / Auto-merge consumer task into Phase 14. The
      consumer gate now belongs to the `reversible` terminal handler below, not a standalone
      severity-aware `block` gate.

> **User-reachability:** YES — after this phase, a low-severity nit ships as a recorded warning
> instead of killing the run, a real blocking defect parks for a human with the work preserved
> (not discarded), and the accept-with-rationale trail is visible in the run record.

---

## Phase 14 - Severity loop to convergence: no human blocks (reopened 2026-06-18)

> Triggered by the 2026-06-17 orchestrated run, which built the full Phase 13 severity gate and then
> parked `blocked-on-human` on a real `high`/`irreversibility` finding — a gate the coder and reviewer
> are capable of resolving themselves. This phase removes `block` and every human terminal, runs the
> per-task loop to severity convergence under a stagnation backstop + hard round budget, restructures
> the objection taxonomy (drop `irreversibility`, add `outbound`, add a per-finding `reversible`
> flag), gives the review gates per-task findings memory, and makes the only non-merge terminal an
> non-reversible-finding branch HOLD. See spec.md §"Phase 14: Severity loop to convergence" and
> requirements 71-82.
>
> **Sequencing:** runs via the orchestrator AFTER Phase 13. Depends on Phase 4 (team-task workflow),
> Phase 11A (reuses `GateRejectionFeedback`), and Phase 10 (rewrites its auto-merge / finalizer
> consumer). A `/work --auto` target — the design removes every operator decision from the path.

### Red tests (confirm red before implementation)

- [x] Outcome-enum test: `GateVerdict.outcome` is exactly one of `pass`/`pass-with-warnings`/`fail`;
      `block` is no longer a producible outcome and any attempt to map a finding to `block` is a
      type/normalization error.
- [x] Severity-mapping test: `critical`/`high`/`medium` → `fail`, `low` → `pass-with-warnings`;
      multiple findings resolve to the strictest mapped outcome; no input ever yields `block`.
- [x] Finding-shape test: a review-gate finding carries `{class, severity, location, rationale,
      reversible}`; `class` ∈ {`security`,`privacy`,`data-integrity`,`concurrency`,`outbound`,
      `cost-perf`}; `irreversibility` is rejected; `reversible` is required.
- [x] Reversible-default test: a finding (from reviewer, tech-lead diff, or designer) that OMITS or
      malforms `reversible` normalizes to `reversible: false` — never dropped and never defaulted to
      mergeable — so a high/critical finding with a missing flag fails safe to the terminal HOLD.
- [x] No-human-terminal test: no per-task path returns `blocked-on-human`, PM-wrap-up, or consults the
      outer attempt cap; `decideAttemptOutcome` and the block-correction budget are gone.
- [x] No-block-residue test: `ReviewerOutcome`/`GateVerdict.outcome` no longer admits `block` and
      no `ObjectionClass` admits `irreversibility` (compile-level guard); the Phase 13 tests that
      asserted the `block` outcome, block-correction budget, and per-task `blocked-on-human`
      terminals are retired/rewritten and the suite is green against the 3-value model.
- [x] Operational-terminal test: an operational failure that is NOT a finding (malformed/unparseable
      gate output, closeout/persist failure, rejected context update, dirty worktree) terminates as
      a durable non-merge HOLD with the operational reason recorded and branch/worktree preserved —
      it does not auto-merge and does not route to `blocked-on-human` (req 83).
- [x] Evidence-carries-ledger test: `TaskEvidence` returned to the orchestrator carries the terminal
      findings ledger and the loop-exit reason (all-low / stagnation / hard-budget / operational) so
      the orchestrator's terminal handler can drain findings and decide HOLD vs gated merge without
      re-deriving them.
- [x] Primary-exit test: a round whose max open severity is `low`/none exits the loop to closeout with
      the lows recorded as warnings.
- [x] Stagnation-backstop test: a run whose max open severity holds flat for 3 consecutive rounds
      stops and routes to terminal handling before reaching the 4-round budget.
- [x] Hard-budget test: a run still above `low` at round 4 stops and routes to terminal handling;
      round 5 never executes.
- [x] Convergence test: a run whose max severity strictly drops each round (critical→high→medium→low)
      runs past round 3 and exits via the primary all-low gate, not a backstop.
- [x] Coder-ordering test: the coder receives the ledger severity-sorted, attempts every open finding,
      addresses the highest severity first, and reports which findings it addressed.
- [x] Reviewer-regression-first test: on re-review the reviewer verifies each open prior finding
      (citing it) before discovery; a previously `resolved` finding that reappears is marked
      `regressed`; the ledger persists across rounds.
- [x] Review-gates-preserved test: tech-lead diff review and designer review (when
      designer-needed) still run inside each convergence round; their findings normalize into the
      shared ledger with `sourceGate`, so Phase 14 does not bypass existing gates.
- [x] Terminal-bugs.md test: at terminal the orchestrator writes one detailed
      `docs/projects/bugs.md` entry per remaining `>low` finding (finding id, source gate,
      class, severity, location, rationale, run/task id, and reversible flag) and dedupes by
      run/task/finding id.
- [x] Reversible-hold test: a remaining `critical`/`high` finding with `reversible: false` HOLDS the
      branch (no auto-merge, finalizer handoff); when all remaining `>low` findings are reversible the
      gated auto-merge proceeds and the run advances — never `blocked-on-human`.
- [x] Confirm red before implementation.

### Implementation

- [x] Remove `block` from `GateVerdict`; rewrite `mapObjectionSeverityToOutcome`
      (`team-task-workflow.ts`) to `critical`/`high`/`medium` → `fail`, `low` →
      `pass-with-warnings`; delete the block branch + block-correction budget.
- [x] Restructure `ObjectionClass` (`team-task-workflow.ts`): drop `irreversibility`, add
      `outbound`; add a `reversible: boolean` field to `ObjectionFinding`.
- [x] Delete the outer attempt cap: remove `decideAttemptOutcome` (`orch-attempt-cap.ts`), the
      PM-wrap-up-at-cap terminal, and every `blocked-on-human` per-task terminal. Collapse
      `runTaskWithRetries` (`project-orchestrator.ts`) to a single workflow invocation (the workflow
      now owns the convergence loop internally) and drop `OrchestrationDeps.attemptCap` /
      `ORCHESTRATED_ATTEMPT_CAP`. Remove the `attemptCap` field from the persisted run cursor
      (`orchestrated-work-runner.ts`, `sandbox-runtime.ts`) and its resume validators, keeping
      cursor resume backward-tolerant of an older in-flight cursor that still carries `attemptCap`
      (ignore the field, don't reject the cursor).
- [x] Rewrite the round loop (`team-task-workflow.ts`): coder → review gates per round
      (reviewer, tech-lead diff, and designer when applicable) with the exit precedence — all-low
      primary exit, 3-round stagnation backstop on max severity, 4-round hard budget. Set
      `DEFAULT_ROUND_CAP` to 4 (`team-task-deps.ts`) and track the per-round max severity
      history for the stagnation check.
- [x] Add the per-task findings ledger `{id, sourceGate, class, severity, location, rationale,
      reversible, raisedRound, status: open|resolved|regressed}`; thread it into `ReviewerInput`
      (`team-task-workflow.ts`) and any gate prompt that can verify prior findings each round.
- [x] Add stable finding-id generation and dedupe semantics for the ledger and terminal bug
      entries so re-reviews of the same finding update one ledger row instead of creating
      duplicate bugs.
- [x] Update the reviewer harness to run regression-first then discovery, and update
      `agents/reviewer/SOUL.md` to hunt the new class set and set `reversible` per finding.
- [x] Update tech-lead diff and designer verdict normalization so their findings use the same
      class/severity/reversible shape and enter the shared ledger with `sourceGate`; a finding that
      omits `reversible` normalizes to `reversible: false` (fail-safe). Update `agents/tech-lead`
      and `agents/designer` SOUL/prompt instructions to request `class`/`severity`/`reversible` per
      finding (matching the reviewer SOUL update), so the conservative default is a backstop, not
      the common path.
- [x] Update the coder harness to receive the ledger severity-sorted, fix highest-severity-first,
      attempt all findings, and report which it addressed.
- [x] Extend `TaskEvidence` so it carries the terminal findings ledger and the loop-exit reason
      (`all-low` / `stagnation` / `hard-budget` / `operational`) out to the orchestrator; retire the
      now-insufficient `objectionOpen` boolean in favor of the ledger so the terminal handler keys
      on per-finding `reversible`, not a single flag.
- [x] Rewrite the operational fail-safe path: malformed/unparseable gate output and the
      warning/acceptance-recording failures that Phase 13 mapped to `outcome: 'block'`
      (`operationalBlockReason`) now produce an operational non-merge HOLD terminal (req 83), not a
      `block` outcome and not a human-gated park.
- [x] Rewrite the auto-merge / finalizer consumers (`project-orchestrator.ts`
      `maybeParkedRun` / objection-open handling, `operationalParkedRunField`, and
      `orchestrated-work-runner.ts` terminal mapping): replace the per-finding severity gate with the
      terminal handler — drain remaining `>low` findings to the Jarvis repo's `docs/projects/bugs.md`
      via the backlog safe-write substrate (`withFileLock` + `assertBacklogWriteAllowed` +
      `writeFileAtomic`, deduped by run/task/finding id), HOLD the branch when any remaining
      `critical`/`high` is `reversible: false`, else proceed through gated auto-merge. This subsumes
      the multi-finding `.find` → `.every` gate-bypass defect.
- [x] Retire/rewrite the Phase 13 block-model tests that the union changes break at compile or
      assertion time (`team-task-workflow.test.ts`, `team-task-deps.test.ts`,
      `orchestrated-work-runner.test.ts`, `project-orchestrator.test.ts`, `orch-execution.test.ts`):
      drop the `block` outcome / `irreversibility` class / block-correction / per-task
      `blocked-on-human` assertions and re-express them against the severity-convergence model. Leave
      the LEGACY work-run parked-run machinery (`supervision-*`, `work-run-*`) untouched — Phase 14's
      `blocked-on-human` removal is scoped to the per-task orchestration path only.

> **User-reachability:** YES — after this phase, an orchestrated run resolves its own findings to
> severity convergence and lands autonomously; nothing ever parks waiting on the user, unresolved
> nits show up as `docs/projects/bugs.md` entries, and only a genuinely non-reversible
> high/critical finding holds a branch instead of merging.

---

## Phase 15 - Project-completion finalization & per-commit progress alerts (added 2026-06-18)

> Phase 15 wrap-up. Two operator-visibility gaps the Phase 10/14 auto-merge path left open:
> (1) when a project's last task lands and the run merges clean, nothing flips the project's
> `index.md` Status to **Done** and nothing tells the operator the branch reached `main` — the
> merge is silent; (2) the per-task closeout commits stream by with no notification, so there is
> no live "task N of M done" signal while a run is in flight. This phase makes project completion
> finalize the index row and announce itself, and makes every closeout commit emit a progress
> alert.
>
> **Mostly wiring over existing substrate, not new merge machinery.** The gated merge, push,
> worktree removal, and branch delete already exist (`work-run-finalizer.ts` `runFinalizer` /
> `runGatedMerge`: `mergeBranch` → `pushBranch` → `removeWorktree` → `deleteBranch`), and Phase 14's terminal
> handler already routes a clean `branch-complete` run through them and ends the run. Phase 15
> adds two steps INSIDE `runGatedMerge` — an index-status commit recorded as a new
> `project-marked-done` phase AFTER eligibility classification and BEFORE the final summary/index
> writes + gate, and a success notification
> fired AFTER push + cleanup — plus one alert at the per-task closeout commit. Both new steps are
> finalizer-owned (so they inherit the crash-resume phase machine and the no-self-merge invariant);
> the index step gracefully skips a worktree with no `docs/projects/index.md` and HOLDs on an
> ambiguous one. It does NOT add a second merge path, a new bot, or new chat plumbing (reuses the
> operator notification surface in `transport/telegram-sender.ts`, the same path the gate-fail
> `alert` already reaches).
>
> **Sequencing:** runs via the orchestrator AFTER Phase 14. Depends on Phase 5 (orchestrator
> loop), Phase 10 (finalizer wiring + durable transcript), Phase 14 (terminal handler). A
> `/work --auto` target — no operator decisions in the path.

### Red tests (confirm red before implementation)

**A. Project-completion finalization**

- [x] Index-Done test: when the gated finalizer classifies a clean `branch-complete` run (all tasks
      checked, no `reversible:false` hold) and the worktree carries `docs/projects/index.md`, it sets
      the project's status to `Done` in BOTH the table Status cell AND the `## <slug> — <status>`
      section heading and records ONE dedicated commit on the feature branch carrying that edit,
      AFTER classification and BEFORE the gate. An already-`Done` project is left unchanged
      (idempotent — no empty commit, safe on crash-resume re-read).
- [x] Noop-skips-index test: an all-tasks-checked run with zero commits classifies `noop`, so the
      index flip never fires and the run never merges — the flip is gated on the classified
      `branch-complete` outcome, not on all-tasks-checked alone.
- [x] Index-absent-skips test: a worktree with NO `docs/projects/index.md` is a graceful skip — the
      finalizer still merges (the index convention is Jarvis-repo-specific), no HOLD, no commit.
- [x] Index-ambiguous-holds test: a PRESENT-but-malformed table, zero matching rows/headings, or
      multiple matches produces an operational HOLD with branch/worktree preserved; it does not
      guess, edit the base branch, or merge a completed project whose index was not safely finalized.
- [x] Index-status-tokens-only test: the writer changes only the matched project's two status tokens
      (table Status cell + section heading, preserving any `(…)` heading suffix), and preserves the
      project link, summary text, table header/alignment row, section body, row order, and unrelated
      project rows/headings byte-for-byte.
- [x] Terminal-summary-refresh test: because the index flip creates a new commit after the initial
      eligibility classification, `summary.json`, the work-runs index row, and the terminal payload
      include the project-Done commit's head sha/commit count (no stale pre-finalizer summary).
- [ ] Index-on-branch test: the Status→`Done` edit is committed on the feature branch in the
      worktree, so it is part of what merges to the base branch — not written to the base directly
      and not left uncommitted in the worktree (a writer failure leaves no unstaged index edit).
- [ ] Project-marked-done-resume test: crash/restart after `project-marked-done` (and before
      `merged-not-pushed`) re-enters the gated finalizer, skips the already-committed index flip,
      runs the gate/merge/push/delete path, and reaches exactly one terminal without any human
      release or manual retry.
- [ ] Index-merge-conflict test: when the finalizer's `git merge` of the branch hits a conflict on
      `docs/projects/index.md` (a concurrent landing changed it on the base), the merge is aborted
      and the run HOLDs operationally with work preserved — never a half-merged dirty base.
- [ ] Hold-skips-index test: a run that HOLDs (a remaining `reversible:false` high/critical
      finding, or an operational HOLD) does NOT flip the index to `Done`; the flip happens only on a
      merge-bound terminal.
- [ ] Merge-success-notify test: a successful gated merge sends exactly one Telegram message to the
      operator naming the project and the base branch it landed on, after push succeeds and finalizer
      cleanup has been attempted; the orchestrated terminal mutation message does NOT also claim a
      merge (single landing claim); a gate-fail HOLD still sends only the existing fail alert and
      never the success message (no double-send, no success message on a hold).
- [ ] Merge-success-resume-dedupe test: crash/restart after `pushed-not-deleted` resumes finalizer
      cleanup and sends at most one merge-success notification for the run; a replay after the
      notification was recorded sends none.
- [ ] Order test: for a clean run the sequence is eligibility classify → index-`Done` commit →
      refreshed terminal summary/index writes → gate → merge → push → remove worktree → delete
      branch → success notify → run-end; the success notify fires only after `mergeBranch`/
      `pushBranch` resolve.

**B. Per-commit progress alerts**

- [ ] Per-commit-alert test: each successful closeout commit (`commitCloseout`,
      `orchestrated-work-runner.ts:306`) emits one Telegram message naming the just-completed
      task and a remaining/total breakdown (e.g. "3/12 done, 9 remaining") derived from the live
      `tasks.md` checkbox counts / `transitions.tasksRemaining`, not a hardcoded number.
- [ ] No-commit-no-alert test: a task that blocks/holds without a closeout commit emits no
      progress alert — the alert is bound to a real commit, not to task selection.
- [ ] Alert-fail-safe test: an event publication failure (per-commit OR merge-success) records a
      durable skip/error and never blocks or fails the run; a downstream Telegram/webview transport
      send failure is logged by the sender and also never blocks or fails the run.
- [ ] Progress-replay-dedupe test: orchestrator resume/replay after a closeout commit does not
      send a second progress alert for the same commit sha; a new closeout commit still sends once.
- [ ] Confirm red before implementation.

### Implementation

> Part A and Part B are independent; land each as a unit. Both reuse the existing operator
> notification surface — no new bot or chat plumbing.

**A. Project-completion finalization**

- [ ] Add an idempotent index-status writer: a pure helper that parses `docs/projects/index.md`,
      locates exactly one project by slug/link, and sets its status to `Done` in BOTH the table
      Status cell AND the `## <slug> — <status>` section heading (preserving any `(…)` heading
      suffix), preserving link/summary/header/alignment/section-body/row order byte-for-byte.
      Already-`Done` → no edit, no empty commit. Return a typed result distinguishing
      `done`/`already-done`/`absent` (graceful skip) from `ambiguous`/`malformed` (operational HOLD)
      — never a best-effort guess.
- [ ] Wire the index writer as a finalizer step, NOT in the orchestrator terminal handler: invoke it
      inside `runGatedMerge` AFTER `classify()` returns `branch-complete` and BEFORE the gate, record
      a new `project-marked-done` `FinalizerPhase` (after the eligibility classification and before
      `summary-written`/`index-appended`) so a crash-resume skips an already-committed flip, and
      commit only the index edit as one dedicated commit in the worktree. After the commit, refresh
      or re-stamp the terminal event/work-product facts before `writeSummary`/`appendIndexRow` so
      the persisted summary and terminal include the project-Done commit. An `absent` index skips
      the step (still merges); an `ambiguous`/`malformed` index returns an operational-HOLD terminal
      that preserves the branch/worktree and leaves no unstaged index edit behind.
- [ ] Extend finalizer crash recovery: `recovery-finalize-runner` must treat `project-marked-done`
      and any later pre-merge phase (`summary-written`/`index-appended`) as a resumable
      `gated-merge` state for a branch-complete run, re-running the gate/merge/push/delete path
      without human release. It must not downgrade a clean run to HOLD just because the crash
      happened before `merged-not-pushed`.
- [ ] Handle an index merge conflict: when `mergeBranch` fails with a conflict on
      `docs/projects/index.md`, abort the in-progress merge in the base checkout and surface an
      operational HOLD (work preserved on the branch) rather than leaving a half-merged dirty base.
- [ ] Add a merge-success notification: extend the gated-merge effects in `work-run-finalizer.ts`
      `runGatedMerge`/`FinalizerEffects` with an `onLanded` success callback that fires after
      `pushBranch` resolves (or a `pushed-not-deleted` crash-resume proves it landed) and cleanup has
      been attempted — placed in the shared post-cleanup tail gated on `merged === true`, symmetric
      to the existing gate-fail `alert`; bind it in `orchestrated-work-runner.ts` to an operator
      message naming the project + the base branch it landed on. Ensure the orchestrated terminal
      message does not separately claim a merge. Leave the gate-fail `alert` path unchanged.
- [ ] Persist notification delivery state under the run artifact directory (or the existing
      finalizer phase store if that is the cleaner fit): one record keyed by closeout commit sha
      for progress-alert publication and one keyed by run id + branch + pushed phase for
      merge-success publication. Use it for replay/restart dedupe and to record publication
      skip/error metadata; transport delivery errors stay in the sender logs because the bus has no
      acknowledgement channel.
- [ ] Confirm the merge-bound path order (eligibility classify → index-`Done` commit → refreshed
      terminal summary/index writes → gate → merge → push → remove worktree → delete branch →
      success notify → run-end) and that every HOLD path (finding, operational, gate-fail,
      ambiguous-index, merge-conflict) skips BOTH the index flip and the success notify.

**B. Per-commit progress alerts**

- [ ] Emit a per-commit progress alert at `commitCloseout`: after the closeout commit succeeds,
      publish one operator progress event with the just-completed task title, short sha, commit
      subject, and remaining/total from the live `tasks.md` checkbox counts. Bind it to the commit
      sha; fail-safe (a publication error is recorded, never fatal; sender delivery errors are
      logged by the sender, never fatal).
- [ ] Bind the progress and merge-success events through the existing mutation/activity bus and
      `transport/telegram-sender.ts` formatting instead of calling Telegram from orchestration code.
      Enforce the dedupe (the Part A publication-state records) at the run/artifact layer BEFORE the
      event is published, so the sender stays stateless and a redelivered/replayed event cannot
      double-send. Webview forwarding may pass the same event through, but Phase 15 acceptance only
      requires the injected operator-notification sink plus Telegram formatting.
- [ ] **Live acceptance:** a multi-task orchestrated run on a throwaway fixture project (reuse the
      Phase 8/10 `__acceptance__` temp-repo + local bare remote harness, notification surface
      injected so no real Telegram is needed) drives ≥2 tasks and asserts: one progress alert per
      closeout commit with a correct remaining/total; on the final task the project status flips to
      `Done` in BOTH the index table cell and the section heading on the branch; the branch merges to
      the bare remote base branch; and exactly one merge-success notification fires.

> **User-reachability:** YES — after this phase, an operator watching a run gets a "task done, N
> remaining" ping at every commit, and when the project finishes, its index row reads **Done** and
> a single "merged to `main`" message lands. The silent auto-merge becomes a narrated one.

### Bug: orchestrated runs strand at `running` — non-atomic two-phase terminal write (found 2026-06-18)

> **Symptom.** The cockpit shows an "active" orchestrated run for `14-product-team-agents` that is
> not actually running. Run `0620f39e` (dispatched from the webview at `2026-06-19T03:12:25Z`,
> classified `noop`, durationMs 186) is wedged: `summary.json` + the work-runs `index.jsonl` row
> say terminal (`noop`), but `mutations.jsonl` has only `pending` + `running` (no terminal line) and
> `supervised-runs.json` still reads `status: running`. The cockpit projects that stale supervised
> record as `active:1` — and has read it as active continuously since dispatch (`work-run-projection`
> logged `active:1` from `03:12:26` through the end of the log ~21 min later).
>
> **Root cause — the terminal state is written by two actors, non-atomically.** (1) The applier
> writes the work-product artifacts inline: the finalizer / `persistTerminalArtifacts`
> (`orchestrated-work-runner.ts:893`) writes `summary.json` + `index.jsonl`, then `yield terminal`
> (`:907`). (2) The *consumer* `startApply` (`transport/mutations.ts:493-538`) writes the lifecycle
> status — flips the mutation status (`appendMutationLine`) and the supervised status
> (`safeUpsertRun`) — but only when it *consumes* that yielded terminal event. For `0620f39e` step 1
> ran and step 2 never did: the work product is persisted but the run status is forever `running`.
>
> **Pinned from the logs, NOT a guess:** the applier did **not** throw (no `"Mutation applier threw"`
> error line — `startApply`'s catch at `transport/mutations.ts:550` never fired), and the dispatch did
> **not** bypass `startApply` (`createMutation` → `autoApprove:true` → `void startApply`, and the
> `running` supervised seed at `:392` proves it started). The `for await` at `transport/mutations.ts:423`
> simply never received the terminal `yield` from `orchestrated-work-runner.ts:907` — an un-terminated
> consumer of a floating, un-awaited `void startApply` promise. The asymmetry is the proof: the
> work-product layer (written before the yield) is present; the lifecycle layer (written after consuming
> the yield) is absent; no error surfaced.
>
> **Why nothing self-heals.** The only mechanisms that terminalize a stranded orchestrated run are
> startup-only: `reconcileOrphans` (`mutations-log.ts:71`) **intentionally skips orchestrated-work**
> (`:99-100`), and supervision-recovery (`index.ts:66`, `supervision-recovery.ts`) runs only at boot.
> Both ran at the `03:11:11` restart — `74s before` `0620f39e` was dispatched — so they missed it, and
> nothing has run since. (Those sweeps are what flipped the earlier stuck runs `74452a40` / `869d9e09`
> to terminal `failed` — note `74452a40`'s work product says `branch-complete` but its lifecycle status
> was force-flipped to `failed`: the same two-actor disagreement, opposite direction.)
>
> **Second-order:** `stall-check-runner` (5-min threshold, live since `03:11:11`) never flagged the run
> despite 20+ min "running" — it inspects live `activeRuns` handles, not the persisted supervised store,
> so an abandoned record with no live handle is invisible to the one backstop meant to catch quiet runs.

**Red tests (confirm red before implementation)**

- [ ] Atomic-terminal test: when the orchestrated applier reaches a terminal outcome
      (`finalized`/`held`/`blocked`/`failed`), the mutation status AND the supervised status are
      persisted terminal **by the applier itself**, in the same step that writes the work-product
      artifacts — not contingent on a downstream consumer observing the yielded event. Assert that
      after the applier's terminal step, `mutations.jsonl` (latest line) and `supervised-runs.json`
      both read the terminal status even if the yielded event is dropped/never consumed.
- [ ] Lost-yield-no-strand test: simulate the consumer abandoning the `for await` immediately after
      the work-product write (no terminal event consumed); the run must NOT be left at `running` —
      the supervised store reflects the classified outcome (`noop`/`branch-complete`/`failed`).
- [ ] Work-product-vs-lifecycle-agreement test: for every terminal outcome, the work-runs
      `summary.json` outcome and the supervised/mutation status are consistent (a `branch-complete`
      work product is never paired with a `failed` lifecycle status, and a terminal work product is
      never paired with a `running` lifecycle status).
- [ ] Periodic-reconciler test: a supervised entry still `running` whose
      `work-runs/<id>/summary.json` already shows a terminal outcome is flipped to that outcome by a
      timer-driven reconciler (NOT startup-only), with no restart and no live handle required. An
      entry with no terminal summary is left untouched (still genuinely in flight).
- [ ] Stall-check-store-source test: stall detection reads the persisted supervised store (not only
      live `activeRuns` handles), so an abandoned `running` record past the stall threshold with no
      live handle is surfaced rather than silently ignored.
- [ ] Reconcile-orchestrated-mutations test: `reconcileOrphans` (or its replacement) no longer
      exempts `orchestrated-work` — a stale `running` orchestrated mutation with a terminal work
      product is terminalized, not left `running` forever in `mutations.jsonl`.

**Implementation**

- [ ] Move the lifecycle-terminal write into the applier's terminal path so work product and run
      status are persisted together (single owner, atomic): the applier writes the terminal mutation
      line + supervised status alongside `persistTerminalArtifacts`; the yielded event becomes
      notification-only (bus/Telegram/cockpit-stream), no longer the sole carrier of the status write.
- [ ] Add a periodic, store-driven reconciler (timer, not startup-only) that flips any supervised
      `running` whose run-artifact `summary.json` shows a terminal outcome to that outcome, and
      terminalizes the matching mutation-log line.
- [ ] Point stall-check at the persisted supervised store (in addition to live handles) so abandoned
      runs past threshold are caught.
- [ ] Stop exempting `orchestrated-work` in `reconcileOrphans` (`mutations-log.ts:99-100`), or fold
      its responsibility into the periodic reconciler above.
- [ ] One-time cleanup: terminalize the currently-stranded `0620f39e` (its work product is `noop`)
      so the cockpit clears the phantom active run.

> **Provenance:** same defect class as Phase 11 ("persist run state, exactly one terminal" / the
> double-terminal incident); surfaced 2026-06-18 while diagnosing a phantom active run in the cockpit.

---

## Out of scope

- Roles beyond PM, tech lead, QA, coder, reviewer, and designer.
- A quality/engagement eval.
- Replacing Project 15's finalizer.
- Requiring live model calls, real Telegram interaction, real vault feedback, or production
  merge for automated acceptance of Phases 1-7. (Phase 8 is the deliberate exception: its
  acceptance requires one live, non-fixture run that drives a real task to a real diff — the
  stub-free proof the original closeout lacked.)
- Fully autonomous scheduler dispatch.
- Removing legacy `/work --auto` before the orchestrated path is proven.
