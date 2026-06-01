# Work-Run Observability — Tasks

Not started. See [spec.md](spec.md) for architecture and [test-plan.md](test-plan.md) for verification.

> **Test-first by default.** Every phase opens with a **Tests (write first)** block. Those tests mirror the matching [test-plan.md](test-plan.md) sections and must fail (red) before any implementation task begins. A phase is done when its test-plan sections pass.
>
> Granularity here is the meaningful deliverable — per-task file layout and signatures are settled in `/work`'s Plan phase, against the spec.

## Phase 1 — Durable transcript stream

> Depends on: nothing.

### Tests (write first)

- [x] Write the suite for the stream-json adapter, transcript persistence (backpressure + awaited `finish`), and redaction — test-plan.md §1.
- [x] Confirm red before implementation.

### Stream spawn + convert

- [x] Spawn the child with `--output-format stream-json --verbose` and consume JSON envelopes.
- [x] Build a stream-json-to-display adapter that emits the existing human-readable `output` MutationEvents (drawer back-compat).

### Durable sink

- [x] Per-run `WriteStream` to `logs/work-runs/<id>/transcript.jsonl` with backpressure handling, independent of drawer state; await `finish` on terminate.
- [x] Maintain a bounded last-N stdout ring buffer and stderr tail on the run record.
- [x] Best-effort secret/token redaction on persisted events.

## Phase 2 — Terminal classification + run store

> Depends on: Phase 1.

### Tests (write first)

- [x] Write the pure `classifyOutcome(facts)` fixture suite (rules 3-7), the exit-fact handoff test, the `baseSha` diff-base test, the crash-mid-forensics test (one terminal event still fires), the outcome-survives-persistence test, and the atomic `summary.json` + torn-line `index.jsonl` tests — test-plan.md §2.
- [x] Confirm red before implementation.

### Baseline + exit facts

- [x] Thread `baseSha` into `createWorktree` (`git worktree add -b <branch> <path> <baseSha>`); capture the in-memory `tasks.md` baseline at spawn.
- [x] Refactor `streamProcess` to return exit facts (exitCode, signal, durationMs, ring buffer, stderr tail) instead of yielding the terminal event.

### Work-product + classifier

- [x] Compute work product through an injected `GitRunner` (commits/diffstat/shas/files on `baseSha..branch`, tree state); parse `tasks.md` into records and compute transitions.
- [x] Implement the pure `classifyOutcome(facts)` returning `branch-complete | partial | noop | dirty-uncommitted | failed` + reason.
- [x] Wrap classify+forensics in a try/catch that always emits exactly one terminal outcome-bearing event (`classification-error` -> `failed`).

### Persist

- [x] Flush transcript + atomically (temp-then-rename) write `summary.json` before the terminal event.
- [x] Add `outcome` + `workProduct` to `MutationDescriptor`; copy them in `startApply`'s terminal write before `appendMutationLine`.
- [x] Make `telegram-sender` / `app.js` / `mutations-log` outcome-aware; append a torn-line-tolerant row to `logs/work-runs/index.jsonl`.

## Phase 3 — Branch & forensic retention

> Depends on: Phase 2.

### Tests (write first)

- [x] Write the suite for forensics export contents, unconditional worktree destroy, and GC (single-pass, protected set, branch-in-worktree skip, idempotency) — test-plan.md §3.
- [x] Confirm red before implementation.

### Forensics + GC

- [x] Export `bundle.git`, `diffstat.txt`, `status.txt`, `diff.patch`, staged diff, and (non-clean) `untracked.tar` to `logs/work-runs/<id>/` before the terminal event.
- [x] Always destroy the deterministic worktree in `finally` after export.
- [x] GC as a single synchronous pass by count and bytes (transcripts, forensics, branch refs) with a protected set from `activeRuns` + run-store + `git worktree list` (reuse the `cleanupOrphanWorktrees` parse); never delete a checked-out branch; run on startup and completion.

## Phase 4 — Alerts

> Depends on: Phase 2.

### Tests (write first)

- [x] Write the suite for each alert trigger and payload, the noop-never-reads-as-success rendering, the commit-poll progress throttle, and the quiet-run predicate (distinct from `isStalled`, fields round-trip through `isSupervisedRun`) — test-plan.md §4.
- [x] Confirm red before implementation.

### Triggers

