# PM-led scoping interview + fix-it self-review — Tasks

Not started. See [spec.md](spec.md) for architecture and [test-plan.md](test-plan.md) for verification.

> **Test-first by default.** Every phase below opens with a **Tests (write first)** block.
> Those tests mirror the matching [test-plan.md](test-plan.md) sections and must fail (red)
> before any implementation task in the phase begins. A phase's implementation is done when
> its test-plan sections pass.

## Phase 1 — PM-led interview

> Depends on: nothing.

### Tests (write first)

- [x] Write the test suite for **merge-interview-into-pm** — test-plan.md §1.
- [x] Write the test suite for **retire-specified-enough-gate** — test-plan.md §1.
- [x] Write the test suite for **persist-spec-approval-state** — test-plan.md §1.
- [x] Write the test suite for **reposition-approval-split-pipeline** — test-plan.md §1.
- [x] Write the test suite for **legacy-session-hard-fail** — test-plan.md §1.
- [x] Confirm every suite above fails (red) before starting implementation.

### Implementation

- [x] **merge-interview-into-pm** — Wire `defaultScopingTurn` (`src/reviews/planning-handler.ts`) to compose the PM role context via `composeRoleContext('pm', INTERVIEW_INSTRUCTION)` instead of `SCOPING_SYSTEM_PROMPT`, run the interview on the persistent planning-session id (the one intentional fresh-context exception), apply one-question-at-a-time discipline, honor the two stop conditions (PM satisfied OR the user signals to proceed — intent-detected via the existing resolver, e.g. "go"/"proceed"/"ship it", not a literal `=== 'go'` match), and emit the finished spec directly (`ScopingResult kind:'spec'` with a versioned `{kind:'pm-spec', product, title, spec, assumptions, selfReview}` artifact) via a `pm-spec` fence instead of a planning-brief fence. Narrow the `/plan` `ScopingResult` to `question | spec` — remove the existing `kind:'ready'` planning-brief handoff variant on the `/plan` path. `INTERVIEW_INSTRUCTION` authoring is part of this task.
- [x] **retire-specified-enough-gate** — Remove the block-for-interview / specified-enough gate from the `/plan` path. `/plan` no longer calls `pmAssessAndSpec` and the `blocked-for-interview` outcome is unreachable from `/plan`. The repo audit found no other production caller of `runPlannerRoles`; preserve only private helpers/test fixtures that remain useful. Add a regression test proving `/plan` cannot bounce the user into a second interview through this gate.
- [x] **persist-spec-approval-state** — Update planning session/proposal persistence so the pending approval stores a versioned PM-only approval artifact plus durable product/session metadata for `/approve` to resume the downstream pipeline after process restart. Split the PM-only approval artifact from the full scaffold artifact required by `buildSetupWriterBrief`/`runScaffoldApproval`. Once downstream planning produces the full artifact, persist it on the session before scaffold so `/approve` retry after scaffold failure reuses it instead of re-running downstream. **Reconcile with the existing retry branch in `approve.ts`** (the current "approved-but-unscaffolded" path): extend that single branch to read how far the durable record got (`approvedSpec` only → re-run downstream then scaffold; `downstreamArtifact` present → skip downstream, re-run scaffold) rather than adding a parallel retry path.
- [x] **legacy-session-hard-fail** — Add explicit detection for pre-project-20 planning sessions. Today's approval artifact has no version field, so legacy detection is the **absence of the new discriminant**: a stored artifact lacking `{version:2, kind:'pm-spec'}` is the old shape (gate on the discriminant being absent, not on `version < 2`). `/approve` must return a clear restart-planning message and leave/delete state deliberately; it must never silently scaffold or reinterpret the old shape as a PM-approved spec.
- [x] **reposition-approval-split-pipeline** — Reposition the single human approval gate to the revised PM spec and split `runPlannerRoles`. After interview+self-review produces the spec, present it inline and set status `spec-proposed`; both `/approve` (`src/bot/commands/approve.ts`) and the webview planning approval route (`src/server/webview.ts`) now trigger the downstream pipeline (tech-lead breakdown → `pmReviewMatch` → Claude critique → Codex critique → context seed → scaffold) as a post-approval automated stage. Extract the tail into `runDownstreamPlan(approvedSpec, {progress})` returning the full scaffold artifact. Keep exactly one human approval gate; `pmReviewMatch` remains automated fail-closed and critique remains automated degrade-to-last-good-plan with a warning.

