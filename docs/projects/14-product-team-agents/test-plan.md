# Product-Team Orchestrated Work Test Plan

Verification for the merged role-agent and Rune-orchestrated work project: role substrate,
planner roles, `context.md`, per-task orchestration, role gates, finalizer handoff, fallback,
and the vault-driven learning loop.

This project is **test-first**: each numbered section below is written by a phase's
**Tests (write first)** task in [tasks.md](tasks.md), and those tests must fail (red) before
that phase's implementation begins. A phase is done when its sections pass.

The required verification is agent-runnable. Use deterministic fixtures, injected spawners and
readers, temp/controlled repo paths, and fixture feedback records. Real PM interviews, real
vault feedback, live model calls, and production pushes are optional smoke checks, not required
acceptance criteria.

> See also: [Cross-cutting test plan](../../tech/test-plan.md) for shared guidelines,
> monitoring, and security checks.

## Priority Levels

- Critical: breaks authority boundaries, task sequencing, merge safety, recovery, or memory
  write safety.
- High: weakens orchestration quality, context quality, attribution, privacy, or cap behavior.
- Low: optional diagnostics and smoke coverage.

## 1. Role substrate

- [ ] Critical: For each role, `SOUL.md` is passed as system-prompt authority and `memory.md`
      is passed only as low-authority reference.
- [ ] Critical: Loader reads role files from `PROJECT_ROOT/agents/<role>/`, not the vault.
- [ ] High: Empty `memory.md` yields SOUL-only prompt without error.
- [ ] High: Over-budget `memory.md` truncates loaded reference context with visible marker and
      leaves disk entries intact.
- [ ] High: Rune is registered as a targetable product when needed.
- [ ] Low: Each `SOUL.md` states role mandate and review edges.

## 2. Planner roles

- [ ] Critical: Underspecified brief enters PM-interview / blocked-on-human state; PM does not
      fabricate a silent spec.
- [ ] Critical: Produced `spec.md` includes an **Assumptions** section when PM makes calls.
- [ ] High: Tech lead output includes task breakdown, role-sizing metadata (including an
      explicit front-end / designer-needed flag per task), and per-task test strategy.
- [ ] High: PM reviews tech spec against product spec and flags mismatches.
- [ ] High: Planning seeds `context.md` with required sections.
- [ ] Low: Raw assumptions stay in the spec; only distilled lessons reach role memory.

## 3. Context and orchestrator substrate

### `context.md`

- [ ] Critical: `context.md` contains `Current State`, `Key Decisions`,
      `Interfaces & Contracts`, `Known Risks`, and `Next Task Handoff`.
- [ ] Critical: Post-task context update preserves all required sections.
- [ ] Critical: Transcript-style dumps or over-budget updates are rejected or compressed.
- [ ] High: Technical contract changes require tech-lead validation.
- [ ] High: Product-intent changes require PM validation when flagged.
- [ ] High: Roles can emit handoff notes, but no role invocation writes `context.md` directly.

### Orchestrator substrate

- [ ] Critical: Rune selects the first unchecked task from `tasks.md` before invoking a
      task executor.
- [ ] Critical: Task N+1 receives bounded handoff input, not Task N's transcript or
      accumulated conversation.
- [ ] Critical: Task run records include task id/text, attempt id, roles invoked, transcript
      ids, model/provider choices, commit sha, verdicts, context outcome, and gate decisions.
- [ ] Critical: Task closeout updates exactly the selected checkbox in `tasks.md`, updates
      `context.md`, runs closeout checks, records a closeout commit, and verifies the worktree
      is clean.
- [ ] Critical: Closeout failure blocks durably and does not advance to the next task.
- [ ] Critical: Repeated task non-convergence stops via the Phase 14 all-low exit,
      stagnation backstop, or hard round budget; it does not retry forever or route to PM /
      blocked-on-human.
- [ ] Critical: After restart, Rune reconstructs partial project run state without replaying
      completed tasks.
- [ ] High: Stale `tasks.md` state is detected and blocks or reloads safely.

## 4. Team-task workflow

