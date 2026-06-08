# Work-Run Monitoring (Phase 1: Findability & Parked Worktrees) Specification

## Overview

Make an automated `/work --auto` run reachable and testable by a human when it needs one —
without asking Jarvis where the work lives, and without fighting the Project 15 finalizer.

Today an automated work-run executes inside a worktree at a deterministic path, but that path is
not consistently surfaced as an operator-actionable value. Project 15 now owns ordinary terminal
classification, gated merge, and worktree teardown for plain work-runs. That makes Project 13
narrower and still relevant: when a run needs a human before it can be finalized, Jarvis must park
the run, keep the live worktree protected from finalizer/GC cleanup, expose the pending check, and
resume the Project 15 finalizer after the human releases it.

The motivating incident is still project 10's interactive Codex check: the run needed a human, but
there was no machine-detectable signal, no live worktree contract, and no hand-back path. Michael had
to ask where the worktree was, and by the time he looked it could be gone or terminalized incorrectly.

This project surfaces the worktree path in run notifications and introduces a durable **parked**
state: a run that needs a human keeps its worktree alive, holds the per-project slot, blocks
finalizer teardown/merge, and is released by an explicit action once the human is done. It does not
touch how `/work` executes a task, and it does not add durable integration branches (see Deferred).

### Core Value Proposition

When a run needs Michael (or he just wants to look), the notification hands him the worktree path
and the pending check; he tests in place and releases the run back to the finalizer instead of the
work disappearing or bypassing the normal merge gate.

### Goals

1. **Primary:** A run that parks for a human keeps its worktree alive and surfaces the path + the
   pending action, so Michael can reach it in one step.
2. **Secondary:** Every run surfaces its worktree path and run id at start, for live monitoring.
3. **Tertiary:** Releasing a parked run is one explicit action that either cold-finalizes a clean
   parked worktree through the Project 15 finalizer (gated-merge mode), or explicitly discards a
   dirty worktree after confirmation.

### Non-Goals

- **Durable integration branches.** Cut from this spec — the proposed topology was
  invalid (see Deferred). Phase 1 changes nothing about which branch a run is cut from
  (`jarvis-work/<run-id>` off repo HEAD, as today) and defines no new merge path.
- **Changing how `/work` executes** (the plan→test→implement→review cycle in
  `.claude/skills/work/SKILL.md`). Same boundary project 11 held.
- **Parking the orchestrated-work applier.** Parking is scoped to the **legacy `work-run`
  applier only** (the single `/work --auto` process). Project 14's `orchestrated-work` applier
  runs Jarvis's own task-by-task loop — it never spawns a `/work --auto` process, so the sentinel
  never appears, and its `apply()` already maps a human-block to `failed` and unconditionally
  destroys the worktree in `finally` (`orchestrated-work-runner.ts:351`). Project 13 does **not**
  make orchestrated runs parkable. This is acceptable for Phase 1 because orchestrated mode is OFF
  by default (`ORCHESTRATED_WORK_ENABLED=false` + no per-product opt-in); the limitation is called
  out so flipping that toggle is a known trade-off, not a silent regression. See Background §6.
- **A new cockpit screen.** Reuse the existing run card / drawer, the existing `blocked-on-human`
  cockpit inbox row (`approval-actions.ts`), and the Telegram formatter; add fields and one action,
  don't build surfaces. The one formatter exception: `formatWorkRunTerminal` keys off the
  `WorkOutcome`, and parked is deliberately not a `WorkOutcome` value — so it needs a small
  parked-aware branch or a parked run renders its underlying `partial`/`noop` as the headline.
- **Defining merge policy.** Project 15 owns terminal correctness, gated merge, push, worktree
  teardown, branch delete, and terminal writes for plain work-runs. Project 13 only pauses that
  finalizer while a run is parked and resumes it on clean release.

### Agent-runnable acceptance

