# Work-Run Observability Test Plan

Error-handling checklist for the work-run observability layer.

This project is **test-first**: each numbered section below is written by a phase's **Tests (write first)** task in [tasks.md](tasks.md), and those tests must fail (red) before that phase's implementation begins. A phase's implementation is done when its test-plan sections pass.

> See also: [Cross-cutting test plan](../../tech/test-plan.md) for shared guidelines, monitoring, and security checks.

## Priority Levels

- 🔴 **Critical**: Blocks user progress, requires immediate attention
- 🟡 **High**: Degrades experience significantly, should be handled gracefully
- 🟢 **Low**: Non-blocking, can fail silently with logging

## 1. Durable transcript stream

### Persistence

- [ ] 🔴 Every stream event is appended to `logs/work-runs/<id>/transcript.jsonl` with the drawer closed.
- [ ] 🔴 Transcript survives a run that ends in failure; `summary.json` is written only after the stream's `finish`.
- [ ] 🟡 Backpressure is respected (drain awaited); no events dropped under a fast stream.
- [ ] 🟡 Last-N ring buffer and stderr tail are populated on the run record.

### Adapter + redaction

- [ ] 🟡 stream-json envelopes render as human-readable `output` events in the drawer (back-compat), not raw JSON.
- [ ] 🟡 Known secret/token patterns are redacted before persistence.
- [ ] 🟢 A malformed/partial JSON line is logged to the stderr tail and does not crash the run.

## 2. Terminal classification

### classifyOutcome (pure, fixtures)

- [ ] 🔴 zero commits + zero task transitions + clean tree -> `noop` (the case that would have caught `7828477a`).
- [ ] 🔴 zero commits + dirty/untracked tree -> `dirty-uncommitted`.
- [ ] 🔴 commits + unchecked tasks remain -> `partial`.
- [ ] 🔴 commits + all original tasks checked -> `branch-complete`.
- [ ] 🔴 non-zero/signal exit -> `failed` with the correct reason (cancelled vs killed vs code N).

### Diff base + task parsing

- [ ] 🔴 Diff is computed against captured `baseSha`, not `main`, and stays stable if `HEAD` moves.
- [ ] 🟡 `[x]`/`[X]` markers count equal; a deleted/rewritten task is reported added/removed, not progress; absent `tasks.md` -> 0 transitions.

### Handoff, crash safety, persistence

- [ ] 🔴 `streamProcess` returns exit facts; `apply()` emits exactly one terminal event (no double-terminal, no skipped classifier).
- [ ] 🔴 A throw during classify/forensics still emits one terminal `failed`/`classification-error` event before the worktree is destroyed; forensics exported best-effort.
- [ ] 🔴 `outcome` + `workProduct` are copied onto the descriptor and reach `mutations.jsonl`, cockpit, Telegram, and the index.
- [ ] 🟡 `summary.json` is written atomically (temp-then-rename); `index.jsonl` readers skip a torn trailing line.
- [ ] 🟡 Mutation `status` stays within the existing enum; the verdict rides on `outcome`.

## 3. Retention & GC

- [ ] 🔴 Non-clean run exports `bundle.git` + status + diff (+ untracked tarball) before teardown; bundle over a live worktree succeeds.
- [ ] 🔴 The deterministic worktree is always destroyed after export, so the next run for the same project is not blocked.
- [ ] 🔴 GC runs as a single synchronous pass; a branch any worktree has checked out is never deleted.
- [ ] 🟡 GC excludes the active-run protected set (`activeRuns` + run-store + `git worktree list`) and prunes only terminal runs by count and bytes.
- [ ] 🟡 GC is idempotent — a second pass with no new runs deletes nothing.

## 4. Alerts

- [ ] 🔴 No-op, failure, and dirty-uncommitted alerts fire with reason + outcome summary, never bare finished-in-Ns.
- [ ] 🔴 A `completed` status with a `noop`/`dirty-uncommitted` outcome never renders as success in Telegram or the cockpit.
- [ ] 🟡 branch-complete and partial alerts carry the commits + tasks X/Y summary.
- [ ] 🟡 Progress ping is commit-driven and throttled; never one per task.
- [ ] 🟡 Quiet-run nudge fires once after 5 minutes of no `output` events via `lastOutputAt`, distinct from a child-dead stall; `lastOutputAt`/`quietNudgedAt` round-trip through `isSupervisedRun`.
- [ ] 🟢 Notification-bus failure does not block teardown; outcome still persisted.

## 5. Cockpit UX

- [ ] 🔴 `buildCockpitView` / `/api/cockpit` exposes run id, last-N output, elapsed, outcome, and reason.
- [ ] 🔴 Active card shows live last-N output + elapsed with the drawer closed; terminated card shows outcome + reason in place of a stale `running` pill.
- [ ] 🟡 The authenticated `GET /api/work-runs/:id` (+ `/transcript`) route enforces path containment, rejects traversal, and sets correct content-type.
- [ ] 🟢 Card degrades gracefully when no transcript exists yet.

## 6. Validation & diagnosis

- [ ] 🔴 End-to-end: a deliberately empty run classifies `noop` and emits the no-op alert.
- [ ] 🟡 A real watched run classifies `branch-complete`/`partial` correctly and persists a full transcript.
- [ ] 🟢 Diagnosis write-up exists; follow-on filed if a structural `/work` mismatch is confirmed.
