# Work-Run Observability Specification

## Overview

Every `/work --auto` run today spawns `claude -p <prompt>` in a throwaway worktree, streams raw stdout to the cockpit drawer only while it is open, and calls the run `completed` whenever `exitCode === 0`. On 2026-05-30 two runs on project 10 (`7828477a`, `3b002b26`) exited clean, produced zero commits and zero checked tasks, and were reported `completed` (`finished in 1188.4s`) in both Telegram and the cockpit. Nothing in the trail let us diagnose why.

This project makes a work run observable, verifiable, and reconstructable end to end. It classifies the terminal state on the actual work product, persists the full event stream to a durable per-run file, retains the run branch and uncommitted evidence for inspection, surfaces live progress and truthful outcomes on the cockpit card, and alerts on the moments that matter. It does not change how `/work` itself executes.

### Core Value Proposition

A work run can no longer report success while doing nothing, and any run can be reconstructed after the fact from a persisted transcript and retained forensics.

### Goals

1. **Primary:** Classify the terminal state on work product (commits + `tasks.md` delta + working-tree state), not exit code, with a distinct no-op state that would have caught both silent runs.
2. **Primary:** Persist the full turn-by-turn event stream durably to `logs/work-runs/<id>/transcript.jsonl` regardless of whether a cockpit drawer is open.
3. **Secondary:** Surface live output, elapsed time, and truthful outcomes on the cockpit card; link each card to its transcript.
4. **Secondary:** Alert on failure, no-op, uncommitted-work, branch completion, and stall, carrying an outcome summary.
5. **Tertiary:** Use the new instrumentation to diagnose the original silent-failure root cause and file any `/work` fix as a follow-on.

### Non-Goals

- Changing how `/work` executes or what it emits (one-shot `claude -p`, multi-turn drivers, resume mechanics, output markers). If the trail confirms a structural mismatch, the fix is a separate spec.
- Pause detection. A self-paused run classifies as `partial`; no attempt to distinguish a deliberate breakpoint.
- Phase / current-step display. The CLI emits no phase concept; the card shows live output and elapsed only.
- Per-task-completion alerts. Progress pings are commit-driven.
- A restart-server button. Deferred — it cannot load code sitting on a run branch, and `tsx watch` covers the live checkout.
- Auto-resuming a run, or merging/landing the run branch.
- Retaining live worktrees (they would wedge the single-occupant worktree path).

---

## User Journey

### Happy Path

```
start run -> live output + elapsed on card -> classify on work product -> outcome on card + Telegram -> transcript + forensics retained
```

1. **Start** — User clicks Work on a project card (or it is dispatched). The card shows a `running` pill, elapsed time, and the last N lines of agent output without opening the drawer.
2. **Mid-run** — A parent-side poll of the run branch detects new commits and fires a throttled progress ping (commit subject + running task tally). If the run produces no output for 5 minutes, the existing stall-check sends a quiet-run nudge.
3. **Terminal** — On exit, the run is classified `branch-complete`, `partial`, `noop`, `dirty-uncommitted`, or `failed`. The transcript is flushed, `summary.json` and forensics are written, then a single terminal event fires. The card shows the verdict and reason; Telegram carries the outcome summary (commits, tasks X/Y). The transcript link and, for non-clean runs, retained forensics are available.

### Entry Points

- Cockpit project card Work button; existing mutation dispatch paths.

### Exit Points

- Cockpit card outcome state with transcript link; Telegram outcome message; retained forensics under `logs/work-runs/<id>/`.

---

## Requirements

### Terminal classification

