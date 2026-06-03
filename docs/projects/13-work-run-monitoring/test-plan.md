# Work-Run Monitoring (Phase 1) Test Plan

Error handling checklist for surfacing work-run worktree paths and the parked-worktree lifecycle.

This project is **test-first**: each numbered section below is written by a phase's
**Tests (write first)** task in [tasks.md](tasks.md), and those tests must fail (red) before that
phase's implementation tasks begin. A phase's implementation is done when its test-plan sections pass.

> See also: [Cross-cutting test plan](../../tech/test-plan.md) for shared guidelines, monitoring, and security checks.

## Priority Levels

- 🔴 **Critical**: Blocks user progress, requires immediate attention
- 🟡 **High**: Degrades experience significantly, should be handled gracefully
- 🟢 **Low**: Non-blocking, can fail silently with logging

## 1. Path surfacing (Phase 1a)

### Start notification

- [ ] 🔴 A run-start notification includes the deterministic worktree path
      (`<WORKTREE_ROOT>/<product>/<project>`) and the run id.
- [ ] 🔴 The surfaced operator path is **un-scrubbed** (usable as a `cd` target) — the
      `WORKTREE_ROOT`/`PROJECT_ROOT` prefix is NOT stripped on this field.

### Leak containment

- [ ] 🔴 The un-scrubbed path never appears in `mutations.jsonl`, the forensics bundle, or any
      committed/remote artifact — those paths stay scrubbed (`tool-labels.ts:32`).
- [ ] 🟡 A run with no worktree (create failed before a path existed) omits the path field cleanly
      rather than emitting an empty/partial path.

## 2. Parked state (Phase 1b)

### Sentinel parsing

- [ ] 🔴 A final `JARVIS_WORK_RUN_SENTINEL { … }` line in the result envelope is parsed (from the
      raw envelope, before display scrubbing) and triggers the parked path.
- [ ] 🟡 A malformed sentinel (bad JSON / missing fields) does NOT park — the run falls through to
      an ordinary terminal outcome, logged, no crash.
- [ ] 🟢 The sentinel line is not rendered as agent output to the operator (consumed, not echoed).

### Durable state + restart

- [ ] 🔴 A parked run records a durable supervision `blocked-on-human` state; the mutation itself
      reaches a normal terminal status (no invented `MutationStatus` value).
- [ ] 🔴 The parked state and its worktree survive a Jarvis restart (supervision recovery preserves
      `blocked-on-human`; the worktree is not reaped on startup).

### Lifecycle carve-outs

- [ ] 🔴 `work-runner` teardown does NOT `destroyWorktree` while parked.
- [ ] 🔴 GC does not reap a parked run's dir or branch, and `cleanupOrphanWorktrees` does not remove
      its live (registered) worktree.

### Cap

- [ ] 🔴 A second dispatch for a slug with a parked run is rejected by the per-project cap.
- [ ] 🔴 A dispatch for a slug whose worktree is registered on disk but whose parked state was lost
      to a crash (recovery left it `unknown`) is still rejected by the registered-worktree backstop —
      `createWorktree` is never reached on an occupied path.
- [ ] 🟡 The parked alert carries the worktree path + the pending check from the sentinel payload.

## 3. Release (Phase 1c)

### Clean release

- [ ] 🔴 Releasing a parked run with a clean worktree destroys the worktree, clears the supervision
      parked record, and frees the per-project slot (a subsequent dispatch for the slug is accepted).
- [ ] 🔴 The release action is reachable from both Telegram and the cockpit, routed through the
      mutation pipeline.

### Dirty release

- [ ] 🔴 Releasing a parked run with a **dirty** worktree warns with the dirty file list and does
      NOT destroy the worktree without an explicit confirm — a human fix is never force-removed
      silently (`destroyWorktree` is `--force`, `sandbox-runtime.ts:333`).
- [ ] 🟡 After an explicit confirm, the dirty worktree is destroyed and the slot frees.

### Misuse / races

- [ ] 🟡 Releasing an already-released (or never-parked) run is a clean no-op with a clear message,
      not an error that destroys an unrelated worktree.
- [ ] 🟢 A parked run left unreleased is surfaced in the cockpit; a staleness nudge (reusing project
      11's quiet-run machinery) fires rather than auto-releasing.

## 4. Regression

- [ ] 🔴 A run that never emits a sentinel behaves exactly as today: ordinary terminal outcome,
      worktree destroyed at teardown, branch retained per existing GC. No behavior change on the
      non-parked path.
