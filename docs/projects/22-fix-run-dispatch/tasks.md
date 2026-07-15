# Fix Run Dispatch — Tasks

Not started. See [spec.md](spec.md) for architecture and [test-plan.md](test-plan.md) for verification.

> **Test-first per task.** QA authors the tests that pin each task's contract (mirroring the
> matching [test-plan.md](test-plan.md) sections) before the coder implements it; every task
> lands green at closeout. Tests are not a separate up-front task list.
>
> Granularity here is the meaningful deliverable — not a granular sub-task. Per-task file
> layout, schemas, and signatures are settled in `/work`'s Plan phase, against the spec.

## Phase 1 — Core state model

> Depends on: nothing.

### Core state model

- [x] **fix-attempt-terminal-states** — Extend `FixAttemptState` in
  `src/jobs/fix-attempt-store.ts` with the post-dispatch terminals `fixed` \| `failed` \|
  `parked-on-human` (the pre-dispatch `declined` already exists and is reused for guard
  policy-declines): add them to the `FixAttemptState` union, the `STATES` set, and
  `parseFixAttempt` validation (new terminals carry optional `reason`/`detail`; keep `runId`
  required only where it already is). **This is not type-layer-only.** Extending the union
  breaks every exhaustive consumer, and strict typecheck will not pass until they handle the
  new members — so this task implicitly owns those consumer sites. The known consumer is the
  exhaustive `switch (attempt.state)` in `src/server/backlog-actions.ts` (no `default`, relies
  on exhaustiveness). Add an explicit `case` for each new terminal that maps to a **safe,
  non-throwing placeholder** using an existing benign `FixActionState` shape. Do **not** paper
  over the exhaustiveness error with a bare `default: throw` (an unrendered terminal must never
  crash the backlog surface), and do **not** introduce new `FixActionState` members or real
  labels here — those are Phase 3 (`cockpit-fix-terminal-surface`); keep the placeholder
  obviously provisional. No transition wiring yet. QA pins: all three new states round-trip
  through the parser, legacy `declined` still parses without `runId`, and the backlog-action
  mapper returns a value (never throws) for each new terminal.

## Phase 2 — Dispatch

> Depends on: Phase 1.

### Guard

- [x] **single-product-guard** — Add the fail-closed single-product guard used by
  `startFixRun`: a `resolveDeliverableRepo(bug, product, productsConfig)` seam that in v1
  returns the product's own `repoPath`, plus guard logic that resolves `getProductConfig`
  and rejects `unknown-product` / `not-repo-backed` / `not-single-product` with
  `{ accepted: false, reason, detail }`. Never throw for these expected cases. Keep reason
  strings stable (the webview mapping keys off them). Log accept/reject + reason. Make the
  resolver injectable so tests prove the divergent branch.

### Scaffold

- [x] **fix-project-scaffold-commit** — Deterministic minimal one-task fix-project
  scaffold-and-commit helper. Derive a stable slug (e.g. `NN-fix-<bugId>`) from `{ bug, facts }`
  and write `docs/projects/<slug>/spec.md` + `tasks.md` (spec states bug/facts/acceptance;
  tasks carries exactly one unchecked implementation task with tests). Commit only those paths
  to the product `baseBranch` so a fresh worktree resolves the project via `findProjectDir`.
  Safe git handling: verify/checkout `baseBranch` or use a task-local worktree, preserve
  unrelated dirty changes, never stage unrelated files, fail with a typed scaffold/commit
  reason on branch/dirty/path conflicts, leave no half-written project. Idempotent re-dispatch
  returns the existing slug + SHA. Log slug + SHA.

### Dispatch

- [ ] **start-fix-run-dispatch** — Implement `startFixRun` in `src/jobs/fix-run-handoff.ts`
  replacing the throwing stub: run the guard; scaffold-and-commit; dispatch
  `createMutation('orchestrated-work', { projectSlug, product }, 'webview')`; on
  `createMutation` `!ok` return `{ accepted: false, reason: 'dispatch-rejected', detail }`; on
  success return `{ accepted: true, runId: descriptor.id }` immediately. Expected
  guard/scaffold/commit/dispatch failures return `accepted: false` with stable reasons;
  reserve `throw` for unexpected failures. Log run start with `runId` + dispatch kind and each
  failure branch with cause.

