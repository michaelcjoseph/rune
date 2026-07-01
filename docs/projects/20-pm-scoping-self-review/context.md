# Project Context: Merge scoping interview into the PM, add fresh-context fix-it self-review for artifact-producing roles

> Orchestration state for the `rune` project "Merge scoping interview into the PM, add fresh-context fix-it self-review for artifact-producing roles".
> Owned by Rune's context curator — roles read a bounded slice and emit handoff
> notes; they do not author this file directly.

## Current State

The goal is to make `/plan` less lossy and less silent: the PM should conduct the scoping interview directly, produce the spec from first-hand context, and run a cold fix-it self-review before the user approves it. After that single approval, the automated downstream planning/scaffolding pipeline should run with visible progress, while PM, Tech Lead, and Coder each self-review their own artifact before any downstream role sees it.

## Key Decisions

- The 'user' throughout is the single human running /plan; there is one human-in-the-loop, not a multi-operator surface.
- Progress lines are informational, non-interactive text emitted per downstream stage through the existing sender surfaces; progress, warnings, failures, and success messages must follow path-scrubbing conventions.
- A self-review pass that finds a genuinely clean artifact may emit it unchanged — 'measurably revised' is the requirement when issues exist; the deliverable is always the corrected-or-confirmed artifact, never a flag-only report. `revised` is a whitespace-normalized content delta, not a model claim.
- Self-review runs cold (artifact only, no interview/authoring context) and is scoped to improving the artifact on its own terms; it must not invent product direction the artifact does not already contain. On a malformed/unparseable or flag-only reply it gets exactly one strict-format re-prompt (a format retry, not a fix-convergence loop) before being treated as a self-review failure.
- Retiring the block-for-interview gate is scoped to the /plan path; repo audit found no other production caller of the gate. The /plan `ScopingResult` narrows to `question | spec`; the old `kind:'ready'` planning-brief variant is removed on this path.
- The user 'go' stop condition is intent-detected via the existing resolver (e.g. "go"/"proceed"/"ship it"), not a literal exact-string match.
- 'Same number of approval gates' is operationalized as exactly one human approval gate on the self-reviewed PM spec **in the /plan planning flow**; downstream task execution keeps its own legitimate execution-time gates, which are out of this count.
- Coder self-review targets the code diff and runs once after QA test intent but before the reviewer / tech-lead diff / designer rounds loop (not per round), symmetric with PM and Tech Lead. Allow-divergence, re-validate: if it changes diff behavior, QA test intent is re-evaluated against the revised diff before downstream review (automated, no new gate).
- The post-approval pipeline is now multi-minute and registers an `InFlightOp` so it is visible and cancellable via `/cancel`; cancellation is cooperative and leaves the session resumable.
- The PM's multi-turn state is held only from interview start through inline spec presentation; everything after (including the PM's own self-review) runs in fresh context.
- Old in-flight planning sessions using the retired full-plan artifact shape hard-fail with a restart-planning message; no one-time migration is attempted. Legacy detection gates on the absence of the `{version:2, kind:'pm-spec'}` discriminant (today's artifact has no version field).

## Interfaces & Contracts

> The full technical contract is in [tech-spec.md](tech-spec.md). This is the bounded slice roles need; do not duplicate the tech spec here.

- **PM-led scoping** — `defaultScopingTurn` (`src/reviews/planning-handler.ts`) composes `composeRoleContext('pm', INTERVIEW_INSTRUCTION)` on the persistent planning-session id (the one multi-turn exception) and emits `ScopingResult kind:'spec'` carrying `{ version:2, kind:'pm-spec', product, title, spec, assumptions?, selfReview? }` via a `pm-spec` fence. No `planning-brief`, no `blocked-for-interview` on `/plan`.
- **Approval split** — the single human gate moves to the PM spec (`status = spec-proposed`). The tech-lead→scaffold tail is extracted into `runDownstreamPlan(approvedSpec, { progress })` returning the full `SpecArtifact`; both `/approve` (`src/bot/commands/approve.ts`) and the webview route (`src/server/webview.ts`) drive it. Persist `approvedSpec` always and `downstreamArtifact` once assembled; retry extends the existing approve.ts "approved-but-unscaffolded" branch (one decision keyed on how far the record got).
- **Progress contract** — `PlanningProgress { stage, warning, terminal, success }` emits one sender line per stage (`tech-lead-breakdown`, `pm-review-match`, `claude-critique`, `codex-critique`, `context-seed`, `scaffold`), warnings on critique degrade/skip, terminal on early stop, and one final success line with the created identifier. Never awaited as responses; never a gate; always path-scrubbed.
- **Self-review primitive** — `runSelfReview<A>({ role, artifact, render, parse, modelCall })` in `src/intent/self-review.ts`: composes `composeRoleContext(role, SELF_REVIEW_INSTRUCTION)`, invokes the role cold through the throwaway-session seam (`randomUUID` + `cleanupSession`), one fix pass with at most one format re-prompt, returns `{ artifact, revised }`.
- **Insertion points** — PM spec (after interview, before inline presentation/approve); Tech Lead `{techSpec, tasks}` (inside `runDownstreamPlan`, after breakdown, before `pmReviewMatch`/critique, under the `tech-lead-breakdown` stage); Coder diff (`team-task-workflow.ts`, after QA test intent and first diff, before reviewer/tech-lead-diff/designer rounds).
- **Held constant** — `composeRoleContext`, role loading, role model-call seams, `pmReviewMatch`, `runPlanningCritique`, context-curator ownership, and scaffold output shape are reused/semantically unchanged except for relocation, progress wrapping, and the self-review insertions. Self-review never writes `context.md`.

## Known Risks

- Approval-state migration is intentionally not attempted. The implementation must detect old stored artifacts (absence of the `{version:2, kind:'pm-spec'}` discriminant) and hard-fail clearly, or `/approve` could scaffold stale/full-plan state under the new PM-spec approval semantics.
- Moving approval earlier means tech-spec/tasks are no longer human-approved before scaffold. Progress, warnings, terminal failures, the PM review/critique gates, and the cancellable in-flight op are the compensating controls.
- Cold self-review on the PM spec lacks interview context; the scope-preservation mandate (fix the artifact, don't invent new direction) is what prevents it from regressing interview-grounded decisions. Tests must include a scope-preservation check.
- Critique degradation is not terminal under the existing contract. The implementation must surface it as a warning without accidentally adding a second approval gate or silently calling it success.
- Coder self-review must be inserted after QA test intent and coder implementation, run once before the rounds loop, and must not let the revised diff silently diverge from QA test intent (re-validate on behavior change).
- Sender/progress failures and unsanitized paths could make a post-approval pipeline look silent or leak local paths; tests need to pin visible, scrubbed messages.

## Next Task Handoff

- cancellation, terminal, success, and path-scrub behavior for cockpit approval.

Verified:
- `npm test -- src/intent/planning-roles.test.ts src/bot/commands/approve.test.ts src/server/webview.test.ts src/intent/planner.test.ts` passes: 145 tests.
- `npm run build` passes.
- `git diff --check` passes.
