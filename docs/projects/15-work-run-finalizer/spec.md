# Work-Run Finalizer (Terminal Correctness & Gated Auto-Merge) Specification

## Overview

Make every `/work --auto` run reach a correct, durable terminal state on its own — even when the
agent emits `result: success` and then never exits — and give plain work-runs a single gated path
onto `main`.

On 2026-06-06, run `d0679453` (project `12-writer-memory`) emitted `result: success` at 04:38 and
then sat `running` until a human killed the process tree at 13:12 — ~8.5 hours. Five backgrounded
`vitest run` tasks had hung (open handles → vitest never exits), and `claude -p` will not exit while
background tasks are alive. The keep-alive ticker kept the run looking "quiet, not stalled," the
quiet nudge re-fired every 30s, and when the tree was finally killed the run mis-classified as
`failed` (exit 143) despite a branch with all 13 commits and tasks complete. The completed work only
reached `main` because a Rune assistant session, answering the operator, merged it by hand.

This is the same symptom class as the wedge bug fixed on 2026-06-04 (teardown keyed off process
`exit`), but a different trigger: that fix assumed the process eventually exits. When it never does,
nothing finalizes. One incident surfaced **six distinct defects** spanning completion detection,
the supervision store, the classifier, and recovery — plus the structural gap that a plain work-run
has no merge path at all.

This project closes all six and adds a shared, resumable **finalizer** that owns the terminal end of
a run: classify → (gated) merge → push → worktree teardown → branch delete → terminal writes. It
splits cleanly into P0 correctness work (no policy change — a run just reaches the *right* terminal
state) and a P1 policy change (gated auto-merge to `main`), with backstops that hold even when the
agent never cooperates.

### Core Value Proposition

A `/work --auto` run always self-terminates correctly and is classified on its work product, not its
exit signal; a clean, complete run lands on `main` through one auditable gate instead of waiting
hours for a human to notice and merge by hand.

### Goals

1. **Primary (P0, no policy change):** A run that emits a terminal `result` and then wedges, gets
   externally killed, or is recovered after a restart always reaches a *correct* terminal state —
   classified on work product, with the process tree reaped and the worktree handled — without a
   human in the loop.
2. **Secondary (P1, decided policy change):** A plain `/work --auto` run that passes a hard gate
   auto-merges to `main` through one shared, idempotent, resumable finalizer; one that fails the
   gate stops at `branch-complete` and alerts, never silently landing broken work.
3. **Tertiary (P2, resilience):** Backstops independent of agent cooperation — a quiet→cancel
   actuator, a hard max-runtime ceiling, and a worktree-scoped process sweep — guarantee no run can
   wedge `running` indefinitely, plus a regression suite that replays every observed failure mode.

### Non-Goals

- **Changing how `/work` executes a task** (the plan→test→implement→review cycle in
  `.claude/skills/work/SKILL.md`). Same boundary projects 11 and 13 held.
- **Auto-merge without a gate.** Autonomous runs spawn with `--dangerously-skip-permissions`
  (`work-runner.ts:361`); the gate is the line between "autonomous" and "lands broken work on main."
  Unconditional promotion is explicitly out of scope.
- **Gen-eval-loop merge changes.** The gen-eval-loop already merges via `realMergeBranch`
  (`gen-eval-loop-runner.ts:254-302`) behind its own review gates. This project reuses/refactors
  that code but does not change the gen-eval contract.
- **Fixing the silent re-fork-on-restart bug** (separate `bugs.md` entry). It shares the
  resume/branch-reuse surface and its run-record-cleanup test is cross-listed here, but its fix is
  tracked separately.
- **A new `MutationStatus` value.** Where a transient "wrapping-up" state is needed it is modeled
  without widening the persisted status union unless a new enum value is shown to be unavoidable.

### Agent-runnable acceptance