### Call-site mapping

- [ ] **fix-decline-terminal-mapping** — At `webview.ts` `runFixGateAttempt`, refine
  `accepted: false` handling: `not-single-product` records a `declined` fix-attempt terminal
  carrying reason + detail, while `unknown-product`, `not-repo-backed`, `dispatch-rejected`,
  scaffold/commit failures, and throws record `handoff-failed`. Do not let `accepted: false`
  clobber an already-recorded terminal.

## Phase 3 — Terminal reconciliation

> Depends on: Phase 2.

### Reconciler

- [ ] **fix-attempt-terminal-reconciler** — Reconcile each `proceeding` fix-attempt to a
  post-dispatch terminal from the run's existing outcome, with no parallel status system. Read
  run terminal data by `runId` from the mutation descriptor / `supervision-store` and map
  `completed + merged:true` => `fixed`, completed-but-unmerged or parked/blocked/held/noop/
  partial => `parked-on-human`, failed => `failed` with failure detail. Wire event-driven
  (where terminal mutation events exist) plus a startup catch-up sweep over `proceeding`
  attempts. Idempotent: never overwrite an existing terminal. Log `runId -> fix terminal +
  underlying run outcome`.

### Cockpit surface

- [ ] **cockpit-fix-terminal-surface** — Map `fixed` \| `failed` \| `parked-on-human` through
  `backlog-actions.ts` `FixActionState`, add readable labels in
  `src/server/static/product-deep-view.js`, add state classes in `src/server/static/app.css`,
  and keep the existing `runId -> /api/work-runs/<runId>` transcript link. Ensure guard
  `declined` renders reason/detail so the operator can distinguish policy decline, gate
  decline, and handoff failure. _(designer review)_

### Observability

- [ ] **fix-run-logs-and-observability** — Make the start, terminal, and failure logs
  queryable from the existing work-run/mutation diagnosis logs: `startFixRun` logs
  guard/scaffold/dispatch decisions; the reconciler logs terminal mappings; the webview
  records policy declines vs handoff failures with detail. Prove every new failure path emits a
  reason-bearing line and no raw unsanitized host path is surfaced.

## Phase 4 — Acceptance

> Depends on: Phase 3.

### Acceptance

- [ ] **fix-run-e2e-acceptance** — Stub-free acceptance test in `src/server/__acceptance__`
  for the load-bearing path with no stub on `startFixRun` or the reconciler: against a temp git
  repo, real `startFixRun` runs the real guard, real scaffold-and-commit to `baseBranch`, and
  real `createMutation('orchestrated-work')` dispatch, asserting `{ accepted: true, runId }` and
  a resolvable run. Then feed recorded terminal outcomes and assert `proceeding -> fixed`,
  `-> failed`, and `-> parked-on-human`, with required start + terminal logs present. Assert a
  divergent deliverable repo returns `accepted: false` `not-single-product` and the call site
  records `declined`. The only unexercised seam is model-driven agent execution inside
  orchestrated-work, covered by the live gate. _(tests-as-deliverable)_

- [ ] **docs-sync-for-fix-run** — If implementation adds or substantially changes modules,
  commands, persistent log files, env/config surfaces, or documented lifecycle behavior, run
  the docs-sync agent and update `docs/architecture/module-reference.md` plus any affected
  architecture docs. Docs/config-only unless code structure changed enough to require
  import/type checks. _(docs-or-config-only)_

- [ ] **fix-run-live-gate** — Release gate: an operator clicks Fix on a real, gate-approved
  single-product bug in the cockpit; a run dispatches with `accepted: true` and `runId`
  visible; the run produces a change, the team-task reviewer/code-review gate actually runs on
  the diff, the project-15 finalizer gates it, and it merges to `main`, or it reaches a clear
  declined/parked/failed terminal. The fix-attempt terminal is visible in the cockpit,
  transcript readable, and start/terminal/failure logs present. Spot-check one guard-reject
  surfaces as `declined` with a readable reason, not `handoff-failed`. Reachable code paths and
  green tests do not satisfy this gate. Confirm no protected listener at `127.0.0.1:3847` or
  `:3848` is killed or reused. _(manual/live — not automatable)_