- [ ] Critical: QA tests exist and are tech-lead-reviewed before coder starts on
      `code-tests-required` tasks.
- [ ] Critical: Docs/config-only tasks record a QA no-code-test rationale and tech-lead review
      before coder starts.
- [ ] Critical: Reviewer resolves to a different provider than coder when model policy
      requires evaluator/provider distinction.
- [ ] Critical: When no distinct-provider reviewer can be resolved (executor unavailable),
      the task blocks rather than accepting same-provider review — independence is fail-closed,
      never silently downgraded.
- [ ] Critical: Reviewer input contains diff, spec, tests, task, and bounded context; it does
      not contain coder hidden reasoning.
- [ ] Critical: Objection-class findings gate task completion by severity: low records a
      warning; medium/high/critical drive another coder/reviewer round; only terminal
      non-reversible high/critical residue holds the branch.
- [ ] High: The reviewer verdict carries a machine-readable objection-class payload
      (class, severity, location, rationale) the orchestrator can gate on — distinct from a
      bare pass/fail.
- [ ] Critical: PM wrap-up is not part of the per-task terminal path; unresolved findings route
      through Phase 14 terminal handling.
- [ ] High: Non-objection disagreement above `low` participates in the same convergence loop and
      terminal handling; it does not route to PM or blocked-on-human.
- [ ] High: Designer is invoked when the tech-lead sizing flags a task front-end/designer-needed
      and skipped by default otherwise (routing keys off the flag, not runtime inference).
- [ ] High: Task workflow returns ready-for-closeout or terminal-handling evidence, role
      verdicts, findings ledger, and handoff notes without marking tasks complete, writing
      context, or merging to main.
- [ ] Low: Role invocation failures include structured reason data for retry/model swap.

## 5. Multi-task orchestration and finalizer handoff

- [ ] Critical: A task cannot advance until gates pass, closeout checks pass,
      `tasks.md`/`context.md` closeout is committed, and the worktree is clean.
- [ ] Critical: Blocked/failed/objection-open task is not skipped.
- [ ] Critical: Fixture run advances through at least two tasks.
- [ ] Critical: Fixture includes a context update from task N that affects task N+1 input.
- [ ] Critical: When no unchecked tasks remain, orchestrator hands branch/run facts to Project
      15 finalizer; it does not implement an independent merge path.
- [ ] Critical: If Project 15 finalizer is unavailable, Rune records the handoff payload and
      stops branch-complete/blocked; it does not self-merge.
- [ ] Critical: Finalizer failure leaves durable terminal/blocked state, not ambiguous
      "all tasks done but not finalized".
- [ ] Critical: Legacy `/work --auto` fallback still works when orchestrated mode is disabled
      and records fallback explicitly.
- [ ] High: Finalizer receives enough task-level evidence for useful terminal summaries and
      forensics links.
- [ ] High: The cockpit per-project start action (`POST /api/mutations`) dispatches the
      orchestrated applier when the rollout toggle selects orchestrated mode, and the legacy
      `/work --auto` applier when it does not — verified at the dispatch seam without a live
      run.
- [ ] High: The cockpit project card or Start confirmation displays the selected dispatch
      mode before launch; fallback runs expose the fallback reason in run details/transcript
      metadata.
- [ ] Low (smoke): A real cockpit Start click on a fixture project kicks off an orchestrated
      run and the project card shows run status / outcome / transcript link. Optional smoke,
      not required acceptance.

## 6. Learning loop

- [ ] Critical: No feedback record means no post-mortem and no memory write.
- [ ] Critical: Feedback records are explicit machine-readable inputs read through an
      injected/configured reader and include project slug, source, createdAt, issue summary,
      evidence, expected/actual behavior when applicable, and optional run/task id.
- [ ] Critical: Malformed feedback records are skipped with a durable reason and do not
      trigger post-mortem or memory writes.
- [ ] Critical: Captured lessons are provenance-stamped, privacy-clean, and committed
      atomically into the attributed role's `memory.md`.
- [ ] High: Given feedback on a known miss, Rune-owned post-mortem attributes it to the
      correct stage and role.