All required acceptance checks for this project are automated. The implementation agent should use
fixture-driven work-run streams, temp product repositories/worktrees, injected clocks, injected
notification sinks, and the existing supervision/mutation stores under test paths. No required
verification depends on a real Telegram chat, a production cockpit click, an actual Jarvis restart,
or Michael manually running commands in a live parked worktree. A live smoke check is optional after
the automated suites pass.

---

## Background: verified current-state

Confirmed originally against the code on 2026-06-03, then re-audited after Projects 14 and 15 landed
on 2026-06-08.

1. **Worktree paths are already deterministic.** `worktreePathFor(product, project, root)` →
   `<WORKTREE_ROOT>/<product>/<project>` (`src/intent/sandbox.ts:75`); `WORKTREE_ROOT` defaults to
   `<PROJECT_ROOT>/.worktrees` (`src/config.ts:152`). The findability gap is that this path is
   never surfaced, not that it is unpredictable.
2. **Project 15 moved ordinary terminal ownership into the finalizer.** Plain work-runs now have a
   gated path to `main` through the shared finalizer. Project 13 must not implement an independent
   merge or teardown path; parked runs are a finalizer hold state until release.
3. **The run branch is NOT the fragile artifact; the live worktree is.** Project 15 preserves or
   removes worktrees according to finalizer outcome. Project 13's job is to protect the checked-out
   worktree while human work is pending and to hand it back to the finalizer after clean release.
4. **GC already protects parked runs — both the run dir and the branch.** `runWorkRunGc` builds
   its protected set from active mutation ids **plus every non-terminal supervised run**, where
   `TERMINAL_STATUSES = {completed, failed}` — so a `blocked-on-human` record is already protected
   (`work-run-gc-runner.ts:21`, `:55–62`). GC also protects branches checked out in any worktree
   and refuses to prune outside the `jarvis-work/` prefix. **Implication:** the GC carve-out is
   *verify-not-implement* — no code change, only a regression test that a parked run survives a GC
   pass.
5. **`cleanupOrphanWorktrees` already preserves parked worktrees.** It only `rmSync`s on-disk dirs
   that are **not** registered in `git worktree list --porcelain` (`sandbox-runtime.ts:527`). A
   parked worktree stays registered (nobody runs `git worktree remove` on it while parked), so it
   is never an orphan. **Implication:** Req 6 is *verify-not-implement* — a regression test, not a
   code carve-out.
6. **Parking is legacy-`work-run`-only.** The `orchestrated-work` applier (project 14) maps a
   human-block to mutation `failed` and unconditionally `destroyWorktree`s in its `finally`
   (`orchestrated-work-runner.ts:351`, `:394`), and never spawns the `/work --auto` process the
   sentinel rides on. Project 13's parked lifecycle therefore attaches to the `work-run` applier.
   Orchestrated mode is OFF by default, so this is a scoped limitation, not a regression (see
   Non-Goals).
7. **The terminal supervision status has TWO writers, not one.** Terminal `completed`/`failed` is
   flipped both by `mutations.ts`'s own pipeline transition AND by the finalizer's
   `writeSupervisionTerminal` effect (wired from `work-runner`). `upsertRun` field-merges
   (`{...current, ...run}`), so a bare `{status:'completed'}` write from *either* path clobbers a
   `blocked-on-human` record. The parked override must therefore be written so it wins against
   both writers (see Resolved design decisions → "Where parked lives").
8. **The Project 15 backstops are safe for parked runs — verified.** `isStalled`, `isQuietRun`,
   `planQuietCancel`, and `planMaxRuntimeKills` all early-return unless `status === 'running'`
   (`supervision.ts:96`, `:129`, `:193`, `:230`). A `blocked-on-human` record is invisible to the
   quiet→cancel and max-runtime-ceiling actuators, so a parked run is genuinely never auto-killed.
   This is the load-bearing assumption behind storing parked in supervision rather than inventing a
   status value.