All required acceptance checks are automated. The implementation agent must use fixture-driven
work-run streams, temp product repos/worktrees, injected clocks, injected notification sinks, and
test-scoped supervision/mutation stores. No required verification depends on a real Telegram chat, a
production cockpit click, an actual Rune restart, or a human killing a live process tree. A live
smoke check is optional after the automated suites pass.

> **Self-reference sequencing guard.** This project's Phase 4 regression suite reproduces the exact
> background-`vitest` hang that triggered the incident. To keep the project agent-runnable, the
> implementation agent must land and verify Phase 1 and Phase 2 in order using bounded fixture tests
> before enabling/running the Phase 4 incident replay. Do not require a human to watch the run; use
> injected clocks, mocked children, and hard test timeouts so every phase can finish unattended.

---

## Background: verified current-state

Confirmed against the code by two independent investigations (Claude + Codex) plus an adversarial
Codex critique of the combined plan, 2026-06-06. The critique corrected an early "finalize on
`result`" proposal (unsafe — re-introduces the false `failed` the 2026-06-04 fix removed) into a
result-seen **watchdog**, and flagged that auto-promotion is a policy change, not a bug fix.

The single incident surfaced six distinct defects:

1. **Completion keys off process `exit`/`close`, not the terminal `result`.** The 2026-06-04 fix
   deliberately keyed teardown off the agent process `exit` because `result` arrives while the agent
   is still alive. That leaves a hole: if the agent emits `result: success` and then **never exits**,
   nothing finalizes. `streamProcess` sets `done` only on `child.on('exit'|'close'|'error')` or
   cancel (`work-runner.ts:838-871`); `reapTree()` (`:816-830`) is triggered only from `on('exit')`
   (`:838-844`), so it never ran.
2. **Backgrounded tasks keep `claude -p` alive.** The agent ran tests as background Bash tasks; five
   `vitest run` tasks hung (open handles) and `claude -p` will not exit while background tasks are
   alive. The agent finished at 04:38 (`result: success`, `terminal_reason: completed`) but the
   process stayed up until 13:12:30. The keep-alive ticker (`:673`) kept `lastChildAliveAt` fresh,
   so supervision saw "quiet," never "stalled."
3. **Recurring quiet ping — `quietNudgedAt` is dropped.** The stall runner stamps `quietNudgedAt`
   and persists it (`stall-check-runner.ts:70-85`), but the keep-alive heartbeat rebuilds the whole
   `SupervisedRun` without that field (`mutations.ts:32-63, 305-320`) and `upsertRun` **replaces by
   id, it does not merge fields** (`supervision-store.ts:138-145`). Every 30s heartbeat clears the
   one-shot guard and the quiet nudge re-fires (`supervision.ts:124-138`; 5-min threshold
   `stall-check.ts:21-26`).
4. **Classifier ranks exit-signal above work product.** `work-run-classify.ts:233-248` checks
   cancelled/signal/missing-code/nonzero **before** branch-complete. The human SIGTERM (exit 143) on
   a completed run therefore stamped `failed`; `summary.json` recorded `outcome: "failed"`,
   `reason: "exited with code 143"` with null work-product fields, even though the branch had all 13
   commits and tasks complete. A naive reorder is wrong — it would mis-mark a genuinely
   user-cancelled run as complete. The fix needs an exit-fact taxonomy.
5. **No merge/push/delete-branch finalizer for plain work-runs.** `work-runner.ts` classifies,
   writes summary/index, destroys the worktree (`finally`, `:556-578`), and fires GC (`:585`) — but
   never merges or pushes. Only `gen-eval-loop-runner.ts:254-302` (`realMergeBranch`) does merge →
   push → `branch -d`, behind review gates (`:618`). Docs confirm plain work-runs are intentionally
   "branch-complete, not yet on main" (`docs/projects/index.md:192-208`). The project-12 merge that
   landed was done by a Rune assistant session (commit `5b8dec8`, 13:12:48), NOT by the autonomous
   system. Left alone, the run stays failed-on-a-branch forever.
