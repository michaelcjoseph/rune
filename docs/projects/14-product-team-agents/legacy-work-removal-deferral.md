# Legacy `/work --auto` Removal — Deferral ADR

**Status:** Deferred. The legacy long-process applier stays reachable as the
recorded fallback; remove it when the trigger fires.
**Decided:** 2026-06-08, at Project 14 Phase 7 closeout.
**Owner:** Project 14, orchestrated-work track.

## Context

The spec's **Deferrals** names this cut:

> **Legacy `/work --auto` removal.** Deferred — the legacy applier stays reachable as
> the recorded fallback. *Trigger to promote:* the orchestrated path has run N
> consecutive real projects to a clean finalizer handoff with no fallback, at which
> point legacy dispatch is removed.

And the spec's **Non-Goals** / **Fallback** sections make the keep-it explicit:

> Keep [the legacy `/work --auto` path] as a fallback while the orchestrated path is
> proven. … Fallback is explicit and recorded; it must not silently masquerade as
> orchestrated execution.

What v1 ships:

- Two appliers coexist — `orchestrated-work`
  (`src/jobs/orchestrated-work-runner.ts`) and the legacy `work-run`
  (`src/jobs/work-runner.ts`). They share the same per-project worktree path and the
  same per-project + global concurrency caps, so they never run a project twice.
- The dispatch seam (`src/jobs/work-dispatch.ts` `resolveWorkDispatch`) chooses
  between them from the `ORCHESTRATED_WORK_ENABLED` global default + per-product
  `orchestratedMode` override + an operator force-legacy. **Orchestrated mode is OFF
  by default** (`ORCHESTRATED_WORK_ENABLED=false`).
- Every legacy dispatch carries a non-empty `fallbackReason`, surfaced on the cockpit
  Start surface (`dispatchMode` + `fallbackReason` on the project card) so a fallback
  run is never mistaken for orchestrated execution.

## Decision

**Defer removing the legacy applier.** Keep `work-run` registered and reachable as
the recorded fallback. Do not delete the legacy dispatch path, its applier, or the
`LEGACY_WORK_KIND` branch of the dispatch seam in v1.

## Rationale

1. **The orchestrated path is not yet proven on real work.** The orchestrated loop
   closes mechanically on the deterministic fixture
   (`project-orchestrator.test.ts`), but the production `runTaskWorkflow` role-spawn
   binding is deferred — today an orchestrated run blocks durably with a truthful
   reason rather than driving live role models. Removing the only working executor
   before its replacement drives real projects would leave no usable path.

2. **A recorded fallback is the safe default during prove-out.** Orchestrated mode
   defaults OFF; the cockpit Start action dispatches the legacy applier unless a
   product opts in. This means the proven path is the default and the new path is
   opt-in — the correct risk posture while the new path is unproven.

3. **Removal is cheap once the trigger fires.** The seam already isolates the choice:
   deleting legacy means dropping the `LEGACY_WORK_KIND` branch and the `work-run`
   applier registration, with the dispatch seam collapsing to always-orchestrated.
   No caller restructuring is required — the surfaces already go through
   `resolveWorkDispatch`.

4. **Keeping it costs little.** The two appliers are concurrency-disjoint per project
   and the fallback is always visible/recorded, so the legacy path can't silently
   corrupt the orchestrated story. The carrying cost is one extra applier and a
   toggle branch — acceptable insurance.

## Trigger to promote (remove legacy dispatch)

All of:

- **The live role-spawn binding has landed** (the production `runTaskWorkflow` drives
  real role models), so orchestrated runs actually do work instead of blocking.
- **The orchestrated path has run N consecutive real projects to a clean Project-15
  finalizer handoff with no fallback** — `N` to be fixed when the binding lands
  (a small single-digit count, e.g. 3–5, is the spec's intent). "No fallback" means
  none of those runs dispatched `work-run`.
- At that point, delete the `work-run` applier registration and the
  `LEGACY_WORK_KIND` branch; collapse `resolveWorkDispatch` to orchestrated-only and
  drop the `forceLegacy` operator override.

## Out of scope (here)

- Choosing the exact `N` — deferred to when the role-spawn binding lands and real
  runs can be counted.
- A migration for in-flight legacy runs at removal time — there is no persistent
  legacy run that survives the deletion window; the concurrency caps make a clean
  cutover possible.

## Related

- Spec: `docs/projects/14-product-team-agents/spec.md` §"Fallback", §"Non-Goals",
  §"Deferrals".
- Seam: `src/jobs/work-dispatch.ts`, `src/intent/orch-config.ts`.
- Appliers: `src/jobs/orchestrated-work-runner.ts` (new), `src/jobs/work-runner.ts`
  (legacy).
- Sibling deferrals: `autonomous-dispatch-deferral.md` (shares the real-closure
  prerequisite), `quality-eval-deferral.md`.
