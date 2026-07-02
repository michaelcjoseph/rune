# Fix Run Dispatch Test Plan

Error handling checklist for the cockpit Fix button dispatching a real, verified
orchestrated-work fix run and reconciling it to a readable terminal.

This project is **test-first**: each numbered section below is written by a phase's
**Tests (write first)** task in [tasks.md](tasks.md), and those tests must fail (red)
before that phase's implementation tasks begin. A phase's implementation is done when its
test-plan sections pass.

> See also: [Cross-cutting test plan](../../tech/test-plan.md) for shared guidelines, monitoring, and security checks.

## Priority Levels

- 🔴 **Critical**: Blocks user progress, requires immediate attention
- 🟡 **High**: Degrades experience significantly, should be handled gracefully
- 🟢 **Low**: Non-blocking, can fail silently with logging

## 1. Core state model

### fix-attempt-store terminals

- [ ] 🔴 `parseFixAttempt` accepts a record in each new terminal (`fixed`, `failed`,
  `parked-on-human`) and round-trips it; a terminal carrying `runId` stays valid.
- [ ] 🔴 The pre-dispatch `declined` path parses without requiring `runId`.
- [ ] 🟡 Torn-line tolerance is preserved: a partially written line does not crash the parser.
- [ ] 🟢 An unknown state string is rejected (or ignored) rather than silently coerced.

## 2. Single-product guard

### Accept / reject

- [ ] 🔴 Divergent deliverable repo (resolver returns a repo different from the product's
  mutate repo) => `{ accepted: false, reason: 'not-single-product', detail }`, no throw.
- [ ] 🔴 Unknown product => `reason: 'unknown-product'`, no throw.
- [ ] 🔴 Product with empty `repoPath` => `reason: 'not-repo-backed'`, no throw.
- [ ] 🟡 Happy path (deliverable repo equals product repo) => guard accepts.
- [ ] 🟡 The injectable resolver lets a test force the divergent branch that v1 never hits by
  construction.
- [ ] 🟢 Every accept/reject logs a reason-bearing line; reason strings are stable.

## 3. Fix-project scaffold + commit

### Files and format

- [ ] 🔴 Scaffold writes `docs/projects/<slug>/spec.md` + `tasks.md`; the spec states the bug,
  facts, and acceptance; `tasks.md` carries exactly one unchecked implementation task with
  tests.
- [ ] 🔴 The slug is stable and derived from the bug id (e.g. `NN-fix-<bugId>`).

### Safe git handling

- [ ] 🔴 Only the scaffold paths are committed to the product `baseBranch`; unrelated dirty
  operator work is preserved and never staged or committed.
- [ ] 🔴 A fresh orchestrated-work worktree resolves the project via `findProjectDir` from the
  committed scaffold.
- [ ] 🟡 Idempotent re-dispatch of the same bug returns the existing slug + SHA with no
  duplicate project and no empty-commit error.
- [ ] 🟡 A branch / dirty-tree / path conflict fails with a typed scaffold/commit reason and
  leaves no half-written project.
- [ ] 🟢 The slug + SHA is logged.

## 4. startFixRun dispatch

### Happy path and failures

- [ ] 🔴 Guard passes → scaffold/commit → `createMutation('orchestrated-work', ...)` returns
  `{ accepted: true, runId: descriptor.id }` immediately.
- [ ] 🔴 `createMutation` `!ok` => `{ accepted: false, reason: 'dispatch-rejected', detail }`.
- [ ] 🔴 Guard reject, scaffold failure, and commit failure each return `accepted: false` with
  a stable reason and do not throw.
- [ ] 🟡 An unexpected programmer/runtime error still throws (not swallowed as a decline).
- [ ] 🟢 Run start logs `runId` + dispatch kind; each failure branch logs its cause.

## 5. Fix decline / terminal mapping (call site)

### runFixGateAttempt

- [ ] 🔴 `reason: 'not-single-product'` records a `declined` fix-attempt terminal carrying
  reason + detail.
- [ ] 🔴 `unknown-product`, `not-repo-backed`, `dispatch-rejected`, scaffold/commit failures,
  and throws record `handoff-failed`.
- [ ] 🟡 `accepted: false` does not clobber an already-recorded terminal.
- [ ] 🟢 The recorded reason/detail is readable at the call site for later rendering.

## 6. Terminal reconciliation

### Run outcome → fix terminal

- [ ] 🔴 `completed + merged:true` => `fixed`.
- [ ] 🔴 `failed` => `failed` with failure detail.
- [ ] 🔴 Completed-but-unmerged and parked/blocked/held/noop/partial => `parked-on-human`.
- [ ] 🔴 Startup catch-up sweep reconciles a `proceeding` attempt whose run terminated while
  the process was down.
- [ ] 🟡 Reconciliation is idempotent: an existing terminal is never overwritten.
- [ ] 🟢 The reconciler logs `runId -> fix terminal + underlying run outcome`.

## 7. Cockpit fix terminal surface

### Rendering

- [ ] 🔴 `fixed`, `failed`, and `parked-on-human` render with readable labels and state
  classes.
- [ ] 🔴 The `runId -> /api/work-runs/<runId>` transcript link is retained for every dispatched
  run.
- [ ] 🟡 A guard `declined` renders its reason/detail so policy decline, gate decline, and
  handoff failure are distinguishable.
- [ ] 🟢 `product-deep-view-client.test.ts` covers terminal renders, run-link retention, and
  the declined-with-reason render.

## 8. Logs and observability

### Diagnosability

- [ ] 🔴 Every new failure path (guard reject, scaffold/commit failure, dispatch rejection,
  reconciler mapping) emits a reason-bearing log line queryable from the existing
  work-run/mutation diagnosis logs.
- [ ] 🔴 No raw unsanitized host path reaches a user-visible channel (chat reply, HTTP error
  body, transcript, mutations.jsonl).
- [ ] 🟡 Policy declines and handoff failures are recorded distinctly with detail.
- [ ] 🟢 Start and terminal log lines carry `runId` for correlation.

## 9. End-to-end acceptance (tests-as-deliverable)

### fix-run-e2e-acceptance

- [ ] 🔴 Against a temp git repo, real `startFixRun` runs the real guard, real
  scaffold-and-commit to `baseBranch`, and real `createMutation('orchestrated-work')`,
  asserting `{ accepted: true, runId }` and a resolvable run — no stub on `startFixRun` or the
  reconciler.
- [ ] 🔴 Fed recorded terminal outcomes, assert `proceeding -> fixed`, `-> failed`, and
  `-> parked-on-human`, with required start + terminal logs present.
- [ ] 🟡 A divergent deliverable repo returns `accepted: false` `not-single-product` and the
  call site records `declined`.
- [ ] 🟢 The only unexercised seam is model-driven agent execution inside orchestrated-work,
  which the live gate covers.

## 10. Manual / live release gate

### fix-run-live-gate

- [ ] 🔴 An operator clicks Fix on a real, gate-approved single-product bug; a run dispatches
  with `accepted: true` and `runId` visible; the run produces a change, the reviewer/code-review
  gate runs on the diff, the project-15 finalizer gates it, and it merges to `main`, or it
  reaches a clear declined/parked/failed terminal.
- [ ] 🔴 The fix-attempt terminal is visible in the cockpit, the transcript is readable, and
  start/terminal/failure logs are present.
- [ ] 🟡 One guard-reject spot-check surfaces as `declined` with a readable reason, not
  `handoff-failed`.
- [ ] 🔴 No protected listener at `127.0.0.1:3847` or `:3848` is killed or reused.
  - Expected operator evidence: record the live/browser/integration check result before
    release.