- [ ] High: A miss judged uncatchable produces "no lesson warranted" and writes nothing.
- [ ] High: A lesson captured from run N loads into run N+1's role reference context.
- [ ] High: Learning-loop tests use fixture feedback records through injected/temp readers.

## 7. Project closeout and checklist compliance

- [ ] Critical: The three deferrals named in the spec have ADR files in
      `docs/projects/14-product-team-agents/` with status, context, decision, rationale, and
      trigger-to-promote sections.
- [ ] Critical: Project closeout writes `agent-lessons.md` with propagated lessons, or an
      explicit "no new lessons" rationale; any lesson that needs propagation names and updates
      the target surface or queues it in the planning-checklist TODO block.
- [ ] High: The final project completion check includes the Phase 5 trigger-surface dispatch
      seam and mode-visibility tests, so closeout cannot mark the project complete while
      orchestrated work is still not user-reachable.

## 10. Execution observability parity

- [ ] Critical: A working orchestrated run emits `activity`/`output` events between the start
      and terminal events when roles report activity; the old two-event gap is impossible.
- [ ] Critical: `lastHeartbeatAt` and `lastOutputAt` advance during a long-running role
      session, and the quiet-nudge / quiet-cancel path does not fire while activity streams.
- [ ] Critical: `runCodex` streams incrementally before process close. `codex exec --json` is
      the default; unsupported or malformed JSONL falls back automatically to scrubbed raw-line
      streaming with fallback metadata.
- [ ] Critical: Claude artifact-role sessions use stream-json display mapping and stream
      through the same event sink as Codex roles.
- [ ] Critical: Team-task workflow emits labeled role-stage transitions and verdict/objection
      summaries with role/provider/model attribution.
- [ ] Critical: Every streamed line is path/secret-scrubbed before it leaves the process.
- [ ] Critical: A completed orchestrated run writes `transcript.jsonl`, `summary.json`, and
      work-product classification under `WORK_RUNS_DIR/<runId>/`.
- [ ] Critical: A clean `branch-complete` orchestrated run invokes the Project 15 finalizer in
      `gated-merge` mode and merges/pushes only through the gate.
- [ ] Critical: Failed finalizer gate or open high/critical objection-class finding records a
      hold and never touches the base branch.
- [ ] Critical: The Phase 8 finalizer `unavailable` hold stub is removed and regression-guarded.
- [ ] High: Cockpit run projection shows the orchestrated transcript tail / last output while
      the run is active.
- [ ] High: Live acceptance uses a self-contained temp repo and local bare remote for
      merge/push assertions, with no production push credentials or operator action.

## 11. Orchestration resilience

- [ ] Critical: Gate rejection evidence includes structured feedback: rejecting role,
      counterpart/rejected role, rejected artifact, what failed, and actionable notes.
- [ ] Critical: QA test-intent rejection enters a bounded QA rewrite loop with the tech-lead's
      feedback in the next QA input; it is not a one-shot block.
- [ ] Critical: Coder retry inputs include reviewer and tech-lead-diff feedback from the
      failed round; no retry path repeats identical role inputs with no feedback.
- [ ] Critical: Exhausted feedback retries preserve branch/worktree and route through Phase 14
      terminal handling instead of ending destructively or parking blocked-on-human.
- [ ] Critical: `TaskRunRecord`s, run cursor, and resume marker persist enough product,
      branch, base, worktree, and task-cursor data to reconstruct a partial run at task
      granularity. (Intra-task convergence state — the Phase 14 findings ledger and round history —
      is in-memory, rebuilt by re-running the interrupted task, and intentionally not persisted;
      Phase 14 also removes the `attemptCap` cursor field, and resume tolerates an older cursor that
      still carries it.)
- [ ] Critical: Boot recovery reconstructs still-running/resumable orchestrated mutations and
      re-dispatches against the existing branch instead of orphaning them.
- [ ] Critical: A single-run lease prevents two server processes from resuming the same
      mutation concurrently.
- [ ] Critical: Terminal writes are idempotent; crash recovery and late generator drain cannot
      append two terminal records for one mutation id.
