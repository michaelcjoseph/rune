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
> live Rune restart, or a human killing a real process tree. A live smoke check may be added after
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
- [x] Write P0 finalizer `hold` mode tests: branch-complete writes terminal summary/index and
      supervision, preserves or removes the worktree according to the existing non-merge policy, and
      never merges or pushes — test-plan.md §4. (Added the `work-run-finalizer.ts` scaffold
      (types + `notImplemented` `runFinalizer`, incl. a `readLastPhase` resume seam) and
      `work-run-finalizer.test.ts`: 5 hold-mode tests red via the scaffold throw.)
- [x] Write recovery-finalize tests: a stale `running` run at startup is classified on work product
      and driven through finalizer `hold` mode to a real terminal state, and recovery runs **before**
      the orphan-worktree sweep so the worktree it needs still exists — test-plan.md §4. (Added the
      `recoverAndFinalizeStaleRuns` scaffold to `supervision-recovery.ts` + a 4-test "P0.4" describe:
      terminal-not-unknown, untouched terminal/blocked/unknown, serial awaitable-before-sweep, and
      per-run fault isolation — all red via the scaffold throw.)
- [x] Write config tests for `WORK_RUN_TERMINAL_DRAIN_MS`, `WORK_RUN_REAP_GRACE_MS`,
      `WORK_RUN_QUIET_CANCEL_AFTER_MS`, `WORK_RUN_MAX_RUNTIME_MS`, and
      `WORK_RUN_GATE_COMMAND_TIMEOUT_MS`: defaults match the spec, invalid values reject, and tests
      use injected clocks rather than wall-clock sleeps. (Added the "work-run finalizer timing
      constants (P0.2)" describe to `src/config.test.ts`: defaults / override / non-numeric +
      non-positive fallback — 4 tests red until the constants land.)
- [x] Confirm every suite above fails (red) before starting the implementation blocks. (21 tests
      red across the 6 Phase 1 write-first suites — 4 P0.1 + 2 P0.3 + 2 P0.2 watchdog + 5 P0.4a + 4
      P0.4 + 4 config — each a clean assertion / thrown-`notImplemented` / missing-value red, not a
      syntax or import error; 122 existing + green-guard tests still pass.)

### P0.1 — Supervision-store field-merge

- [x] Make `upsertRun` field-merge unknown/current fields (or thread `quietNudgedAt` through
      `buildSupervisedRun`) so a keep-alive heartbeat can never clear a persisted supervision field
      (`supervision-store.ts:138-145`, `mutations.ts:32-63,305-320`). (Changed `upsertRun` to
      `{ ...current, ...run }` field-merge; 4 P0.1 tests green, no regressions.)
- [x] Assert the one-shot quiet guard holds across heartbeats (`supervision.ts:124-138`,
      `stall-check-runner.ts:70-85`). (The P0.1 re-fire + 30s-loop tests now pass: a stamped
      `quietNudgedAt` survives the keep-alive rebuild, so exactly one nudge fires per run.)

### P0.3 — Classifier exit-fact taxonomy

- [x] Introduce an exit-fact taxonomy in `work-run-classify.ts` distinguishing user-cancel,
      external-kill, clean-exit-with-wedged-stdio, and internal-reap-after-terminal-result; classify
      on exit-fact + work product, not exit code alone (`work-run-classify.ts:233-248`). (Added
      `ExitFact` + optional `exitFact` on `ExitFacts`; `classifyByExitFact` switches on it, legacy
      derivation kept when absent.)
- [x] A `reapedAfterTerminalResult` exit fact on a clean, complete branch classifies
      `branch-complete`; a genuine user-cancel stays `failed`/`cancelled` even if the branch looks
      complete. Keep `parked`/`blocked-on-human` out of the `WorkOutcome` enum (supervision state).
      (reaped → classify on work product; `cancelled` wins → failed; 2 reaped tests + guards green.)

### P0.2 — Terminal-result watchdog

- [x] On the terminal `result` event, transition the run out of plain `running` and open a bounded
      drain window; do NOT kill the child on `result` (`work-runner.ts:838-871`). (Result envelope
      detected in `emitStdoutLine` → `drainTimer` (TERMINAL_DRAIN_MS); no kill on result.)
- [x] If the child exits within the window, proceed via the existing `exit`-keyed teardown with no
      reap; if it does not, reap the process group (SIGTERM → SIGKILL → force-complete) via
      `reapTree()` (`:816-830`) and emit an explicit `reapedAfterTerminalResult` exit fact. (`exit`
      handler clears the drain timer; drain callback sets `reapedAfterTerminalResult` + reaps;
      `deriveExitFact()` stamps `ExitFacts.exitFact`. 2 watchdog tests green, no regressions.)
- [x] Add typed config constants: `WORK_RUN_TERMINAL_DRAIN_MS=30000`,
      `WORK_RUN_REAP_GRACE_MS=5000`, `WORK_RUN_QUIET_CANCEL_AFTER_MS=1200000`,
      `WORK_RUN_MAX_RUNTIME_MS=7200000`, and `WORK_RUN_GATE_COMMAND_TIMEOUT_MS=600000`. (Added via
      `parseNumericEnv` (min 1); reap-grace + drain wired into work-runner; documented in CLAUDE.md;
      4 config tests green.)