9. **`scrubPathsInText` strips `WORKTREE_ROOT` / `PROJECT_ROOT`** (`src/ai/tool-labels.ts:32`) — so
   any path that flows through the scrubber is unusable as a `cd` target. The findability
   notification must carry an un-scrubbed path on a local-operator-only field (see Requirements 2).

> **Line-reference caveat.** The `file:line` anchors in this spec were captured on 2026-06-08 and
> drift as the code moves (e.g. the per-project cap moved off `work-runner.ts:165` when project 14
> widened it to count `orchestrated-work`). Treat them as "look near here," and re-verify before
> editing.

### Phase 0 finding (resolved — no longer an open task)

Before Project 15, Codex traced the promotion path and found that plain work-runs did not
auto-promote to main. Project 15 resolved that with a shared gated finalizer. Project 13 therefore
has no promotion plumbing of its own: it keeps the worktree alive while parked, then calls back into
the finalizer on clean release.

---

## User Journey

### Happy path (run parks for a human)

```
run starts (notification: path + id) → commits accrue on the run branch
   → run hits a step --auto can't do → PARKS (worktree kept alive, slot held)
   → alert: worktree path + pending check → Michael cd's in, tests, confirms/fixes
   → Michael releases → Project 15 finalizer cold-finalizes (gated-merge) → merge/hold/teardown per gate
```

1. **Run starts.** The start notification names the project, run id, and the worktree path.
2. **Run parks.** A task needs an interactive step `--auto` can't take. The run emits a durable
   `blocked-on-human` (parked) state, its worktree is **not** destroyed, and the per-project slot
   stays held. The alert carries the worktree path and the pending action.
3. **Michael tests in place.** He `cd`s to the live worktree, runs the check, confirms or applies a
   fix (commits land on the run branch, which already survives per GC).
4. **He releases.** A release action hands a clean worktree to the Project 15 finalizer while the
   parked hold remains in place until the finalizer terminal write. A clean, gate-passing branch can
   merge; a gate failure stops at `branch-complete`; a dirty worktree requires explicit discard
   confirmation before any destructive cleanup.

### Entry / exit points

- **Entry:** a `/work --auto` dispatch (cockpit button, Telegram, scheduled), or a run-state alert.
- **Exit:** run parks → Michael tests → releases → Project 15 finalizes; or run reaches an ordinary
  terminal outcome and Project 15 finalizes without parking.

---

## Requirements

### Findability

1. WHEN a run starts THEN its start notification includes the deterministic worktree path and the
   run id.
2. WHEN a notification carries the worktree path for the operator to act on THEN that path is
   un-scrubbed and rides a local-operator-only field named `operatorWorktreePath`; it MUST NOT
   flow into `mutations.jsonl`, forensics, summaries/indexes, transcripts, or any committed/remote
   artifact (those stay scrubbed). Resolves the path-vs-scrubbing contradiction.

### Parked state

3. WHEN a run emits the blocked-on-human sentinel THEN the durable supervision `blocked-on-human`
   record is written **before the parked terminal event is yielded and before any finalizer path**
   (see Edge Cases → "Crash between sentinel and parked write"), and the terminal work-run event
   carries explicit `parked` metadata. The mutation still terminates normally; no new
   `MutationStatus` value. The terminal mutation pipeline MUST detect that parked terminal metadata
   and preserve/reassert supervision as `blocked-on-human` instead of writing `completed`/`failed`.
   The finalizer writer is bypassed on park (Req 4), so it cannot clobber the record. The state
   survives a Jarvis restart via the existing supervision store + recovery (`recoverRun` and
   `recoverAndFinalizeStaleRuns` both leave a `blocked-on-human` record untouched —
   `supervision-recovery.ts:135` only finalizes `running` runs).
4. WHEN a run is parked THEN `work-runner` does NOT route it into the Project 15 finalizer (which
   would remove the worktree in its shared tail — `work-run-finalizer.ts:219`); the worktree is
   left live. GC + `cleanupOrphanWorktrees` already preserve it (Background §4, §5: a
   `blocked-on-human` record is non-terminal, so its run dir is in GC's protected set, and a
   registered worktree is never an orphan) — this requirement is therefore a regression check on
   existing behavior, not a new carve-out.
