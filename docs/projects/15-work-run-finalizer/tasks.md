# Work-Run Finalizer (Terminal Correctness & Gated Auto-Merge) — Tasks

Not started. See [spec.md](spec.md) for architecture and [test-plan.md](test-plan.md) for verification.

> **Test-first by default.** Every phase below opens with a **Tests (write first)** block.
> Those tests mirror the matching [test-plan.md](test-plan.md) sections and must fail (red)
> before any implementation task in the phase begins. A phase's implementation is done when
> its test-plan sections pass.
>
> Granularity here is the meaningful deliverable — not a granular sub-task. Per-task file
> layout, schemas, and signatures are settled in `/work`'s Plan phase, against the spec.
>
> **Agent-runnable constraint:** required verification must use temp repos/worktrees, injected
> work-run streams, fake sender/HTTP surfaces, test-scoped supervision/mutation stores, and injected
> clocks. Do not make any required task depend on a real Telegram chat, a production cockpit click, a
> live Jarvis restart, or a human killing a real process tree. A live smoke check may be added after
> the automated suites pass, but it is not a blocking task.
>
> **Self-reference sequencing guard:** Phase 4's regression suite reproduces the
> exact background-`vitest` hang that triggered the incident. Land and verify Phase 1 (watchdog)
> and Phase 2 (backstops) with bounded fixture tests before enabling/running Phase 4's incident
> replay. This is an automated sequencing rule, not a manual attendance requirement. Phases 1 and 2
> are no-policy-change P0/P2 correctness; Phase 3 is the decided auto-merge policy change.

## Phase 1 — Terminal correctness (P0, no policy change)

> Depends on: nothing.

### Tests (write first)

- [x] Write supervision-store metadata-merge tests: a quiet nudge stamps `quietNudgedAt`, a
      keep-alive heartbeat rebuilds the `SupervisedRun`, and the field survives so the nudge does not
      re-fire — test-plan.md §1. (Added the "upsertRun — field-merge across heartbeats (P0.1)" block
      to `src/jobs/supervision-store.test.ts`: 4 tests, red against current replace-by-id upsertRun.)
- [x] Write classifier exit-fact taxonomy tests covering user-cancel, external-kill,
      clean-exit-with-wedged-stdio, and internal-reap-after-terminal-result, each crossed with a
      clean+complete branch and an incomplete/dirty branch — test-plan.md §2. (Added the
      "classifyOutcome — exit-fact taxonomy (P0.3)" + "finalizeWorkRun — external-kill carries
      truthful work product" blocks to `src/jobs/work-run-classify.test.ts`; the
      reaped-after-terminal-result cases are red, the rest are green reorder-guards.)
- [x] Write terminal-result watchdog tests with an injected clock and a fixture stream: `result`
      emitted then child exits within the drain window (no reap); `result` emitted then child never
      exits (drain → SIGTERM → SIGKILL group reap → `reapedAfterTerminalResult` exit fact); assert no
      immediate kill on `result` — test-plan.md §3. (Added "terminal-result watchdog (P0.2)" describe
      to `src/jobs/work-runner.test.ts`: never-exits + incident-replay cases red, the
      exits-within-window + no-immediate-kill guards green; fake-timer driven, no hangs.)
- [ ] Write P0 finalizer `hold` mode tests: branch-complete writes terminal summary/index and
      supervision, preserves or removes the worktree according to the existing non-merge policy, and
      never merges or pushes — test-plan.md §4.
- [ ] Write recovery-finalize tests: a stale `running` run at startup is classified on work product
      and driven through finalizer `hold` mode to a real terminal state, and recovery runs **before**
      the orphan-worktree sweep so the worktree it needs still exists — test-plan.md §4.
- [ ] Write config tests for `WORK_RUN_TERMINAL_DRAIN_MS`, `WORK_RUN_REAP_GRACE_MS`,
      `WORK_RUN_QUIET_CANCEL_AFTER_MS`, `WORK_RUN_MAX_RUNTIME_MS`, and
      `WORK_RUN_GATE_COMMAND_TIMEOUT_MS`: defaults match the spec, invalid values reject, and tests
      use injected clocks rather than wall-clock sleeps.
- [ ] Confirm every suite above fails (red) before starting the implementation blocks.

### P0.1 — Supervision-store field-merge

- [ ] Make `upsertRun` field-merge unknown/current fields (or thread `quietNudgedAt` through
      `buildSupervisedRun`) so a keep-alive heartbeat can never clear a persisted supervision field
      (`supervision-store.ts:138-145`, `mutations.ts:32-63,305-320`).
