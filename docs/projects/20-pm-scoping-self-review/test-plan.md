# PM-led scoping interview + fix-it self-review Test Plan

Error handling checklist for the PM-led `/plan` interview, the single repositioned approval gate, post-approval progress streaming, and the fresh-context fix-it self-review for PM, Tech Lead, and Coder.

This project is **test-first**: each numbered section below is written by a phase's
**Tests (write first)** task in [tasks.md](tasks.md), and those tests must fail (red)
before that phase's implementation tasks begin. A phase's implementation is done when its
test-plan sections pass.

> See also: [Cross-cutting test plan](../../tech/test-plan.md) for shared guidelines, monitoring, and security checks.

## Priority Levels

- 🔴 **Critical**: Blocks user progress, requires immediate attention
- 🟡 **High**: Degrades experience significantly, should be handled gracefully
- 🟢 **Low**: Non-blocking, can fail silently with logging

## 1. PM-led interview & repositioned approval

### Interview merge

- [ ] 🔴 A `/plan` run conducts the whole interview through the PM via `composeRoleContext('pm', INTERVIEW_INSTRUCTION)`, with no Planner step and no planning-brief fence emitted.
- [ ] 🔴 The PM holds conversation state across turns and asks one question at a time; multi-turn state on the planning-session id is the only fresh-context exception.
- [ ] 🔴 The interview stops on either condition — PM satisfied OR the user signals to proceed — and emits `ScopingResult kind:'spec'` with a versioned `{kind:'pm-spec', product, title, spec, assumptions, selfReview}` artifact via the `pm-spec` fence. The `/plan` `ScopingResult` is narrowed to `question | spec`; the old `kind:'ready'` planning-brief variant is gone on this path.
- [ ] 🟡 The user proceed-signal is intent-detected (e.g. "go", "let's go", "proceed", "ship it", "done"), not a literal `=== 'go'` match.
- [ ] 🟡 A malformed or absent `pm-spec` fence surfaces a clear planning failure rather than an empty/garbled spec.

### Retired specified-enough gate

- [ ] 🔴 Regression: a `/plan` run cannot be bounced into a second interview-needed state through the removed block-for-interview gate.
- [ ] 🔴 `/plan` no longer calls `pmAssessAndSpec`; the `blocked-for-interview` outcome is unreachable from `/plan`.
- [ ] 🟢 Repo-audit regression: no production entry point other than the retired `/plan` path calls `runPlannerRoles`/`pmAssessAndSpec`; any remaining references are private helpers or tests.

### Approval persistence & repositioning

