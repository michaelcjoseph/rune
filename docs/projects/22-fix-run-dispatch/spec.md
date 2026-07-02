# Fix Run Dispatch Specification

## Overview

The cockpit already gates a bug through PM/Tech-Lead scoping. But once the gate approves,
`startFixRun` (`src/jobs/fix-run-handoff.ts`) throws `fix-run handoff unavailable`, so a
gate-approved Fix attempt records `handoff-failed` and the operator has to fix the bug by
hand. Fix is a scoping button today, not an execution button.

This project makes the Fix button turn an approved, single-product bug scope into a real
orchestrated-work run. The run either lands a reviewed, finalizer-gated merge on `main` or
reaches a readable terminal state in the cockpit. The operator can tell success, policy
decline, parked human intervention, and machinery failure apart without reading raw CLI
output.

### Core Value Proposition

One click on Fix dispatches a real orchestrated-work run that lands a verified, merged fix on
`main`, or reaches a clear terminal (`declined`, `fixed`, `parked-on-human`, `failed`, or
`handoff-failed`) the operator can read and distinguish in the cockpit.

### Goals

1. **Primary:** A gate-approved single-product Fix dispatches a real orchestrated-work run
   instead of throwing.
2. **Secondary:** The run is reviewed by the team-task reviewer gate and gated through the
   project-15 finalizer before merge, and the fix-attempt reaches a real terminal visible in
   the cockpit (`fixed`, `failed`, `parked-on-human`, `declined`, or `handoff-failed`).
3. **Tertiary:** Start, terminal, guard-decline, and failure paths log enough detail to
   diagnose from logs, and scaffold/commit work is safe for the operator repo (no unrelated
   staged files, no clobbered dirty work, no half-written project).

### Non-Goals

- Cross-repo / cross-product fix runs. v1 is single-product only: the bug's deliverable repo
  must equal the product repo.
- Changes to the bug scoping decision or `bug-fix-gate`.
- Gen-eval-loop seeding.
- Bug-to-bug sweeps or auto-fix-everything behavior.
- Building a new reviewer, runner, merge finalizer, or run status system. Existing
  orchestrated-work, team-task reviewer, finalizer, transcript, and run observability are
  reused.

---

## User Journey

### Happy Path

```
Operator clicks Fix → PM/Tech-Lead gate approves (proceed) → startFixRun
        ↓
single-product guard passes → scaffold + commit fix project → dispatch orchestrated-work
        ↓
run visible (runId + transcript link) → reviewer gate runs → project-15 finalizer gates merge
        ↓
merged to main → fix-attempt reconciles to `fixed` in the cockpit
```

1. **Fix on a gate-approved bug** — the operator clicks Fix on a single-product bug that has
   passed the PM/Tech-Lead scoping gate.
2. **Dispatch** — `startFixRun` runs the guard, scaffolds and commits a minimal one-task fix
   project, dispatches `createMutation('orchestrated-work', ...)`, and returns
   `{ accepted: true, runId }` immediately. The `runId` shows up in the cockpit runs
   container linked to the run transcript.
3. **Terminal** — the run produces a change, the reviewer gate runs on the diff, the
   project-15 finalizer gates the merge, and the change lands on `main`. The fix-attempt
   reconciles to `fixed`. If the run cannot merge cleanly it reaches `parked-on-human`,
   `failed`, or a pre-dispatch `declined` / `handoff-failed`.

### Entry Points

- The Fix action button on a bug in the cockpit per-product deep view (backlog), after the
  PM/Tech-Lead scoping gate returns `proceed`.

### Exit Points

- A merged fix on `main` with the fix-attempt showing `fixed` and a readable transcript link.
- A readable terminal (`declined`, `parked-on-human`, `failed`, `handoff-failed`) the
  operator can distinguish and act on.

---

## Requirements

### Dispatch & guard

1. WHEN the operator clicks `proceed` on a single-product bug THEN
   `startFixRun({ product, bugId, scope: { bug, facts } })` scaffolds a minimal one-task fix
   project, commits it to the product base branch, dispatches
   `createMutation('orchestrated-work', { projectSlug, product }, 'webview')`, and returns
   `{ accepted: true, runId }` immediately.
2. WHEN a run is dispatched THEN the returned `runId` is visible in the cockpit runs
   container and links to the run transcript.