- [ ] Assert the one-shot quiet guard holds across heartbeats (`supervision.ts:124-138`,
      `stall-check-runner.ts:70-85`).

### P0.3 — Classifier exit-fact taxonomy

- [ ] Introduce an exit-fact taxonomy in `work-run-classify.ts` distinguishing user-cancel,
      external-kill, clean-exit-with-wedged-stdio, and internal-reap-after-terminal-result; classify
      on exit-fact + work product, not exit code alone (`work-run-classify.ts:233-248`).
- [ ] A `reapedAfterTerminalResult` exit fact on a clean, complete branch classifies
      `branch-complete`; a genuine user-cancel stays `failed`/`cancelled` even if the branch looks
      complete. Keep `parked`/`blocked-on-human` out of the `WorkOutcome` enum (supervision state).

### P0.2 — Terminal-result watchdog

- [ ] On the terminal `result` event, transition the run out of plain `running` and open a bounded
      drain window; do NOT kill the child on `result` (`work-runner.ts:838-871`).
- [ ] If the child exits within the window, proceed via the existing `exit`-keyed teardown with no
      reap; if it does not, reap the process group (SIGTERM → SIGKILL → force-complete) via
      `reapTree()` (`:816-830`) and emit an explicit `reapedAfterTerminalResult` exit fact.
- [ ] Add typed config constants: `WORK_RUN_TERMINAL_DRAIN_MS=30000`,
      `WORK_RUN_REAP_GRACE_MS=5000`, `WORK_RUN_QUIET_CANCEL_AFTER_MS=1200000`,
      `WORK_RUN_MAX_RUNTIME_MS=7200000`, and `WORK_RUN_GATE_COMMAND_TIMEOUT_MS=600000`.

### P0.4a — Finalizer hold mode

- [ ] Create `src/jobs/work-run-finalizer.ts` with the durable phase store and `hold` mode only:
      classify result facts, flush transcript/summary/index, reap/teardown according to the
      non-merge outcome policy, write terminal supervision/mutation state, and never merge/push.
- [ ] Thread ordinary work-run terminal paths and post-watchdog reaps through `hold` mode so Phase 1
      delivers terminal correctness without changing the plain work-run merge policy.

### P0.4 — Recovery classifies before cleanup

- [ ] Make startup recovery (and the restart path) compute work product and drive a stale `running`
      run to a real terminal state through finalizer `hold` mode, instead of only relabeling it
      `unknown` (`supervision-recovery.ts:36-55`, `supervision.ts:201-203`).
- [ ] Order recovery classification/finalize **before** the orphan-worktree sweep (`index.ts:64`) so
      the sweep cannot race away the worktree the finalizer needs.

## Phase 2 — Backstops independent of agent cooperation (P2.7)

> Depends on: Phase 1.

### Tests (write first)

- [ ] Write quiet→cancel actuator tests with an injected clock: sustained quiet past the first
      threshold notifies; quiet past the longer threshold escalates to cancel/reap/finalize rather
      than nudging again — test-plan.md §5.
- [ ] Write max-runtime-ceiling tests with an injected clock proving a run that keeps `lastChildAliveAt`
      fresh (keep-alive ticker active) is still group-killed and finalized once the ceiling is
      exceeded — test-plan.md §5.
- [ ] Write worktree-scoped sweep tests: a reparented/detached process whose cwd is under the run's
      worktree path is reaped by the fallback sweep, and a process outside that path is left
      untouched. Use an injected process table/kill adapter; do not spawn real long-lived processes —
      test-plan.md §5.
- [ ] Confirm red before implementation.

### Actuator + ceiling + sweep

- [ ] Quiet→cancel actuator: first sustained-quiet notifies; a longer threshold escalates to
      cancel/reap/finalize through the shared finalizer instead of nagging forever
      (`stall-check.ts:21-26`, `supervision.ts:124-138`).
- [ ] Hard max-runtime ceiling that group-kills and finalizes regardless of apparent liveness; the
      keep-alive ticker (`work-runner.ts:673`) must not be able to defeat it.
- [ ] Worktree-scoped cwd process sweep as a fallback reap for reparented/detached grandchildren the
      pgid kill misses, scoped to the one worktree path (demoted from the happy path, kept for
      defense-in-depth).

## Phase 3 — Gated auto-merge finalizer (P1.5 + P1.6, policy change)

> Depends on: Phase 1, Phase 2.

### Tests (write first)

- [ ] Write finalizer state-machine tests in a temp repo: classify → gate → merge → push+verify →
      worktree remove → branch delete → terminal `merged`, with no operator action — test-plan.md §6.
