# PM-led scoping interview + fix-it self-review Specification

## Overview

`/plan` today runs a stateless Planner that conducts the scoping interview, distills it into a cold planning brief, and hands that brief to a separate PM who must guess whether it is specified enough. The summarization loses context, and the block-for-interview gate can bounce the user back into a second interview. On top of that, every artifact-producing role hands its work straight downstream — no role re-reads its own output before someone else has to.

This project removes both weaknesses. The PM conducts the full scoping interview directly, multi-turn, and writes the spec from first-hand context. After a single inline approval, the automated downstream pipeline runs with visible per-stage progress. The PM (spec), Tech Lead (tech-spec + tasks), and Coder (code diff) each run one fresh-context fix-it self-review on their own artifact before any downstream role sees it.

### Core Value Proposition

`/plan` becomes less lossy and less silent: the PM interviews you directly and writes the spec from what it heard, each artifact gets one cold self-review that fixes issues before handoff, and the post-approval pipeline streams its progress instead of going dark.

### Goals

1. **Primary:** The PM conducts the full scoping interview directly, multi-turn, and writes the spec from first-hand context — no Planner step, no planning-brief intermediary, no block-for-interview bounce.
2. **Secondary:** PM (spec), Tech Lead (tech-spec + tasks), and Coder (code diff) each run exactly one fresh-context fix-it self-review that corrects issues before downstream roles see the work.
3. **Tertiary:** The post-approval pipeline streams per-stage progress and surfaces terminal failure or final scaffold success, so the moved approval boundary never produces dead air.

### Non-Goals

- **No change to the number of human approval gates.** Exactly one human approval gate remains **in the `/plan` planning flow**. This count is scoped to planning; downstream task execution (gated-merge finalizer, parked-run release) keeps its own legitimate execution-time gates, which this project does not touch or count.
- Self-review does not replace downstream checks — it stacks ahead of the existing reviewer pass and sequential cross-model critique.
- Self-review does not loop. One fix-pass per role, no convergence target, no new blocking state, no human gate introduced by self-review.
- Self-review is not extended to reviewing roles in this project.
- The fresh-context principle is not abandoned wholesale — only the PM's interview+spec step intentionally holds multi-turn state.
- Not redesigning the tech-lead breakdown, cross-model critique, or final scaffold semantics beyond approval repositioning, progress streaming, failure surfacing, persistence updates, and self-review insertions.

---

## User Journey

### Happy Path

```
/plan → PM interview (one question at a time) → user says "go"
              ↓
      PM writes spec → PM self-review (cold) → inline spec presented
              ↓
      user approves (single gate) → downstream pipeline (streamed progress)
              ↓
      tech-lead breakdown + self-review → pm review → Claude critique → Codex critique → context seed → scaffold
              ↓
      scaffold success line with created product/project/task id
              ↓
      task execution → QA test intent → coder diff → coder self-review (cold) → reviewer/tech-lead diff/designer
```

1. **`/plan [product]`** — the user starts a planning conversation; the PM asks scoping questions one at a time.
2. **Interview** — the user answers turn by turn and can end early by saying "go"; the PM also stops on its own when satisfied.
3. **Inline spec** — the PM writes the spec, runs a cold self-review on it, and presents the revised-or-confirmed spec inline for approval.
4. **`/approve`** — a single approval starts the automated downstream pipeline; the user no longer separately approves tech-spec and tasks.
5. **Progress** — each downstream stage emits one informational line; the run ends with a visible terminal failure or a scaffold-success line carrying the created identifier.
6. **Execution** — when a scaffolded task runs, QA test intent remains first; after the coder produces a diff, the coder self-reviews it cold before reviewer, tech-lead diff review, and designer checks consume it.

### Entry Points

- `/plan` (Telegram or webview) — the only entry point whose specified-enough gate is retired.

### Exit Points

