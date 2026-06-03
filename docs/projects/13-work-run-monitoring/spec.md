# Work-Run Monitoring (Phase 1: Findability & Parked Worktrees) Specification

## Overview

Make an automated `/work --auto` run reachable and testable by a human when it needs one —
without asking Jarvis where the work lives.

Today an automated work-run executes inside a worktree at a deterministic path, but that path is
never surfaced, and the worktree is always destroyed at terminal end (`work-runner.ts`'s `finally`
calls `destroyWorktree`). When a run hits a task `--auto` cannot perform — the interactive Codex
check that stalled project 10 — there is no signal that a human is needed, no live worktree to act
in, and no way to hand the run back. Michael had to ask where the worktree was, and by the time he
looked it could be gone.

This project surfaces the worktree path in run notifications and introduces a durable **parked**
state: a run that needs a human keeps its worktree alive, holds the per-project slot, and is
released by an explicit action once the human is done. It does not touch how `/work` executes a
task, and it does not add durable integration branches (see Deferred).

### Core Value Proposition

When a run needs Michael (or he just wants to look), the notification hands him the worktree path
and the pending check; he tests in place and releases the run — instead of the work evaporating at
teardown.

### Goals

1. **Primary:** A run that parks for a human keeps its worktree alive and surfaces the path + the
   pending action, so Michael can reach it in one step.
2. **Secondary:** Every run surfaces its worktree path and run id at start, for live monitoring.
3. **Tertiary:** Releasing a parked run is one explicit action that tears down the worktree and
   frees the per-project slot.

### Non-Goals

- **Durable integration branches / promotion.** Cut from this spec — the proposed topology was
  invalid (see Deferred). Phase 1 changes nothing about which branch a run is cut from
  (`jarvis-work/<run-id>` off repo HEAD, as today) or how work reaches main.
- **Changing how `/work` executes** (the plan→test→implement→review cycle in
  `.claude/skills/work/SKILL.md`). Same boundary project 11 held.
- **A new cockpit screen.** Reuse the existing run card / drawer and the Telegram formatter; add
  fields and one action, don't build surfaces.
- **Auto-promotion to main.** Reaching main stays the gen-eval-loop's cross-model merge contract;
  a parked run's branch (and any human commits on it) persists per existing GC but is not promoted.

---

## Background: verified current-state

Confirmed against the code on 2026-06-03, with the Codex critique's corrections applied.

1. **Worktree paths are already deterministic.** `worktreePathFor(product, project, root)` →
   `<WORKTREE_ROOT>/<product>/<project>` (`src/intent/sandbox.ts:75`); `WORKTREE_ROOT` defaults to
   `<PROJECT_ROOT>/.worktrees` (`src/config.ts:152`). The findability gap is that this path is
   never surfaced, not that it is unpredictable.
2. **The worktree is always destroyed at terminal end** — `work-runner.ts:487` `finally` →
   `destroyWorktree` (`:493`). This is the behavior Phase 1 makes conditional.
3. **The run branch is NOT deleted at terminal end** (correction). GC deletes a branch only when
   its run is terminal *and* unprotected *and* over the retention caps (`work-run-gc.ts:95` `planGc`,
   `:100`, branch delete at `:201`); the just-finished run is protected while still in `activeRuns`
   (`work-runner.ts:504`). So a run branch survives until a later cap-driven GC pass — the commits
   are not lost at teardown, only the *worktree* (the checked-out files) is.
4. **The single-model runner never merges to main.** Best outcome is `branch-complete · not yet on
   main` (`telegram-sender.ts:94`); there is no merge path in `work-runner`.
5. **GC protects branches checked out in any worktree** (`work-run-gc.ts:168`, `:175`) and refuses
   to prune anything outside the `jarvis-work/` prefix.
6. **`scrubPathsInText` strips `WORKTREE_ROOT` / `PROJECT_ROOT`** (`src/ai/tool-labels.ts:32`) — so
   any path that flows through the scrubber is unusable as a `cd` target. The findability
   notification must carry an un-scrubbed path on a local-operator-only field (see Requirements 2).

### Phase 0 finding (resolved — no longer an open task)

Codex traced the promotion path: **nothing auto-promotes a plain `/work --auto` work-run to main.**
The only merge-to-main is `realMergeBranch` in the gen-eval-loop (`git merge --no-ff` + push,
`gen-eval-loop-runner.ts:274`/`:279`), gated by `evaluateMergeContract` (`:632`). Project 10's
commits reached main manually or via gen-eval, not via the work-runner. Phase 1 needs no promotion
plumbing — it only keeps the worktree alive and hands it to a human.

---

## User Journey

### Happy path (run parks for a human)

```
run starts (notification: path + id) → commits accrue on the run branch
   → run hits a step --auto can't do → PARKS (worktree kept alive, slot held)
   → alert: worktree path + pending check → Michael cd's in, tests, confirms/fixes
   → Michael releases → worktree torn down, slot freed
```

