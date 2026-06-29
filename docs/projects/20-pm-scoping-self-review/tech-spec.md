# Tech Spec — PM-led scoping interview + fix-it self-review

## System under change

The `rune` project is a Telegram/webview product-team orchestrator. The `/plan` flow today runs scoping, planning roles, critique, context seed, proposal, approval, then scaffold. The code diff targeted by Coder self-review is produced later in `team-task-workflow.ts`.

This project changes sequencing, approval state, progress visibility, and self-review insertion points. It does not redesign role charters, downstream critique semantics, or scaffold output formats except where needed to preserve user reachability after approval moves earlier.

## Target `/plan` sequence

```text
/plan <product>
  -> PM interview on persistent planning session
  -> PM emits spec directly
  -> PM spec self-review, cold
  -> present revised spec inline; status = spec-proposed
  -> /approve  [the one human approval gate]
  -> post-approval automated pipeline:
       progress: tech-lead-breakdown
       tech-lead breakdown
       tech-lead self-review, cold
       progress: pm-review-match
       pmReviewMatch
       progress: claude-critique
       Claude critique
       progress: codex-critique
       Codex critique
       progress: context-seed
       context seed
       progress: scaffold
       scaffold
       final success line

later, team-task-workflow:
  -> QA writes/reviews test intent
  -> coder produces diff
  -> coder diff self-review, cold
  -> reviewer / tech-lead diff / designer checks consume the corrected diff
```

The approval gate moves from “after full plan” to “after PM spec.” This is intentional and requires durable spec approval state plus progress/failure/success surfacing for everything that now runs post-approval.

## PM-led scoping

`src/reviews/planning-handler.ts` changes `ScopingResult` for the `/plan` path:

```ts
type ScopingResult =
  | { kind: 'question'; text: string }
  | {
      kind: 'spec';
      text: string;
      artifact: {
        version: 2;
        kind: 'pm-spec';
        product: string;
        title: string;
        spec: string;
        assumptions?: string[];
        selfReview?: { revised: boolean };
      };
    };
```

`defaultScopingTurn` uses `composeRoleContext('pm', INTERVIEW_INSTRUCTION)` on the persistent planning-session id. `INTERVIEW_INSTRUCTION` carries one-question-at-a-time discipline, stop conditions, and the required `pm-spec` fence.

The new `/plan` `ScopingResult` is narrowed to `question | spec`: the existing `kind:'ready'` planning-brief handoff variant is **removed from the `/plan` path** (it was the Planner→PM brief seam this project retires). `blocked-for-interview` is a `PlanningRolesOutcome` variant (`src/intent/planning-roles.ts`), not a `ScopingResult`; the `/plan` path must no longer reach it.

**Stop conditions.** The two stop conditions are "PM is satisfied" and "user signals go." The user signal must be **intent-detected, not a literal `=== 'go'` match** — accept "go", "let's go", "proceed", "ship it", "done", etc. via the existing resolver/intent path rather than a brittle exact-string compare. The PM-satisfied condition is the model deciding, in-band, to emit the `pm-spec` fence instead of another question.

The `/plan` path must not consume a `planning-brief` or produce `blocked-for-interview`.

## Approval state and pipeline split

The pending approval record now stores the revised PM spec as the approved source artifact. It must include enough product/session metadata for `/approve` to run the downstream pipeline after delayed approval or process restart.

Use a discriminated artifact shape so the old full-plan `SpecArtifact` and the new PM-only approval artifact cannot be confused. The approved session can carry:

- `approvedSpec`: the versioned PM-only artifact the user approved;
- `downstreamArtifact`: optional full scaffold artifact produced after tech-lead breakdown, critique, context seed, and test-plan assembly.

If `/approve` reaches scaffold and scaffold fails, persist `downstreamArtifact` before calling scaffold so a retry does not need to re-run the whole downstream planning pipeline. If failure happens before a coherent downstream artifact exists, a retry may re-run downstream from `approvedSpec`. A post-approval self-review failure (tech-lead/coder) is treated the same way: the session stays resumable from `approvedSpec` (or `downstreamArtifact` if one was already persisted) so `/approve` retry re-runs the remaining downstream work without a full restart.

**Reconcile with the existing retry path.** `approve.ts` already has an "approved-but-unscaffolded" retry branch (it currently re-runs scaffold for a session that was approved but never scaffolded). The new `downstreamArtifact`-reuse logic must **extend that same branch**, not add a parallel one: a single retry decision reads how far the durable record got (`approvedSpec` only → re-run downstream then scaffold; `downstreamArtifact` present → skip downstream, re-run scaffold).