- An approved, self-reviewed spec → a scaffolded product/project/task the user can execute.
- A surfaced terminal failure at any post-approval stage.

---

## Requirements

### Change 1 — Merge the interview into the PM

1. WHEN a `/plan` run starts THEN the entire scoping interview runs through the PM, with no separate Planner step and no distilled planning-brief intermediary.
2. WHEN the PM interviews THEN it holds conversation state across turns and applies one-question-at-a-time discipline.
3. WHEN the PM is satisfied it has enough context OR the user signals to proceed THEN it stops interviewing and produces the spec. The user "go" signal is intent-detected (e.g. "go", "let's go", "proceed", "ship it", "done") through the existing resolver, not a literal exact-string match.
4. WHEN the spec is complete and self-reviewed THEN the PM presents it inline in the same conversation for approval.
5. WHEN a `/plan` run is in progress THEN the block-for-interview / specified-enough gate cannot bounce the user back into a second interview-needed state.
6. WHEN a spec is awaiting approval THEN the pending approval state stores a versioned PM-only approval artifact containing `{ version: 2, kind: 'pm-spec', product, title, spec, assumptions, selfReview }`, not the old fully planned `SpecArtifact`.
7. WHEN `/approve` runs after a restart or delayed approval THEN it can resume from the durable PM-only approval artifact; if a downstream full-plan artifact was already assembled before a scaffold failure, retry reuses that durable full-plan artifact instead of re-running the whole downstream pipeline.
8. WHEN an old in-flight session uses the retired planning-brief/full-plan approval shape THEN `/approve` hard-fails with a clear "restart planning" message; this project does not attempt one-time migration.

### Change 1b — Progress streaming

9. WHEN the user approves the spec THEN the downstream pipeline emits a per-stage progress line for tech-lead breakdown, PM review, Claude critique, Codex critique, context seed, and scaffold.
10. WHEN a progress line is emitted THEN it is strictly informational and adds zero approval or response points.
11. WHEN any post-approval automated step terminates the run early THEN that terminal outcome is surfaced to the user through the same informational channel.
12. WHEN critique degrades or Codex is skipped under the existing critique contract THEN the degradation is surfaced as a non-terminal warning and the pipeline continues with the last coherent plan.
13. WHEN scaffold completes successfully THEN the success is surfaced with the created product/project/task identifier the user needs to continue.
13a. WHEN the post-approval pipeline is running THEN it is registered as an in-flight op so the user can see it is working and cancel it via the existing `/cancel` surface; cancellation stops at the next stage boundary, surfaces a terminal outcome, and leaves the session resumable.

### Change 2 — Fix-it self-review

14. WHEN an artifact is produced by the PM (spec), Tech Lead (tech-spec + tasks), or Coder (code diff) THEN that role runs a self-review; no other role does.
15. WHEN a self-review runs THEN it runs in a fresh context under the same role charter, with no memory of having authored the artifact.
16. WHEN a self-review runs THEN it is a fix pass: the role must emit the corrected-or-confirmed artifact in the expected fence. A flag-only or malformed (unparseable) response triggers exactly one strict-format re-prompt; if that also fails to parse it is a self-review failure, surfaced to the caller, never accepted as a successful self-review. The single re-prompt is a format retry, not a fix-convergence loop.
16a. WHEN a self-review runs THEN it runs cold on the rendered artifact alone (no interview/authoring context) and is scoped to improving the artifact on its own terms — fixing internal inconsistency, gaps, and errors — without inventing new product direction the artifact does not already contain. `revised` is computed from a whitespace-normalized content delta, not from model claims.
17. WHEN a self-review runs THEN it runs exactly once per role — no looping, no convergence target, no blocking human gate.
18. WHEN a self-review runs THEN it completes before any downstream role sees the artifact it is reviewing.
19. WHEN the PM writes the spec with interview state THEN its self-review runs cold on that spec before the spec is presented for approval.
20. WHEN self-review runs for PM and Tech Lead THEN it is a planning-time step; the Coder self-review is an execution-time step in `team-task-workflow`, after QA test intent and coder implementation, but before reviewer, tech-lead diff review, and designer review consume the diff. It runs once, before the existing objection-driven revision rounds, not once per round.
21. WHEN the Coder self-review changes diff behavior THEN QA test intent is re-evaluated against the revised diff before reviewer/tech-lead-diff/designer consume it, so the agreed test intent and the diff cannot silently diverge; a revised diff that still conforms to the existing intent proceeds unchanged. This re-validation is automated and adds no human gate.

