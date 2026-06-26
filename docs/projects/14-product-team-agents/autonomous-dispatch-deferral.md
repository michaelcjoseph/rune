# Autonomous Scheduler Dispatch — Deferral ADR

**Status:** Deferred. A human or an existing surface starts every run in v1; promote
to scheduler-driven dispatch when the trigger fires.
**Decided:** 2026-06-08, at Project 14 Phase 7 closeout.
**Owner:** Project 14, orchestrated-work track.

## Context

The spec's **Non-Goals** and **Deferrals** both name this cut:

> **Scheduler-driven dispatch.** A human or existing surface can start a run in v1;
> fully autonomous scheduling remains a later intent-layer concern.

What v1 ships for triggering is the *existing* surface, re-pointed — not a new one:

- **Plan trigger:** `/plan <product>` (Telegram + the cockpit Plan button) runs the
  role-enriched planner (Phase 2).
- **Work trigger:** the cockpit per-project Start action (`app.js` confirm-modal →
  `POST /api/mutations`) is routed through the dispatch seam
  (`src/jobs/work-dispatch.ts` `resolveWorkDispatch`) to the orchestrated applier
  (`orchestrated-work`) or the legacy fallback, decided by the
  `ORCHESTRATED_WORK_ENABLED` / per-product `orchestratedMode` toggle (Phase 5).

In every case a **human clicks Start** (or types `/plan`). Nothing in v1 selects a
project and dispatches a run on its own.

## Decision

**Defer autonomous scheduler dispatch.** Keep the human/existing-surface start
action as the only way a run begins. Do not build an intent-layer scheduler that
picks a project and fires `createMutation('orchestrated-work', …)` without a human
in the loop.

## Rationale

1. **Loop closure must be proven before autonomy.** v1's bar is mechanical loop
   closure on a deterministic fixture (spec §"What's shipping"), not quality and not
   unattended operation. Autonomously dispatching runs before the orchestrated loop
   has demonstrably closed on *real* tasks would compound an unproven loop with an
   unproven trigger.

2. **The production role-spawn binding is itself deferred.** The orchestrated
   applier is wired and user-triggerable, but the live `runTaskWorkflow` role-spawn
   binding is not yet implemented — today an orchestrated run blocks durably with a
   truthful reason rather than driving live role models
   (`src/jobs/orchestrated-work-runner.ts`). Auto-dispatching runs that can only
   block is pointless; autonomy waits on the binding *and* on observed real closure.

3. **The intent layer already has the dispatch primitive.** When the trigger fires,
   a scheduler reuses the existing `createMutation` pipeline and the
   `resolveWorkDispatch` seam — there is no missing mechanism, only the missing
   *decision policy* (which project, when) and the confidence to let it run
   unattended. Building that policy now, against a loop that can't yet close, risks
   the wrong shape.

4. **A human start is a cheap, strong safety net.** The whole point of v1 is to move
   ownership of the *post-spec* work to Rune while keeping a person on the *start*
   gate. That gate costs one click and removes an entire class of runaway-automation
   risk during the prove-out window.

## Trigger to promote to scheduler-driven dispatch

Both of:

- **The intent layer can select and dispatch project runs without a human start
  action.** A concrete selection policy exists (e.g. the observation/intent loop
  promotes a ready project to a run) and has been reviewed.
- **Orchestrated loop closure is proven on real tasks.** The live role-spawn binding
  has landed and the orchestrated path has driven at least a few real projects to a
  clean Project-15 finalizer handoff (not just the deterministic fixture). See the
  `legacy-work-removal-deferral.md` trigger, which shares this real-closure
  prerequisite.

## Out of scope (here)

- The selection policy itself (which project, what priority, rate limits) — that is
  the intent-layer scheduler's design when promoted.
- Per-run budget/spend caps for unattended operation — a separate hardening concern
  that should land *with* autonomy, not before.

## Related

- Spec: `docs/projects/14-product-team-agents/spec.md` §"Triggering & Surfaces",
  §"Non-Goals", §"Deferrals".
- Seam: `src/jobs/work-dispatch.ts` (`resolveWorkDispatch`), `src/intent/orch-config.ts`
  (`resolveDispatchMode`).
- Sibling deferrals: `legacy-work-removal-deferral.md` (shares the real-closure
  trigger), `quality-eval-deferral.md`.