**Legacy detection.** Today's persisted approval artifact has **no version field**. Legacy detection is therefore the *absence* of the new discriminant — a stored approval artifact that lacks `{ version: 2, kind: 'pm-spec' }` is treated as the old shape and hard-fails with a clear "restart planning" message. (The new artifact is numbered `version: 2` to leave `1` for the implicit unversioned past shape; do not gate on `version < 2`, gate on the discriminant being absent.)

Existing in-progress sessions with the old shape hard-fail with a clear “restart planning” message. Silent partial scaffold is not acceptable.

**Cancellation / liveness.** Today `/approve` is a thin wrapper around scaffold; after this change it drives a multi-minute pipeline (tech-lead breakdown + two cross-model critiques + context seed + scaffold) that runs after the user may have stopped watching. The post-approval pipeline must register an `InFlightOp` (`src/transport/in-flight.ts`) so it is visible and cancellable via the existing `/cancel` surface, consistent with other long-running spawns. Cancellation is cooperative: it stops at the next stage boundary and surfaces a terminal outcome through the progress channel, leaving the session resumable per the persistence rules above.

Extract the tech-lead through scaffold tail into:

```ts
async function runDownstreamPlan(
  spec: PmSpecApprovalArtifact,
  options: { progress: PlanningProgress }
): Promise<SpecArtifact>
```

`/approve` invokes this function, stores the returned full scaffold artifact, then calls the existing scaffold approval runtime. `pmReviewMatch`, critique behavior, context seed ownership, and scaffold contracts remain unchanged except for relocation and progress wrapping.

Both approval surfaces must use the same engine:

- Telegram `/approve` in `src/bot/commands/approve.ts`;
- cockpit/webview planning approval in `src/server/webview.ts`.

## Progress contract

```ts
type PlanningStage =
  | 'tech-lead-breakdown'
  | 'pm-review-match'
  | 'claude-critique'
  | 'codex-critique'
  | 'context-seed'
  | 'scaffold';

type PlanningTerminal =
  | { kind: 'spec-mismatch'; detail: string }
  | { kind: 'context-seed-failed'; detail: string }
  | { kind: 'scaffold-failed'; detail: string };

type PlanningWarning =
  | { kind: 'critique-degraded'; detail: string }
  | { kind: 'codex-critique-skipped'; detail: string };

type PlanningProgress = {
  stage: (stage: PlanningStage) => void | Promise<void>;
  warning: (w: PlanningWarning) => void | Promise<void>;
  terminal: (t: PlanningTerminal) => void | Promise<void>;
  success: (detail: { productId?: string; projectId?: string; taskId?: string }) => void | Promise<void>;
};
```

Production progress posts one sender line per stage, one warning line on critique degradation/skip, one terminal line on early stop/failure, and one final success line after scaffold. These calls are never awaited as user responses and never create approval gates. Message bodies must pass through the existing sender/path-scrubbing conventions before they leave the process.

Tests must pin:

- each stage emits exactly once on the happy path;
- each terminal outcome is surfaced;
- critique degradation/skip is surfaced as a non-terminal warning;
- final scaffold success is surfaced;
- the human approval gate count **for the `/plan` planning flow** remains exactly one. This invariant is scoped to planning: downstream *task execution* (`team-task-workflow`, gated-merge finalizer, parked-run release) retains its own legitimate human gates and is out of scope for this count. The progress lines, QA re-validation, and self-review passes add zero planning-flow gates.

## Self-review primitive

Create `src/intent/self-review.ts`:

```ts
interface SelfReviewInput<A> {
  role: 'pm' | 'tech-lead' | 'coder';
  artifact: A;
  render: (a: A) => string;
  parse: (reply: string, prev: A) => A | null;
  modelCall: RoleModelCall;
}

interface SelfReviewResult<A> {
  artifact: A;
  revised: boolean;
}
```

`runSelfReview` composes `composeRoleContext(role, SELF_REVIEW_INSTRUCTION)` and invokes the role through the existing throwaway-session seam using a random session id and cleanup. It performs **one fix pass**: at most one re-prompt, used only to recover from a format/parse failure (see below), never to drive fix convergence.

**Cold-review mandate.** The self-review runs cold — it does not receive the interview transcript or any authoring context, only the rendered artifact. The instruction therefore scopes the role to **improving the artifact on its own terms**: fix internal inconsistency, gaps, unclear or incorrect statements, and missing detail that the artifact itself implies. It must **not invent new product direction** that the artifact does not already contain (it has no interview context to justify one), and must treat the artifact as the source of truth for scope. This prevents a cold PM self-review from silently regressing interview-grounded decisions.