- [x] failure / noop / dirty-uncommitted / partial / branch-complete alerts carrying reason + outcome summary; specialized work-run rendering. (Delivered in Phase 2 §"Persist": `formatWorkRunTerminal` in `telegram-sender.ts` + outcome-aware cockpit `renderRecentMutations`; covered by `telegram-sender.test.ts`.)
- [x] Parent-side commit poll (last-seen SHA) driving throttled progress pings; never one per task.
- [x] Quiet-run nudge via a distinct `lastOutputAt`/`quietNudgedAt` predicate alongside `isStalled`; add both fields to `SupervisedRun` and `isSupervisedRun`.
- [x] Replace the bare finished-in-Ns message everywhere.

## Phase 5 — Cockpit UX

> Depends on: Phases 1 and 2.

### Tests (write first)

- [x] Write the suite for the cockpit projection fields, the authenticated transcript route (path containment, traversal rejection), and the card states — test-plan.md §5.
- [x] Confirm red before implementation.

### Data path + card

- [x] Add the work-run projection to `buildCockpitView` from the new store (id, last-N output, elapsed, outcome, reason, transcript URL).
- [x] Add an authenticated `GET /api/work-runs/:id` (+ `/transcript`) route with path containment and content-type handling.
- [x] Card shows live last-N output + elapsed; outcome + reason on termination in place of a stale `running` pill; transcript link.

## Phase 6 — Validation & diagnosis

> Depends on: Phases 1-5.

### Tests (write first)

- [x] Write an end-to-end assertion that a deliberately empty run classifies `noop` and emits the no-op alert — test-plan.md §6.
- [x] Confirm red before implementation. _(N/A — validation phase: the asserted behavior shipped in Phases 2+4, so the §6 e2e is green-on-arrival rather than red-then-green; see the test file header.)_

### Watched run

- [ ] Re-run a real project under instrumentation in a watched (not fire-and-forget) run. _(Genuinely pending — not done despite an earlier bulk "mark complete". The only run so far (`7b8410fb`) was fire-and-forget and noop'd. Now unblocked: the permission-gate fix landed in `b3ce3b3` (`docs/projects/bugs.md`) and live-panel fixes #1/#2 shipped, so a watched run can finally land commits and be observed end to end.)_
- [~] Confirm the taxonomy fires correctly across at least one real and one empty run. _(Empty half validated: run `7b8410fb` classified `noop` correctly with full transcript + forensics. Real/productive half pending the watched run above — unblocked as of `b3ce3b3`.)_
- [x] Write up the original silent-failure root cause; file the `/work` fix follow-on if a structural mismatch is confirmed. → [phase-6-diagnosis.md](phase-6-diagnosis.md). Confirmed structural: the `--auto` permission gate refuses all mutations (`Edit`/`git`/`npm`/`vitest`), so runs exit clean with no work product. `/work` fix filed in `docs/projects/bugs.md`.

## Phase 6 follow-on — live-path observability fixes

> Surfaced by the 2026-06-01 validation run. See [phase-6-diagnosis.md](phase-6-diagnosis.md).
> Test-first: each fix opens with a failing test before implementation.

### Fix #1 — surface error tool_results in the live display

- [x] Write a failing test: a `user`/`tool_result` envelope with `is_error: true` renders a readable line (not `null`) through `streamJsonToDisplay`.
- [x] Extend `streamJsonToDisplay` (`src/jobs/work-run-transcript.ts:154`) to convert `is_error` tool_results into a readable line (e.g. `⨯ blocked: <tool>` / the error text), instead of dropping all `user` frames at the `default` branch. Path-scrub like the other cases.
- [x] Confirm the block now appears in the drawer, card `lastOutput`, and the transcript-tail projection.

### Fix #2 — show active in-flight runs on the cockpit card

- [x] Write a failing test: an active run (present in the supervision store, absent from `index.jsonl`) appears in the cockpit projection with live `lastOutput` + elapsed.
- [x] Merge active runs from the in-memory supervision store (`activeRuns` / `SupervisedRun` ring buffer + `startedAt`) into `readWorkRunProjections` / `buildCockpitView`, layered over the terminal index rows (terminal row wins once the run ends). Satisfies spec req 24.
- [x] Confirm a live run renders last-N output + elapsed on the card without opening the drawer, then transitions to the outcome verdict on termination.