6. **Recovery/reconciliation relabel but don't finalize.** `recoverRun` only maps stale `running` →
   `unknown` (`supervision.ts:201-203`), persisted by `supervision-recovery.ts:36-55`;
   `reconcileOrphans` flips mutations to failed/orphaned (`mutations-log.ts:43-75`) but does no
   process/worktree/branch cleanup. A run orphaned across a server restart is never driven to a real
   terminal state. Startup also runs the orphan-worktree sweep after recovery (`index.ts:64`), so a
   future recovery-finalizer could race away its own evidence.

---

## User Journey

This is backend lifecycle behavior; the "user" is the autonomous system, with Michael as the
operator who receives truthful terminal signals instead of a stranded `running` run.

### Happy path (clean run auto-merges)

```
run starts → agent emits result: success → (child exits OR watchdog drains+reaps)
   → classify on work product = branch-complete → finalizer gate (all green)
   → merge → push+verify → worktree remove → branch delete → terminal: merged
   → notification: "landed on main"
```

### Wedge path (the incident, now self-healing)

```
agent emits result: success → process never exits (hung background vitest)
   → terminal-result watchdog opens a bounded drain window → child still alive at deadline
   → reap process group (SIGTERM → SIGKILL), emit reapedAfterTerminalResult exit fact
   → classify: clean branch + complete tasks + internal-reap → branch-complete
   → finalizer gate → merge/push/teardown → terminal: merged (no human, no 8.5h wedge)
```

### Fail-the-gate path

```
classify → gate check (tests red OR dirty tree OR tasksRemaining>0 OR conflict OR concurrent run)
   → STOP at branch-complete, alert operator, do NOT merge, do NOT delete branch
```

### Entry / exit points

- **Entry:** a `/work --auto` dispatch (cockpit, Telegram, scheduled), a terminal `result` event, a
  backstop trigger (quiet-cancel / max-runtime), or startup recovery of an orphaned run.
- **Exit:** terminal `merged`, `branch-complete` (gate failed or policy holds work on a branch),
  `failed`/`cancelled`/`blocked-on-human`, or `orphaned-then-finalized` after recovery — never a
  quiet-pinging `running`.

---

## Requirements

### Supervision-store correctness (P0.1)

1. WHEN a keep-alive heartbeat rebuilds a `SupervisedRun` THEN previously-persisted supervision
   metadata (at minimum `quietNudgedAt`) survives — `upsertRun` field-merges unknown/current fields
   rather than replacing the record by id, OR the field is threaded through `buildSupervisedRun`.
2. WHEN a run has been quiet-nudged once AND a keep-alive heartbeat fires THEN the quiet nudge does
   NOT re-fire (the one-shot guard holds across heartbeats).

### Terminal-result watchdog (P0.2)

3. WHEN the agent emits a terminal `result` event THEN the run transitions out of plain `running`
   into a bounded drain window; the runner does NOT kill the child immediately on `result` (that
   re-introduces the false `failed` the 2026-06-04 fix removed).
4. WHEN the child exits on its own within the drain window THEN teardown proceeds via the existing
   `exit`-keyed path with no reap.
5. WHEN the child has NOT exited by the end of the drain window THEN the runner reaps the process
   group (SIGTERM → SIGKILL → force-complete) and emits an explicit `reapedAfterTerminalResult` exit
   fact distinguishing this from an external kill.

### Classifier exit-fact taxonomy (P0.3)

6. WHEN a run terminates THEN the classifier distinguishes the exit facts: user-cancel,
   external-kill, clean-exit-with-wedged-stdio, and internal-reap-after-terminal-result.
7. WHEN the exit fact is `reapedAfterTerminalResult` AND the branch is clean and complete THEN the
   run classifies `branch-complete`, NOT `failed`.
8. WHEN the exit fact is a genuine user-cancel THEN the run classifies `failed`/`cancelled` even if
   the branch looks complete — the reorder must not mis-mark a real cancel as success.

### Recovery finalizes (P0.4)

