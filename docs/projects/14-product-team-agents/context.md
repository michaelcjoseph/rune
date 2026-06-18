# Project Context: Product-Team Orchestrated Work — a simulated PM/tech-lead/QA/coder/reviewer/designer team that owns a project's per-task build loop end-to-end

> Orchestration state for the `jarvis` project "Product-Team Orchestrated Work".
> Owned by Jarvis's context curator — roles read a bounded slice and emit handoff
> notes; they do not author this file directly.

## Current State

Phases 1-9 shipped: the role substrate (`agents/<role>/{SOUL.md,memory.md}` for PM,
tech lead, QA, coder, reviewer, designer), planning, per-task orchestration, the live
execution binding (Phase 8 — stub-free proof in `live-acceptance-6abf35cf.md`), and the
planning critique pass (Phase 9). Orchestrated runs now drive real tasks to real diffs.

The project was REOPENED 2026-06-14 for Phases 10-12, all triggered by the overnight
project-17 orchestrated run:

- **Phase 10 — Execution observability parity.** Orchestrated runs do real work but do it
  blind. The applier emits only a "starting" `log` and one terminal event, so codex/claude
  role activity never reaches the cockpit stream and the supervision heartbeat goes stale
  mid-run. Phase 10 streams role activity + advances the heartbeat for both executors, then
  reuses that stream as the durable transcript so a clean run auto-merges through the
  Project 15 finalizer instead of holding for an operator.
- **Phase 11 — Orchestration resilience.** Two structural failure modes the project-17 run
  exposed: (A) gate rejections discard the feedback that would fix them (blind retries), and
  (B) a server restart orphans the run instead of resuming it (double-terminal record).
- **Phase 12 — Role learning & exemplars.** The team has cold-start memories and no model of
  "good"; a gate rejection leaves zero durable residue, so the same mistake recurs every run.

Phases 10-12 are all unstarted — every task is unchecked.

## Key Decisions

- Jarvis owns the project loop (select next unchecked task → assemble bounded context →
  invoke roles → Jarvis-owned closeout → advance), replacing the single long `/work --auto`
  process that delegated task selection, continuation, and wrap-up to one accumulating model.
- Multi-model role separation: judgment roles run Opus 4.8; artifact roles run GPT-5.5/Codex.
  Reviewer independence is fail-closed — a same-provider-only review blocks (Gate 0).
- Orchestrated runs never self-merge in the Phase 8 shape: they land `completed` + `held:true`
  branch-complete and hold for the Project 15 finalizer. Phase 10 reverses this for clean runs
  (gated auto-merge); a failed gate or open objection still holds the branch, never merges.
- Both Claude and Codex executors are treated equally — observability, heartbeat, and
  attribution are at first-class parity with the legacy work-runner, not codex-only.
- Completion requires a non-fixture live run (the 2026-06-10 correction: a live real-task run
  is load-bearing, not an "optional smoke check" — that mislabel was the original defect, and
  it is exactly the task whose closeout `~~...~~ **PROMOTED**` rename blocked the recent run).
- Task closeout is Jarvis-owned and atomic: tick exactly one `tasks.md` box, update
  `context.md`, commit — stale-refuse if state drifted.

## Interfaces & Contracts

Key seams (file:symbol references are the source of truth; do not reinvent):

- **Orchestrated applier** — `orchestrated-work-runner.ts` (`apply()` generator). Today emits
  a "starting" `log` (~:347) and one terminal (~:373) with the whole loop inside one
  `await runOrchestration`. Phase 10 must pump ≥1 `activity`/`output` event between them.
- **Heartbeat** — supervision advances `lastHeartbeatAt`/`lastOutputAt` only on
  `output`/`activity` events (`transport/mutations.ts:364`); the quiet→cancel / quiet-nudge
  backstop reads a streaming run as alive once those events flow.
- **Team-task workflow** — `team-task-workflow.ts`. Per-task role pipeline
  (QA → tech-lead review → coder → reviewer → designer → PM wrap-up), returns
  ready-for-closeout / blocked / failed plus structured verdicts. The QA→tech-lead test gate
  is currently one-shot (`:196`); the coder round loop re-runs without notes (`:208`) — both
  are the Phase 11A blind-retry defect.
- **Attempt outcome** — `decideAttemptOutcome` (`orch-attempt-cap.ts:50`): retry while below
  cap, then block.
- **Run records** — `orch-run-record.ts` (`TaskRunRecord`, `rolesInvoked`, `modelChoices`).
  Records are in-memory only today (`project-orchestrator.ts:90`); `orch-reconstruct.ts`
  (`reconstructRun`) is dead code. Phase 11B must persist records + a run cursor and route a
  still-`running` mutation through `reconstructRun` instead of `reconcileOrphans`
  (`mutations-log.ts:45`).
- **Context curator** — `context-curator.ts` / `project-context.ts`. `context.md` MUST retain
  the five required sections (`CONTEXT_SECTIONS`: Current State, Key Decisions, Interfaces &
  Contracts, Known Risks, Next Task Handoff); a curated update that drops one is rejected
  `missing-section` (Gate 4, `context-curator.ts:122`). Roles emit handoff notes; they never
  author this file directly.
- **Codex stream** — `runCodex` (`codex exec --json`, per-line `onStdout`/`onEvent`); malformed
  JSONL falls back to scrubbed raw-line streaming.
- **Claude stream** — `spawnClaudeAgent` forwards stream-json envelopes through the shared
  `streamJsonToDisplay` mapping (parity with `work-runner.ts:1284-1313`).
- **Finalizer** — `runFinalizer` (`gated-merge`): clean `branch-complete` merges `--no-ff` +
  pushes under the per-base merge lock; failed gate / open objection holds.

## Known Risks

- **The reopen is bootstrapped through the system it fixes.** Phases 10-12 are being built by
  orchestrated runs, so the same un-built resilience bites: a single gate/closeout rejection
  takes down the whole run rather than parking or retrying. Until Phase 11A lands, expect any
  rejection to be terminal for the run.
- **This `context.md` was missing entirely** until 2026-06-14, which blocked an orchestrated
  run at closeout (`context update rejected: missing-section`). The five required section
  headers above must survive every curated update or the run re-blocks the same way.
- **Quiet-backstop false positives.** Until Phase 10 streams activity, a genuinely working
  orchestrated run looks quiet and may be nudged/cancelled by the backstop. The Phase 10
  active-harm probe test exists to pin current behavior before changing it.
- **Double-terminal on restart.** `reconcileOrphans` rewrites the on-disk `running` line while
  the draining generator appends its own terminal — no idempotency guard. Phase 11B needs a
  skip-if-already-terminal guard plus a graceful-shutdown drain to a durable `resumable` state.

## Next Task Handoff

- ader.ts` unchanged.

Verification:
- `npx vitest run src/roles/loader.test.ts --configLoader runner` passed: 51 tests.
- `npm run build` still fails on unrelated existing TypeScript errors outside `loader.ts`.

Worktree remains with only the pre-existing staged QA change: `src/roles/loader.test.ts`.