- [ ] 🔴 The pending approval stores a versioned PM-only approval artifact plus durable state; `/approve` resumes the downstream pipeline after a process restart.
- [ ] 🔴 If downstream planning has produced a full scaffold artifact and scaffold then fails, retrying `/approve` reuses the persisted full artifact rather than re-running tech-lead breakdown/critique; the retry extends the existing `approve.ts` "approved-but-unscaffolded" branch (one retry decision keyed on how far the durable record got), not a parallel path.
- [ ] 🟡 Legacy detection gates on the **absence** of the `{version:2, kind:'pm-spec'}` discriminant (today's artifact has no version field), not on `version < 2`.
- [ ] 🔴 Both Telegram `/approve` and the webview planning approval route run the same post-approval downstream pipeline before scaffold.
- [ ] 🔴 Exactly one human approval gate exists in the `/plan` planning flow after repositioning (execution-time gates excluded from the count); `pmReviewMatch` remains automated fail-closed and critique remains automated degrade-to-last-good-plan with a warning, not a human gate.
- [ ] 🟡 An in-flight session on the old planning-brief/full-plan approval shape hard-fails with a clear restart-planning message — it never silently scaffolds an incomplete or stale plan.
- [ ] 🟢 Concurrent planning sessions for the same product keep separate approval state keyed per session.

## 2. Progress streaming & terminal surfacing

### Per-stage progress

- [ ] 🔴 After approval, each downstream stage emits exactly one informational line: `tech-lead-breakdown`, `pm-review-match`, `claude-critique`, `codex-critique`, `context-seed`, `scaffold`.
- [ ] 🔴 Progress lines add zero approval/response points; the planning-flow human-gate count after the change asserts to exactly one (execution-time gates excluded).
- [ ] 🔴 The post-approval pipeline registers an `InFlightOp` for the planning user and is cancellable via `/cancel`; cancellation stops at the next stage boundary, surfaces a terminal line, marks the op cancelled, and leaves the session resumable.
- [ ] 🟡 No stage transition happens in unexplained silence — every transition is observable on the informational channel.
- [ ] 🟡 User-visible progress, warning, terminal, and success messages scrub absolute paths before leaving the process.

### Terminal outcomes

- [ ] 🔴 A `pmReviewMatch` spec-mismatch, context-seed failure, or scaffold failure surfaces a terminal outcome to the user, never silent success.
- [ ] 🔴 Critique degradation or Codex skip surfaces a visible non-terminal warning and continues with the last coherent plan.
- [ ] 🔴 Successful scaffold surfaces a final success line with the created product/project/task identifier.
- [ ] 🟡 A Claude or Codex CLI failure during critique is surfaced as a warning with a path-scrubbed message when the existing critique contract can continue from the last coherent plan.
- [ ] 🟢 An unwritable vault/workspace file during context seed or scaffold surfaces a terminal failure with created-so-far state.

## 3. Fix-it self-review

### Primitive (`runSelfReview`)

- [ ] 🔴 `runSelfReview<A>` composes the role charter via `composeRoleContext(role, SELF_REVIEW_INSTRUCTION)` and invokes the role cold through the throwaway-session seam (`randomUUID` + `cleanupSession`).
- [ ] 🔴 It runs one fix pass and returns `{artifact: revised-or-confirmed, revised: boolean}` — no fix-convergence loop, no convergence target, no blocking state.
- [ ] 🔴 A malformed/unparseable or flag-only response triggers exactly one strict-format re-prompt of the same cold role; only a still-unparseable retry is a self-review failure surfaced to the caller. The re-prompt is a format retry, not a fix loop (assert at most two transport calls, and that a clean first response makes only one).
- [ ] 🟡 The cold review sees only the rendered artifact and does not introduce product direction absent from the input artifact (scope-preservation check).
- [ ] 🟢 A genuinely clean response returns the input unchanged with `revised=false`, where `revised` is a whitespace-normalized delta (a pure reformat does not flip it to `true`).

### PM spec self-review

- [ ] 🔴 `runSelfReview('pm', spec)` runs cold after the interview emits `kind:'spec'` and before the spec is presented inline for approval; the revised-or-confirmed spec is what the user approves.
- [ ] 🟡 A malformed/flag-only PM self-review surfaces a planning failure instead of presenting an unreviewed spec as reviewed.

### Tech Lead self-review

- [ ] 🔴 `runSelfReview('tech-lead', {techSpec, tasks})` runs cold inside `runDownstreamPlan` after the breakdown and before `pmReviewMatch` and cross-model critique, under the `tech-lead-breakdown` progress stage.
- [ ] 🟡 A malformed/flag-only tech-lead self-review surfaces as a terminal post-approval outcome.

### Coder diff self-review

- [ ] 🔴 In `team-task-workflow.ts`, `runSelfReview('coder', diff)` runs cold once after the existing QA-before-coder test-intent flow and after the coder's first diff, but before the reviewer / tech-lead diff / designer rounds loop consumes the diff (not once per round); the deliverable is the corrected diff.
- [ ] 🔴 If the coder self-review changes diff behavior, QA test intent is re-evaluated against the revised diff before downstream review consumes it; a conforming revised diff proceeds unchanged. The re-validation is automated (no new human gate).
- [ ] 🔴 A coder self-review still unparseable after the single re-prompt fails the task run before downstream review sees the diff.
- [ ] 🟢 The coder may reuse the Phase-14 `ObjectionFinding` shape internally without changing the corrected-diff deliverable.

## 4. End-to-end acceptance

- [ ] 🔴 One real planning-through-execution run (a `/plan` session plus execution of at least one scaffolded task) asserts all four Definition-of-Done behaviors with self-review unstubbed — only the LLM transport faked. Harness boundary: `runSelfReview`, progress emitter, approval/persistence state machine, `runDownstreamPlan`, and team-task ordering run real; git/worktree/scaffold use existing test seams.
- [ ] 🔴 In the deliberate-flaw fixture, the PM spec, tech-lead tech-spec+tasks, and coder diff each show a measurably-revised artifact from real self-review.
- [ ] 🔴 A green pipeline with self-review stubbed, skipped, flag-only, malformed, or injecting no revision must fail this test.
- [ ] 🟡 **(manual/live gate)** A real `/plan` run on Telegram (and once on webview) with live models shows a one-question-at-a-time interview, an approvable inline self-reviewed spec at one gate, streamed post-approval progress, `/cancel` working, and a scaffold-success identifier. Judgment gate, tracked separately from the automated suite.
