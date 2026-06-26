# Work-Run Monitoring (Phase 1) Test Plan

Error handling checklist for surfacing work-run worktree paths and the parked-worktree lifecycle.
Project 15 owns normal terminalization and gated merge; this project verifies that parked runs hold
that finalizer until release and that clean release cold-finalizes through it in gated-merge mode.

This project is **test-first**: each numbered section below is written by a phase's
**Tests (write first)** task in [tasks.md](tasks.md), and those tests must fail (red) before that
phase's implementation tasks begin. A phase's implementation is done when its test-plan sections pass.

Required verification is automated and fixture-driven. Use temp product repos/worktrees, injected
work-run NDJSON streams, fake sender/HTTP/callback surfaces, test-scoped stores, and injected clocks.
Do not require a real Telegram chat, a production cockpit click, a real Rune process restart, or a
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

- [ ] 🔴 A final `RUNE_WORK_RUN_SENTINEL { … }` line in the result envelope is parsed from the
      raw envelope, before display scrubbing, and triggers the parked path.
- [ ] 🔴 Valid sentinel schema is enforced: `version: 1`, non-empty `pendingCheck`, optional
      `command`, and optional `reason`.
- [ ] 🟡 A malformed sentinel (bad JSON, unsupported `version`, missing/empty `pendingCheck`, or
      wrong field types) does NOT park — the run falls through to an ordinary terminal outcome,
      logged, no crash.
- [ ] 🟢 The sentinel line is not rendered as agent output to the operator (consumed, not echoed).

### Durable state + restart

- [ ] 🔴 A parked run records a durable supervision `blocked-on-human` state **as the first effect
      (before any terminal/finalize step)**; the mutation itself reaches a normal terminal status
      (no invented `MutationStatus` value).
- [ ] 🔴 `work-runner` **skips `runFinalizer`** on a parked run (the finalizer's shared tail removes
      the worktree); the worktree is left live and the terminal mutation event is still yielded.
- [ ] 🔴 Neither terminal supervision writer clobbers parked: not the finalizer (it's skipped) and
      **not the `mutations.ts` pipeline terminal flip** — the supervised run remains
      `blocked-on-human` until release because the parked terminal event carries explicit metadata
      and the mutation terminal branch treats it as a supervision override (Background §7).
- [ ] 🔴 The parked state and its worktree survive a Rune restart (`recoverRun` and
      `recoverAndFinalizeStaleRuns` both leave `blocked-on-human` untouched; tested by invoking
      recovery/cleanup against test stores and temp repos, not by manually restarting Rune).
- [ ] 🟡 **Crash window:** a run that emitted the sentinel but whose parked record was lost (still
      `running` on disk) is finalized by `recoverAndFinalizeStaleRuns` as an ordinary recovered
      terminal (worktree removed, no park) — no crash. Documents the window the first-write ordering
      minimizes.

### Lifecycle carve-outs (verify-not-implement — existing behavior)

- [ ] 🔴 GC does not reap a parked run's dir (non-terminal `blocked-on-human` id is in the protected
      set) or its branch (checked out in the live worktree), and `cleanupOrphanWorktrees` does not
      remove its registered worktree — asserted against current code in the temp-repo fixture, no
      carve-out added.

### Scope (legacy-only)

- [ ] 🟡 An `orchestrated-work` run that blocks maps to mutation `failed` and destroys its worktree
      (NOT parked) — documents that parking is the legacy `work-run` applier's behavior only.

### Cap

- [ ] 🔴 A second dispatch for a slug with a parked run is rejected by the per-project cap.
- [ ] 🔴 A dispatch for a slug whose worktree exists on disk but whose parked state was lost to a
      crash (recovery left it `unknown`) is still rejected by the synchronous
      `existsSync(worktreePathFor(...))` backstop — `createWorktree` is never reached on an occupied
      path.
- [ ] 🟡 The parked alert carries `operatorWorktreePath`, `pendingCheck`, optional `command`, and
      optional `reason` from the sentinel payload; `formatWorkRunTerminal` renders a parked run via
      its parked-aware branch (not as its underlying `partial`/`noop` outcome).