9. WHEN startup recovery encounters a stale `running` run THEN it computes work product and drives
   the run to a real terminal state through the finalizer in **hold mode** (no auto-merge), rather
   than only relabeling it `unknown`.
10. WHEN recovery runs at startup THEN it classifies/finalizes **before** the orphan-worktree sweep
    (`index.ts:64`), so the sweep cannot race away the evidence the finalizer needs.

### Gated auto-merge finalizer (P1.5)

11. WHEN a run is classified `branch-complete` THEN a shared, idempotent, phase-recorded finalizer
    (`work-run-finalizer.ts`) owns terminalization in two explicit modes:
    `hold` (P0: classify → flush transcript/summary/index → teardown/preserve per outcome →
    terminal writes, no merge) and `gated-merge` (P1: verify gate → merge → push + verify →
    worktree remove → branch delete → terminal writes). Both modes are one resumable state machine.
12. WHEN the finalizer evaluates the gate THEN it merges ONLY if ALL hold: tests green, working tree
    clean, `tasksRemaining == 0`, no merge conflict / sane base relationship, and no concurrent run
    owns the branch/project. If any fails, it stops at `branch-complete`, alerts, and does not merge.
13. WHEN the gate's checks run THEN they run in an integration worktree (or on the branch) and main
    is tested **before** it is mutated, so a red result never leaves local `main` altered.
14. WHEN concurrency is guarded THEN the lock is per-product / per-base-branch (not per-project),
    because different projects in a product share one `main` (`config.ts:250` allows concurrent
    runs; `supervision-store.ts:10-15` assumes a single writer).
15. WHEN the finalizer mutates refs THEN it pushes before deleting the branch (origin is the durable
    backup) and records durable phases (`merged-not-pushed`, `pushed-not-deleted`, …) so a crash
    mid-finalize is resumable by the P0.4 recovery path.
16. WHEN the merge gate needs to run validation commands THEN it reads product-scoped
    `validationCommands` from `policies/products.json`; if absent, the gate fails closed with
    `missing-validation-command` and stops at `branch-complete`. Rune starts with
    `["npm run build", "npm test"]`. Each command runs with `WORK_RUN_GATE_COMMAND_TIMEOUT_MS`
    (default 10 minutes) in the integration worktree; timeout is a red gate result, not a wedge.

### Failure / partial / cancelled path (P1.6)

17. WHEN a run is failure/partial/cancelled THEN the finalizer always reaps the tree and flushes
    transcript/summary, never merges, and either removes the worktree after preserving forensics OR
    marks an explicit `blocked-on-human`; supervision becomes terminal or intentionally blocked,
    never a quiet-pinging `running`. Branch retention/deletion is recorded.

### Backstops independent of agent cooperation (P2.7)

18. WHEN a run stays quiet past a first threshold THEN it notifies; WHEN quiet persists past a
    longer threshold THEN an actuator escalates to cancel/reap/finalize instead of nagging forever.
19. WHEN a run exceeds a hard max-runtime ceiling THEN it is group-killed and finalized regardless
    of apparent liveness (the keep-alive ticker must not be able to defeat this).
20. WHEN the process-group reap misses reparented/detached grandchildren THEN a fallback sweep of
    processes whose cwd is under the run's worktree path reaps them (scoped to that one worktree
    path; defense-in-depth, not the happy path).

---

## Technical Implementation

A backend lifecycle change in `src/jobs/` and `src/intent/`, plus a new finalizer module and a
notification/terminal-write surface in `src/transport/`. No Convex/frontend — the generic template's
DB/component sections are N/A.

### Resolved design decisions (from the adversarial critique)

**Watchdog, not finalize-on-result.** The early proposal to finalize when `result` is seen is unsafe:
`result` arrives while the agent is still alive, and killing then re-introduces the false `failed`
the 2026-06-04 fix removed (defect 1). The decision is a **result-seen watchdog** — `result` starts
a bounded drain window; the child is reaped only if it does not exit on its own, and that reap is
stamped with a distinct `reapedAfterTerminalResult` exit fact so the classifier can tell it apart
from an external kill.

