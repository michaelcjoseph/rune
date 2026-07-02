# Fix Run Dispatch — Tasks

Not started. See [spec.md](spec.md) for architecture and [test-plan.md](test-plan.md) for verification.

> **Test-first by default.** Every phase below opens with a **Tests (write first)** block.
> Those tests mirror the matching [test-plan.md](test-plan.md) sections and must fail (red)
> before any implementation task in the phase begins. A phase's implementation is done when
> its test-plan sections pass.
>
> Granularity here is the meaningful deliverable — not a granular sub-task. Per-task file
> layout, schemas, and signatures are settled in `/work`'s Plan phase, against the spec.

## Phase 1 — Core state model

> Depends on: nothing.

### Tests (write first)

- [ ] Write the test suite for **fix-attempt-terminal-states** — test-plan.md §1. Update
  `fix-attempt-store.test.ts` for parse/round-trip of the new `fixed` / `failed` /
  `parked-on-human` states (a terminal with `runId` stays valid; keep torn-line tolerance; do
  not require `runId` on the guard-decline path).
- [ ] Confirm the suite fails (red) before starting the implementation block.

### Core state model

- [ ] **fix-attempt-terminal-states** — Extend `FixAttemptState` in
  `src/jobs/fix-attempt-store.ts` with the post-dispatch terminals `fixed` \| `failed` \|
  `parked-on-human` (the pre-dispatch `declined` already exists and is reused for guard
  policy-declines): add them to the `FixAttemptState` union, the `STATES` set, and
  `parseFixAttempt` validation. No transition wiring yet.

## Phase 2 — Dispatch

> Depends on: Phase 1.

### Tests (write first)

- [ ] Write the test suite for **single-product-guard** — test-plan.md §2. Prove accept plus
  each reject (`unknown-product`, `not-repo-backed`, `not-single-product`), that expected cases
  never throw, and that the injectable resolver exercises the divergent repo branch.
- [ ] Write the test suite for **fix-project-scaffold-commit** — test-plan.md §3. Test in temp
  git repos for files, task format, clean base-branch commit, unrelated dirty-file
  preservation, and idempotent rerun (existing slug + SHA, no duplicate, no empty commit).
- [ ] Write the test suite for **start-fix-run-dispatch** — test-plan.md §4. Cover the happy
  path (`{ accepted: true, runId }`), `dispatch-rejected` on `createMutation` `!ok`, and each
  expected guard/scaffold/commit failure returning `accepted: false` with a stable reason.
- [ ] Write the test suite for **fix-decline-terminal-mapping** — test-plan.md §5.
  `not-single-product` => `declined`; `dispatch-rejected` and the plumbing reasons =>
  `handoff-failed`; an already-recorded terminal is not clobbered.
- [ ] Confirm every suite above fails (red) before starting the implementation blocks.

### Guard

- [ ] **single-product-guard** — Add the fail-closed single-product guard used by
  `startFixRun`: a `resolveDeliverableRepo(bug, product, productsConfig)` seam that in v1
  returns the product's own `repoPath`, plus guard logic that resolves `getProductConfig`
  and rejects `unknown-product` / `not-repo-backed` / `not-single-product` with
  `{ accepted: false, reason, detail }`. Never throw for these expected cases. Keep reason
  strings stable (the webview mapping keys off them). Log accept/reject + reason. Make the
  resolver injectable so tests prove the divergent branch.

### Scaffold

- [ ] **fix-project-scaffold-commit** — Deterministic minimal one-task fix-project
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

### Tests (write first)

- [ ] Write the test suite for **fix-attempt-terminal-reconciler** — test-plan.md §6. Feed
  recorded run records for merged, parked, blocked, noop/partial, and failed, and assert the
  mapping, the startup catch-up sweep, and idempotence (no overwrite of an existing terminal).
- [ ] Write the test suite for **cockpit-fix-terminal-surface** — test-plan.md §7. Update
  `product-deep-view-client.test.ts` for terminal renders, run-link retention, and
  declined-with-reason render.
- [ ] Write the test suite for **fix-run-logs-and-observability** — test-plan.md §8. Assert
  every new failure path emits a reason-bearing line and no raw unsanitized host path reaches a
  user-visible channel.
- [ ] Confirm every suite above fails (red) before starting the implementation blocks.

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

### Tests (write first)

- [ ] _No code-test-required tasks — the acceptance test below is itself the deliverable; the
  live gate is manual. See per-task strategy._

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