---

## Technical Implementation

### Modules touched

- **`src/reviews/planning-handler.ts`** — `defaultScopingTurn` composes the PM role context via `composeRoleContext('pm', INTERVIEW_INSTRUCTION)` instead of `SCOPING_SYSTEM_PROMPT`, runs the interview on the persistent planning-session id (the one intentional fresh-context exception), and emits `ScopingResult { kind: 'spec', artifact: { version: 2, kind: 'pm-spec', product, title, spec, assumptions, selfReview } }` via a `pm-spec` fence instead of a planning-brief fence. The planning-brief `ready` handoff is retired on the `/plan` path. `INTERVIEW_INSTRUCTION` authoring is part of this work.
- **Specified-enough gate** — `pmAssessAndSpec` is no longer called from `/plan`; the `blocked-for-interview` outcome is unreachable from `/plan`. Repo audit found no production entry point other than `planning-handler.ts` calls `runPlannerRoles`, so the gate can be removed from the production `/plan` flow; keep only test fixtures or private helpers that remain useful.
- **Planning session / proposal persistence** — the pending approval stores a PM-only approval artifact as the approved source plus enough durable state for `/approve` to resume after a process restart. The stored record is versioned/discriminated from the old fully planned `SpecArtifact`. If a full downstream artifact is produced before scaffold failure, persist it for retry. Sessions on the old planning-brief/full-plan approval shape hard-fail clearly with a restart-planning message; they must not silently scaffold a stale plan.
- **`src/intent/planner.ts` / artifact types** — split the approval artifact from the scaffold artifact. `spec-proposed` may hold a PM-only artifact; `buildSetupWriterBrief` and `runScaffoldApproval` still require the assembled full artifact with tasks/test-plan/tech-spec/context after `runDownstreamPlan`.
- **`src/bot/commands/approve.ts` and `src/server/webview.ts` planning approve route** — both approval surfaces trigger the downstream pipeline (tech-lead breakdown → `pmReviewMatch` → Claude critique → Codex critique → context seed → scaffold) as a post-approval automated stage. The tail of `runPlannerRoles` is extracted into `runDownstreamPlan(approvedSpec, { progress })`. `pmReviewMatch` remains an automated fail-closed step; critique keeps its existing degrade-to-last-good-plan behavior and surfaces any degradation as a warning, not a human gate.
- **`PlanningProgress` emitter** — wired into `runDownstreamPlan` so each stage (`tech-lead-breakdown`, `pm-review-match`, `claude-critique`, `codex-critique`, `context-seed`, `scaffold`) emits one informational line via the sender; terminal/failure outcomes, critique degradation warnings, and the final scaffold-success line (with created identifier) flow through the same channel.
- **`runSelfReview<A>({ role, artifact, render, parse, modelCall })`** — the reusable fresh-context fix-it primitive. Composes the role charter via `composeRoleContext(role, SELF_REVIEW_INSTRUCTION)`, invokes the role cold through the existing throwaway-session seam (`randomUUID` + `cleanupSession`), prompts the role to find AND fix issues, and returns `{ artifact: revised-or-confirmed, revised: boolean }`. One fix pass, with at most one strict-format re-prompt to recover a parse/flag-only failure (not a convergence loop). The cold review is scoped to improving the artifact on its own terms and must not invent direction absent from the artifact. A clean response may return the input unchanged with `revised=false` (computed from a whitespace-normalized delta); a still-unparseable response after the re-prompt is a self-review failure surfaced to the caller. `SELF_REVIEW_INSTRUCTION` authoring is part of this work.
- **`src/intent/team-task-workflow.ts`** — `runSelfReview('coder', diff)` runs cold once after the coder produces its first diff and before the existing reviewer / tech-lead diff / designer rounds consume it (not once per round). QA's existing test-intent step remains before coder implementation; if the self-review changes diff behavior, QA test intent is re-evaluated against the revised diff before downstream review. The self-review may reuse the Phase-14 `ObjectionFinding` shape internally, but the deliverable is the corrected diff. A still-unparseable response after the single re-prompt fails the task run before downstream diff review sees the diff.
- **`src/transport/in-flight.ts`** — the post-approval pipeline (now multi-minute) registers an `InFlightOp` for the planning user so it is visible and cancellable via `/cancel`. Today neither planning nor scaffold-approval registers one; this adds the registration around `runDownstreamPlan` + scaffold. Cancellation is cooperative (stops at a stage boundary, surfaces a terminal line, leaves the session resumable).

