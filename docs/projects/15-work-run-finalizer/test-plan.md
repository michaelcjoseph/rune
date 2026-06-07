# Work-Run Finalizer (Terminal Correctness & Gated Auto-Merge) Test Plan

Error handling checklist for the `/work --auto` terminal lifecycle: completion detection, the
supervision store, the classifier, recovery, the gated auto-merge finalizer, and the
agent-cooperation-independent backstops.

This project is **test-first**: each numbered section below is written by a phase's
**Tests (write first)** task in [tasks.md](tasks.md), and those tests must fail (red)
before that phase's implementation tasks begin. A phase's implementation is done when its
test-plan sections pass.

> See also: [Cross-cutting test plan](../../tech/test-plan.md) for shared guidelines, monitoring, and security checks.

## Priority Levels

- 🔴 **Critical**: Blocks user progress, requires immediate attention
- 🟡 **High**: Degrades experience significantly, should be handled gracefully
- 🟢 **Low**: Non-blocking, can fail silently with logging

## 1. Supervision-store correctness (P0.1)

### Metadata survival across heartbeats

- [ ] 🔴 Quiet nudge stamps `quietNudgedAt`; a keep-alive heartbeat rebuilds the `SupervisedRun`;
      the field survives and the one-shot quiet nudge does NOT re-fire.
- [ ] 🔴 `upsertRun` field-merges unknown/current fields rather than replacing the record by id —
      seed a record with extra fields, upsert a partial rebuild, assert nothing is dropped.
- [ ] 🟡 30s heartbeat loop over a long quiet run produces exactly one quiet nudge, not one per tick.

## 2. Classifier exit-fact taxonomy (P0.3)

### Exit-fact × work-product matrix

- [ ] 🔴 `reapedAfterTerminalResult` + clean, complete branch (all commits, `tasksRemaining == 0`) →
      `branch-complete`, NOT `failed`.
- [ ] 🔴 Genuine user-cancel + branch that looks complete → `failed`/`cancelled` (the reorder must
      not read a real cancel as success).
- [ ] 🟡 External-kill (operator SIGTERM, exit 143) of an incomplete branch → `failed` with truthful
      work-product fields, not the null-field classify-error path.
- [ ] 🟡 Clean-exit-with-wedged-stdio + complete branch → `branch-complete`.
- [ ] 🟢 `parked`/`blocked-on-human` is never emitted as a `WorkOutcome` value (it stays supervision
      state).

## 3. Terminal-result watchdog (P0.2)

### Drain window + conditional reap

- [ ] 🔴 `result` emitted, child exits within the drain window → teardown via the existing
      `exit`-keyed path, NO reap, classified on work product.
- [ ] 🔴 `result` emitted, child never exits → drain deadline → SIGTERM → SIGKILL group reap →
      terminal within the bounded window; exit fact is `reapedAfterTerminalResult`.
- [ ] 🔴 Child is NOT killed immediately on `result` (assert no signal before the drain deadline) —
      this guards against re-introducing the false `failed` the 2026-06-04 fix removed.
- [ ] 🟡 Backgrounded-task hang fixture (the incident shape: `result: success` then ≥1 never-exiting
      child) reaches a terminal state without a human, with an injected clock advancing past the
      drain window.

## 4. Recovery finalizes (P0.4)

### Startup recovery

- [ ] 🔴 A stale `running` run at startup is classified on work product and driven to a real terminal
      state through the finalizer, not left as `unknown`.
- [ ] 🔴 Recovery classification/finalize runs BEFORE the orphan-worktree sweep (`index.ts:64`) —
      assert the worktree still exists when the finalizer reads it.
- [ ] 🟡 A run orphaned across a simulated restart with a clean, complete branch finalizes to
      `branch-complete`/`merged` (per gate), not a permanent `unknown`/`running`.

## 5. Backstops independent of agent cooperation (P2.7)

### Quiet→cancel actuator

- [ ] 🔴 Sustained quiet past the first threshold notifies once; quiet past the longer threshold
      escalates to cancel/reap/finalize instead of nudging again (injected clock).

### Max-runtime ceiling

- [ ] 🔴 A run with a fresh keep-alive ticker (`lastChildAliveAt` kept current) is still group-killed
      and finalized once the max-runtime ceiling is exceeded — liveness cannot defeat the ceiling.

### Worktree-scoped sweep

- [ ] 🟡 A reparented/detached process whose cwd is under the run's worktree path is reaped by the
      fallback sweep.
- [ ] 🔴 A process whose cwd is OUTSIDE the run's worktree path is left untouched (the sweep is
      scoped to exactly one worktree path).

## 6. Gated auto-merge finalizer (P1.5)

### Happy path

- [ ] 🔴 Classify `branch-complete` → gate green → merge → push + verify → worktree remove → branch
      delete → terminal `merged`, with no operator action (temp repo).

### Gate (each condition stops at branch-complete, main unchanged)

- [ ] 🔴 Tests red → stop at `branch-complete` + alert, no merge.
- [ ] 🔴 Dirty working tree → stop, no merge.
- [ ] 🔴 `tasksRemaining > 0` → stop, no merge.
- [ ] 🔴 Merge conflict / unsound base relationship → stop, no merge, no half-applied `main`.
- [ ] 🔴 Concurrent run owns the branch/project → stop, no merge.
- [ ] 🔴 Gate checks run in an integration worktree (or on the branch); a red result leaves local
      `main` byte-for-byte unchanged (test before mutating main).

### Concurrency + durability

- [ ] 🔴 Two projects sharing one product `main` serialize through the per-product / per-base-branch
      lock; neither corrupts the other's merge.
- [ ] 🔴 Push happens before branch delete — origin has the work before the local branch is removed.
- [ ] 🔴 Kill at each durable phase (`merged-not-pushed`, `pushed-not-deleted`, …) → recovery resumes
      at the right step, merge applied exactly once, no orphan.
- [ ] 🟡 Push succeeds, branch-delete fails → recorded `pushed-not-deleted`; a later resume completes
      the delete without re-merging.

## 7. Failure / partial / cancelled path (P1.6)

- [ ] 🔴 A failure/partial/cancelled run always reaps the tree and flushes transcript/summary, never
      merges, and ends terminal OR explicit `blocked-on-human` — never quiet-pinging `running`.
- [ ] 🟡 Branch retention/deletion is recorded for the failure path.
- [ ] 🟢 A transient "wrapping-up" state, if used, does not widen the persisted status union (no new
      `MutationStatus`/supervision enum value unless shown unavoidable).

## 8. Cross-mode regression suite (P2.8)

### Full incident replay

- [ ] 🔴 `d0679453` replay: `result: success` → child never exits → drain → group reap →
      `reapedAfterTerminalResult` → classify `branch-complete` → gate green → merge → push → terminal
      `merged`; assert no quiet ping re-fires and no human acts.

### Per-mode matrix

- [ ] 🔴 result-before-exit reaches terminal; result-then-reap classifies `branch-complete`.
- [ ] 🔴 Quiet marker survives keep-alive; supervision-store divergence cannot clear the guard.
- [ ] 🟡 Resume / branch-reuse cleans ALL of a project's run records (cross-listed with the adjacent
      re-fork bug — coordinate, but that bug's fix is tracked separately).
- [ ] 🔴 Finalizer-resume-at-each-phase and merge-conflict / push-failure don't-delete-prematurely
      integration tests pass as a standing guard.