3. WHEN the resolved deliverable repo differs from the product's mutate repo THEN the
   single-product guard rejects with `{ accepted: false, reason: 'not-single-product' }`. The
   resolver is injectable so the divergent branch is testable even though v1 normally resolves
   to the product repo by construction.
4. WHEN the product is unknown or not repo-backed (empty `repoPath`) THEN the guard rejects
   with `reason: 'unknown-product'` or `'not-repo-backed'` and never throws for these expected
   cases.
5. WHEN a guard, scaffold, commit, or dispatch failure occurs THEN `startFixRun` returns
   `{ accepted: false, reason, detail }` with a stable reason string; `throw` is reserved for
   unexpected programmer/runtime failures.

### Scaffold & commit

6. WHEN scaffolding a fix project THEN a stable slug is derived from the bug id
   (e.g. `NN-fix-<bugId>`) and `docs/projects/<slug>/spec.md` + `tasks.md` are written; the
   spec states the bug, facts, and acceptance, and `tasks.md` carries exactly one unchecked
   implementation task with tests.
7. WHEN committing the scaffold THEN only the scaffold paths are committed to the product
   base branch so a fresh orchestrated-work worktree can resolve the project via
   `findProjectDir`; unrelated operator work is preserved and never staged or committed.
8. WHEN the same bug is re-dispatched THEN scaffold/commit is idempotent by bug id: the
   existing slug + SHA is returned with no duplicate project and no empty-commit error.
9. WHEN a branch, dirty-tree, or path conflict blocks a safe commit THEN the helper fails
   with a typed scaffold/commit reason and leaves no half-written project.

### Verification & merge

10. WHEN a run completes THEN "verified before merge" means both conditions hold: the existing
    team-task reviewer gate ran on the diff, and the project-15 finalizer allowed the merge.
    The reviewer gate is fail-closed today; the live gate reconfirms it ran.

### Terminal reconciliation

11. WHEN a dispatched run reaches a terminal outcome THEN the fix-attempt reconciles through
    existing work-run/mutation observability: merged completion => `fixed`; failed run =>
    `failed`; parked/blocked/held/noop/partial/completed-unmerged => `parked-on-human`.
12. WHEN a policy decline occurs pre-dispatch (especially `not-single-product`) THEN the
    fix-attempt records `declined`. Precondition/plumbing failures (`unknown-product`,
    `not-repo-backed`, scaffold/commit failure, dispatch rejection, unexpected throw) surface
    as `handoff-failed`.
13. WHEN the process is down while a run terminates THEN a startup catch-up sweep reconciles
    each `proceeding` fix-attempt to its post-dispatch terminal; reconciliation is idempotent
    and never overwrites an existing terminal.

### Cockpit surface & logging

14. WHEN a fix-attempt reaches a terminal THEN the cockpit renders it with a readable label
    (`fixed`, `failed`, `parked-on-human`, `declined`, `handoff-failed`) and keeps the
    `runId -> /api/work-runs/<runId>` transcript link; a guard `declined` renders its
    reason/detail so the operator can distinguish policy decline, gate decline, and handoff
    failure.
15. WHEN any start, terminal, guard-decline, or failure path runs THEN it emits a
    reason-bearing log line queryable from the existing work-run/mutation diagnosis logs, and
    no raw unsanitized host path reaches a user-visible channel.

---

## Technical Implementation

### Module map

| Module | Change |
| ------ | ------ |
| `src/jobs/fix-attempt-store.ts` | Extend `FixAttemptState` with `fixed` \| `failed` \| `parked-on-human`; add them to the `STATES` set and `parseFixAttempt` validation (`declined` already exists, reused for guard declines). |
| `src/jobs/fix-run-handoff.ts` | Replace the throwing `startFixRun` stub with the real dispatch: run the guard, scaffold + commit, dispatch orchestrated-work, return `{ accepted, runId }`. Add the injectable `resolveDeliverableRepo` seam and the single-product guard. |
| `src/jobs/fix-project-scaffold.ts` (new or co-located) | Deterministic minimal one-task fix-project scaffold-and-commit helper, idempotent by bug id, safe git handling. |
| `src/jobs/fix-attempt-reconciler.ts` (new or co-located) | Reconcile each `proceeding` fix-attempt to a post-dispatch terminal from the run's existing outcome; event-driven where terminal mutation events exist, plus a startup catch-up sweep. |
| `src/server/webview.ts` (`runFixGateAttempt`) | Refine `accepted: false` handling: `not-single-product` => `declined`; other reasons + throws => `handoff-failed`; never clobber an already-recorded terminal. |
| `src/transport/backlog-actions.ts` | Map `fixed` \| `failed` \| `parked-on-human` through `FixActionState`. |
| `src/server/static/product-deep-view.js`, `product-deep-view-client.test.ts` | Readable terminal labels, transcript-link retention, declined-with-reason render. |
| `src/server/static/app.css` | State classes for the new terminals. |