5. WHEN the per-project cap is evaluated THEN it rejects a new run if ANY of: an `activeRuns` run is
   `running` for the slug; a supervision `blocked-on-human` (parked) record exists for the slug; or
   a worktree already exists at the deterministic path for the slug. The third check is a synchronous
   `existsSync(worktreePathFor(product, project, WORKTREE_ROOT))` — it fits the current sync
   `validate()` and does NOT require an async `git worktree list`. It is the backstop for the
   crash-before-parked-state-written case and for runs that startup recovery left as `unknown`
   (`supervision-recovery.ts`) — without it, validation would pass and `createWorktree` would later
   fail on the occupied path. (The cap currently checks only in-memory `running`; it moved off
   `work-runner.ts:165` when project 14 widened it to count `orchestrated-work` too — re-locate it
   before editing.)
6. WHEN startup orphan-cleanup runs THEN a parked worktree (still registered in `git worktree list`)
   is preserved, not swept. This already holds (`cleanupOrphanWorktrees` only sweeps unregistered
   on-disk dirs — Background §5); the requirement is a regression assertion.

### Release

7. WHEN Michael releases a parked run with a clean worktree THEN the run is handed to the Project
   15 finalizer in **gated-merge** mode (the same mode the live work-runner path uses, so the gate
   decides merge vs `branch-complete` hold) while the supervision `blocked-on-human` hold remains in
   place until the release/finalizer terminal write. This prevents a second run from starting in
   the same deterministic worktree while finalization is still merging, holding, or tearing down.
   The finalizer owns merge/hold/teardown/terminal writes; Project 13 does not destroy the clean
   worktree directly. **This is a COLD finalize, not a live "resume":** at release time there is no
   live child, transcript sink, or in-memory `baseSha`, so the release applier must recompute
   `baseSha` via merge-base, classify on the current work product, then drive the gated-merge.
   `finalizeStaleRun` (`recovery-finalize-runner.ts:154`) already assembles exactly this cold
   machinery — merge-base baseSha, `computeWorkProduct`, the real gate/merge/push/delete
   `FinalizerEffects`, and a `writeSupervisionTerminal` targeting the run's own id — so reuse it, but
   note one difference: `finalizeStaleRun` defaults a *fresh* run to **hold** mode and only selects
   `gated-merge` to RESUME an already-landed merge (`:331`). The release path must invoke
   `runFinalizer` in `gated-merge` mode unconditionally (the gate is what makes that safe), not
   inherit that hold default. Reuse the building blocks; do not call `finalizeStaleRun` verbatim.
   Only after the finalizer reaches a terminal write does the run stop occupying the project
   slot. The actionable surface is the **existing** `blocked-on-human` cockpit inbox row, which today
   returns `not-found` (non-actionable) for approve/reject (`approval-actions.ts` `blocked-on-human`
   case, ~`:152`); Project 13 makes that existing row actionable — it does not add a new surface
   (consistent with the "no new cockpit screen" non-goal).
8. WHEN a release is requested AND the parked worktree has dirty/uncommitted changes THEN release
   does NOT silently `destroyWorktree` (which force-removes — `sandbox-runtime.ts:333`). Dirty state
   is detected with `git status --porcelain` in the parked worktree. The release response warns with
   the dirty file list and requires an explicit `confirmDirty=true`. A confirmed dirty release is an
   explicit discard/abandon path: it destroys the worktree, then clears the parked hold, emits
   terminal release events, and does NOT invoke gated merge.
9. WHEN a release is requested THEN it is available from both Telegram and the cockpit through one
   shared release runtime. The cockpit route is `POST /api/work-runs/:id/release` with optional JSON
   `{ "confirmDirty": true }`; the Telegram action uses callback id `work-run-release:<id>` and the
   same dirty-confirm branch. Release runs as a new auto-approved mutation kind
   `work-run-release` with payload `{ "runId": "<id>", "confirmDirty": true|false }`, so terminal
   status, cancellation, audit, and cockpit/Telegram events use the existing mutation machinery.

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