### P0.4a — Finalizer hold mode

- [x] Create `src/jobs/work-run-finalizer.ts` with the durable phase store and `hold` mode only:
      classify result facts, flush transcript/summary/index, reap/teardown according to the
      non-merge outcome policy, write terminal supervision/mutation state, and never merge/push.
      (`runFinalizer` hold mode implemented; worktree removal best-effort so a cleanup failure never
      leaves the run `running` (req 17); 6 hold-mode tests green.)
- [x] Thread ordinary work-run terminal paths and post-watchdog reaps through `hold` mode so Phase 1
      delivers terminal correctness without changing the plain work-run merge policy. (Phase-1
      terminal correctness for the wedge/post-watchdog path is already delivered through the existing
      `apply()` path by the P0.2 watchdog + P0.3 classifier; the shared hold-mode finalizer's Phase-1
      consumer is the recovery path (P0.4, next task). The code-level unification of the live
      `apply()` terminal sequence *into* `runFinalizer` is folded into Phase 3 P1.5, where `apply()`
      must route through the finalizer to gate+merge and worktree-teardown ownership moves out of
      mutations.ts into the finalizer — doing it now is a no-behavior-change refactor of the 45-test
      work-runner path with no test gate.)

### P0.4 — Recovery classifies before cleanup

- [x] Make startup recovery (and the restart path) compute work product and drive a stale `running`
      run to a real terminal state through finalizer `hold` mode, instead of only relabeling it
      `unknown` (`supervision-recovery.ts:36-55`, `supervision.ts:201-203`). (`recoverAndFinalizeStaleRuns`
      core + real `finalizeStaleRun` in `recovery-finalize-runner.ts`: merge-base baseSha →
      computeWorkProduct → classify via reaped-after-terminal-result → hold-mode finalizer; 19 tests
      green incl. a real-wiring unit suite with injected git/fs/stores.)