1. **Run starts.** The start notification names the project, run id, and the worktree path.
2. **Run parks.** A task needs an interactive step `--auto` can't take. The run emits a durable
   `blocked-on-human` (parked) state, its worktree is **not** destroyed, and the per-project slot
   stays held. The alert carries the worktree path and the pending action.
3. **Michael tests in place.** He `cd`s to the live worktree, runs the check, confirms or applies a
   fix (commits land on the run branch, which already survives per GC).
4. **He releases.** A release action tears down the worktree and frees the slot for the next run.

### Entry / exit points

- **Entry:** a `/work --auto` dispatch (cockpit button, Telegram, scheduled), or a run-state alert.
- **Exit:** run parks → Michael tests → releases; or run reaches an ordinary terminal outcome and
  tears down as today.

---

## Requirements

### Findability

1. WHEN a run starts THEN its start notification includes the deterministic worktree path and the
   run id.
2. WHEN a notification carries the worktree path for the operator to act on THEN that path is
   un-scrubbed and rides a local-operator-only field; it MUST NOT flow into `mutations.jsonl`,
   forensics, or any committed/remote artifact (those stay scrubbed). Resolves the
   path-vs-scrubbing contradiction.

### Parked state

3. WHEN a run emits the blocked-on-human sentinel THEN it records a durable supervision
   `blocked-on-human` state (the mutation still terminates normally; no new `MutationStatus` value).
   The state survives a Jarvis restart via the existing supervision store + recovery.
4. WHEN a run is parked THEN `work-runner`'s teardown does NOT destroy its worktree, and GC +
   `cleanupOrphanWorktrees` do NOT reap the worktree or its run dir while the supervision
   `blocked-on-human` record stands (parked runs join the protected set).
5. WHEN the per-project cap is evaluated THEN it rejects a new run if ANY of: an `activeRuns` run is
   `running` for the slug; a supervision `blocked-on-human` (parked) record exists for the slug; or
   a worktree is already registered at the deterministic path for the slug. The registered-worktree
   check is the backstop for the crash-before-parked-state-written case and for runs that startup
   recovery left as `unknown` (`supervision-recovery.ts`) — without it, validation would pass and
   `createWorktree` would later fail on the occupied path (`work-runner.ts:165` today checks only
   in-memory `running`).
6. WHEN startup orphan-cleanup runs THEN a parked worktree (still registered in `git worktree list`)
   is preserved, not swept.

### Release

7. WHEN Michael releases a parked run THEN the worktree is destroyed, the supervision
   `blocked-on-human` record clears, and the per-project slot frees for the next run. This is a
   net-new actionable path: existing `blocked-on-human` approval rows are intentionally
   non-actionable (`approval-actions.ts:155`).
8. WHEN a release is requested AND the parked worktree has dirty/uncommitted changes THEN release
   does NOT silently `destroyWorktree` (which force-removes — `sandbox-runtime.ts:333`). It warns
   with the dirty file list and requires an explicit confirm, so a half-finished human fix is never
   discarded without consent. A clean worktree releases directly.
9. WHEN a release is requested THEN it is available from both Telegram and the cockpit, routed
   through the existing mutation pipeline.

---

## Technical Implementation

A backend lifecycle + state change in `src/jobs/` and `src/intent/`, plus notification + one action
in `src/transport/`. No Convex/frontend framework — the generic template's DB/component sections
are N/A.

### Resolved design decisions (from the 2nd Codex round)

**Where "parked" lives in the state model.** The mutation lifecycle has no room for a "terminal but
parked" status: `MutationStatus` is `pending|approved|running|completed|failed|rejected`
(`mutations.ts:87`), and on a terminal event `startApply` immediately marks the descriptor
`completed`/`failed`, writes the supervision terminal, and drops the run from `activeRuns`
(`mutations.ts:323`, `:367`). **Decision:** do NOT add a `MutationStatus` value and do NOT keep the
mutation artificially `running` (the child has exited; stall detection would flag it). Instead the
parked state lives in **supervision** as `blocked-on-human` — a value supervision already carries
and that startup recovery preserves (`supervision-recovery.ts`). The mutation terminates normally;
the durable supervision `blocked-on-human` record **plus the live registered worktree** are the
source of truth for "parked." Cap checks, GC protection, cockpit visibility, and release all read
*that*, not `activeRuns` or `MutationStatus`. Parked is therefore NOT a `WorkOutcome` value either —
it does not belong in the `work-run-classify.ts` enum (`branch-complete | partial | noop |
dirty-uncommitted | failed`).