The mutation descriptor can still become `completed` or `failed`, but the supervised run remains
`blocked-on-human` until a release path reaches its terminal step: the Project 15 finalizer terminal
write for clean release, or the confirmed-discard cleanup for dirty release. Two things make this
concrete:

- **Branch in `work-runner`, not inside the finalizer.** The live terminal path unconditionally
  routes through `runFinalizer`, and *every* finalizer path ends in the shared tail that removes
  the worktree (`work-run-finalizer.ts:219`). Rather than threading supervision-awareness into
  Project 15's idempotent, phase-recorded state machine (invasive, and it fights that tail), the
  cleaner seam is: on a parsed sentinel, `work-runner` writes the durable parked record, **skips
  `runFinalizer` entirely**, leaves the worktree, and yields a terminal mutation event. Project
  15's finalizer stays untouched; the release runtime is the only path that later invokes it (as a
  cold finalize, Req 7).
- **The parked write must win against both terminal supervision writers.** Terminal status is
  flipped by `mutations.ts`'s own pipeline transition AND by the finalizer's
  `writeSupervisionTerminal` effect, and `upsertRun` field-merges (Background §7). Since
  `work-runner` skips the finalizer on park, the surviving hazard is `mutations.ts`'s own terminal
  flip. **Contract:** the applier writes `blocked-on-human` before yielding the parked terminal
  event, and `mutations.ts`'s terminal branch treats `event.data.parked === true` as a supervision
  override: persist the mutation descriptor as terminal, but upsert supervision back to
  `blocked-on-human` rather than `completed`/`failed`. This is not "write last from the applier";
  it is an explicit terminal-branch exception for parked events. The durable parked record must be
  on disk before any finalizer path so a crash can't strand a `running` record that recovery would
  finalize and reap (Edge Cases → "Crash between sentinel and parked write").