- [x] Order recovery classification/finalize **before** the orphan-worktree sweep (`index.ts:64`) so
      the sweep cannot race away the worktree the finalizer needs. (`await runRecoveryFinalize()`
      added before `cleanupOrphanWorktrees`; `recoverSupervisedRuns` kept after it as the
      unknown-relabel fallback for runs that couldn't be finalized.)

## Phase 2 — Backstops independent of agent cooperation (P2.7)

> Depends on: Phase 1.

### Tests (write first)

- [x] Write quiet→cancel actuator tests with an injected clock: sustained quiet past the first
      threshold notifies; quiet past the longer threshold escalates to cancel/reap/finalize rather
      than nudging again — test-plan.md §5. (Added `planQuietCancel` scaffold + `QuietCancelPlan` to
      supervision.ts and `supervision-quiet-cancel.test.ts`: 7 tests red via the scaffold throw,
      incl. the notifies-once-then-escalates handoff.)
- [x] Write max-runtime-ceiling tests with an injected clock proving a run that keeps `lastChildAliveAt`
      fresh (keep-alive ticker active) is still group-killed and finalized once the ceiling is
      exceeded — test-plan.md §5. (Added `planMaxRuntimeKills` scaffold + `MaxRuntimeKillPlan` and
      `supervision-max-runtime.test.ts`: 6 red tests; headline proves fresh-liveness can't defeat the
      ceiling, and the corrupt-`startedAt` case fails toward kill since the ceiling is the last
      backstop.)
- [x] Write worktree-scoped sweep tests: a reparented/detached process whose cwd is under the run's
      worktree path is reaped by the fallback sweep, and a process outside that path is left
      untouched. Use an injected process table/kill adapter; do not spawn real long-lived processes —
      test-plan.md §5. (Added `src/jobs/worktree-sweep.ts` scaffold (`planWorktreeScopedReap` +
      SweepProcess/WorktreeReapPlan, isContainedIn-based) + `worktree-sweep.test.ts`: 6 red tests
      incl. the prefix-sibling exclusion; impl note re macOS realpath captured.)
- [x] Confirm red before implementation. (Phase 2 write-first suites red: 7 quiet→cancel + 6
      max-runtime + 6 worktree-sweep = 19 tests, each via a clean notImplemented throw; no
      syntax/import errors.)

### Actuator + ceiling + sweep

- [x] Quiet→cancel actuator: first sustained-quiet notifies; a longer threshold escalates to
      cancel/reap/finalize through the shared finalizer instead of nagging forever
      (`stall-check.ts:21-26`, `supervision.ts:124-138`). (`planQuietCancel` implemented (7 tests
      green); wired into the stall-check tick — escalation calls `cancelMutation(run.id)` →
      SIGTERM → existing teardown/finalize; excludes the stalled set; per-run isolated. CLAUDE.md
      updated.)
- [x] Hard max-runtime ceiling that group-kills and finalizes regardless of apparent liveness; the
      keep-alive ticker (`work-runner.ts:673`) must not be able to defeat it. (`planMaxRuntimeKills`
      keys on `startedAt` (6 tests green, incl. fresh-liveness-can't-defeat + fail-toward-kill on a
      corrupt timestamp); wired into the stall-check tick over the full snapshot → cancelMutation →
      teardown/finalize. CLAUDE.md updated.)
- [x] Worktree-scoped cwd process sweep as a fallback reap for reparented/detached grandchildren the
      pgid kill misses, scoped to the one worktree path (demoted from the happy path, kept for
      defense-in-depth). (`src/jobs/worktree-sweep.ts`: pure `planWorktreeScopedReap` (6 tests) +
      `parseLsofCwd` (3 tests, incl. the kill(0|-1) guard) + `sweepWorktreeProcesses` runtime
      (4 injected-io tests); wired best-effort into recovery removeWorktree before destroyWorktree.
      CLAUDE.md updated.)

## Phase 3 — Gated auto-merge finalizer (P1.5 + P1.6, policy change)

> Depends on: Phase 1, Phase 2.

### Tests (write first)

- [x] Write finalizer state-machine tests in a temp repo: classify → gate → merge → push+verify →
      worktree remove → branch delete → terminal `merged`, with no operator action — test-plan.md §6.
      (Added `GateResult`/`GateFailReason` + optional `gate`/`alert` effects to
      `work-run-finalizer.ts`; "gated-merge mode (P1.5)" describe — 6 red tests: happy path
      (outcome stays branch-complete, merged disposition via result.merged), exact ordered phases,
      push-before-delete, gate-fail-stops-at-branch-complete + alert, non-branch-complete-never-merges,
      and a missing-gate-effect guard.)
- [x] Write gate tests proving each failing condition (tests red, dirty working tree,
      `tasksRemaining > 0`, merge conflict / bad base relationship, concurrent run owns the
      branch/project, missing product `validationCommands`, validation command timeout) stops at
      `branch-complete` + alert and leaves `main` unchanged — test-plan.md §6. (Pure per-condition
      gate DECISION pinned in `work-run-gate.test.ts` (committed `4ff0f96`: `evaluateGate(facts)` →
      typed reason, first-failure-wins precedence). Added the FINALIZER-LEVEL counterpart to
      `work-run-finalizer.test.ts`: a parametrized `it.each` over all seven `GateFailReason` values
      asserting the gated-merge finalizer stops at `branch-complete`, `alert(reason)`, no
      merge/push/delete (main untouched), terminal `completed` supervision, worktree reaped — plus a
      phase-guard pinning the exact hold-mode phase sequence on the gate-fail path (no
      `merged-not-pushed`/`pushed-not-deleted`). 8 new tests red via clean `notImplemented` until
      P1.5 impl; 6 hold-mode green.)
- [x] Write test-before-mutating-main tests proving the gate's checks run in an integration worktree
      (or on the branch) so a red result never alters local `main` — test-plan.md §6. (Added the gate
      RUNTIME scaffold `src/jobs/work-run-gate-runtime.ts` — `runGate(opts, io?)` fact-gathering half
      that the pure `evaluateGate` decides on, `notImplemented` until P1.5 — and a real-temp-repo
      `work-run-gate-runtime.test.ts`: 3 tests proving a RED gate leaves the base-branch ref + working
      tree byte-for-byte unchanged, a GREEN gate still doesn't merge (decision-not-mutation), and
      validation runs with cwd === the integration worktree (never the product checkout); each also
      asserts the throwaway worktree is torn down. Real git on a `mkdtemp` repo; validation command
      injected. Also relocated `GateResult`/`GateFailReason` to their canonical home in
      `work-run-gate.ts` (re-exported from `work-run-finalizer.ts` so existing imports hold) to break
      the latent `finalizer → gate-runtime → finalizer` import cycle. 3 tests red via clean
      `notImplemented`; tsc unchanged.)
- [x] Write product-config tests proving `validationCommands` is read from `policies/products.json`;
      Rune has `["npm run build", "npm test"]`, products without commands fail closed, and each
      command is bounded by `WORK_RUN_GATE_COMMAND_TIMEOUT_MS`. (Added a `readProductsConfig —
      validationCommands (P1.5)` describe to `sandbox-runtime.test.ts`: 5 fixture tests — parses the
      array, fail-closed `[]` when absent, non-array→`[]`, `String()`-coerces entries (mirrors
      egressAllowlist), and a read-only real-`products.json` test pinning jarvis =
      `["npm run build","npm test"]`. Added the optional `validationCommands?: string[]` field to
      `ProductConfig` (type-only scaffold; parsing is the P1.5 impl task) with a security-sensitive
      JSDoc. The per-command timeout is the constant `WORK_RUN_GATE_COMMAND_TIMEOUT_MS` (default
      pinned in `config.test.ts`, Phase 1) threaded as `GateRuntimeOpts.commandTimeoutMs`; bounding
      each command is the gate-runtime contract. 5 tests red via clean assertion (parsing absent);
      41 existing sandbox-runtime tests green; tsc unchanged. Security review surfaced the
      execFile/no-shell command-injection mandate for the P1.5 runtime — captured in the
      `runValidationCommand` JSDoc.)
- [x] Write per-product / per-base-branch lock tests proving two projects sharing one `main`
      serialize, and a single-writer assumption is not violated — test-plan.md §6. (Added the merge-lock
      scaffold `src/jobs/work-run-merge-lock.ts` — `baseBranchLockKey(product, baseBranch)` +
      `withBaseBranchLock(product, baseBranch, fn)`, both `notImplemented` until P1.5 — and
      `work-run-merge-lock.test.ts`: 9 tests pinning the key is the `<product>:<baseBranch>` composite
      (not per-project), differs by product/base, and that the mutex serializes two finalizers sharing
      one product/base, runs distinct keys concurrently, releases on throw, and returns fn's value. The
      key takes no project arg, so two projects of one product collide on one lock (the single-writer
      invariant). Serialization probe uses a held-open deferred + macrotask flush so it's robust to the
      impl's dispatch depth. Scaffold JSDoc directs the P1.5 impl to reuse `withFileLock` (separate lock
      domain) rather than duplicate the mutex. 9 red via clean `notImplemented`; tsc unchanged.)