**How the run signals "a human is required".** The child only emits NDJSON envelopes that the runner
parses then converts to display lines (`work-runner.ts:661`); there is no custom stream-event
channel, and the `/work` SKILL today only says hard stops "report to the user" with no machine
payload (`SKILL.md:23`). **Decision (Codex's contract):** the `/work --auto` SKILL must end a
blocked-on-human stop with one exact final line — `JARVIS_WORK_RUN_SENTINEL { ...json... }` — and
`work-runner` parses that sentinel from the **raw `assistant`/`result` envelope before display
scrubbing**, not from a tasks.md freetext marker. The sentinel JSON carries the pending-check
description and any command to run. A run that needs a human but emits no sentinel falls through to
an ordinary terminal outcome (no park, no regression).

### Touch points

- **`.claude/skills/work/SKILL.md`** — define the structured blocked-on-human sentinel the runner
  parses (the hard stop already exists; this makes it machine-detectable).
- **`src/jobs/work-runner.ts`** — parse the sentinel; on parked, skip the `finally` `destroyWorktree`
  and emit the durable parked state; thread the worktree path to the start + parked notifications.
- **`src/jobs/work-run-gc.ts`** + **`cleanupOrphanWorktrees`** — add parked runs to the protected
  set so neither the run dir nor the worktree is reaped while parked.
- **per-project cap** (`work-runner.ts:165` validate) — consult durable parked state.
- **supervision / run store** — a durable parked record + a release transition.
- **`src/transport/`** (telegram-sender + cockpit bus + a release action) — path on start/parked
  notifications; a release control wired through the mutation pipeline.

---

## Implementation Phases

> Task breakdown in [tasks.md](tasks.md), verification in [test-plan.md](test-plan.md); built
> test-first — every phase opens with a **Tests (write first)** block that is red before
> implementation, and a phase is done when its test-plan sections pass.

### Phase 1a: Surface the path

- [ ] Worktree path + run id on the start notification (un-scrubbed, local-operator field).
- [ ] Confirm the un-scrubbed path never reaches `mutations.jsonl` / forensics / committed artifacts.

### Phase 1b: Parked state

> Depends on: 1a.

- [ ] Define + parse the structured blocked-on-human sentinel from the `/work --auto` stream.
- [ ] Durable parked record (survives restart); teardown + GC + orphan-cleanup skip a parked run.
- [ ] Per-project cap consults durable parked state.
- [ ] Parked alert carries worktree path + the pending check.

### Phase 1c: Release

> Depends on: 1b.

- [ ] Release action (Telegram + cockpit) tears down the worktree, clears parked state, frees the slot.

---

## Success Metrics

| Metric | Target | How Measured |
| ------ | ------ | ------------ |
| Steps to reach a parked run's worktree | 1 (copy path from alert) | Manual: trigger a park, follow the alert |
| Parked worktree survives until released | Yes | Park a run; confirm worktree present after a Jarvis restart |
| Parked run blocks a new run for the same project | Yes | Attempt a second dispatch; expect the cap to reject |
| Operator path leaks to a committed/remote artifact | Never | Grep `mutations.jsonl` / forensics for the un-scrubbed prefix |

---

## Edge Cases & Error Handling

- **Parked worktree never released:** the slot blocks new runs for that project indefinitely.
  Surface parked runs in the cockpit and add a staleness nudge (reuse project 11's quiet-run
  machinery) rather than auto-releasing, which would discard an unfinished manual check.
- **Crash while parked:** the parked record must be durable in the run store; startup recovery
  re-derives the held slot and does not reap the worktree.
- **Human commits a fix in the parked worktree:** those commits land on the run branch, which
  already survives per GC. Phase 1 does not promote them — release only tears down the worktree;
  promotion stays manual / gen-eval (Non-Goals).
- **Dirty/uncommitted edits at release:** now a hard requirement (Req 8), not a deferred policy —
  a dirty worktree warns + requires explicit confirm before the force-removing `destroyWorktree`.
- **Sentinel false-negative:** if the run needed a human but emitted no sentinel, it classifies as
  an ordinary terminal outcome and tears down as today — no regression, just no park. The sentinel
  contract (Phase 1b) is where this risk is controlled.

---

## Open Questions

- [ ] Release UX: a button on the cockpit run card vs. a Telegram reply action vs. both.
- [ ] Parked-worktree TTL/nudge cadence before it reads as a forgotten disk + slot leak.
- [ ] The exact JSON fields the `JARVIS_WORK_RUN_SENTINEL` line carries (pending-check text +
  command at minimum) — pin the schema in tasks.md before Phase 1b implementation.

> Resolved in this round (was open): the sentinel mechanism (a final
> `JARVIS_WORK_RUN_SENTINEL {…}` line parsed pre-scrub) and where the parked state lives (reuse
> supervision `blocked-on-human`, made actionable). See Resolved design decisions.

---

## Deferred (cut from this spec)

- **Durable per-project integration branches + promotion.** The original Phase 2. Cut because the
  proposed topology was invalid — `refs/heads/jarvis-work/<project>` and
  `refs/heads/jarvis-work/<project>/<run-id>` cannot coexist (a ref is a file; a nested ref needs it
  to be a directory). If revived, the correct mechanism (per the Codex critique) is a machine-owned
  ref **outside** `refs/heads` (e.g. `refs/jarvis/integration/<product>/<project>`), advanced by
  compare-and-swap and never checked out by a human; Michael refreshes a separate view worktree via
  `git merge --ff-only`. It is a separate product decision with real git-topology cost, and it does
  not unblock the motivating incident — track it as a future spec, not here.
