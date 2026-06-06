# Work-Run Monitoring (Phase 1) Test Plan

Error handling checklist for surfacing work-run worktree paths and the parked-worktree lifecycle.

This project is **test-first**: each numbered section below is written by a phase's
**Tests (write first)** task in [tasks.md](tasks.md), and those tests must fail (red) before that
phase's implementation tasks begin. A phase's implementation is done when its test-plan sections pass.

Required verification is automated and fixture-driven. Use temp product repos/worktrees, injected
work-run NDJSON streams, fake sender/HTTP/callback surfaces, test-scoped stores, and injected clocks.
Do not require a real Telegram chat, a production cockpit click, a real Jarvis process restart, or a
human manually inspecting a worktree. Live smoke testing is optional after these checks pass.

> See also: [Cross-cutting test plan](../../tech/test-plan.md) for shared guidelines, monitoring, and security checks.

## Priority Levels

- 🔴 **Critical**: Blocks user progress, requires immediate attention
- 🟡 **High**: Degrades experience significantly, should be handled gracefully
- 🟢 **Low**: Non-blocking, can fail silently with logging

## 1. Path surfacing (Phase 1a)

### Start notification

- [ ] 🔴 A run-start notification includes the deterministic worktree path on
      `operatorWorktreePath` (`<WORKTREE_ROOT>/<product>/<project>`) and includes the run id.
- [ ] 🔴 `operatorWorktreePath` is **un-scrubbed** (usable as a `cd` target) — the
      `WORKTREE_ROOT`/`PROJECT_ROOT` prefix is NOT stripped on this local-operator-only field.

### Leak containment

- [ ] 🔴 With a fake absolute worktree prefix, the un-scrubbed path never appears in
      `mutations.jsonl`, work-run summaries/indexes, transcripts, forensics payloads, or any
      committed/remote artifact candidate — those paths stay scrubbed (`tool-labels.ts:32`).
- [ ] 🟡 A run with no worktree (create failed before a path existed) omits the path field cleanly
      rather than emitting an empty/partial path.

## 2. Parked state (Phase 1b)

### Sentinel parsing

- [ ] 🔴 A final `JARVIS_WORK_RUN_SENTINEL { … }` line in the result envelope is parsed from the
      raw envelope, before display scrubbing, and triggers the parked path.
- [ ] 🔴 Valid sentinel schema is enforced: `version: 1`, non-empty `pendingCheck`, optional
      `command`, and optional `reason`.
- [ ] 🟡 A malformed sentinel (bad JSON, unsupported `version`, missing/empty `pendingCheck`, or
      wrong field types) does NOT park — the run falls through to an ordinary terminal outcome,
      logged, no crash.
- [ ] 🟢 The sentinel line is not rendered as agent output to the operator (consumed, not echoed).

### Durable state + restart

- [ ] 🔴 A parked run records a durable supervision `blocked-on-human` state; the mutation itself
      reaches a normal terminal status (no invented `MutationStatus` value).
- [ ] 🔴 The mutation terminal path does not overwrite parked supervision with `completed` or
      `failed`; the supervised run remains `blocked-on-human` until release.
- [ ] 🔴 The parked state and its worktree survive a Jarvis restart (supervision recovery preserves
      `blocked-on-human`; startup behavior is tested by invoking recovery/cleanup against test
      stores and temp repos, not by manually restarting Jarvis).

### Lifecycle carve-outs

- [ ] 🔴 `work-runner` teardown does NOT `destroyWorktree` while parked.
- [ ] 🔴 GC does not reap a parked run's dir or branch, and `cleanupOrphanWorktrees` does not remove
      its live registered worktree in the temp repo fixture.

### Cap

- [ ] 🔴 A second dispatch for a slug with a parked run is rejected by the per-project cap.
- [ ] 🔴 A dispatch for a slug whose worktree is registered on disk but whose parked state was lost
      to a crash (recovery left it `unknown`) is still rejected by the registered-worktree backstop —
      `createWorktree` is never reached on an occupied path.
- [ ] 🟡 The parked alert carries `operatorWorktreePath`, `pendingCheck`, optional `command`, and
      optional `reason` from the sentinel payload.

## 3. Release (Phase 1c)

### Clean release

- [ ] 🔴 Releasing a parked run with a clean worktree destroys the worktree, clears the supervision
      parked record, and frees the per-project slot (a subsequent dispatch for the slug is accepted).
- [ ] 🔴 The release action is reachable from both Telegram and the cockpit, routed through the
      mutation pipeline and one shared release runtime.
- [ ] 🔴 `POST /api/work-runs/:id/release` delegates to the shared release runtime and returns the
      mutation-created/not-parked/dirty-confirm outcomes without exposing unrelated absolute paths.
- [ ] 🔴 Telegram callback `work-run-release:<id>` delegates to the same shared runtime and returns
      the same mutation-created/not-parked/dirty-confirm outcomes.
- [ ] 🔴 A clean or confirmed release request returns `202 { "mutationId": "..." }`; final release
      success/failure is reported by the release mutation terminal event.
- [ ] 🔴 `work-run-release` is registered as an auto-approved mutation kind with payload
      `{ runId, confirmDirty }`; its applier rechecks parked/dirty state before teardown and emits
      terminal mutation events.

### Dirty release

- [ ] 🔴 Releasing a parked run with a **dirty** worktree warns with the dirty file list and does
      NOT destroy the worktree without an explicit confirm — a human fix is never force-removed
      silently (`destroyWorktree` is `--force`, `sandbox-runtime.ts:333`).
- [ ] 🔴 Dirty state is detected with `git status --porcelain` in the parked worktree.
- [ ] 🔴 Dirty release without confirmation returns `409 { "error": "dirty-worktree", "files": [...] }`
      from the cockpit route and creates no mutation.
- [ ] 🟡 After explicit `{ "confirmDirty": true }`, the dirty worktree is destroyed and the slot
      frees.

### Misuse / races

- [ ] 🟡 Releasing an already-released (or never-parked) run is a clean no-op with a clear message,
      not an error that destroys an unrelated worktree.
- [ ] 🟢 A parked run left unreleased is surfaced in the cockpit; an injected-clock test advances
      past `PARKED_RUN_NUDGE_AFTER_MS` (default 24 hours) and asserts a staleness nudge fires rather
      than auto-releasing.

## 4. Regression

- [ ] 🔴 A run that never emits a sentinel behaves exactly as today: ordinary terminal outcome,
      worktree destroyed at teardown, branch retained per existing GC. No behavior change on the
      non-parked path.