### Types

```typescript
// fix-attempt-store.ts
type FixAttemptState =
  | 'proceeding'
  | 'declined'          // pre-dispatch policy decline (reused for guard declines)
  | 'fixed'             // run completed + merged
  | 'failed'            // run failed
  | 'parked-on-human'   // completed-unmerged / parked / blocked / held / noop / partial
  | 'handoff-failed';   // precondition / plumbing failure

// fix-run-handoff.ts
type StartFixRunResult =
  | { accepted: true; runId: string }
  | { accepted: false; reason: FixDeclineReason; detail?: string };

type FixDeclineReason =
  | 'unknown-product'
  | 'not-repo-backed'
  | 'not-single-product'
  | 'dispatch-rejected'
  | 'scaffold-failed'
  | 'commit-failed';

// injectable seam — v1 returns the product's own repoPath
type ResolveDeliverableRepo =
  (bug: BugScope, product: string, productsConfig: ProductsConfig) => string;
```

### Dispatch flow (`startFixRun`)

1. Run the single-product guard: resolve `getProductConfig(product)`; reject
   `unknown-product` / `not-repo-backed`; call `resolveDeliverableRepo` and reject
   `not-single-product` when it differs from the product's mutate repo. Never throw for these.
2. Scaffold + commit the fix project (idempotent by bug id, safe git handling).
3. Dispatch `createMutation('orchestrated-work', { projectSlug, product }, 'webview')`. On
   `createMutation` `!ok`, return `{ accepted: false, reason: 'dispatch-rejected', detail }`.
4. On success, return `{ accepted: true, runId: descriptor.id }` immediately. Fix always
   dispatches orchestrated-work directly.

### Terminal reconciliation

Read run terminal data by `runId` from the mutation descriptor / `supervision-store`. Map
`completed + merged:true` => `fixed`; `completed` but not merged or
`parked/blocked/held/noop/partial` => `parked-on-human`; `failed` => `failed` (with failure
detail). Wire both event-driven (where terminal mutation events exist) and a startup catch-up
sweep over `proceeding` attempts, so downtime is covered. Reconciliation is idempotent and
never overwrites an existing terminal. There is no parallel status system.

### Integration notes

- Reuses orchestrated-work, the team-task reviewer gate, the project-15 finalizer,
  `transcript.jsonl`, and existing run observability. It builds none of them.
- Path scrubbing: scrub absolute paths before any message reaches a user-visible channel; the
  un-scrubbed operator worktree path never reaches `mutations.jsonl` / summary / index /
  transcript / forensics.
- Reason strings are stable because the webview terminal mapping keys off them.

---

## UI/UX Design

### Cockpit fix-attempt terminal

- **Surface:** the Fix action state on a bug in the per-product deep view backlog.
- **States:** `proceeding`, `fixed`, `failed`, `parked-on-human`, `declined`,
  `handoff-failed`.
- **Layout:** each terminal renders a readable label and a state class; the
  `runId -> /api/work-runs/<runId>` transcript link is retained for every dispatched run. A
  `declined` state renders its reason/detail inline so the operator can tell policy decline,
  gate decline, and handoff failure apart.

---

## Implementation Phases

> The phase-by-phase task breakdown lives in [tasks.md](tasks.md) and the verification
> checklist in [test-plan.md](test-plan.md); both follow the phase structure below. The
> project is built **test-first** — every phase in tasks.md opens with a **Tests (write
> first)** block whose tests must fail (red) before that phase's implementation begins, and a
> phase is done when its test-plan sections pass.

### Phase 1: Core state model

- [ ] Extend `FixAttemptState` with `fixed` / `failed` / `parked-on-human` (union, `STATES`
  set, `parseFixAttempt`), keeping torn-line tolerance and not requiring `runId` on the
  guard-decline path. No transition wiring yet.

