# Work-Run Monitoring (Phase 1) — Tasks

Not started. See [spec.md](spec.md) for architecture and [test-plan.md](test-plan.md) for verification.

> **Test-first by default.** Every phase below opens with a **Tests (write first)** block.
> Those tests mirror the matching [test-plan.md](test-plan.md) sections and must fail (red)
> before any implementation task in the phase begins. A phase's implementation is done when
> its test-plan sections pass.
>
> Granularity here is the meaningful deliverable — not a granular sub-task. Per-task file
> layout, schemas, and signatures are settled in `/work`'s Plan phase, against the spec.
>
> Scope is Phase 1 only (findability + parked worktree + release). Durable integration branches
> are explicitly out of scope — see spec.md → Deferred.

## Phase 1a — Surface the worktree path

> Depends on: nothing.

### Tests (write first)

- [ ] Write the test suite for **path surfacing** — test-plan.md §1.
- [ ] Confirm every suite above fails (red) before starting the implementation block.

### Path on notifications

- [ ] Thread the deterministic worktree path + run id onto the run-start notification (Telegram +
      cockpit bus), on a local-operator-only field carrying the **un-scrubbed** path.
- [ ] Guarantee the un-scrubbed path never reaches `mutations.jsonl`, the forensics bundle, or any
      committed/remote artifact — those continue through `scrubPathsInText` (`tool-labels.ts:32`).

## Phase 1b — Parked state

> Depends on: Phase 1a.

### Tests (write first)

- [ ] Write the test suite for **parked state** — test-plan.md §2.
- [ ] Confirm red before implementation.

### Sentinel contract

- [ ] Define the `JARVIS_WORK_RUN_SENTINEL { … }` line contract in `.claude/skills/work/SKILL.md`:
      a blocked-on-human hard stop ends its final result with exactly this line, JSON carrying the
      pending-check text + any command to run.
- [ ] Parse the sentinel in `work-runner` from the **raw `assistant`/`result` envelope before
      display scrubbing** (`work-runner.ts:661` region); a malformed/absent sentinel falls through
      to an ordinary terminal outcome (no park).

### Durable parked state + lifecycle carve-outs

- [ ] On a parsed sentinel, record a durable supervision `blocked-on-human` state (mutation still
      terminates normally; no new `MutationStatus` value). State survives restart via the existing
      supervision store + recovery.
- [ ] Make `work-runner`'s teardown skip `destroyWorktree` while the run is parked.
- [ ] Add parked runs to the protected set in `work-run-gc.ts` and exempt the live worktree from
      `cleanupOrphanWorktrees`, so neither the run dir nor the worktree is reaped while parked.

### Cap + alert

- [ ] Harden the per-project cap (`work-runner.ts:165` validate) to reject when ANY of: an
      `activeRuns` run is `running` for the slug; a supervision `blocked-on-human` record exists for
      the slug; or a worktree is already registered at the deterministic path for the slug.
- [ ] Parked alert (Telegram + cockpit) carries the worktree path + the pending check from the
      sentinel payload.

## Phase 1c — Release

> Depends on: Phase 1b.

### Tests (write first)

- [ ] Write the test suite for **release** — test-plan.md §3.
- [ ] Confirm red before implementation.

### Release action

- [ ] Add an actionable release path (net-new — existing `blocked-on-human` approval rows are
      non-actionable, `approval-actions.ts:155`) routed through the mutation pipeline, available
      from both Telegram and the cockpit.
- [ ] On release of a **clean** worktree: `destroyWorktree`, clear the supervision parked record,
      free the per-project slot.
- [ ] On release of a **dirty** worktree: warn with the dirty file list and require explicit
      confirm before the force-removing `destroyWorktree` (`sandbox-runtime.ts:333`); never discard
      a half-finished human fix silently.