## Phase 2 — Progress streaming

> Depends on: Phase 1.

### Tests (write first)

- [x] Write the test suite for **downstream-progress-streaming** — test-plan.md §2.
- [x] Write the test suite for **post-approval-inflight-op** — test-plan.md §2.
- [x] Confirm red before implementation.

### Implementation

- [x] **downstream-progress-streaming** — Add a `PlanningProgress` emitter to the post-approval downstream pipeline so each stage emits one informational line via the sender: `tech-lead-breakdown`, `pm-review-match`, `claude-critique`, `codex-critique`, `context-seed`, `scaffold`. Lines are strictly informational — zero approval/response points. Surface terminal/failure outcomes including `pmReviewMatch` spec-mismatch, context-seed failure, and scaffold failure. Surface critique degradation/Codex skip as a visible non-terminal warning and continue with the last coherent plan. Emit a final success line when scaffold completes with the user-relevant created product/project/task identifier. Assert the **planning-flow** human-gate count equals one (execution-time gates excluded) and that no stage transition, warning, terminal outcome, or final success happens in unexplained silence. Scrub paths in every user-visible progress/failure message.
- [x] **post-approval-inflight-op** — Register the post-approval pipeline as an `InFlightOp` (`src/transport/in-flight.ts`) for the planning user, around `runDownstreamPlan` + scaffold, so it is visible and cancellable through the existing `/cancel` surface (neither planning nor scaffold-approval registers one today). Cancellation is cooperative: it stops at the next stage boundary, surfaces a terminal line through the progress channel, and leaves the session resumable from the durable approval/downstream artifact. Mark the op success on the final scaffold-success line and error/cancelled on terminal outcomes.
- [x] **update-plan-docs** — Update operator-facing `/plan` documentation, command help, and any webview/cockpit copy describing planning approval. The docs must state the PM now conducts scoping directly, there is no Planner step or planning-brief intermediary, the single human approval gate is on the PM spec, and approving the spec automatically runs tech-lead breakdown → critique → context seed → scaffold with streamed progress. Make clear the user no longer separately approves the tech-spec and tasks. _(docs-or-config-only — reviewed no-code-test rationale.)_

## Phase 3 — Fix-it self-review

> Depends on: Phase 2.

### Tests (write first)

- [x] Write the test suite for **self-review-primitive** — test-plan.md §3.
- [x] Write the test suite for **pm-spec-self-review** — test-plan.md §3.
- [x] Write the test suite for **tech-lead-self-review** — test-plan.md §3.
- [x] Write the test suite for **coder-diff-self-review** — test-plan.md §3.
- [x] Confirm red before implementation.

### Implementation