**Format/parse failure and the single re-prompt.** The role must emit the corrected-or-confirmed artifact inside the expected fence so `parse()` can recover a structured artifact. Two failures are about output format, not review quality:
- *malformed/unparseable* — `parse()` returns `null` (no fence, broken/truncated fence);
- *flag-only* — the reply describes issues but emits no rewritten artifact.

On either, `runSelfReview` re-prompts the same cold role **exactly once** with a strict fence-format reminder. This format retry is distinct from a fix-convergence loop and preserves the "one fix pass" rule. If the retry still fails to parse, it is a self-review failure: the caller must surface/fail rather than mark the artifact reviewed. For post-approval roles (tech-lead, coder) the failure must leave the run resumable (see Approval state) rather than discarding approved state.

A clean confirmation may return the previous artifact with `revised=false`.

`revised` is computed from a **normalized content delta**, not from model claims. Normalization trims leading/trailing whitespace, collapses internal runs of whitespace, and normalizes line endings before comparison, so a pure reformat does not spuriously flip `revised` to `true`; any substantive text change yields `revised=true`.

## Self-review insertion points

| Role | Artifact | Runs after | Runs before | Lifecycle |
|---|---|---|---|---|
| PM | spec | PM interview emits `kind:'spec'` | inline presentation and `/approve` | `/plan` |
| Tech Lead | `{ techSpec, tasks }` | tech-lead breakdown | `pmReviewMatch` and critique | post-approval `/plan` |
| Coder | diff | coder produces diff after QA test intent | reviewer / tech-lead diff / designer checks | task execution |

Coder self-review lives in `team-task-workflow.ts`, not `/plan`. It runs **once**, after the coder's first diff and before the existing reviewer/tech-lead-diff/designer rounds loop begins — not once per round. The existing objection-driven revision loop is unchanged and continues to operate on the self-reviewed diff.

**Coder self-review vs. QA test intent (allow-divergence, re-validate).** QA test intent is written before the coder. If the coder self-review changes diff *behavior* (not just quality/formatting), the revised diff may no longer satisfy the agreed test intent. So after the coder self-review, if the diff behavior changed, QA test intent is **re-evaluated against the revised diff** before reviewer / tech-lead diff / designer consume it. A revised diff that conforms to the existing intent proceeds unchanged; a behavior divergence triggers one QA re-validation so the test intent and the diff cannot silently drift apart. This re-validation is automated and is not a new human gate.

## Contracts held constant

- `composeRoleContext`, role loading, and role model-call seams are reused.
- `pmReviewMatch`, `runPlanningCritique`, context curator ownership, and scaffold output shape remain semantically unchanged.
- Self-review produces revised artifacts only. It never writes `context.md` directly.
- Progress messages must pass through existing sender/path-scrubbing conventions.

## Acceptance

The required acceptance test drives one planning-through-execution run:

1. `/plan` interview is entirely PM-led and ends on user “go.”
2. The user approves the inline self-reviewed spec at exactly one gate.
3. Post-approval progress covers tech-lead breakdown, PM review, Claude critique, Codex critique, context seed, scaffold, critique degradation warnings, terminal failures, and final success.
4. PM, Tech Lead, and Coder self-review are real calls through the primitive. The fake LLM transport may be used, but self-review itself must not be stubbed. The fixture should return flawed first artifacts and corrected self-review artifacts so deltas are observable.

A test that stops after `/plan`, skips task execution, accepts flag-only self-review, or injects revision without exercising the primitive must fail.

**Harness boundary.** Only the **LLM transport** (the `RoleModelCall` / `askClaudeWithContext` seam) is faked — `runSelfReview`, the progress emitter, the approval/persistence state machine, `runDownstreamPlan`, and the team-task-workflow ordering all run real. The faked transport returns scripted flawed-then-corrected artifacts so self-review deltas are observable. Git/worktree and real filesystem scaffold writes may use the existing test seams (temp dir / fake git) rather than mutating a real repo; the acceptance asserts the *orchestration and self-review behavior*, not real Claude/Codex output quality.

**Manual/live reachability gate (not automatable).** Because the automated acceptance fakes the LLM transport, it cannot prove the interview is *good*, the self-review fixes are *substantive*, or the progress lines actually render on a real surface. One manual/live gate covers that: run `/plan <product>` for real on Telegram (and once on the webview) with live models, confirm the PM conducts a one-question-at-a-time interview, the inline spec is presented and approvable at one gate, the post-approval progress lines stream, and a scaffold-success line with a real identifier arrives. This is a judgment gate, tracked separately from the green test suite.