**Classifier taxonomy, not a reorder.** Simply ranking branch-complete above the exit-signal checks
would mis-mark a genuine user-cancel as success (defect 4). The classifier needs an exit-fact
taxonomy — user-cancel vs external-kill vs clean-exit-with-wedged-stdio vs
internal-reap-after-terminal-result — and decides on the combination of exit fact + work product,
not exit code alone. `parked`/`blocked-on-human` is supervision state, not a `WorkOutcome` value.

**One shared finalizer, two modes.** Today only the gen-eval-loop merges; plain work-runs never do
(defect 5). Rather than duplicate `realMergeBranch`, build a single `work-run-finalizer.ts` with
two modes. P0 recovery and watchdog paths call `hold` mode so terminal correctness can land without
policy change. P1 calls `gated-merge` mode for clean branch-complete runs. Both modes use the same
durable phase store and terminal-write path so a crash mid-finalize resumes at the right step
instead of re-merging or orphaning. Reuse/refactor `realMergeBranch`
(`gen-eval-loop-runner.ts:254-302`); note its existing half-merged push-failure warning (`:274`).

**Gated, because of `--dangerously-skip-permissions`.** Auto-merge is a *policy* change, not a bug
fix. Autonomous runs skip permission prompts, so the gate (tests green, clean tree, zero tasks
remaining, no conflict, no concurrent owner) is the boundary between "autonomous" and "lands broken
work on main." The gate runs in an integration worktree so a red check never alters local `main`.

**Lock scope is per-product / per-base-branch.** Different projects in one product share `main`
(`config.ts:250`); a per-project lock would let two finalizers race the same `main`. The lock is
keyed on the base branch, and `supervision-store.ts:10-15`'s single-writer assumption is respected.

**Transient "wrapping-up" without widening the status union.** P1.6 may want a transient status
between terminal-result and finalized. Model it without adding a `MutationStatus`/supervision enum
value unless unavoidable; if a new value is truly required, treat it as a deliberate cross-surface
change (`supervision.ts` + `supervision-store.ts:25`) made explicitly, not silently.

**Pinned runtime constants.** Add typed config for the backstops so tests and production share one
contract:

- `WORK_RUN_TERMINAL_DRAIN_MS` default `30000` — wait after a terminal `result` before internal reap.
- `WORK_RUN_REAP_GRACE_MS` default `5000` — SIGTERM grace before SIGKILL.
- `WORK_RUN_QUIET_CANCEL_AFTER_MS` default `1200000` — 20 minutes after first quiet nudge.
- `WORK_RUN_MAX_RUNTIME_MS` default `7200000` — 2 hours hard ceiling.
- `WORK_RUN_GATE_COMMAND_TIMEOUT_MS` default `600000` — 10 minutes per validation command.

All timer tests use injected clocks; no test sleeps for these wall-clock durations.

### Touch points

- **`src/jobs/work-runner.ts`** — the terminal-result watchdog (drain window + conditional group
  reap + `reapedAfterTerminalResult` exit fact); hand the terminal sequence to the finalizer.
- **`src/jobs/work-run-finalizer.ts`** (new) — the shared, idempotent, phase-recorded state machine:
  `hold` mode terminalizes without merge; `gated-merge` mode verifies the gate, merges, pushes,
  removes the worktree, deletes the branch, and writes terminal state.
- **`src/jobs/work-run-classify.ts`** — exit-fact taxonomy; classify on exit-fact + work product so
  an internal post-result reap of a clean branch is `branch-complete`, a real cancel stays `failed`.
- **`src/jobs/supervision-store.ts`** + **`src/transport/mutations.ts`** — field-merge in
  `upsertRun` (or thread `quietNudgedAt` through `buildSupervisedRun`) so a heartbeat cannot clear
  the quiet guard.