## 3. Release (Phase 1c)

### Clean release

- [ ] 🔴 Releasing a parked run with a clean worktree keeps the supervision `blocked-on-human`
      hold while it **cold-finalizes** through the Project 15 finalizer in **gated-merge** mode — the
      release path recomputes `baseSha` via merge-base, classifies on the current work product, then
      runs the gated-merge (reusing `finalizeStaleRun`'s building blocks, since there is no live
      process/transcript/`baseSha` at release time); Project 13 does not directly destroy the clean
      worktree.
- [ ] 🔴 A clean, gate-passing branch-complete release actually MERGES (does not merely hold): the
      release path drives `runFinalizer` in `gated-merge` mode explicitly and does NOT inherit
      `finalizeStaleRun`'s fresh-run **hold** default (which would leave the branch unmerged with the
      worktree removed).
- [ ] 🔴 A clean release does not free the per-project slot while the cold finalizer is still
      running; the slot is released only by the finalizer terminal write (or by confirmed dirty
      discard after destructive cleanup).
- [ ] 🔴 The release action is reachable from both Telegram and the cockpit, routed through the
      mutation pipeline and one shared release runtime.
- [ ] 🔴 The existing `blocked-on-human` inbox row is the actionable surface: Approve/Release routes
      to release preflight, Reject/dismiss leaves the parked run untouched with a dismissed/no-op
      response, and dirty confirmation uses the explicit release endpoint/callback with
      `confirmDirty=true`.
- [ ] 🔴 `POST /api/work-runs/:id/release` delegates to the shared release runtime and returns the
      mutation-created/not-parked/dirty-confirm outcomes without exposing unrelated absolute paths.
- [ ] 🔴 Telegram callback `work-run-release:<id>` delegates to the same shared runtime and returns
      the same mutation-created/not-parked/dirty-confirm outcomes.
- [ ] 🔴 A clean or confirmed release request returns `202 { "mutationId": "..." }`; final release
      success/failure is reported by the release mutation terminal event.
- [ ] 🔴 `work-run-release` is registered as an auto-approved mutation kind with payload
      `{ runId, confirmDirty }`; its applier rechecks parked/dirty state, invokes the Project 15
      finalizer on clean release, and emits terminal mutation events.

### Dirty release

- [ ] 🔴 Releasing a parked run with a **dirty** worktree warns with the dirty file list and does
      NOT destroy the worktree without an explicit confirm — a human fix is never force-removed
      silently (`destroyWorktree` is `--force`, `sandbox-runtime.ts:333`).
- [ ] 🔴 Dirty state is detected with `git status --porcelain` in the parked worktree.
- [ ] 🔴 Dirty release without confirmation returns `409 { "error": "dirty-worktree", "files": [...] }`
      from the cockpit route and creates no mutation.
- [ ] 🟡 After explicit `{ "confirmDirty": true }`, the dirty worktree is destroyed as an explicit
      discard, the parked hold clears only after destructive cleanup, and gated merge is not
      invoked.

### Misuse / races

- [ ] 🟡 Releasing an already-released (or never-parked) run is a clean no-op with a clear message,
      not an error that destroys an unrelated worktree.
- [ ] 🟢 A parked run left unreleased is surfaced in the cockpit (via the existing
      `blocked-on-human` inbox row, now actionable); an injected-clock test advances past
      `PARKED_RUN_NUDGE_AFTER_MS` (default 24 hours) and asserts the NET-NEW `planParkedNudges`
      predicate fires a staleness nudge once (`parkedNudgedAt` marker) rather than auto-releasing —
      and that `isQuietRun`/`planQuietNudges`/`planQuietCancel`/`planMaxRuntimeKills` do NOT fire on
      the `blocked-on-human` record.

## 4. Regression

- [ ] 🔴 A run that never emits a sentinel behaves exactly as today: ordinary terminal outcome
      through the Project 15 finalizer. No behavior change on the non-parked path.
- [ ] 🔴 A clean released run follows the Project 15 finalizer gate: gate green may merge; gate red
      stops at `branch-complete`; Project 13 never bypasses that gate.