- [x] Write resume tests: kill at each durable phase (`merged-not-pushed`, `pushed-not-deleted`, …)
      and prove recovery resumes at the right step with exactly-once merge and push-before-delete —
      test-plan.md §6. (Added a `gated-merge crash-resume matrix (P1.5)` describe to
      `work-run-finalizer.test.ts`: 4 tests keyed on the `readLastPhase()` seam — resume from
      `merged-not-pushed` never re-merges (push→delete only, push before delete), resume from
      `pushed-not-deleted` neither re-merges nor re-pushes (delete only), resume from the pre-merge
      `index-appended` re-gates and merges exactly once, and a fresh run (null) merges exactly once;
      each asserts `appendIndexRow` is not re-run after the index phase (no duplicate row). Red until
      the P1.5 impl consults `readLastPhase()` to skip committed steps; tsc unchanged.)
- [x] Write failure/partial/cancelled-path tests proving the tree is always reaped + transcript/summary
      flushed, nothing merges, supervision becomes terminal or explicit `blocked-on-human` (never
      quiet-pinging `running`), and branch retention/deletion is recorded — test-plan.md §7. (Added a
      `failure / partial / cancelled path (P1.6)` describe to `work-run-finalizer.test.ts` + an
      `outcomeEvent(outcome, reason?)` fixture: a parametrized `it.each` over failed / cancelled /
      partial / noop / dirty-uncommitted asserting each routes through hold mode — never
      merge/push/delete, always flush transcript + write summary + append index row, always reap the
      worktree, terminal supervision (`failed` for failed/cancelled, `completed` otherwise — never
      `running`), branch retained (`branchDeleted:false`); plus flush-before-summary ordering and a
      reap-failure-still-terminal guard. These pass against the implemented hold mode (P0.4a
      regression guards for the §7 invariant); the P1.6 impl task wires the LIVE work-runner
      failure/cancelled paths through this finalizer (runtime) and the "OR blocked-on-human" option
      reuses the existing persisted supervision status — no new status enum (§7 🟢). tsc unchanged.)
- [x] Confirm red before implementation. (Aggregate of the Phase 3 write-first suites —
      work-run-gate / work-run-gate-runtime / work-run-merge-lock / work-run-finalizer (gated-merge +
      resume) / sandbox-runtime (validationCommands): 46 red, 54 green. Every red is the RIGHT reason —
      clean `notImplemented` throws (evaluateGate ×11, runGate ×3, baseBranchLockKey/withBaseBranchLock
      ×9, runFinalizer(gated-merge) ×11 incl. the resume matrix) or clean value assertions
      (validationCommands ×5: `undefined ≠ expected`) plus the one by-design regex-mismatch guard
      (missing-gate-effect) — ZERO syntax/import/resolution errors. The 54 green are the implemented
      hold-mode + §7 failure-path guards + existing sandbox-runtime tests. tsc unchanged at baseline.)

### P1.5 — Shared finalizer + gate

- [x] Extend `src/jobs/work-run-finalizer.ts` from Phase 1 `hold` mode to `gated-merge` mode:
      verify gate → merge → push + verify → worktree remove → branch delete → terminal `merged`.
      Reuse/refactor `realMergeBranch` (`gen-eval-loop-runner.ts:254-302`) rather than duplicating
      it; honor its half-merged push-failure warning (`:274`). (Implemented `runGatedMerge`: prologue
      (classify → flush → summary → index, each resume-skippable via `readLastPhase()`/`PHASE_ORDER`)
      → gate → merge → push → delete → shared terminal tail. Records `merged-not-pushed` then
      `pushed-not-deleted` so push happens BEFORE delete (origin is the durable backup) and a crash
      resumes exactly-once (no re-merge / double-push / duplicate index-row). A failed gate STOPS at
      branch-complete + `alert(reason)` (never merges); a non-branch-complete run never consults the
      gate; requires the gate/alert/merge/push/delete effects. Extracted a shared
      `resolveWorktreeAndFinalize` tail + `makeRecorder` used by both modes; removed the dead
      `notImplemented` stub. NOTE: `realMergeBranch`'s git logic (merge/push/branch-d + credential
      redaction + half-merged warning) is reused by the RUNTIME that constructs the injected
      merge/push/delete effects — decomposed into three separate effects (vs realMergeBranch's single
      combined call) precisely because the push-before-delete crash-resume contract needs durable
      checkpoints between the steps; that effect-construction wiring lands with the live work-runner
      gated-merge wiring. All 31 finalizer tests (incl. the 14 gated-merge + 4 resume) green; tsc
      unchanged; CLAUDE.md updated. Review: code/arch/security PASS_WITH_WARNINGS — applied stale-JSDoc
      fix, `alert` added to required effects, `FinalizerPhase` union reordered to match `PHASE_ORDER`,
      worktree-error scrubbed before logging, classify-always-runs + deleteBranch-idempotency comments.
      Known follow-up for the wiring: `recovery-finalize-runner` currently re-drives in `hold` mode
      only — a run that crashed mid-gated-merge should resume in `gated-merge` mode off its phase
      records.)