- [x] **self-review-primitive** — Build the reusable fresh-context fix-it self-review primitive `runSelfReview<A>({role, artifact, render, parse, modelCall})`. It composes the role charter via `composeRoleContext(role, SELF_REVIEW_INSTRUCTION)`, invokes the role cold through the existing throwaway-session seam (`randomUUID` + `cleanupSession`), prompts the role to find AND fix issues, and returns `{artifact: revised-or-confirmed, revised: boolean}`. **One fix pass**, with at most one strict-format **re-prompt** used only to recover a parse/flag-only failure — this is a format retry, not a fix-convergence loop (no convergence target, no blocking state). The cold review sees only the rendered artifact (no interview/authoring context) and is scoped by `SELF_REVIEW_INSTRUCTION` to improving the artifact on its own terms — fixing internal inconsistency/gaps/errors — and must NOT invent new product direction the artifact does not already contain. A clean-artifact response returns the input unchanged with `revised=false`, where `revised` is a **whitespace-normalized content delta** (trim, collapse internal whitespace, normalize line endings), not a model claim. A response still unparseable after the single re-prompt is a self-review failure surfaced to the caller. `SELF_REVIEW_INSTRUCTION` authoring is part of this task.
- [x] **pm-spec-self-review** — Run `runSelfReview('pm', spec)` cold on the spec the PM wrote during the stateful interview, after the interview emits `kind:'spec'` and BEFORE the spec is presented inline for approval. The revised or explicitly-confirmed spec is what the user sees and approves. Stacks ahead of — does not replace — downstream checks. One pass, no new gate; if self-review fails malformed/flag-only, surface the planning failure instead of presenting an unreviewed spec as reviewed.
- [x] **tech-lead-self-review** — Run `runSelfReview('tech-lead', {techSpec, tasks})` cold inside `runDownstreamPlan` after the tech-lead breakdown and BEFORE `pmReviewMatch` and the cross-model critique. Emit the revised or explicitly-confirmed tech-spec+tasks. One pass, no new gate; include this work under the `tech-lead-breakdown` progress stage and surface malformed/flag-only self-review failure as a terminal post-approval outcome.
- [x] **coder-diff-self-review** — In `src/intent/team-task-workflow.ts`, preserve the existing QA-before-coder test-intent flow, then run `runSelfReview('coder', diff)` cold **once** after the coder produces its first diff and BEFORE the existing reviewer / tech-lead diff review / designer rounds loop consumes that diff (not once per round). The coder must emit a revised or explicitly-confirmed diff; it may reuse the Phase-14 `ObjectionFinding` shape internally, but the deliverable is the corrected diff, not findings. **If the self-review changes diff behavior, re-evaluate QA test intent against the revised diff before downstream review** (allow-divergence, re-validate — a conforming revised diff proceeds unchanged; this re-validation is automated, no new human gate). One pass, symmetric with PM and tech-lead; no new blocking loop. A response still unparseable after the single re-prompt must fail the task run before downstream diff review sees the diff.

## Phase 4 — Acceptance

> Depends on: Phase 3.

### Implementation

- [x] **e2e-acceptance-four-behaviors** — Author an end-to-end acceptance test that drives one real planning-through-execution run — a `/plan` session AND the execution of at least one resulting scaffolded task — and asserts all four Definition-of-Done behaviors: (1) interview runs entirely with the PM, ends on the user's proceed-intent, never bounced by the retired gate; (2) user approves an inline spec at exactly one planning gate and `/approve` can resume from persisted spec approval state; (3) each post-approval stage emits progress, critique warnings/final scaffold success are visible, and terminal failures are surfaced with the planning-flow human-gate count still one; (4) the PM spec and tech-lead tech-spec+tasks each show a measurably-revised artifact from real self-review during the `/plan` run, and the coder diff shows a measurably-revised artifact when the scaffolded task is executed. **Harness boundary:** only the LLM transport (`RoleModelCall`/`askClaudeWithContext`) is faked; `runSelfReview`, the progress emitter, the approval/persistence state machine, `runDownstreamPlan`, and the team-task ordering run real; git/worktree/scaffold use the existing test seams (temp dir / fake git), not a real repo mutation. A green pipeline with self-review stubbed, skipped, flag-only, malformed, or injecting no revision in the deliberate-flaw fixture must fail this test. _(tests-as-deliverable.)_
- [ ] **live-reachability-gate** *(manual/live — not automatable)* — Run `/plan <product>` for real on Telegram, and once on the webview, with live models. Confirm: the PM conducts a one-question-at-a-time interview; the inline self-reviewed spec is presented and approvable at exactly one gate; the post-approval progress lines stream; the run is cancellable via `/cancel`; and a scaffold-success line with a real created identifier arrives. This is a judgment gate (interview/self-review/progress quality the faked-transport test cannot prove), tracked separately from the green suite.