### Phase 2: Dispatch

> Depends on: Phase 1

- [ ] Add the fail-closed single-product guard with the injectable `resolveDeliverableRepo`
  seam and stable reject reasons.
- [ ] Build the deterministic, idempotent, safe scaffold-and-commit helper.
- [ ] Replace the throwing `startFixRun` stub with real guard → scaffold/commit → dispatch.
- [ ] Refine `runFixGateAttempt`: `not-single-product` => `declined`; other reasons + throws
  => `handoff-failed`; never clobber an already-recorded terminal.

### Phase 3: Terminal reconciliation

> Depends on: Phase 2

- [ ] Reconcile each `proceeding` fix-attempt to a post-dispatch terminal from the run's
  existing outcome, event-driven plus a startup catch-up sweep, idempotent.
- [ ] Surface the new terminals in the cockpit (labels, state classes, run-link retention,
  declined-with-reason render).
- [ ] Make start, terminal, and failure logs queryable and reason-bearing, with no raw host
  path in user-visible channels.

### Phase 4: Acceptance

> Depends on: Phase 3

- [ ] Stub-free acceptance test over the load-bearing path (real guard, real scaffold/commit,
  real dispatch, recorded terminal outcomes).
- [ ] Run docs-sync if structural changes warrant it.
- [ ] Live operator gate: click Fix on a real gate-approved single-product bug and confirm the
  full path end-to-end.

---

## Success Metrics

### Core KPIs

| Metric | Target | How Measured |
| ------ | ------ | ------------ |
| Gate-approved Fix dispatches a real run | 100% (no `fix-run handoff unavailable` throw) | `startFixRun` returns `{ accepted: true, runId }` on the happy path |
| Fix-attempt reaches a real terminal | Every dispatched attempt | Reconciled state is one of `fixed` / `failed` / `parked-on-human` (or pre-dispatch `declined` / `handoff-failed`) |
| Verified before merge | Every merge | Reviewer gate ran on the diff AND project-15 finalizer allowed the merge |
| Operator can diagnose from logs | Every failure/decline path | A reason-bearing log line is present for start, terminal, guard-decline, and failure |
| Live end-to-end proof | Once, pre-release | Operator gate: Fix → dispatch → review → finalizer → merge, terminal + transcript visible |

### Observability signals

- `startFixRun` logs guard/scaffold/dispatch decisions (with `runId` + dispatch kind on
  start).
- The reconciler logs `runId -> fix terminal + underlying run outcome`.
- The webview records policy declines vs handoff failures with detail.

---

## Edge Cases & Error Handling

### Guard / precondition

- Unknown product => `unknown-product` (no throw) => `handoff-failed` at the call site.
- Product not repo-backed (empty `repoPath`) => `not-repo-backed` => `handoff-failed`.
- Deliverable repo differs from product repo => `not-single-product` => `declined`.

### Scaffold / commit

- Re-dispatch of the same bug returns the existing slug + SHA; no duplicate project, no
  empty-commit error.
- Unrelated dirty operator work is preserved; only scaffold paths are staged and committed.
- Branch / dirty-tree / path conflict => typed scaffold/commit reason, no half-written
  project, `handoff-failed` at the call site.

### Dispatch / run

- `createMutation` `!ok` => `dispatch-rejected` => `handoff-failed`.
- Run failed => `failed` with failure detail.
- Run completed but unmerged, or parked/blocked/held/noop/partial => `parked-on-human`.
- Server restart mid-run => startup catch-up sweep reconciles the `proceeding` attempt without
  overwriting an existing terminal.

### Concurrency

- Double-dispatch is possible if the UI allows repeated Fix clicks while an attempt is
  `proceeding`. Mitigated by idempotent scaffold and non-overwriting reconciliation; a stricter
  in-flight guard can be added later.

### Safety

- Rune's own secrets never reach the sandboxed child; only the run's product credentials do.
- No raw unsanitized host path reaches a user-visible channel.

---

## Open Questions

- [ ] Are event-driven terminal mutation events available, or is the startup catch-up sweep
  the sole correctness path for reconciliation?
- [ ] Should a stricter in-flight guard against double Fix clicks land in v1 or as a follow-up?
- [ ] Where should the scaffolded fix project's slug counter (`NN`) come from so it stays
  stable and idempotent across re-dispatch?
