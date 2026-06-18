# Phase 10 Closeout Decisions

**Recorded:** 2026-06-17
**Status:** Phase 10 substrate and finalizer wiring decisions recorded.

## Context

Phase 8 deliberately held clean orchestrated runs at branch-complete because the
orchestrated path did not yet produce the artifacts Project 15's finalizer needs:
a durable transcript, `summary.json`, work-product classification, gate
configuration, and finalizer phase checkpoints.

Phase 10 closed that gap. Orchestrated runs now stream role activity while the run
is alive, persist that stream as transcript substrate, classify the resulting
branch, and hand clean branch-complete runs to the same gated finalizer used by
legacy `/work` runs.

## Decisions

1. **Reuse `WORK_RUNS_DIR`, do not create an orchestrated-only artifact root.**
   Orchestrated run artifacts live under `config.WORK_RUNS_DIR`
   (`logs/work-runs`) with the same per-run layout as work-runs:
   `<runId>/transcript.jsonl`, `<runId>/summary.json`, and the finalizer phase
   checkpoint file, plus the shared rolling `logs/work-runs/index.jsonl`.

2. **Use streamed activity as both the live surface and durable transcript.**
   `orchestrated-work-runner.ts` pumps `activity`/`output` events while
   `runProjectOrchestration` is still running. Those events advance mutation
   supervision (`lastHeartbeatAt` / `lastOutputAt`), feed the cockpit tail, and
   are teed into `WORK_RUNS_DIR/<runId>/transcript.jsonl`. Non-output liveness
   pings stay live-only; terminal facts are persisted in `summary.json` and the
   index row.

3. **Use the shared `WorkRunSummary` contract.** The orchestrated terminal path
   builds `summary.json` with `buildSummary`-compatible facts: run id, product,
   project, branch, base SHA, transcript path, work-product classification, and
   gated-merge disposition (`merged`, `branchDeleted`, `baseBranch`, and
   `gateHeldReason` when present). This keeps cockpit/recovery readers on the
   existing work-run substrate instead of adding a second projection model.

4. **Run Project 15 finalization in `gated-merge` mode for clean completion.**
   The production adapter calls `runFinalizer({ mode: 'gated-merge', ... })`.
   Its effects bind the same durable phases as work-runs: classify, flush
   transcript, write summary, append index, record/read phase, merge, push,
   worktree removal, and branch deletion. Project 14 still does not implement an
   independent merge path.

5. **Gate configuration is product-scoped and locked by base branch.** The
   orchestrated adapter reads `repoPath`, `baseBranch`, and `validationCommands`
   from the product config. It runs the gate through
   `withBaseBranchLock(product, baseBranch, () => runGate(...))`, passes
   `tasksRemaining` from the computed work product, uses the configured gate
   command timeout, and builds the integration worktree under
   `WORKTREE_ROOT/gate-<product>-<runId>`.

6. **Failed gates hold, clean gates merge.** A branch-complete run with a passing
   gate merges `--no-ff`, pushes the base branch, removes the worktree, and
   deletes the work branch through the finalizer. A failed gate records
   `gateHeldReason`, leaves the base branch untouched, and retains a durable
   branch-complete hold. Open blocking objections remain a hold path, never an
   autonomous merge.

## Reversed Phase 8 Decision

The 2026-06-10 Phase 8 decision to keep a durable operator hold is superseded.
It was correct while orchestrated runs lacked finalizer substrate; it is no
longer the default terminal for a clean run. Clean orchestrated runs now land
through Project 15's gated finalizer. Holds remain only for failed gates,
blocking objections, unavailable substrate, or operational failure.

## Verification

The runtime contract is covered by the Phase 10 substrate/finalizer tests:

- `src/jobs/orchestrated-work-runner.test.ts` covers `WORK_RUNS_DIR` transcript
  binding, `transcript.jsonl` + `summary.json`, work-product classification,
  `gated-merge` invocation, phase ordering, gate-pass merge/push/delete, and
  gate-fail hold behavior.
- `src/jobs/team-task-deps.test.ts`, `src/jobs/execution-agent.test.ts`, and
  `src/ai/codex.test.ts` cover role/executor streaming and provider attribution.
- `src/transport/mutations.test.ts` covers heartbeat advancement from
  `activity`/`output` events.
- `src/jobs/__acceptance__/orchestrated-live.acceptance.ts` is the live harness:
  clean run merges/pushes through the gated finalizer; deliberate gate failure
  records a hold without mutating the base branch.