1. WHEN the worktree is created THEN `createWorktree` branches explicitly from a captured base — `git worktree add -b <branch> <path> <baseSha>` — and persists `baseSha` and the parsed `tasks.md` baseline on the run record. Capture and use of `baseSha` are atomic so a moving `HEAD` cannot change the diff base.
2. WHEN a run exits THEN, inside `apply()` before any teardown, compute commits on `baseSha..<run-branch>`, diffstat, commit shas, files changed, the `tasks.md` task transitions (see Outcome computation), and the working-tree state (`git status --porcelain`, staged diff, untracked manifest).
3. WHEN exit code is 0 AND commits are present AND no original tasks remain unchecked THEN classify outcome `branch-complete`.
4. WHEN exit code is 0 AND commits are present AND unchecked tasks remain THEN classify outcome `partial`.
5. WHEN exit code is 0 AND there are zero commits AND zero task transitions AND the tree is clean THEN classify outcome `noop`.
6. WHEN exit code is 0 AND there are zero commits BUT the tree is dirty or has untracked files THEN classify outcome `dirty-uncommitted`.
7. WHEN exit is non-zero or signal-killed THEN classify outcome `failed` with a reason string (cancelled / killed / exited with code N).
8. WHEN classification finishes THEN the transcript is flushed, `summary.json` and forensics are written, and only then does `apply()` emit exactly one terminal MutationEvent (`completed` for `branch-complete`/`partial`/`noop`, `failed` otherwise), carrying the typed `outcome` field and work-product facts. The entire classify+forensics block is wrapped in `apply()`'s own try/catch: if it throws, forensics are exported best-effort and a single terminal `failed` event with `outcome: 'failed'` and reason `classification-error` is emitted BEFORE returning, so the error never reaches `startApply`'s generic catch (which would persist no outcome) and the worktree-destroying `finally` runs only after evidence is captured. Mutation `status` stays within the existing enum.
9. WHEN any run terminates THEN record exitCode, signal, durationMs, baseSha, commitCount, commitShas, filesChanged, tasksNewlyChecked, tasksRemaining, tasksAdded, tasksRemoved, dirty flag, diffstat, outcome, and reason on the run store. The typed `outcome` and a `workProduct` facts blob are added to `MutationDescriptor`, and `startApply`'s terminal branch copies `event.data.outcome`/facts onto the descriptor before `appendMutationLine` — otherwise the classification is dropped on persist and never reaches `mutations.jsonl`, the cockpit, Telegram, the index, or GC.

### Durable transcript

10. WHEN the child is spawned THEN pass `--output-format stream-json --verbose` so every assistant turn and tool call lands on stdout.
11. WHEN any stream event arrives THEN append it via a per-run `WriteStream` (with backpressure handling) to `logs/work-runs/<id>/transcript.jsonl`, independent of cockpit drawer state.
12. WHEN stream events are written THEN a stream-json-to-display adapter converts them to the existing human-readable `output` MutationEvents (`data.line` plain text) so the cockpit drawer renders readable lines, not raw JSON.
13. WHEN a run terminates THEN flush and await the transcript stream's `finish` before writing `summary.json` and before the terminal event.
14. WHEN a run terminates THEN record the last N stdout lines and the stderr tail on the run record for quick triage.
15. WHEN a run terminates THEN append a summary row (id, project, outcome, duration, started, ended) to `logs/work-runs/index.jsonl`.

### Retention & GC

16. WHEN a run terminates THEN, inside `apply()` before the terminal event, export forensics to `logs/work-runs/<id>/`: `bundle.git` (the run branch), `diffstat.txt`, `status.txt`, `diff.patch`, the staged diff, and a tarball of untracked files for non-clean outcomes.
17. WHEN forensics are exported THEN the deterministic worktree is always destroyed in the generator `finally` so its single-occupant path frees up for the next run.
18. WHEN GC runs (on startup and on each run completion) THEN it prunes transcripts, forensics, and local run-branch refs by both count and total bytes, after excluding a protected set built from `activeRuns`, non-terminal run-store statuses, and `git worktree list --porcelain`. It runs as a single synchronous pass with no `await` between reading the protected set and performing deletes (so two concurrent completions cannot interleave a read-modify-delete, per the same-tick discipline noted in `supervision-store.ts:12`), reuses the worktree-list parse from `cleanupOrphanWorktrees` (`sandbox-runtime.ts:356`), never deletes a branch any worktree has checked out, and prunes only terminal runs.

### Alerts