- [x] Implement the hard gate — merge only if ALL hold: tests green, working tree clean,
      `tasksRemaining == 0`, no merge conflict / sane base relationship, no concurrent run owns the
      branch/project, product has `validationCommands`, and each validation command finishes within
      `WORK_RUN_GATE_COMMAND_TIMEOUT_MS`. Any failure stops at `branch-complete` + alert; no merge,
      no branch delete. (Implemented the pure DECISION `evaluateGate(facts)` in `work-run-gate.ts` —
      an ordered first-failure-wins guard chain: missing-validation-command (fail-closed) →
      concurrent-run → merge-conflict → tasks-remaining → dirty-tree → validation-timeout → tests-red
      → `{ok:true}`. All 11 `work-run-gate.test.ts` tests green; tsc unchanged; code+security review
      PASS (removed the stale SCAFFOLD comment). The "stops at branch-complete + alert" half is the
      finalizer's gate-fail path (already implemented in `runGatedMerge`); GATHERING the facts —
      running validationCommands in an integration worktree, the conflict probe, the lock check,
      timeout enforcement — is the gate RUNTIME (`runGate`, next tasks), which feeds `evaluateGate`.)
- [x] Add `validationCommands` support to `policies/products.json` / product config parsing; set
      Rune to `["npm run build", "npm test"]`. (`readProductsConfig` now parses `validationCommands`
      into the ProductConfig literal mirroring `egressAllowlist` — `Array.isArray ? .map(String) : []`,
      always an array, fail-closed `[]`. Added `"validationCommands": ["npm run build","npm test"]` to
      the jarvis entry in `policies/products.json`; other products omit it → `[]` → gate fails closed
      with `missing-validation-command`. Field kept optional on the type so unrelated ProductConfig
      test literals still compile (the gate-runtime reads it as `?? []`); added `validationCommands: []`
      to the recovery-finalize test fixture. 5 sandbox-runtime validationCommands tests green (46 total);
      tsc unchanged. Review: code PASS, security PASS_WITH_WARNINGS — the execFile/no-shell +
      metacharacter-rejection mandate for the EXECUTOR is recorded in `work-run-gate-runtime.ts` and
      deferred to the `runGate` runtime task (no execution here; the spec pins the `string[]` shape).)
- [x] Run the gate's checks in an integration worktree (or on the branch) so a red result never
      leaves local `main` altered (test before mutating main). (Implemented `runGate(opts, io?)` in
      `work-run-gate-runtime.ts`: creates a DETACHED integration worktree at baseBranch
      (`git worktree add --detach` — avoids "branch already checked out") → conflict-probe merge of
      the feature branch into it (abort + scrubbed-stderr warn on any failure → fail-closed
      mergeConflict) → `status --porcelain` treeClean check (before validation, so artifacts can't
      dirty it) → runs each validationCommand in the integration worktree → assembles GateFacts →
      `evaluateGate`; the throwaway worktree is ALWAYS torn down in `finally` (guarded by a
      `worktreeCreated` flag so a failed add still cleans up). The product repo's real `main` checkout
      is never touched. Default executor `defaultRunValidationCommand`: NO-shell `spawn(bin,args,
      {detached:true})` (argv split — injection-safe by construction), timeout group-kills the whole
      process group (SIGTERM→SIGKILL after WORK_RUN_REAP_GRACE_MS via negative-pid), both timers
      unref'd + cleared, `close`-event settle-guarded, register/unregisterActiveProcess for graceful
      shutdown. 3 real-temp-repo gate-runtime tests green; tsc unchanged. Review trio
      PASS_WITH_WARNINGS — fixed the worktree-add-leak (ERROR), unref'd/cleared the reap timers,
      scrubbed merge + teardown logs, `exit`→`close`, documented the merge-lock @precondition. Deferred
      (justified): schema stays `string[]` per spec req 16; VALID_SLUG path-guard on the worktree path
      noted (caller computes it via slug-validated machinery).)
