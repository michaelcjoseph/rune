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
> Scope is Phase 1 only (findability + parked worktree + release/resume), and the **legacy
> `work-run` applier only** — Project 14's `orchestrated-work` applier never spawns the
> `/work --auto` process the sentinel rides on and unconditionally destroys its worktree, so it is
> not parkable (spec.md → Background §6, Non-Goals). Durable integration branches are explicitly out
> of scope — see spec.md → Deferred. Project 15 now owns normal terminalization and gated merge;
> Project 13 pauses that finalizer while a run is parked (by **skipping** it in `work-runner`, not
> by teaching the finalizer about parking) and cold-finalizes on clean release.
>
> **Two carve-outs are verify-not-implement.** GC already protects non-terminal
> (`blocked-on-human`) supervised ids + checked-out branches (`work-run-gc-runner.ts:55`), and
> `cleanupOrphanWorktrees` only sweeps unregistered dirs — a parked worktree stays registered. Those
> become regression assertions, not new code (spec.md → Background §4, §5).
>
> **Agent-runnable constraint:** required verification must use temp repos/worktrees, injected
> work-run streams, fake sender/HTTP surfaces, test-scoped stores, and injected clocks. Do not make
> any required task depend on a real Telegram chat, a production cockpit click, a live Jarvis
> restart, or Michael manually inspecting a parked worktree. A live smoke check may be added after
> the automated suites pass, but it is not a blocking task.

## Phase 1a — Surface the worktree path

> Depends on: nothing.

### Tests (write first)

- [x] Write run-start notification tests asserting `operatorWorktreePath` contains the exact
      deterministic path (`<WORKTREE_ROOT>/<product>/<project>`) and the run id is present on the
      Telegram/cockpit bus payloads — test-plan.md §1. (`work-runner.test.ts` "Phase 1a" describe
      block, test "yields a run-start event carrying operatorWorktreePath + run id".)