### Integration notes

- The PM interview is the single intentional multi-turn state exception; every self-review remains cold via the throwaway-session seam.
- Self-review stacks ahead of the existing reviewer pass and cross-model critique — it adds no gate and no loop.
- The human-gate count must equal exactly one after every change; tests assert this invariant.
- Any sender-visible progress, terminal, warning, or success message must use existing path-scrubbing conventions before it leaves localhost/operator-only surfaces.

---

## Implementation Phases

> The phase-by-phase task breakdown lives in [tasks.md](tasks.md) and the verification
> checklist in [test-plan.md](test-plan.md); both follow the phase structure below. The
> project is built **test-first** — every phase in tasks.md opens with a **Tests (write
> first)** block whose tests must fail (red) before that phase's implementation begins.

### Phase 1: PM-led interview

- [ ] `merge-interview-into-pm` — PM-charter scoping replaces the standalone Planner; emit the spec directly via a `pm-spec` fence.
- [ ] `retire-specified-enough-gate` — remove the block-for-interview gate from `/plan`; regression-test that `/plan` cannot bounce into a second interview.
- [ ] `persist-spec-approval-state` — pending approval stores a versioned PM-only artifact + durable resume state; old shapes hard-fail clearly.
- [ ] `reposition-approval-split-pipeline` — move the single gate to the PM spec; extract the tail into `runDownstreamPlan(approvedSpec, { progress })`.

### Phase 2: Progress streaming

> Depends on: Phase 1

- [ ] `downstream-progress-streaming` — `PlanningProgress` emitter on every downstream stage; surface terminal failures and final scaffold success with the created identifier; assert planning-flow human-gate count equals one.
- [ ] `post-approval-inflight-op` — register the post-approval pipeline as an `InFlightOp` so it is visible and cancellable via `/cancel`; cancellation stops at a stage boundary, surfaces a terminal line, and leaves the session resumable.
- [ ] `update-plan-docs` — update operator-facing `/plan` docs, command help, and webview/cockpit copy.

### Phase 3: Fix-it self-review

> Depends on: Phase 2

- [ ] `self-review-primitive` — build `runSelfReview<A>` plus `SELF_REVIEW_INSTRUCTION`.
- [ ] `pm-spec-self-review` — cold self-review on the PM spec before it is presented for approval.
- [ ] `tech-lead-self-review` — cold self-review on tech-spec + tasks inside `runDownstreamPlan`, before `pmReviewMatch` and critique.
- [ ] `coder-diff-self-review` — cold self-review on the coder diff in `team-task-workflow`, run once after QA test intent and before reviewer/tech-lead diff/designer checks consume the diff; if it changes diff behavior, re-validate QA test intent against the revised diff before downstream review.