- [ ] Critical: Orphan-worktree cleanup skips resumable runs, or branch-resume rebuilds the
      worktree deterministically before execution resumes.
- [ ] High: Live acceptance injects a restart mid-run and verifies completion with exactly one
      terminal, plus a forced gate rejection that passes after a corrective retry.

## 12. Role learning and exemplars

- [ ] Critical: `composeRoleContext` loads SOUL as authority and memory/exemplars as
      low-authority reference; exemplars are budget-bounded and visibly truncated/skipped when
      invalid.
- [ ] Critical: Each role has a permanent `agents/<role>/examples/` baseline; QA includes a
      correct redaction/security-boundary test using real secret-shaped input and asserting raw
      secret absence.
- [ ] Critical: Tech-lead planning emits per-project exemplars, persists them with the project,
      and the relevant role invocation receives them.
- [ ] Critical: Each gate block emits the same structured rejection record used by Phase 11
      corrective retries; learning does not invent a second schema.
- [ ] Critical: The rejecting role may draft a candidate lesson, but a neutral Rune validation
      pass privacy-filters, dedupes, attributes, and may fail safe to no-lesson before any
      memory write.
- [ ] Critical: Passing gate-time validation writes the lesson to the counterpart role's
      memory through `writeRoleLesson`; roles never write memory directly.
- [ ] Critical: Gate-time learning and the nightly feedback loop share the same write/dedupe
      path and do not double-write the same lesson.
- [ ] Critical: Drafting, validation, exemplar load, or memory-write failure records a durable
      skip/error and does not block the current corrective retry path.
- [ ] High: Live acceptance forces a QA->tech-lead redaction rejection, writes a validated QA
      lesson, then verifies a re-run loads the lesson/exemplar and passes the gate.

## 13. Outcome gating

- [ ] Critical: Reviewer, tech-lead diff, and designer gates normalize to a shared structured
      verdict with exactly one outcome: `pass`, `pass-with-warnings`, `fail`, or `block`; bare
      booleans are accepted only at adapter boundaries and never drive orchestration directly.
- [ ] Critical: Objection-class severity maps through one helper:
      `critical`/`high` -> `block`, `medium` -> `fail`, `low` -> `pass-with-warnings`; multiple
      findings resolve to the strictest mapped outcome.
- [ ] Critical: `pass-with-warnings` advances the task and records warnings in both the
      `TaskRunRecord` and finalizer handoff.
- [ ] Critical: `fail` threads structured feedback to the coder and retries within the round cap;
      a non-cleared fail at the cap routes to PM wrap-up.
- [ ] Critical: Reviewer-produced `block` receives exactly one feedback-threaded corrective
      coder round from a dedicated block-correction budget before parking; it never
      short-circuits with zero corrective attempts.
- [ ] Critical: A surviving block parks `blocked-on-human` with branch/worktree preserved and is
      not mapped to a failed terminal with destroyed work.
- [ ] High: The core accept-with-rationale seam requires a rationale, records it durably, and
      resumes the task as `pass-with-warnings`; cockpit/Telegram wiring is not required for this
      phase's automated acceptance.
- [ ] High: Unknown outcomes, malformed severities, or failed warning/acceptance recording fail
      closed to an operational `block` with a durable reason and park without consuming a coder
      corrective round.

---

## 14. Severity loop to convergence

- [ ] Critical: `GateVerdict.outcome` is exactly one of `pass`/`pass-with-warnings`/`fail`; `block`
      is not a producible outcome and no severity maps to it. `critical`/`high`/`medium` → `fail`,
      `low` → `pass-with-warnings`; multiple findings resolve to the strictest mapped outcome.
- [ ] Critical: No per-task path returns `blocked-on-human`, routes to PM wrap-up, or consults an
      outer attempt cap; `decideAttemptOutcome` and the block-correction budget are removed.
- [ ] Critical: Primary exit — a round whose max open severity is `low`/none exits to closeout with
      lows recorded as warnings.
- [ ] Critical: Stagnation backstop — a run whose max open severity holds flat for 3 consecutive
      rounds stops before round 4; a run that strictly drops each round runs past round 3 and exits
      via the all-low gate, not the backstop.
