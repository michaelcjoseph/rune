# Product-Team Orchestrated Work Test Plan

Verification for the merged role-agent and Jarvis-orchestrated work project: role substrate,
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
- [ ] High: Jarvis is registered as a targetable product when needed.
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

- [ ] Critical: Jarvis selects the first unchecked task from `tasks.md` before invoking a
      task executor.
- [ ] Critical: Task N+1 receives bounded handoff input, not Task N's transcript or
      accumulated conversation.
- [ ] Critical: Task run records include task id/text, attempt id, roles invoked, transcript
      ids, model/provider choices, commit sha, verdicts, context outcome, and gate decisions.
- [ ] Critical: Task closeout updates exactly the selected checkbox in `tasks.md`, updates
      `context.md`, runs closeout checks, records a closeout commit, and verifies the worktree
      is clean.
- [ ] Critical: Closeout failure blocks durably and does not advance to the next task.
- [ ] Critical: Repeated task failure stops at the configured attempt cap and routes to PM
      wrap-up or blocked-on-human; it does not retry forever.
- [ ] Critical: After restart, Jarvis reconstructs partial project run state without replaying
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
- [ ] Critical: Open objection-class findings block task completion.
- [ ] High: The reviewer verdict carries a machine-readable objection-class payload
      (class, severity, location, rationale) the orchestrator can gate on — distinct from a
      bare pass/fail.
- [ ] Critical: PM wrap-up does not clear unresolved objection-class findings.
- [ ] High: Non-objection disagreement at the configured cap routes to PM; unresolved PM
      decisions enter blocked-on-human.
- [ ] High: Designer is invoked when the tech-lead sizing flags a task front-end/designer-needed
      and skipped by default otherwise (routing keys off the flag, not runtime inference).
- [ ] High: Task workflow returns ready-for-closeout/blocked/failed, role verdicts, and
      handoff notes without marking tasks complete, writing context, or merging to main.
- [ ] Low: Role invocation failures include structured reason data for retry/model swap.

## 5. Multi-task orchestration and finalizer handoff

- [ ] Critical: A task cannot advance until gates pass, closeout checks pass,
      `tasks.md`/`context.md` closeout is committed, and the worktree is clean.
- [ ] Critical: Blocked/failed/objection-open task is not skipped.
- [ ] Critical: Fixture run advances through at least two tasks.
- [ ] Critical: Fixture includes a context update from task N that affects task N+1 input.
- [ ] Critical: When no unchecked tasks remain, orchestrator hands branch/run facts to Project
      15 finalizer; it does not implement an independent merge path.
- [ ] Critical: If Project 15 finalizer is unavailable, Jarvis records the handoff payload and
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
- [ ] High: Given feedback on a known miss, Jarvis-owned post-mortem attributes it to the
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

---

## Integration Verification

Run a deterministic fixture through planning: PM writes a spec with assumptions, tech lead
breaks it into tasks, role sizing, test strategy, and explicit front-end/designer-needed
flags, PM confirms spec/tech-spec match, and Jarvis seeds `context.md`.

Run orchestrated work through injected spawners/readers: Jarvis selects task 1, QA writes
tests or records a no-code-test rationale according to task strategy, tech lead reviews it,
coder implements, reviewer and tech lead review, designer runs only when the tech-lead sizing
flag requires it, objection-class gates clear, Jarvis performs closeout (`tasks.md` checkbox
+ `context.md` + closeout checks + commit + clean worktree), Jarvis advances to task 2 with
that context included, then hands the completed project to an injected Project 15 finalizer
adapter. No live model call, Telegram interaction, or production push is required.

Feed a valid fixture feedback record into the nightly post-mortem seam. Jarvis attributes the
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