**How the run signals "a human is required".** The child only emits NDJSON envelopes that the runner
parses then converts to display lines (`work-runner.ts:661`); there is no custom stream-event
channel, and the `/work` SKILL today only says hard stops "report to the user" with no machine
payload (`SKILL.md:23`). **Decision (Codex's contract):** the `/work --auto` SKILL must end a
blocked-on-human stop with one exact final line — `JARVIS_WORK_RUN_SENTINEL { ...json... }` — and
`work-runner` parses that sentinel from the **raw `assistant`/`result` envelope before display
scrubbing**, not from a tasks.md freetext marker. The sentinel JSON carries the pending-check
description and any command to run. A run that needs a human but emits no sentinel falls through to
an ordinary terminal outcome (no park, no regression).

Sentinel schema is fixed for Phase 1:

```json
{
  "version": 1,
  "pendingCheck": "Run the interactive Codex check and confirm the result",
  "command": "optional shell command for the operator",
  "reason": "optional short reason the agent could not proceed"
}
```

`version` must be `1`, `pendingCheck` must be a non-empty string, and `command` / `reason` are
optional strings. Invalid JSON, a missing sentinel, an unsupported version, or a missing/empty
`pendingCheck` is logged and falls through to the ordinary terminal path.

**Parked staleness policy.** A parked run is never auto-released. The cockpit always surfaces it
while the `blocked-on-human` record stands. A staleness nudge fires after
`PARKED_RUN_NUDGE_AFTER_MS` (default 24 hours), using an injected clock in tests. **The predicate is
net-new — it cannot reuse `isQuietRun`/`planQuietNudges`**, which early-return unless
`status === 'running'` (`supervision.ts:129`, `:160`); a parked run is `blocked-on-human`, so those
never fire. Add a `planParkedNudges` predicate over `blocked-on-human` + `PARKED_RUN_NUDGE_AFTER_MS`
with its **own** once-only marker field (e.g. `parkedNudgedAt` — not `quietNudgedAt`, whose
semantics belong to the quiet-run path). Only the *delivery* mechanism (bus publish + persisted
once-only marker via `upsertRun`) is reused.

**Release preflight and mutation kind.** Add `work-run-release` to `MutationKind` and register an
auto-approved applier. The shared release runtime has a pure preflight step used by both the HTTP
route and Telegram callback before creating the mutation:

- not parked / unknown run → return a clear no-op outcome; do not create a mutation.
- dirty worktree and no confirmation → return dirty-confirm outcome with the `git status
  --porcelain` file list; do not create a mutation.
- clean worktree → create `work-run-release` with payload `{ runId, confirmDirty: false }`; the
  applier rechecks the parked record and dirty state, keeps the parked hold while it invokes the
  Project 15 finalizer in the configured mode, and lets the finalizer terminal write clear the hold.
- confirmed dirty worktree → create `work-run-release` with payload `{ runId, confirmDirty: true }`;
  the applier rechecks the parked record and dirty state, destroys the worktree as explicit discard,
  then clears the parked hold and emits terminal release events without invoking gated merge.

The cockpit route returns `202 { "mutationId": "..." }` when it creates a clean/confirmed release
mutation, `200` for not-parked no-op outcomes, and `409 { "error": "dirty-worktree", "files": [...]
}` for dirty-confirm. Telegram uses the same preflight result to send either the confirm prompt or
the mutation-created message; final release success/failure comes from the mutation terminal event.
For the existing cockpit inbox row, **Approve/Release** maps to the same release preflight; **Reject
/ dismiss** leaves the parked run untouched and returns a clear no-op/dismissed response. A dirty
confirm must go through the explicit release endpoint/callback carrying `confirmDirty=true`, not an
implicit reject.

### Touch points

- **`.claude/skills/work/SKILL.md`** — define the structured blocked-on-human sentinel the runner
  parses (the hard stop already exists; this makes it machine-detectable). Legacy `work-run` path
  only — the orchestrated applier never spawns this process.
- **`src/jobs/work-runner.ts`** — parse the sentinel; on parked, write the durable parked record,
  **skip `runFinalizer` entirely** (so the worktree is left live), thread the worktree path to the
  start + parked notifications, and harden the per-project cap (now ~`:238–260`, not `:165`) with
  the `blocked-on-human` + `existsSync(worktreePathFor(...))` backstops.
- **`src/jobs/work-run-finalizer.ts`** — **no change for the park path** (it is bypassed on park).
  The release runtime is its only Project-13 caller, and it invokes the *existing* gated-merge/hold
  modes unchanged. Recorded here only to make explicit that the finalizer is NOT taught about
  parking.
- **`src/jobs/work-run-gc.ts`** + **`cleanupOrphanWorktrees`** — **verify-not-implement.** GC's
  protected set already includes non-terminal (`blocked-on-human`) supervised ids
  (`work-run-gc-runner.ts:55`) and checked-out branches; orphan cleanup only sweeps unregistered
  dirs. Add regression tests, not carve-outs.
- **per-project cap** (`work-runner.ts` validate, ~`:238`) — consult durable parked state +
  `existsSync` on the deterministic worktree path (synchronous; no async `git worktree list`).
- **supervision / run store** — a durable parked record (+ a `parkedNudgedAt` marker field) and a
  release transition that keeps the parked hold during clean finalization and clears it only on
  finalizer terminal write or confirmed dirty discard.
- **release runtime** — reuse `finalizeStaleRun`'s cold-finalize building blocks
  (`recovery-finalize-runner.ts:154`: recompute `baseSha` via merge-base → `computeWorkProduct` →
  classify → real gate/merge/push/delete effects), but invoke `runFinalizer` in **gated-merge** mode
  explicitly — `finalizeStaleRun` defaults a fresh run to **hold** (no merge), so a verbatim call
  would not merge a clean release (`:331`). Not the live `work-runner` path.
- **`src/transport/`** (telegram-sender + cockpit bus + a release action) — path on start/parked
  notifications; a parked-aware branch in `formatWorkRunTerminal` (parked is not a `WorkOutcome`);
  a release control wired through the existing `blocked-on-human` inbox row + the mutation pipeline.
- **`src/transport/approval-actions.ts`** — make the existing `blocked-on-human` inbox row
  actionable for a parked run (today it returns `not-found`), routing to the release runtime.
- **`src/server/webview.ts`** — `POST /api/work-runs/:id/release` delegates to the shared release
  runtime and returns dirty-confirm, mutation-created, or not-parked outcomes without exposing
  unrelated paths.
- **`src/transport/mutations.ts`** — add `work-run-release` to `MutationKind` and register its
  auto-approved applier; ensure the terminal supervision flip here does not clobber a
  `blocked-on-human` record on a parked terminal event (Background §7).

---

## Implementation Phases

> Task breakdown in [tasks.md](tasks.md), verification in [test-plan.md](test-plan.md); built
> test-first — every phase opens with a **Tests (write first)** block that is red before
> implementation, and a phase is done when its test-plan sections pass.

### Phase 1a: Surface the path

- [ ] Worktree path + run id on the start notification (un-scrubbed, local-operator field).
- [ ] Confirm the un-scrubbed path never reaches `mutations.jsonl` / forensics / committed artifacts.

### Phase 1b: Parked state

> Depends on: 1a. Scope: legacy `work-run` applier only (Background §6).

- [ ] Define + parse the structured blocked-on-human sentinel from the `/work --auto` stream.
- [ ] On a parsed sentinel, write the durable parked record **first** (before any terminal/finalize
  step), and **skip `runFinalizer`** so the worktree is left live (survives restart; wins against
  the `mutations.ts` terminal flip through the parked-event supervision override — Background §7).
- [ ] Verify (don't implement) GC + orphan-cleanup already preserve a parked run's dir/branch/
  worktree — regression tests only (Background §4, §5).
- [ ] Per-project cap consults durable parked state + `existsSync` on the deterministic worktree
  path.
- [ ] Parked staleness nudge via a **net-new** `planParkedNudges` predicate + `parkedNudgedAt`
  marker (not `isQuietRun`/`quietNudgedAt`).
- [ ] Parked alert carries `operatorWorktreePath`, `pendingCheck`, optional `command`, and optional
  `reason`; `formatWorkRunTerminal` gets a parked-aware branch.

### Phase 1c: Release

> Depends on: 1b.

- [ ] Release action (Telegram + cockpit) cold-finalizes a clean parked worktree through the
  Project 15 finalizer in **gated-merge** mode (reuse `finalizeStaleRun`'s building blocks —
  baseSha-recompute → classify → real gate/merge effects — but drive `gated-merge` explicitly, not
  its fresh-run hold default), or explicitly discards a dirty worktree after confirmation. Reachable
  via the existing `blocked-on-human` inbox row made actionable.

---

## Success Metrics

| Metric | Target | How Measured |
| ------ | ------ | ------------ |
| Steps to reach a parked run's worktree | 1 (copy path from alert) | Formatter/bus tests assert `operatorWorktreePath` is present on start + parked notifications |
| Parked worktree survives until released | Yes | Temp-repo lifecycle tests write a parked supervision record, run recovery/orphan cleanup, and assert the registered worktree remains |
| Parked run blocks a new run for the same project | Yes | Per-project cap tests seed active, parked, and registered-worktree cases and assert validation rejects before `createWorktree` |
| Clean release cold-finalizes (gated-merge) | Yes | Release tests assert clean release keeps the parked hold while invoking the Project 15 finalizer in gated-merge mode (merges a gate-passing branch, not just holds), then releases the slot only on the finalizer terminal write |
| Dirty release is explicit discard only | Always | Dirty release tests require confirmation and assert confirmed dirty release does not invoke gated merge |
| Operator path leaks to a committed/remote artifact | Never | Leak-containment tests seed a fake absolute worktree prefix and assert mutation log, summary/index, transcript, and forensics payloads contain only scrubbed paths |

---

## Edge Cases & Error Handling

- **Parked worktree never released:** the slot blocks new runs for that project indefinitely.
  Surface parked runs in the cockpit and send a staleness nudge after
  `PARKED_RUN_NUDGE_AFTER_MS` (default 24 hours) rather than auto-releasing, which would discard an
  unfinished manual check.
- **Crash while parked (record already durable):** startup recovery re-derives the held slot and
  does not reap the worktree — `recoverRun` leaves `blocked-on-human` unchanged, and
  `recoverAndFinalizeStaleRuns` only finalizes `running` runs (`supervision-recovery.ts:135`).
- **Crash BETWEEN the sentinel and the parked write:** this is the dangerous window. If Jarvis dies
  after the run emits the sentinel but before the durable `blocked-on-human` write lands, the
  on-disk record is still `running` — and at next boot `recoverAndFinalizeStaleRuns` will finalize
  it in **hold mode, removing the worktree** (`recovery-finalize-runner.ts:291`), destroying exactly
  what the human needed. Mitigation (Req 3): write the parked record as the **first** effect on
  sentinel detection, before any terminal/finalize step, minimizing the window. The
  `existsSync`-on-worktree cap backstop (Req 5) then prevents a *new* run from colliding on the
  occupied path even if the record was lost — but it does not resurrect the worktree, so the write
  ordering is the real defense. A run that loses this race degrades to an ordinary recovered
  terminal (worktree gone, no park) — no crash, but the human's hand-back is lost.
- **Human commits a fix in the parked worktree:** those commits land on the run branch. A clean
  release hands the branch back to Project 15's finalizer, whose gate decides merge vs
  `branch-complete` hold.
- **Dirty/uncommitted edits at release:** now a hard requirement (Req 8), not a deferred policy —
  a dirty worktree warns + requires explicit confirm before the force-removing `destroyWorktree`;
  confirmed dirty release is a discard path and does not merge.
- **Sentinel false-negative:** if the run needed a human but emitted no sentinel, it classifies as
  an ordinary terminal outcome and Project 15 finalizes as today — no regression, just no park. The
  sentinel contract (Phase 1b) is where this risk is controlled.

---

## Settled decisions for agent execution

- Parking is scoped to the legacy `work-run` applier; orchestrated-work is out of scope (off by
  default).
- On a parsed sentinel, `work-runner` writes the parked record first and skips `runFinalizer`; the
  finalizer itself is not taught about parking.
- Release UX is both cockpit and Telegram, backed by one shared release runtime, surfaced via the
  existing `blocked-on-human` inbox row made actionable.
- Release work runs through a new auto-approved mutation kind, `work-run-release`.
- Clean release is a COLD finalize: reuse `finalizeStaleRun`'s building blocks (baseSha-recompute →
  classify → real gate/merge effects) but invoke `runFinalizer` in **gated-merge** mode explicitly
  (`finalizeStaleRun` defaults a fresh run to hold/no-merge), not the live work-runner path.
  Confirmed dirty release is explicit discard and never gated-merge.
- The cockpit release endpoint is `POST /api/work-runs/:id/release`; dirty release confirmation is
  JSON `{ "confirmDirty": true }`.
- The Telegram callback id is `work-run-release:<id>` and uses the same shared runtime.
- Parked worktrees have no TTL and are never auto-released; the staleness nudge uses a net-new
  `planParkedNudges` predicate (not the quiet-run predicate) and fires after the configured 24-hour
  default threshold.
- The sentinel schema is the fixed `version` + `pendingCheck` contract above.
- All required verification is automated with temp repos, injected streams, injected clocks, and
  fake sender/HTTP tests; manual live smoke testing is optional only.

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
