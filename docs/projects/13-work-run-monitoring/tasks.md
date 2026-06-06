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
>
> **Agent-runnable constraint:** required verification must use temp repos/worktrees, injected
> work-run streams, fake sender/HTTP surfaces, test-scoped stores, and injected clocks. Do not make
> any required task depend on a real Telegram chat, a production cockpit click, a live Jarvis
> restart, or Michael manually inspecting a parked worktree. A live smoke check may be added after
> the automated suites pass, but it is not a blocking task.

## Phase 1a — Surface the worktree path

> Depends on: nothing.

### Tests (write first)

- [ ] Write run-start notification tests asserting `operatorWorktreePath` contains the exact
      deterministic path (`<WORKTREE_ROOT>/<product>/<project>`) and the run id is present on the
      Telegram/cockpit bus payloads — test-plan.md §1.
- [ ] Write leak-containment tests using a fake absolute worktree prefix; assert that
      `mutations.jsonl`, work-run summary/index, transcript/forensics payloads, and committed-file
      candidates contain only scrubbed paths, while `operatorWorktreePath` remains un-scrubbed.
- [ ] Write the create-worktree-failure test: if no worktree exists yet, the notification omits
      `operatorWorktreePath` instead of emitting an empty or partial value.
- [ ] Confirm every suite above fails (red) before starting the implementation block.

### Path on notifications

- [ ] Thread the deterministic worktree path + run id onto the run-start notification (Telegram +
      cockpit bus), on a local-operator-only field named `operatorWorktreePath` carrying the
      **un-scrubbed** path.
- [ ] Guarantee the un-scrubbed path never reaches `mutations.jsonl`, the forensics bundle, or any
      committed/remote artifact — those continue through `scrubPathsInText` (`tool-labels.ts:32`).

## Phase 1b — Parked state

> Depends on: Phase 1a.

### Tests (write first)

- [ ] Write sentinel parser tests for valid `JARVIS_WORK_RUN_SENTINEL` payloads, malformed JSON,
      unsupported `version`, missing/empty `pendingCheck`, optional `command`, optional `reason`,
      and consumed-not-rendered output — test-plan.md §2.
- [ ] Write terminal-path tests proving a parsed sentinel emits parked metadata, leaves the
      mutation terminal, and preserves supervision as `blocked-on-human` instead of letting the
      terminal mutation write overwrite it with `completed`/`failed`.
- [ ] Write temp-repo lifecycle tests proving parked teardown skips `destroyWorktree`, GC protects
      the run dir/branch, startup recovery preserves `blocked-on-human`, and
      `cleanupOrphanWorktrees` leaves the registered parked worktree intact.
- [ ] Write per-project cap tests for all three rejection inputs: in-memory running run, durable
      parked supervision record, and registered deterministic worktree with no parked state.
- [ ] Write parked alert tests asserting the alert includes `operatorWorktreePath`,
      `pendingCheck`, optional `command`, and optional `reason`.
- [ ] Write parked staleness-nudge tests with an injected clock for the default 24-hour threshold;
      assert the nudge fires and no auto-release happens.
- [ ] Confirm red before implementation.

### Sentinel contract

- [ ] Define the `JARVIS_WORK_RUN_SENTINEL { … }` line contract in `.claude/skills/work/SKILL.md`:
      a blocked-on-human hard stop ends its final result with exactly this line, JSON carrying:
      `version: 1`, non-empty `pendingCheck`, optional `command`, and optional `reason`.
- [ ] Parse the sentinel in `work-runner` from the **raw `assistant`/`result` envelope before
      display scrubbing** (`work-runner.ts:661` region); a malformed/absent/unsupported sentinel
      falls through to an ordinary terminal outcome (no park).

### Durable parked state + lifecycle carve-outs

- [ ] On a parsed sentinel, record a durable supervision `blocked-on-human` state (mutation still
      terminates normally; no new `MutationStatus` value). State survives restart via the existing
      supervision store + recovery.
- [ ] Ensure the mutation terminal path preserves the parked supervision override instead of
      overwriting it with `completed`/`failed` after the work-run terminal event.
- [ ] Make `work-runner`'s teardown skip `destroyWorktree` while the run is parked.
- [ ] Add parked runs to the protected set in `work-run-gc.ts` and exempt the live worktree from
      `cleanupOrphanWorktrees`, so neither the run dir nor the worktree is reaped while parked.
- [ ] Add the parked staleness nudge using `PARKED_RUN_NUDGE_AFTER_MS` (default 24 hours) and an
      injected clock seam; never auto-release because of age.

### Cap + alert

- [ ] Harden the per-project cap (`work-runner.ts:165` validate) to reject when ANY of: an
      `activeRuns` run is `running` for the slug; a supervision `blocked-on-human` record exists for
      the slug; or a worktree is already registered at the deterministic path for the slug.
- [ ] Parked alert (Telegram + cockpit) carries `operatorWorktreePath`, `pendingCheck`, optional
      `command`, and optional `reason` from the sentinel payload.

## Phase 1c — Release

> Depends on: Phase 1b.

### Tests (write first)

- [ ] Write shared release-runtime tests for clean release, dirty release without confirmation,
      dirty release with `{ confirmDirty: true }`, already-released/not-parked ids, and stale/missing
      worktree paths — test-plan.md §3.
- [ ] Write HTTP route tests for `POST /api/work-runs/:id/release`, including dirty-confirm
      response shape, not-parked no-op response, and `202 { mutationId }` clean/confirmed release
      response.
- [ ] Write Telegram callback tests for `work-run-release:<id>` proving it delegates to the same
      release runtime and returns the same dirty-confirm/mutation-created/not-parked outcomes.
- [ ] Write mutation tests proving `work-run-release` is a registered auto-approved mutation kind,
      carries payload `{ runId, confirmDirty }`, rechecks parked/dirty state in the applier, and
      emits terminal events.
- [ ] Write post-release cap tests proving a released run no longer blocks the project slot and a
      subsequent dispatch is accepted.
- [ ] Confirm red before implementation.

### Release action

- [ ] Add an actionable release path (net-new — existing `blocked-on-human` approval rows are
      non-actionable, `approval-actions.ts:155`) routed through the mutation pipeline and one shared
      release runtime, available from both Telegram and the cockpit.
- [ ] Add `work-run-release` to `MutationKind` and register an auto-approved applier with payload
      `{ runId: string, confirmDirty?: boolean }`.
- [ ] Implement shared release preflight used by both surfaces: not-parked returns a no-op outcome,
      dirty-without-confirmation returns dirty-confirm with the `git status --porcelain` file list,
      and clean/confirmed release creates the `work-run-release` mutation.
- [ ] Add cockpit route `POST /api/work-runs/:id/release` with optional body
      `{ "confirmDirty": true }`; return `409 { "error": "dirty-worktree", "files": [...] }` for
      dirty-confirm without creating a mutation, `200` for not-parked no-op, and
      `202 { "mutationId": "..." }` when a release mutation is created.
- [ ] Add Telegram callback action `work-run-release:<id>` using the same shared runtime and dirty
      confirmation behavior.
- [ ] On release of a **clean** worktree: `destroyWorktree`, clear the supervision parked record,
      free the per-project slot.
- [ ] On release of a **dirty** worktree (`git status --porcelain` in the parked worktree is
      non-empty): warn with the dirty file list and require explicit confirm before the
      force-removing `destroyWorktree` (`sandbox-runtime.ts:333`); never discard a half-finished
      human fix silently.