- [x] Write leak-containment tests using a fake absolute worktree prefix; assert that
      `mutations.jsonl`, work-run summary/index, transcript/forensics payloads, and committed-file
      candidates contain only scrubbed paths, while `operatorWorktreePath` remains un-scrubbed.
      (Tests "keeps operatorWorktreePath un-scrubbed" + "never leaks the un-scrubbed worktree path
      into persisted/committed artifacts".)
- [x] Write the create-worktree-failure test: if no worktree exists yet, the notification omits
      `operatorWorktreePath` instead of emitting an empty or partial value. (Test "omits the path
      field when no worktree was created (create failed)".)
- [x] Confirm every suite above fails (red) before starting the implementation block. (3 of 4 fail
      cleanly — "expected undefined to be defined" — until the `start` event lands; the create-fail
      guard passes pre-impl. 57 other work-runner tests still green; 0 new tsc errors.)

### Path on notifications

- [x] Thread the deterministic worktree path + run id onto the run-start notification (Telegram +
      cockpit bus), on a local-operator-only field named `operatorWorktreePath` carrying the
      **un-scrubbed** path. (`apply()` yields a `start` MutationEvent after `createWorktree` succeeds;
      `MutationEvent.kind`/`BusMutationEvent.subKind` widened with `'start'`; `formatWorkRunStart`
      renders it on Telegram; WebviewSender broadcasts the frame to the localhost cockpit. Both are
      local-operator surfaces.)
- [x] Guarantee the un-scrubbed path never reaches `mutations.jsonl`, the forensics bundle, or any
      committed/remote artifact — those continue through `scrubPathsInText` (`tool-labels.ts:32`).
      (Leak-containment tests assert the path stays off the descriptor/summary/index/transcript/
      terminal event; the `startApply` loop publishes the `start` event with no descriptor copy. All
      three reviewers confirmed the invariant holds.)

## Phase 1b — Parked state

> Depends on: Phase 1a.

### Tests (write first)

- [x] Write sentinel parser tests for valid `JARVIS_WORK_RUN_SENTINEL` payloads, malformed JSON,
      unsupported `version`, missing/empty `pendingCheck`, optional `command`, optional `reason`,
      and consumed-not-rendered output — test-plan.md §2. (`src/jobs/work-run-sentinel.test.ts` →
      `parseWorkRunSentinel`; `src/jobs/work-run-sentinel.ts` stub returns null. 4 valid-parse RED,
      reject guards green.)
- [x] Write terminal-path tests proving a parsed sentinel writes the parked record **first**,
      leaves the mutation terminal, **skips `runFinalizer`** (worktree left live), and preserves
      supervision as `blocked-on-human` — including a test that the `mutations.ts` terminal branch
      detects parked terminal metadata and does NOT clobber the `blocked-on-human` record
      (Background §7's second writer). (`work-runner.test.ts` "Phase 1b" block: skip-finalizer +
      parked-record-first; `mutations.test.ts`: parked terminal never writes completed/failed
      supervision status. RED.)
- [x] Write the crash-window test: a run that emitted the sentinel but whose parked record was lost
      (still `running` on disk) is finalized by `recoverAndFinalizeStaleRuns` as an ordinary
      recovered terminal (worktree removed, no park) — no crash; documents the window the
      first-write ordering minimizes. (`supervision-recovery.test.ts` project-13 crash-window test —
      verify-not-implement, green.)
- [x] Write temp-repo regression tests proving the EXISTING behavior holds for a parked run: GC
      protects the run dir/branch (non-terminal id + checked-out branch), startup recovery preserves
      `blocked-on-human`, and `cleanupOrphanWorktrees` leaves the registered parked worktree intact.
      (Verify-not-implement — these assert current code, no carve-out.) (`work-run-gc.test.ts`
      project-13 parked-protection + `supervision-recovery.test.ts` parked-survives; orphan-cleanup
      is covered by the existing `sandbox-runtime.test.ts` "registered worktree → not swept" test —
      a parked worktree stays registered. All green.)
- [x] Write per-project cap tests for all three rejection inputs: in-memory running run, durable
      parked supervision record, and `existsSync` deterministic worktree with no parked state.
      (`work-runner.test.ts` "Phase 1b": parked supervision record + existsSync backstop both RED;
      the in-memory running case is covered by the existing validate cap tests.)
- [x] Write an orchestrated-work scope test: an `orchestrated-work` run that blocks maps to `failed`
      and destroys its worktree (NOT parked) — documents the legacy-only boundary.
      (`orchestrated-work-runner.test.ts` project-13 scope test — verify-not-implement, green.)
- [x] Write parked alert tests asserting the alert includes `operatorWorktreePath`,
      `pendingCheck`, optional `command`, and optional `reason`; and a `formatWorkRunTerminal`
      parked-branch test (parked doesn't render as its underlying `partial`/`noop`).
      (`work-runner.test.ts` parked terminal carries the sentinel payload; `telegram-sender.test.ts`
      parked-branch test. RED.)
- [x] Write parked staleness-nudge tests with an injected clock for the default 24-hour threshold
      against a NET-NEW `planParkedNudges` predicate (blocked-on-human + `parkedNudgedAt`), asserting
      the nudge fires once and no auto-release happens — and that `isQuietRun`/`planQuietNudges` do
      NOT fire on a `blocked-on-human` run. (`supervision-parked.test.ts` → `isParkedRun`/
      `planParkedNudges` (RED) + the quiet-predicates-never-touch-parked cross-checks (green).)
- [x] Confirm red before implementation. (Full suite: 12 intentional Phase 1b RED across
      work-run-sentinel/supervision-parked/work-runner/mutations/telegram-sender, all clean
      assertion failures; verify-not-implement regressions green; 0 new tsc errors (29 pre-existing);
      only the 2 pre-existing unrelated failures otherwise. Reviewed: security PASS, code-review
      4 warnings applied.)

### Sentinel contract

- [ ] Define the `JARVIS_WORK_RUN_SENTINEL { … }` line contract in `.claude/skills/work/SKILL.md`:
      a blocked-on-human hard stop ends its final result with exactly this line, JSON carrying:
      `version: 1`, non-empty `pendingCheck`, optional `command`, and optional `reason`.
- [ ] Parse the sentinel in `work-runner` from the **raw `assistant`/`result` envelope before
      display scrubbing** (`work-runner.ts:661` region); a malformed/absent/unsupported sentinel
      falls through to an ordinary terminal outcome (no park).

### Durable parked state + lifecycle carve-outs

- [ ] On a parsed sentinel, record a durable supervision `blocked-on-human` state **as the first
      effect, before any terminal/finalize step** (mutation still terminates normally; no new
      `MutationStatus` value). State survives restart via the existing supervision store + recovery.
- [ ] Make `work-runner` **skip `runFinalizer` entirely** on a parked run (the finalizer's shared
      tail removes the worktree — `work-run-finalizer.ts:219`); yield the terminal mutation event
      directly and leave the worktree live. Do NOT teach the finalizer about parking.
- [ ] Ensure the `mutations.ts` terminal supervision flip does not clobber the `blocked-on-human`
      record: parked terminal events carry explicit parked metadata; the mutation descriptor still
      persists as terminal, while the terminal branch preserves/reasserts supervision as
      `blocked-on-human` (Background §7).
- [ ] GC + `cleanupOrphanWorktrees`: **no code change** — confirm via regression test that a parked
      run's dir/branch/worktree already survive (Background §4, §5).
- [ ] Add the parked staleness nudge via a NET-NEW `planParkedNudges` predicate (over
      `blocked-on-human`, keyed on `PARKED_RUN_NUDGE_AFTER_MS`, default 24h) with its own
      `parkedNudgedAt` marker and an injected clock seam; reuse only the bus-publish + `upsertRun`
      delivery. Never auto-release because of age.

### Cap + alert

- [ ] Harden the per-project cap (`work-runner.ts` validate, ~`:238` post-project-14 — re-locate
      it) to reject when ANY of: an `activeRuns` run is `running` for the slug; a supervision
      `blocked-on-human` record exists for the slug; or `existsSync(worktreePathFor(...))` on the
      deterministic path (synchronous — no async `git worktree list`).
- [ ] Parked alert (Telegram + cockpit) carries `operatorWorktreePath`, `pendingCheck`, optional
      `command`, and optional `reason` from the sentinel payload; add a parked-aware branch to
      `formatWorkRunTerminal` (parked is not a `WorkOutcome`).

## Phase 1c — Release

> Depends on: Phase 1b.

### Tests (write first)

- [ ] Write shared release-runtime tests for clean release COLD-finalizing through the Project 15
      finalizer in **gated-merge** mode (baseSha recomputed via merge-base → classify → gated-merge;
      reuse `finalizeStaleRun`'s building blocks but assert the release path drives `gated-merge`
      mode, NOT `finalizeStaleRun`'s fresh-run hold default — a regression test that a clean
      branch-complete release actually merges, not just holds), dirty release without confirmation,
      dirty release with `{ confirmDirty: true }` as explicit discard, already-released/not-parked
      ids, and stale/missing worktree paths — test-plan.md §3.
- [ ] Write release hold tests proving a clean release keeps the supervision `blocked-on-human`
      record in place while the cold-finalizer mutation is running, and only frees the project slot
      after the finalizer terminal write; confirmed dirty discard frees only after destructive
      cleanup completes.
- [ ] Write HTTP route tests for `POST /api/work-runs/:id/release`, including dirty-confirm
      response shape, not-parked no-op response, and `202 { mutationId }` clean/confirmed release
      response.
- [ ] Write Telegram callback tests for `work-run-release:<id>` proving it delegates to the same
      release runtime and returns the same dirty-confirm/mutation-created/not-parked outcomes.
- [ ] Write existing-inbox-row tests proving `blocked-on-human` Approve/Release routes to release
      preflight, Reject/dismiss leaves the parked run untouched with a dismissed/no-op response, and
      dirty confirmation requires the explicit release endpoint/callback with `confirmDirty=true`.
- [ ] Write mutation tests proving `work-run-release` is a registered auto-approved mutation kind,
      carries payload `{ runId, confirmDirty }`, rechecks parked/dirty state in the applier, invokes
      the Project 15 finalizer on clean release, and emits terminal events.
- [ ] Write post-release cap tests proving a clean release keeps the project slot held while the
      Project 15 finalizer is in progress, then follows the finalizer outcome; a discard release
      frees the project slot only after the destructive cleanup completes.
- [ ] Confirm red before implementation.

### Release action

- [ ] Make the EXISTING `blocked-on-human` cockpit inbox row actionable for a parked run
      (`approval-actions.ts` `blocked-on-human` case returns `not-found` today, ~`:152`), routing to
      the shared release runtime — not a new surface (consistent with the "no new cockpit screen"
      non-goal). Approve/Release runs release preflight; Reject/dismiss leaves the parked run
      untouched with a clear dismissed/no-op response. Available from both Telegram and the cockpit.
- [ ] Add `work-run-release` to `MutationKind` and register an auto-approved applier with payload
      `{ runId: string, confirmDirty?: boolean }`.
- [ ] Implement shared release preflight used by both surfaces: not-parked returns a no-op outcome,
      dirty-without-confirmation returns dirty-confirm with the `git status --porcelain` file list,
      clean release creates a cold-finalize `work-run-release` mutation, and confirmed dirty
      release creates an explicit-discard `work-run-release` mutation.
- [ ] Add cockpit route `POST /api/work-runs/:id/release` with optional body
      `{ "confirmDirty": true }`; return `409 { "error": "dirty-worktree", "files": [...] }` for
      dirty-confirm without creating a mutation, `200` for not-parked no-op, and
      `202 { "mutationId": "..." }` when a release mutation is created.
- [ ] Add Telegram callback action `work-run-release:<id>` using the same shared runtime and dirty
      confirmation behavior.
- [ ] On release of a **clean** worktree: keep the supervision parked record and **cold-finalize**
      through the Project 15 finalizer in **gated-merge** mode (reuse `finalizeStaleRun`'s building
      blocks — recompute `baseSha` via merge-base → `computeWorkProduct` → classify → real
      gate/merge/push/delete effects — there is no live process/transcript/`baseSha` at release
      time; but invoke `runFinalizer` in `gated-merge` mode explicitly, since `finalizeStaleRun`
      defaults a fresh run to hold/no-merge). Keep the parked hold while finalization is in progress;
      the finalizer terminal write owns merge/hold/teardown, clearing the hold, and slot release.
- [ ] On release of a **dirty** worktree (`git status --porcelain` in the parked worktree is
      non-empty): warn with the dirty file list and require explicit confirm before the
      force-removing `destroyWorktree` (`sandbox-runtime.ts:333`); never discard a half-finished
      human fix silently. Confirmed dirty release is a discard path and must not gated-merge.