- [ ] Critical: Hard budget — a run still above `low` at round 4 stops and routes to terminal
      handling; round 5 never executes.
- [ ] Critical: Reversible hold — a remaining `critical`/`high` finding with `reversible: false`
      HOLDS the branch (no auto-merge); when all remaining `>low` findings are reversible the gated
      auto-merge proceeds and the run advances. Never `blocked-on-human`.
- [ ] Critical: Operational terminal — a non-finding failure (malformed/unparseable gate output,
      closeout/persist failure, rejected context update, dirty worktree) terminates as a durable
      non-merge HOLD with the operational reason recorded and branch/worktree preserved; it never
      auto-merges a broken closeout and never routes to `blocked-on-human` (req 83). The legacy
      work-run parked-run machinery is unaffected.
- [ ] High: A review-gate finding that OMITS or malforms `reversible` normalizes to
      `reversible: false` (fail-safe), is never dropped, and a high/critical such finding therefore
      HOLDS at terminal rather than silently merging.
- [ ] High: `TaskEvidence` returned to the orchestrator carries the terminal findings ledger and the
      loop-exit reason; the orchestrator's terminal handler drains/decides from it without
      re-deriving findings. `block` is no longer a producible outcome and the Phase 13 block-model
      assertions are retired (suite green against the 3-value model).
- [ ] High: A review-gate finding carries `{class, severity, location, rationale, reversible}` with
      `class` ∈ {`security`,`privacy`,`data-integrity`,`concurrency`,`outbound`,`cost-perf`};
      `irreversibility` is rejected and `reversible` is required.
- [ ] High: The findings ledger persists across rounds; re-review verifies each open prior finding
      (citing it) before discovery; a reappearing `resolved` finding is marked `regressed`, and
      repeated sightings update a stable finding id rather than creating duplicate ledger rows.
- [ ] High: Tech-lead diff review and designer review (when designer-needed) still run inside
      each convergence round; their findings enter the shared ledger with `sourceGate`
      attribution.
- [ ] High: The coder receives the ledger severity-sorted, attempts every open finding, addresses
      the highest severity first, and reports which it addressed.
- [ ] High: At terminal the orchestrator writes one detailed entry per remaining `>low` finding to
      the Rune repo's `docs/projects/bugs.md` (finding id, source gate, class, severity, location,
      rationale, reversible flag, run/task id), deduped by run/task/finding id, through the backlog
      safe-write substrate (`withFileLock`/`assertBacklogWriteAllowed`/`writeFileAtomic`) — durable
      whether the run subsequently HOLDS or merges, and not written into the product worktree.

---

## 15. Project completion and progress alerts

- [ ] Critical: A clean merge-bound `branch-complete` terminal sets the matching project's status to
      `Done` in BOTH the `docs/projects/index.md` table Status cell AND the `## <slug> — <status>`
      section heading, in the feature worktree, with exactly one dedicated commit after
      classification and before the finalizer gate/merge.
- [ ] Critical: The index writer changes only the matched project's two status tokens; project link,
      summary text, table header/alignment row, section body, `(…)` heading suffix, row order, and
      unrelated rows/headings are preserved byte-for-byte.
- [ ] Critical: `summary.json`, the work-runs index row, and the terminal payload include the
      project-Done commit's head sha/commit count; the finalizer does not persist stale
      pre-index-flip work-product facts.
- [ ] Critical: An all-tasks-checked run with zero commits classifies `noop` — the index flip never
      fires and the run never merges (the flip is gated on the classified `branch-complete` outcome).
- [ ] Critical: A worktree with NO `docs/projects/index.md` is a graceful skip — the finalizer still
      merges, with no HOLD and no index commit.
- [ ] Critical: A PRESENT-but-malformed table, zero matching rows/headings, or multiple matches
      produces an operational HOLD with branch/worktree preserved; it does not edit the base branch,
      guess a row, or merge with the index unresolved.
- [ ] Critical: A `git merge` conflict on `docs/projects/index.md` (concurrent landing) aborts the
      merge and HOLDs operationally with work preserved — never a half-merged dirty base.