- **`src/jobs/supervision-recovery.ts`** + **`src/index.ts`** — recovery computes work product and
  drives stale runs through the finalizer, ordered **before** the orphan-worktree sweep.
- **`src/intent/supervision.ts`** + **`src/jobs/stall-check.ts`** / **`stall-check-runner.ts`** — the
  quiet→cancel actuator and the hard max-runtime ceiling.
- **`src/jobs/gen-eval-loop-runner.ts`** — source of `realMergeBranch` to reuse/refactor (do not
  duplicate); honor its half-merged push-failure warning.
- **`policies/products.json`** — add optional `validationCommands` per product; Rune gets
  `["npm run build", "npm test"]`. Products without validation commands fail the merge gate closed.
- **`src/transport/`** (telegram-sender + cockpit bus) — truthful terminal notifications: `merged`,
  `branch-complete` (gate failed), backstop-cancelled.

---

## Implementation Phases

> Task breakdown in [tasks.md](tasks.md), verification in [test-plan.md](test-plan.md); built
> test-first — every phase opens with a **Tests (write first)** block that is red before
> implementation, and a phase is done when its test-plan sections pass.

### Phase 1: Terminal correctness (P0 — no policy change)

- [ ] P0.1 supervision-store field-merge so a heartbeat can't clear `quietNudgedAt`.
- [ ] P0.3 classifier exit-fact taxonomy (foundation the watchdog + recovery classify against).
- [ ] P0.2 terminal-result watchdog (drain window, conditional group reap, new exit fact).
- [ ] P0.4 recovery classifies/finalizes stale runs in `hold` mode before the orphan-worktree sweep.

### Phase 2: Backstops independent of agent cooperation (P2.7)

> Depends on: Phase 1.

- [ ] Quiet→cancel actuator (notify, then escalate to cancel/reap/finalize).
- [ ] Hard max-runtime ceiling that group-kills regardless of apparent liveness.
- [ ] Worktree-scoped process sweep as a fallback reap for reparented grandchildren.

### Phase 3: Gated auto-merge finalizer (P1.5 + P1.6 — policy change)

> Depends on: Phase 1, Phase 2.

- [ ] Extend the shared, idempotent, phase-recorded `work-run-finalizer.ts` state machine from
  `hold` mode to `gated-merge` mode.
- [ ] The hard gate (tests green, clean tree, zero tasks remaining, no conflict, no concurrent
  owner), tested in an integration worktree before main is mutated.
- [ ] Per-product / per-base-branch lock; push-before-delete; durable resumable phases.
- [ ] Failure/partial/cancelled path: always reap + flush, never merge, terminal or blocked, never
  quiet-pinging.

### Phase 4: Cross-mode regression suite (P2.8)

> Depends on: Phase 3.

- [ ] Full incident replay (`d0679453`: result-before-exit → reap → branch-complete → merged) plus a
  finalizer-resume-at-each-phase matrix and merge-conflict / push-failure don't-delete-prematurely.

---

## Success Metrics

| Metric | Target | How Measured |
| ------ | ------ | ------------ |
| Run wedges `running` after `result: success` | Never | Watchdog tests: result emitted + child never exits → drain → group reap → terminal within the bounded window |
| Quiet nudge re-fires across heartbeats | Never | Supervision-store test: quiet nudge → keep-alive heartbeat → no second nudge |
| Post-result internal reap of a clean branch classified `failed` | Never | Classifier tests: `reapedAfterTerminalResult` + clean+complete branch → `branch-complete`; user-cancel → `failed` |
| Clean, complete, gate-passing run reaches `main` without a human | Yes | Finalizer integration test: classify → gate green → merge → push → terminal `merged`, no operator action |
| Broken work lands on `main` | Never | Gate tests: red tests / dirty tree / tasks remaining / conflict / concurrent run each stop at `branch-complete`, main unchanged |
| Crash mid-finalize re-merges or orphans | Never | Resume matrix: kill at each durable phase → recovery resumes at the right step, exactly-once merge |
| Run exceeds max-runtime ceiling and survives | Never | Backstop test with injected clock: ceiling exceeded → group-kill + finalize regardless of keep-alive liveness |