### Phase 4: Acceptance

> Depends on: Phase 3

- [ ] `e2e-acceptance-four-behaviors` — one real planning-through-execution run asserting all four Definition-of-Done behaviors, with self-review unstubbed (only the LLM transport faked). Harness boundary: `runSelfReview`, progress emitter, approval/persistence state machine, `runDownstreamPlan`, and team-task ordering all run real; git/worktree/scaffold use existing test seams.
- [ ] `live-reachability-gate` *(manual/live)* — one real `/plan` run on Telegram (and once on webview) with live models: confirm one-question-at-a-time interview, inline self-reviewed spec at one gate, streamed post-approval progress, and a scaffold-success identifier. Judgment gate (interview/self-review/progress quality), tracked separately from the automated suite since the faked-transport test cannot prove it.

---

## Success Metrics

### Core KPIs

| Metric | Target | How Measured |
| ------ | ------ | ------------ |
| Human approval gates per `/plan` run (planning flow) | Exactly 1 | Gate-count assertion in tests (execution-time gates excluded) |
| Interview handoffs (Planner→PM brief) | 0 | `/plan` path no longer emits a planning-brief fence |
| Self-review fix-passes per artifact-producing role | Exactly 1 | `runSelfReview` call count per role |
| Post-approval stages with a progress line | All 6 | `PlanningProgress` emission assertions |
| Silent stage transitions, warnings, terminal outcomes, or final success | 0 | Acceptance test fails on unexplained silence |

---

## Edge Cases & Error Handling

### Self-review failures

- A malformed/unparseable or flag-only self-review response triggers exactly one strict-format re-prompt of the same cold role. Only if that retry is also unparseable is it a failure — the caller surfaces it rather than presenting an unreviewed spec as reviewed. The re-prompt is a format retry, not a fix loop.
- A genuinely clean self-review may emit the artifact unchanged with `revised=false` (whitespace-normalized delta).
- A coder self-review still unparseable after the re-prompt fails the task run before downstream review sees the diff.
- A cold self-review must not introduce new product direction the artifact does not already contain; it has no interview context and treats the artifact as the source of truth for scope.

### Coder self-review vs. QA test intent

- If the coder self-review changes diff behavior, QA test intent is re-evaluated against the revised diff before reviewer/tech-lead-diff/designer consume it. A conforming revised diff proceeds; a divergence is reconciled by the automated QA re-validation, not a human gate.

### Cancellation

- The post-approval pipeline is a registered in-flight op; `/cancel` stops it at the next stage boundary, surfaces a terminal outcome, and leaves the session resumable from the durable approval/downstream artifact.

### Persistence and restart

- An in-flight planning session on the retired planning-brief/full-plan approval shape must hard-fail with a clear restart-planning message; it must never silently scaffold an incomplete or stale plan.
- `/approve` must resume the downstream pipeline from persisted spec-approval state after a process restart.

### Post-approval pipeline

- `pmReviewMatch` spec-mismatch, context-seed failure, and scaffold failure each surface a terminal outcome through the informational channel.
- Claude or Codex CLI degradation/skip during critique surfaces as a visible non-terminal warning and continues with the last coherent plan, matching the existing critique contract.
- Vault/workspace file unwritable during context seed or scaffold surfaces as a terminal failure with the created-so-far state.

### Concurrency

- Concurrent planning sessions for the same product must not cross approval state; the durable record is keyed per session.

---

## Resolved Questions

- Pre-existing in-flight sessions on the old approval shape hard-fail with a clear restart-planning message. No migration is attempted because the old persisted artifact cannot safely prove whether it represents an approved PM-only spec or an already assembled full plan.
- Repo audit found no production entry point other than `/plan` using the specified-enough gate (`runPlannerRoles` is called from `src/reviews/planning-handler.ts` only), so the gate is retired from the production planning flow.