- [ ] Critical: Crash/restart after `project-marked-done` but before `merged-not-pushed` resumes the
      gated finalizer, skips the already-committed index flip, runs gate/merge/push/delete, and
      reaches exactly one terminal without human release or manual retry.
- [ ] Critical: HOLD terminals (finding HOLD, operational HOLD, ambiguous-index HOLD, merge-conflict
      HOLD, or finalizer gate-fail HOLD) do not flip the project index to `Done` and do not emit a
      merge-success notification.
- [ ] Critical: A successful gated merge emits exactly one operator success notification naming the
      project and base branch, after the base branch push succeeds and finalizer cleanup has been
      attempted; the orchestrated terminal mutation message does not also claim a merge (single
      landing claim). Crash/restart resume from `pushed-not-deleted` does not double-send after the
      notification record exists.
- [ ] Critical: Each successful per-task closeout commit emits exactly one progress event keyed by
      commit sha with project slug, task label/text, short sha, commit subject, and live
      remaining/total counts from `tasks.md`.
- [ ] Critical: A task that reaches terminal handling without a closeout commit emits no progress
      alert.
- [ ] High: Progress alerts are deduped across orchestrator resume/replay by closeout commit sha;
      a new closeout commit still alerts once.
- [ ] High: Notification event-publication failures for progress or merge-success paths record
      durable skip/error metadata and never fail, hold, roll back, or otherwise change run outcome;
      downstream Telegram/webview delivery failures are logged by the sender and are also
      non-blocking.
- [ ] High: Telegram formatting is exercised through the existing mutation/activity sender path
      with an injected sender; no real Telegram bot is required.
- [ ] High: The Phase 8/10 live acceptance harness runs a multi-task throwaway project (whose
      fixture carries a `docs/projects/index.md` row + section heading) against a local bare remote
      and asserts: one progress alert per closeout commit, correct remaining/total counts, final
      project status `Done` in BOTH the table cell and section heading on the merged base branch,
      remote base branch pushed, and exactly one merge-success notification.

---

## Integration Verification

Run a deterministic fixture through planning: PM writes a spec with assumptions, tech lead
breaks it into tasks, role sizing, test strategy, and explicit front-end/designer-needed
flags, PM confirms spec/tech-spec match, and Rune seeds `context.md`.

Run orchestrated work through injected spawners/readers: Rune selects task 1, QA writes
tests or records a no-code-test rationale according to task strategy, tech lead reviews it,
coder implements, reviewer and tech lead review, designer runs only when the tech-lead sizing
flag requires it, objection-class gates resolve per Outcome gating, Rune performs closeout
(`tasks.md` checkbox + `context.md` + closeout checks + commit + clean worktree), Rune
advances to task 2 with that context included, then hands the completed project to an injected
Project 15 finalizer adapter. No live model call, Telegram interaction, or production push is
required.

For Phase 15, extend the injected finalizer fixture to the local bare remote harness: no real
Telegram or production push is required, but the acceptance run must exercise the real branch
index-Done commit, finalizer gate/merge/push/delete ordering, and injected notification sink.

Feed a valid fixture feedback record into the nightly post-mortem seam. Rune attributes the
miss and writes one atomic lesson into the relevant role memory. Feed a malformed record and
assert it is skipped with a durable reason. A subsequent role invocation loads the captured
lesson as low-authority reference.

**Trigger-surface integration (names the real user action).** With orchestrated mode enabled,
the cockpit per-project Start action (`app.js` confirm-modal → `POST /api/mutations`) dispatches
the orchestrated applier rather than legacy `/work --auto`; the run is observable on the same
project card (selected mode before launch, run status, outcome, transcript link from Project
11). The automated check asserts this at the dispatch seam (which applier the toggle selects)
and at the cockpit mode-visibility seam; a live click-through is an optional smoke check. This
is the user-reachability proof the planning checklist requires — without it, a green fixture
suite is the same false-done signal as a passing pure-core test.

Before marking the project done, verify the deferral ADRs and `agent-lessons.md` exist and
meet the planning-checklist requirements.