---

## Edge Cases & Error Handling

- **`result: success` then never exits (the incident):** watchdog drain window → group reap →
  `reapedAfterTerminalResult` → classify branch-complete → finalize. No 8.5h wedge, no human.
- **Genuine user-cancel of a branch that looks complete:** exit-fact taxonomy keeps it `failed` /
  `cancelled`; the classifier reorder must not read a real cancel as success.
- **Crash mid-finalize:** durable phase records (`merged-not-pushed`, `pushed-not-deleted`) let P0.4
  recovery resume at the right step; push-before-delete keeps origin as the backup.
- **Two projects in one product finalize at once:** per-product / per-base-branch lock serializes
  them; a per-project lock would race the shared `main`.
- **Reparented / detached grandchild survives the pgid kill:** worktree-scoped cwd sweep reaps it,
  scoped to the single worktree path so it never touches unrelated processes.
- **Recovery races the orphan-worktree sweep:** recovery classifies/finalizes before the sweep
  (`index.ts:64` ordering) so the sweep can't delete the worktree the finalizer still needs.
- **Push succeeds but branch-delete fails:** record `pushed-not-deleted`; origin already has the
  work, so a later resume completes the delete without re-merging.
- **Gate is green but merge conflicts at apply time:** stop at `branch-complete` + alert; never
  leave a half-applied `main` (test before mutating main, Req 13).

---

## Settled decisions for agent execution

- The fix is `result`-seen **watchdog** + conditional reap, never finalize-immediately-on-`result`.
- The classifier decides on exit-fact + work product; `reapedAfterTerminalResult` of a clean branch
  is `branch-complete`; a real user-cancel stays `failed`.
- One shared `work-run-finalizer.ts` owns terminal writes for both the happy path and recovery,
  structured as a resumable state machine with durable phase records and explicit `hold` /
  `gated-merge` modes.
- Auto-merge is **gated**, not unconditional, because runs use `--dangerously-skip-permissions`.
- Merge validation commands come from product config and fail closed when absent; command timeouts
  are gate failures, not wedges.
- The concurrency lock is per-product / per-base-branch; push happens before branch delete.
- Backstops (quiet→cancel actuator, max-runtime ceiling, worktree-scoped sweep) hold even if the
  agent never cooperates and the keep-alive ticker stays fresh.
- Land Phase 1 (watchdog + classifier) and Phase 2 (backstops) before running the Phase 4 incident
  replay; this is an automated sequencing rule, not a manual attendance requirement.
- All required verification is automated with temp repos, injected streams, injected clocks, and
  fake sender/HTTP tests; live smoke testing is optional only.
- **Live gated-merge activation: GO (operator decision 2026-06-07, option #2).** Wire the live
  work-runner to `gated-merge` mode for branch-complete + the merged-notification surface (Phase 3.5 in
  tasks.md). Run non-interactively — do not re-ask via `AskUserQuestion` (the auto-deny is the bug under
  fix). The branch merge → `main` and the rune server restart remain a human go-live step.

---

## Provenance

Two independent investigations (Claude + Codex) of incident `d0679453` (project `12-writer-memory`,
2026-06-06) plus an adversarial Codex critique of the combined plan. The critique converted an
unsafe "finalize on `result`" proposal into the result-seen watchdog and flagged gated auto-merge as
a policy decision rather than a bug fix. Promoted from the `bugs.md` "`/work --auto` wedges open
AGAIN" entry, which carries the full six-defect breakdown and the P0/P1/P2 fix plan this spec
implements. Follows on from the 2026-06-04 wedge fix (same symptom class, different trigger) and is
adjacent to the `partial`-vs-`blocked-on-human` classification gap and the `AskUserQuestion`
auto-deny bug, which share the classifier/terminal-state surface and should land consistently with
P0.3 / P1.6.