- [ ] Write gate tests proving each failing condition (tests red, dirty working tree,
      `tasksRemaining > 0`, merge conflict / bad base relationship, concurrent run owns the
      branch/project, missing product `validationCommands`, validation command timeout) stops at
      `branch-complete` + alert and leaves `main` unchanged — test-plan.md §6.
- [ ] Write test-before-mutating-main tests proving the gate's checks run in an integration worktree
      (or on the branch) so a red result never alters local `main` — test-plan.md §6.
- [ ] Write product-config tests proving `validationCommands` is read from `policies/products.json`;
      Jarvis has `["npm run build", "npm test"]`, products without commands fail closed, and each
      command is bounded by `WORK_RUN_GATE_COMMAND_TIMEOUT_MS`.
- [ ] Write per-product / per-base-branch lock tests proving two projects sharing one `main`
      serialize, and a single-writer assumption is not violated — test-plan.md §6.
- [ ] Write resume tests: kill at each durable phase (`merged-not-pushed`, `pushed-not-deleted`, …)
      and prove recovery resumes at the right step with exactly-once merge and push-before-delete —
      test-plan.md §6.
- [ ] Write failure/partial/cancelled-path tests proving the tree is always reaped + transcript/summary
      flushed, nothing merges, supervision becomes terminal or explicit `blocked-on-human` (never
      quiet-pinging `running`), and branch retention/deletion is recorded — test-plan.md §7.
- [ ] Confirm red before implementation.

### P1.5 — Shared finalizer + gate

- [ ] Extend `src/jobs/work-run-finalizer.ts` from Phase 1 `hold` mode to `gated-merge` mode:
      verify gate → merge → push + verify → worktree remove → branch delete → terminal `merged`.
      Reuse/refactor `realMergeBranch` (`gen-eval-loop-runner.ts:254-302`) rather than duplicating
      it; honor its half-merged push-failure warning (`:274`).
- [ ] Implement the hard gate — merge only if ALL hold: tests green, working tree clean,
      `tasksRemaining == 0`, no merge conflict / sane base relationship, no concurrent run owns the
      branch/project, product has `validationCommands`, and each validation command finishes within
      `WORK_RUN_GATE_COMMAND_TIMEOUT_MS`. Any failure stops at `branch-complete` + alert; no merge,
      no branch delete.
- [ ] Add `validationCommands` support to `policies/products.json` / product config parsing; set
      Jarvis to `["npm run build", "npm test"]`.
- [ ] Run the gate's checks in an integration worktree (or on the branch) so a red result never
      leaves local `main` altered (test before mutating main).
- [ ] Per-product / per-base-branch lock (not per-project), respecting the single-writer assumption
      (`config.ts:250`, `supervision-store.ts:10-15`).
- [ ] Push before deleting the branch; record durable resumable phases (`merged-not-pushed`,
      `pushed-not-deleted`, …) so a crash mid-finalize is resumable by Phase 1's P0.4 recovery.

### P1.6 — Failure / partial / cancelled path

- [ ] Route failure/partial/cancelled runs through the finalizer: always reap the tree + flush
      transcript/summary, never merge, remove the worktree after preserving forensics OR mark
      explicit `blocked-on-human`; supervision ends terminal or intentionally blocked, never
      quiet-pinging `running`; branch retention/deletion recorded.
- [ ] If a transient "wrapping-up" state is needed, model it without widening the persisted status
      union; only add a `MutationStatus`/supervision enum value if shown unavoidable, and then as a
      deliberate cross-surface change (`supervision.ts`, `supervision-store.ts:25`).

## Phase 4 — Cross-mode regression suite (P2.8)

> Depends on: Phase 3.

### Tests (write first)

- [ ] Write the full incident replay for `d0679453`: `result: success` → child never exits → drain →
      group reap → `reapedAfterTerminalResult` → classify `branch-complete` → gate green → merge →
      push → terminal `merged`, asserting no quiet ping re-fires and no human acts — test-plan.md §8.
- [ ] Write the per-mode regression matrix: result-before-exit; result-then-reap classifies
      branch-complete; quiet marker survives keep-alive; supervision-store divergence; and
      resume/branch-reuse cleaning ALL of a project's run records (cross-listed with the adjacent
      re-fork bug) — test-plan.md §8.
- [ ] Write finalizer-resume-at-each-phase and merge-conflict / push-failure
      don't-delete-prematurely integration tests — test-plan.md §8.
- [ ] Confirm red before implementation.

### Suite

- [ ] Land the cross-mode regression suite covering every observed failure mode above as a standing
      guard against recurrence; wire it into the project's test run.