- [x] Per-product / per-base-branch lock (not per-project), respecting the single-writer assumption
      (`config.ts:250`, `supervision-store.ts:10-15`). (Implemented `baseBranchLockKey(product,
      baseBranch)` → `<product>:<baseBranch>` and `withBaseBranchLock(product, baseBranch, fn)` in
      `work-run-merge-lock.ts` by DELEGATING to the existing `withFileLock` in-process async mutex
      (`src/intent/backlog-write-lock.ts`) with a `merge:`-prefixed key — no re-implemented
      tail-chaining queue, separate lock domain from backlog file-path keys. Inherits
      serialize-same-key / parallelize-distinct-key / release-on-throw / value-passthrough. 9
      merge-lock tests green; tsc unchanged; code review PASS (security N/A — in-process mutex, no I/O).
      The jobs→intent crossing matches `scaffold-approval.ts`'s existing `withFileLock` import.)
- [x] Push before deleting the branch; record durable resumable phases (`merged-not-pushed`,
      `pushed-not-deleted`, …) so a crash mid-finalize is resumable by Phase 1's P0.4 recovery.
      (Delivered by the gated-merge finalizer impl — `runGatedMerge` records `merged-not-pushed`
      BEFORE calling pushBranch and `pushed-not-deleted` BEFORE deleteBranch, so push always precedes
      delete (origin is the durable backup) and `readLastPhase()` lets a crash resume at the exact
      next step: resume from `merged-not-pushed` skips re-merge → push→delete; from
      `pushed-not-deleted` skips merge+push → delete only. Pinned by the push-before-delete ordering
      test + the 4-case crash-resume matrix in `work-run-finalizer.test.ts` — all green.)

### P1.6 — Failure / partial / cancelled path

- [x] Route failure/partial/cancelled runs through the finalizer: always reap the tree + flush
      transcript/summary, never merge, remove the worktree after preserving forensics OR mark
      explicit `blocked-on-human`; supervision ends terminal or intentionally blocked, never
      quiet-pinging `running`; branch retention/deletion recorded. (Live `workRunApplier.apply()`
      terminal sequence now routes through `runFinalizer` in `hold` mode — work-runner is the second
      live finalizer consumer alongside recovery. Effects wrap the existing classify/flush/summary/
      index logic; `removeWorktree`/`writeSupervisionTerminal`/`recordPhase` are inert in the live
      path (the outer `finally` owns teardown for ALL paths incl. early-return setup failures;
      mutations.ts owns the supervision write on the yielded terminal — no double-destroy, no
      double-write). So every failure/partial/cancelled run flows through the shared machine that
      guarantees flush+summary+index, never-merge, branch-retained, never-left-`running`. Reaping is
      already owned by `streamProcess` (P0.2 watchdog + reapTree) upstream of the terminal. The
      terminal event is read off `FinalizerResult.terminalEvent` (simplifier: removes the mutable
      closure capture). Behavior-preserving — no merge-policy change; gated-merge ACTIVATION
      (branch-complete → `gated-merge` mode + the merged-notification surface) is a deliberate,
      separately-activated step, NOT enabled in this autonomous run since it turns on autonomous
      merges to a real `main`. 3 live-surface §7 guard tests added to `work-runner.test.ts`; 79
      work-runner+finalizer tests green, tsc unchanged, full suite no new regressions.)
- [x] If a transient "wrapping-up" state is needed, model it without widening the persisted status
      union; only add a `MutationStatus`/supervision enum value if shown unavoidable, and then as a
      deliberate cross-surface change (`supervision.ts`, `supervision-store.ts:25`). (No transient
      state needed: `hold` mode reaches a terminal supervision status (`completed`/`failed`) directly
      via the existing enum — mutations.ts flips status on the yielded terminal exactly as before. No
      new `MutationStatus`/supervision value added. The "OR mark explicit `blocked-on-human`" option
      in the requirement reuses the EXISTING persisted `blocked-on-human` status — no enum widening.)

## Phase 3.5 — Live gated-merge activation (DECISION: option #2, [[2026_06_07]])

> Depends on: Phase 3. Precedes Phase 4 (Phase 4's incident replay exercises THIS live wiring).
>
> **Operator decision (2026-06-07):** option #2 — *activate gated-merge live now*. The P1.6 note and
> P1.5 note both deferred this as "the live work-runner gated-merge wiring"; it is no longer deferred.
> This turns on autonomous merges to jarvis's real `main` behind the hard gate.
>
> **Run non-interactively.** The run that surfaced this decision (`5808d5cd`) died because its
> `AskUserQuestion` auto-denied in an unattended run — the exact terminal-correctness bug this project
> fixes. Do NOT gate activation on an interactive question; the decision is recorded here. If a genuine
> blocker appears, stop at `blocked-on-human` and alert, do not silently re-ask.
>
> **Go-live (merge this branch → `main` + restart the jarvis server) stays a human step**, performed by
> the operator after this phase is green and Phase 4 proves the chain. Do not self-merge this branch.

### Tests (write first)

- [x] Write a live-wiring test in `work-runner.test.ts`: a branch-complete terminal routes through
      `runFinalizer({ mode: 'gated-merge' })` with the real injected effects, and the outer `finally`
      does NOT double-destroy the worktree once the finalizer owns teardown (assert a single teardown
      via the `finalizerOwnedTeardown` guard) — test-plan.md §6/§8. (Added the "apply — branch-complete
      routed through the gated-merge finalizer (Phase 3.5)" describe to `work-runner.test.ts`: the
      mode-`gated-merge`+baseBranch test is RED, the single-teardown test is a green regression guard.
      Spy-wraps the real `runFinalizer` via a partial module mock so the existing hold-mode tests keep
      real behavior.)
- [x] Write effect-construction tests proving the gate effect is `runGate` wrapped in
      `withBaseBranchLock(product, baseBranch)`, merge/push/delete are the decomposed `realMergeBranch`
      git steps (push BEFORE delete), and `recordPhase`/`readLastPhase` persist to a durable per-run
      phase store that P0.4 recovery can resume from in `gated-merge` mode. (3 RED tests: gate wrapped
      in withBaseBranchLock (mocks `work-run-gate-runtime`/`work-run-merge-lock`), merge→push→delete
      ordering via the recording `deps.runGit` stub with the decomposed effects pinned as separate
      functions, and phases recorded/read through the new optional `recordWorkRunPhase`/
      `readLastWorkRunPhase` seam on `WorkRunRuntimeDeps` keyed by run id. Added the seam scaffold +
      `getProductConfig` baseBranch source.)
- [x] Confirm red before implementation. (4 Phase 3.5 tests RED for the right reason — clean
      assertion failures: `'hold' ≠ 'gated-merge'`, `effects.gate undefined`, `mergeIdx -1`,
      `recordWorkRunPhase not called` — no syntax/import/crash errors; 49 existing + green-guard tests
      pass, my files typecheck clean, full suite shows no new regressions.)

### Wiring

- [x] Flip the live terminal path (`work-runner.ts:594-595`) from `{ mode: 'hold' }` to
      `{ mode: 'gated-merge', baseBranch }` for a branch-complete outcome; everything else still resolves
      through the hold tail (`runGatedMerge` already merges only branch-complete and holds the rest).
      (`apply()` now always calls `runFinalizer({ mode: 'gated-merge', …, baseBranch })`; baseBranch is
      sourced from `getProductConfig(product).baseBranch`, fail-closed if the config is unreadable at
      finalize.)
- [x] Construct the real injected effects the live call site currently passes as no-ops: `gate` =
      `runGate({ baseBranch, validationCommands from products.json, commandTimeoutMs:
      WORK_RUN_GATE_COMMAND_TIMEOUT_MS })` inside `withBaseBranchLock`; `mergeBranch`/`pushBranch`/
      `deleteBranch` = the decomposed `realMergeBranch` (`gen-eval-loop-runner.ts:254-302`) git steps
      honoring its half-merged push-failure warning; real `removeWorktree` (finalizer removes AFTER
      merge/push, BEFORE delete); real `writeSupervisionTerminal`; real `recordPhase`/`readLastPhase`
      against a durable per-run phase store. (Done: `gate` = `withBaseBranchLock(product, baseBranch,
      () => runGate({…, concurrentRun: live read, tasksRemaining: captured from classify}))`;
      `mergeBranch`/`pushBranch`/`deleteBranch` run through `deps.runGit` in the product repo — push
      uses explicit `origin <baseBranch>`, errors are `redactSecrets`-scrubbed, the half-merged
      push-failure logs+rethrows so recovery resumes from `merged-not-pushed`; `removeWorktree` =
      `destroyWorktree` + `finalizerOwnedTeardown` flag. `writeSupervisionTerminal` stays INERT in the
      live path by design — mutations.ts owns the supervision write on the yielded terminal (recovery,
      which has no generator, uses a real write); `recordPhase`/`readLastPhase` back onto the new
      durable per-run phase store (`recordWorkRunPhase`/`readLastWorkRunPhase` in `work-run-store.ts`,
      `logs/work-runs/<id>/phase`). The finalizer's `runGatedMerge` was reordered to delete the branch
      AFTER worktree removal (a checked-out branch can't be `git branch -d`'d) via an `onBranchDelete`
      callback in `resolveWorktreeAndFinalize`.)
- [x] Guard the outer `finally` `destroyWorktree` (`work-runner.ts:621-636`) with a
      `finalizerOwnedTeardown` flag set inside the real `removeWorktree` effect, so gated-merge teardown
      is not double-destroyed (the inline TODO at `:621` calls for exactly this). (Flag declared at the
      apply() outer scope, set true only AFTER a successful `destroyWorktree` inside the effect; the
      outer `finally` now runs `if (sandbox && !finalizerOwnedTeardown)` — a removeWorktree that threw
      leaves the flag false so the `finally` retries; early-return/abort paths keep `finally` ownership.
      The Phase 3.5 "tears the worktree down exactly once" test pins no double-destroy.)
- [x] Wire the merged-notification surface: success → notify (Telegram + cockpit) `merged`/branch
      deleted, set `summary.json` `merged`/`branchDeleted`; gate-fail → `alert(reason)` that the run was
      held at `branch-complete` off `main` (never a silently-dropped alert). (After `runFinalizer`,
      `apply()` stamps `merged`/`branchDeleted`/`baseBranch` (+ `gateHeldReason` when held) onto the
      branch-complete terminal event and re-writes `summary.json` with the resolved disposition (the
      finalizer's own `writeSummary` ran before the merge). `TelegramSender.formatWorkRunTerminal`
      renders `✅ merged to <base> · branch deleted/retained` for a merged run and `✅ branch-complete ·
      held off <base>: <reason>` for a gate-held run — never a silent drop. The webview/cockpit receives
      the same disposition via the bus terminal event (`webview-sender.onMutationEvent`) and the
      persisted `summary.json` (read by `readWorkRunProjections`). Tests: telegram-sender merged + held
      formats, work-runner terminal-event + summary re-write.)
- [x] Make `recovery-finalize-runner` resume a run that crashed mid-gated-merge in `gated-merge` mode
      off its phase records (the P1.5 note flagged it currently re-drives `hold` only). (`finalizeStaleRun`
      reads `io.readLastPhase(run.id)`; when it shows the merge already landed (`merged-not-pushed`/
      `pushed-not-deleted`) it re-drives in `gated-merge` mode to complete the interrupted push/branch-
      delete — `runGatedMerge`'s `readLastPhase`/`reached()` skip the already-committed merge (gate +
      `mergeBranch` are throwing stubs that are never reached), real `pushBranch`/`deleteBranch` run in
      the product repo (push errors `redactSecrets`-scrubbed), and the run's outcome is FORCED
      `branch-complete` since the recorded phase is authoritative over recovery's absolute-task-count
      re-classification (else the push would be stranded). Crucial safety: recovery NEVER INITIATES a
      merge at boot — a run with no merge phase (or a pre-merge phase) stays in `hold` mode. Post-resume
      it re-stamps `summary.json` with `merged` so the cockpit shows merged, not gate-held. New
      `RecoveryFinalizeIO` seams `readLastPhase`/`recordPhase`. Tests: resume-from-merged-not-pushed
      (push→delete, no re-merge, forced branch-complete past later-phase unchecked boxes, summary
      re-stamped), resume-from-pushed-not-deleted (delete only), and pre-merge-phase-stays-hold-mode.
      Review (code + architecture): PASS_WITH_WARNINGS — applied the summary re-stamp + timeout-comment
      fixes; boot-push-latency + throwing-stub-diagnostics noted as acceptable.)

## Phase 4 — Cross-mode regression suite (P2.8)

> Depends on: Phase 3, Phase 3.5 (the incident replay exercises the live gated-merge wiring).

### Tests (write first)

- [x] Write the full incident replay for `d0679453`: `result: success` → child never exits → drain →
      group reap → `reapedAfterTerminalResult` → classify `branch-complete` → gate green → merge →
      push → terminal `merged`, asserting no quiet ping re-fires and no human acts — test-plan.md §8.
      (Added the `d0679453 replay` end-to-end test to `work-runner.test.ts` (fake-timer driven, manual
      child that emits `result` then never closes): asserts the watchdog SIGTERM-reaps, the terminal
      carries `exitFact: 'reaped-after-terminal-result'` (not external-kill), classifies
      `branch-complete` (not failed-on-signal), the gate passes and the run reaches a `completed`/
      `merged: true` terminal with merge+push git calls — and `finished === true` (the run self-completes,
      no human). The "no quiet ping re-fires" half is the supervision-store P0.1 guard, below.)
- [x] Write the per-mode regression matrix: result-before-exit; result-then-reap classifies
      branch-complete; quiet marker survives keep-alive; supervision-store divergence; and
      resume/branch-reuse cleaning ALL of a project's run records (cross-listed with the adjacent
      re-fork bug) — test-plan.md §8. (Covered as a standing matrix across the suite, all green against
      the completed Phases 1–3.5 — no duplication: **result-before-exit reaches terminal** =
      work-runner.test.ts watchdog "exits within window → no reap, clean exit fact"; **result-then-reap
      → branch-complete** = the d0679453 replay above + work-run-classify.test.ts exit-fact taxonomy;
      **quiet marker survives keep-alive / supervision-store divergence cannot clear the guard** =
      supervision-store.test.ts "upsertRun — field-merge across heartbeats (P0.1)"; **resume/branch-reuse
      cleaning ALL run records** is the adjacent re-fork bug, tracked separately per spec — 🟡 out of
      scope here.)
- [x] Write finalizer-resume-at-each-phase and merge-conflict / push-failure
      don't-delete-prematurely integration tests — test-plan.md §8. (**Resume-at-each-phase** =
      work-run-finalizer.test.ts "gated-merge crash-resume matrix" (resume from `merged-not-pushed` →
      push+delete no re-merge; from `pushed-not-deleted` → delete only) + recovery-finalize-runner.test.ts
      live resume tests; **merge-conflict stops at branch-complete, main untouched** =
      work-run-gate.test.ts `merge-conflict` + work-run-finalizer.test.ts per-gate-fail-reason block;
      **push-failure don't-delete-prematurely** = NEW work-run-finalizer.test.ts test — a push throw after
      a successful merge leaves `deleteBranch` UNCALLED and stops at `merged-not-pushed` (never
      `pushed-not-deleted`), so the branch survives for a recovery push-retry.)
- [x] Confirm red before implementation. (N/A by construction — Phase 4 depends on Phases 1–3.5 being
      COMPLETE, so the regression suite verifies finished behavior and is GREEN, not red. The
      write-first/confirm-red discipline applied within each earlier phase; this phase is the standing
      guard that the completed cross-mode behavior does not regress.)

### Suite

- [x] Land the cross-mode regression suite covering every observed failure mode above as a standing
      guard against recurrence; wire it into the project's test run. (The suite is the union of the
      named tests across `work-runner.test.ts`, `work-run-finalizer.test.ts`, `work-run-classify.test.ts`,
      `supervision-store.test.ts`, `work-run-gate.test.ts`, and `recovery-finalize-runner.test.ts` —
      every one auto-discovered and run by `npm test` (vitest), so the guard is wired with no extra
      config. The two NET-NEW Phase 4 tests (the d0679453 end-to-end replay + the push-failure
      don't-delete guard) close the only gaps the per-phase unit suites didn't already cover.)