19. WHEN a run is `failed`, `noop`, or `dirty-uncommitted` THEN send a Telegram alert with the reason and outcome summary (commits, tasks), not `finished in Ns`. Work-run rendering is specialized so a `completed` status with a `noop`/`dirty-uncommitted` outcome never reads as success.
20. WHEN a run is `branch-complete` THEN send a Telegram alert noting all tasks checked on the branch (not yet landed on main).
21. WHEN a run is `partial` THEN send a Telegram outcome summary (commits, tasks X/Y) so the user knows where it stands.
22. WHEN the parent-side poll of the run branch detects a new commit THEN send a throttled progress ping with the commit subject and running task tally; never one per task. The poll tracks the last-seen commit SHA on the run branch.
23. WHEN a run produces no `output` events for 5 minutes (tracked via a distinct `lastOutputAt`, independent of the keep-alive's `lastChildAliveAt`) THEN the `stall-check` path sends a quiet-run nudge, at most once per run (`quietNudgedAt`), evaluated separately from a child-dead stall.

### Cockpit

24. WHEN a run is active THEN the card shows the last N lines of output and elapsed time without opening the drawer.
25. WHEN a run terminates THEN the card shows the outcome and reason in place of a stale `running` pill.
26. WHEN a run has a transcript THEN the card links to it via an authenticated route.

---

## Technical Implementation

### Where it hooks

- `src/jobs/sandbox-runtime.ts` — `createWorktree` takes a `baseSha`/`startPoint` argument and runs `git worktree add -b <branch> <path> <baseSha>`. The caller captures `git rev-parse HEAD` and passes it in, so capture and branch-point are one operation. The diff base is `baseSha..branch` (the branch is cut from `HEAD`, not necessarily `main`).
- `src/jobs/work-runner.ts` — `streamProcess` (`:207`) is refactored to **return exit facts** (exitCode, signal, durationMs, last-N ring buffer, stderr tail) instead of yielding the terminal event. A parent-side commit poll runs during the stream (interval against the run branch, tracking the last-seen SHA) and emits throttled `progress` events. After the stream ends, `apply()` computes work product, flushes the transcript, writes `summary.json`, exports forensics, then emits the single terminal event. Only `destroyWorktree` remains in the outer `finally` (`:185`). This ordering is required because `startApply` publishes/persists and returns the moment it sees a terminal event (`mutations.ts:298`) — files must exist first.
- Spawn (`:165`) gains `--output-format stream-json --verbose`. A new stream-json-to-display adapter (the parser in `claude.ts:176` is private and only accumulates final text) converts JSON envelopes (`assistant` / `tool_use` / `result`) into human-readable `output` MutationEvents, and tees raw events to the per-run transcript stream.
- `src/intent/supervision.ts` / `src/jobs/stall-check.ts` / `stall-check-runner.ts` — `isStalled` prefers `lastChildAliveAt` (`supervision.ts:89`, kept fresh by the 30s keep-alive at `work-runner.ts:243`), so a stdout-quiet-but-alive run is never `stalled` and the existing path never fires. `lastOutputAt` (set on each `output` event) and `quietNudgedAt` are added to `SupervisedRun` AND to its `isSupervisedRun` type guard (`supervision-store.ts:87`) or they are dropped on read. `checkStalledRuns` (`stall-check.ts:54`) gains a distinct quiet-run predicate (running AND `now - lastOutputAt > 5min` AND not yet `quietNudgedAt`) evaluated ALONGSIDE `isStalled`, not folded into it; the nudge reuses the existing Telegram path.
- Consumers of `outcome`: `src/transport/telegram-sender.ts` (generic formatter says "finished" for any completed mutation — `:67`), `src/server/static/app.js` (renders only `status` — `:1079`), and `src/jobs/mutations-log.ts` (persists only the descriptor — `:13`) are each made outcome-aware for work-run records.
- Alerts go through the existing NotificationBus / MessageSender used by cron jobs.

### Run store & outcome model

- Mutation `status` stays within the fixed enum `pending | approved | running | completed | failed | rejected` (`mutations.ts:78`). A separate typed `outcome` field — `branch-complete | partial | noop | dirty-uncommitted | failed` — is added to `MutationDescriptor` (`mutations.ts:80`) alongside a `workProduct` facts blob; `startApply`'s terminal write (`mutations.ts:298`, which today copies only `status`/`error`) copies them off the terminal event onto the descriptor before `appendMutationLine`. So the verdict reaches every existing view, no status consumer breaks, and none mistakes a noop for success.
- A per-run record (extending the `supervised-runs.json` / mutation lifecycle) holds the outcome facts from requirement 9 plus `transcriptPath` and `forensicsPath`. `logs/work-runs/index.jsonl` is the rolling recent-runs index.
- **Persistence atomicity:** `summary.json` is written temp-then-rename (mirroring `writeAllRuns` in `supervision-store.ts`); `index.jsonl` is appended and its readers tolerate a torn trailing line (the skip-malformed pattern in `readRecentMutations`, `mutations-log.ts:32`).

### Test seams

- All work-product git (`rev-list`, `diff --stat`, `status --porcelain`, `bundle`, tarball) runs through an injected `GitRunner` (the same seam `createWorktree`/`destroyWorktree` already take in `sandbox-runtime.ts`), not a direct `spawn` in `apply()`, so it is unit-testable without real worktrees.
- `classifyOutcome(facts)` is a pure function over parsed git/task outputs, so classification rules 3-7 are testable on fixtures with no git at all.

### Outcome computation

- Inside the worktree before teardown: `git rev-list --count baseSha..<branch>`, `git diff --stat baseSha..<branch>`, `git rev-list baseSha..<branch>` for shas, `git status --porcelain`, `git diff` / `git diff --staged`, and an untracked-file listing.
- `tasks.md` delta: the baseline is the in-memory `tasksContent` string already read at spawn (`work-runner.ts:147`), NOT a post-run re-read of the file (which would be the mutated version). Parse both the baseline and the final file into task records `{indent, marker, normalizedText, checked}` (markers normalized so `[x]`/`[X]` are equal). Compute transitions on the original task set (unchecked->checked), and separately report tasks added and removed. Classification keys on original-task transitions and `tasksRemaining`, not a raw checkbox count, so a deleted or rewritten task is not mistaken for progress.

### Transcript & forensics layout

```
logs/work-runs/<id>/
  transcript.jsonl   # full stream-json event log (per-run WriteStream)
  summary.json       # outcome facts (written after transcript finish, before terminal event)
  bundle.git         # git bundle of the run branch
  diffstat.txt
  status.txt         # git status --porcelain
  diff.patch         # working + staged diff
  untracked.tar      # non-clean runs only
```

### Security

- Transcripts and forensics are gitignored, size-capped, and run through best-effort secret/token redaction before any web exposure. Primary protection is gitignore + the authenticated route + no external exposure; redaction is a second layer, not a guarantee.

### Cockpit data path

- `buildCockpitView` / `/api/cockpit` (`webview.ts:197`) gains a work-run projection sourced from the new work-run store (not just `SupervisedRun`). The existing `readCockpitRunStatus` / `cockpit-run-status.ts` mapper (`:37`) drops run id, output, and outcome; the projection adds mutation id, last-N output, elapsed, outcome, reason, and the transcript URL.
- A new authenticated route `GET /api/work-runs/:id` (and `/transcript`) serves run records and the transcript with path containment and correct content-type. Static serving is `/static/*`-only, so a bare file link won't work.

### Platform

Node.js server (TypeScript). Cockpit is the existing vanilla HTML/JS frontend (`src/server/static/app.js`); card changes extend the current `mutation` rendering, alerts reuse the notification bus. No new framework.

---

## Implementation Phases

> Full breakdown in tasks.md and test-plan.md; built test-first.

### Phase 1: Durable transcript stream

- stream-json --verbose spawn; stream-json-to-display adapter emitting readable `output` events; per-run `WriteStream` to `logs/work-runs/<id>/transcript.jsonl` with backpressure and awaited `finish`; last-N ring buffer + stderr tail; best-effort redaction.

### Phase 2: Terminal classification + run store

> Depends on: Phase 1

- Thread `baseSha` into `createWorktree` and capture the in-memory `tasks.md` baseline at spawn; refactor `streamProcess` to return exit facts; compute work product through an injected `GitRunner` and a pure `classifyOutcome(facts)` function; wrap classify+forensics in a try/catch that always emits one terminal outcome-bearing event; flush transcript + atomically write `summary.json` before that event; add `outcome`/`workProduct` to `MutationDescriptor` and copy them in `startApply`'s terminal write; make Telegram / cockpit / `mutations.jsonl` outcome-aware; append to `index.jsonl`.

### Phase 3: Branch & forensic retention

> Depends on: Phase 2

- Export `bundle.git` + diffstat + status + diff + staged diff + untracked tarball inside `apply()` before the terminal event; destroy the deterministic worktree in `finally`; GC by count and bytes (transcripts, forensics, branch refs) as a single synchronous pass with an active-run protected set (`activeRuns` + run-store + `git worktree list`), on startup and on completion.

### Phase 4: Alerts

> Depends on: Phase 2

- failure / noop / dirty-uncommitted / partial / branch-complete alerts with outcome summary and specialized work-run rendering; parent-side commit poll driving throttled progress pings; quiet-run nudge as a distinct predicate (`lastOutputAt`/`quietNudgedAt`, added to `SupervisedRun` + its type guard) alongside `isStalled` on the existing `stall-check` path; "finished in Ns" replaced everywhere.

### Phase 5: Cockpit UX

> Depends on: Phases 1 and 2

- Work-run projection in `buildCockpitView` from the new store; authenticated `GET /api/work-runs/:id` (+ `/transcript`) route with path containment; card shows live last-N output + elapsed, outcome + reason on termination, and a transcript link.

### Phase 6: Validation & diagnosis

> Depends on: Phases 1-5

- Re-run a real project under instrumentation in a watched run; assert a deliberately empty run classifies `noop`; write up the original silent-failure root cause; file the `/work` fix follow-on if a structural mismatch is confirmed.

---

## Success Metrics

| Metric | Target | How Measured |
| ------ | ------ | ------------ |
| Silent no-op runs reported as completed | 0 | `noop` classification on the index |
| Runs reconstructable from a persisted transcript | 100% | `logs/work-runs/<id>/transcript.jsonl` present per run |
| Non-clean runs with retained forensics | 100% | bundle + status/diff present for failed/noop/dirty/partial |
| Truthful terminal alerts | 100% | alert carries outcome summary, not bare duration |

---

## Edge Cases & Error Handling

### Classification

- Classify+forensics throws midway -> `apply()`'s try/catch exports forensics best-effort, emits one terminal `failed` event with `outcome: 'failed'` and reason `classification-error`, and only then returns so the `finally` destroys the worktree; the error never propagates to `startApply`'s generic catch (which would persist no outcome and leave the run without a terminal event).
- Worktree gone or a git command fails before classification -> record `failed` with reason `classification-error`, keep the transcript.
- Run cancelled by user -> `failed` with reason `cancelled`, no no-op alert.
- `tasks.md` absent -> task transitions are 0; classification falls back to commit count + tree state.
- Task rewritten/deleted rather than checked -> counted as added/removed, not progress; does not flip a run to `branch-complete`.

### Persistence

- Transcript write backpressure -> respect the `WriteStream` drain; never drop events silently.
- Transcript write fails -> record on the stderr tail, do not crash the run; the run still classifies.
- Crash mid-persist -> `summary.json` is temp-then-rename (never half-written); `index.jsonl` readers skip a torn trailing line.
- GC cap reached -> prune oldest terminal runs by count/bytes, never the protected set, before exporting the new run's forensics.

### Concurrency

- Concurrent runs (global cap > 1) -> GC protected set keeps each active run's transcript dir and branch; `baseSha` is per-run.
- `HEAD` moves during dispatch -> `baseSha` is fixed at branch creation, so the diff base is stable.

### Alerts

- Notification bus unavailable -> outcome still persisted; alert retried/queued, never blocks teardown.
- Quiet-run nudge fires at most once per run.

### Security

- Transcripts/forensics gitignored and size-capped; best-effort secret redaction before web exposure; the authenticated route enforces path containment.

---

## Open Questions

- [ ] Retention cap N (count and byte ceiling) for transcripts/forensics/branches — start at 3 runs and tune after use.
- [ ] Commit-poll interval (responsiveness vs. git overhead) — start at 10s and tune.
