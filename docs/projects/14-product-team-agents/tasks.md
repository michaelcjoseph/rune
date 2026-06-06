# Product-Team Role-Agents — Tasks

See [spec.md](spec.md) for architecture and [test-plan.md](test-plan.md) for verification.

> **Test-first by default.** Every phase below opens with a **Tests (write first)** block.
> Those tests mirror the matching [test-plan.md](test-plan.md) sections and must fail (red)
> before any implementation task in the phase begins. A phase's implementation is done when its
> test-plan sections pass.
>
> Granularity here is the meaningful deliverable, not a granular sub-task. Per-task file layout,
> schemas, and signatures are settled in `/work`'s Plan phase, against the spec. Much of the
> substrate (worktree, gen-eval-loop, cross-model adjudication, round cap, autonomous merge)
> **already exists** — see spec.md "Built on what exists". These tasks are the team-and-memory
> layer on top.
>
> **Agent-runnable gate.** The project completion gate uses deterministic fixtures, injected
> spawners/readers, and controlled repo paths. Real PM interviews, real user feedback, and a
> live merge of an arbitrary jarvis task are production usage/smoke checks, not blockers for an
> implementation agent.

## Phase 1 — Role substrate

> Depends on: nothing.

### Tests (write first)

- [ ] Loader authority test: the composed call puts a role's `SOUL.md` in
      `--append-system-prompt` and its `memory.md` in the first user message; memory text is
      absent from the appended system prompt — test-plan.md §1.
- [ ] Cold-start test: empty `memory.md` yields a valid SOUL-only prompt, no error.
- [ ] Budget test: a `memory.md` over the per-role char budget truncates the loaded
      `referenceContext` with a visible marker without deleting entries from disk.
- [ ] Path test: the loader reads `SOUL.md`/`memory.md` from `PROJECT_ROOT/agents/<role>/` for
      each of the six roles, not via `readVaultFile`.
- [ ] Charter test: each role has a `SOUL.md` and empty-or-seeded `memory.md`; each charter
      states its mandate and review edges from the team table.
- [ ] Confirm all suites above are red before implementation.

### Implementation

- [ ] Generalize the writer loader (project 12) into a role loader keyed by role name; per-role
      load-time char budget + truncation marker; returns `{ systemInstructions,
      referenceContext }`.
- [ ] Draft `jarvis/agents/<role>/SOUL.md` from this spec for PM, tech lead, QA, coder,
      reviewer, designer — each charter states the role's mandate, standards, and review edges.
      Create empty `memory.md` for each.
- [ ] Confirm jarvis is registered as a product the loop can target (`policies/products.json`);
      add it only if absent.

## Phase 2 — `plan` (PM + tech lead)

> Depends on: Phase 1.

### Tests (write first)

- [ ] Assumptions test: when the PM judges a brief specified-enough, the produced `spec.md`
      contains an **Assumptions** section enumerating the unspecified calls it resolved —
      test-plan.md §2.
- [ ] Interview-gate test: an underspecified brief enters an explicit PM-interview /
      blocked-on-human state rather than a silent spec; the test uses a fixture and requires no
      real Michael response.
- [ ] Spec-match test: the tech lead's tech spec is reviewed by the PM; a mismatch is flagged,
      not passed.
- [ ] Fixture-plan test: a specified-enough fixture brief completes `plan` without human input
      and produces spec/tasks artifacts plus a sizing decision.
- [ ] Confirm red before implementation.

### Implementation

- [ ] Wire the PM and tech-lead role identities into the planner behind `plan`.
- [ ] PM: judge specified-enough → write spec (with Assumptions section) or enter an explicit
      interview-needed blocked state; own the "done" definition for the task.
- [ ] Tech lead: produce tech spec + task breakdown + sizing (which roles convene for `work`).
- [ ] PM reviews the tech spec against the product spec (match check) before `plan` completes.
- [ ] Add fixture seams/test doubles for specified-enough and underspecified plan paths so the
      full project run does not depend on live user input.

## Phase 3 — `work` (QA + coder + reviewer + designer) on the existing loop

> Depends on: Phase 1, 2.

### Tests (write first)

- [ ] QA-first test: the QA tests exist and are tech-lead-reviewed **before** the first coder
      round runs — test-plan.md §3.
- [ ] Objection-gate test: an open objection-class finding (security / data / concurrency /
      irreversibility / cost) holds the merge and the loop keeps iterating; the PM's round-cap
      wrap-up does not clear it.
- [ ] Global-cap test: a single `work` run is bounded by a global round cap across review edges;
      at the cap with non-objection disagreement, the PM decides; unresolved PM decisions enter
      blocked-on-human.
- [ ] Independence test: the reviewer resolves to a different provider than the coder and is
      given the diff + spec + tests, not the coder's reasoning.
- [ ] Fixture-work test: injected spawners drive a full `work` run with QA-first, one
      diff-changing review round, merge contract clear, and no real model call or human input.
- [ ] Confirm red before implementation.

### Implementation

- [ ] Wire QA, coder, reviewer, designer role identities into `gen-eval-loop-runner.ts`
      (coder = Generator, reviewer = cross-model Evaluator).
- [ ] QA round writes tests from the spec before the coder round; tech-lead review of the tests.
- [ ] Extend `evaluateMergeContract` with the objection-class dimension: an open finding blocks
      merge; PM wrap-up authority excludes objection classes.
- [ ] Add a structured objection-class signal to the `/review` verdict (beyond `VERDICT:
      PASS/FAIL`).
- [ ] Add the global per-run round cap; on cap reached, route non-objection disagreement to PM
      decide and unresolved/objection-class cases to blocked-on-human.
- [ ] Designer reviews front-end diffs when the task is sized as having FE work.
- [ ] Keep orchestration injectable so tests can drive QA/coder/reviewer/designer behavior
      deterministically without real subprocess/model calls.

## Phase 4 — Loop-closure gate

> Depends on: Phase 1, 2, 3.

### Tests (write first)

- [ ] Gate assertion: a deterministic jarvis fixture task driven `plan` → `work` reaches
      autonomous merge in a controlled repo path with ≥1 review round that changed the diff and
      no human at the merge — test-plan.md §4.
- [ ] No-manual-gate assertion: the loop-closure gate can run with a fixture repo and injected
      spawners/readers; no real Telegram interaction, arbitrary task selection, or production
      push is required.

### Implementation

- [ ] Create/use a deterministic jarvis fixture task and controlled repo path; run it end to end
      through `plan` then `work` using the same runtime seams as production.
- [ ] Confirm the fixture merge landed autonomously, ≥1 review round changed the code, no human
      touched the merge. Record the outcome in the index row.
- [ ] Optionally run a live real-task smoke check after the automated gate; failures there are
      follow-up bugs, not blockers for the project completion gate.

## Phase 5 — The learning loop

> Depends on: Phase 4.

### Tests (write first)

- [ ] Attribution test: given a feedback record for a known miss, the nightly post-mortem
      attributes it to a stage and writes one atomic, provenance-stamped lesson into that role's
      `memory.md` — test-plan.md §5.
- [ ] No-feedback test: no feedback record → no post-mortem → no memory write.
- [ ] No-lesson test: a miss the retro judges uncatchable produces a "no lesson warranted"
      outcome and writes nothing.
- [ ] Compounding test: a lesson captured from run-N feedback loads into run N+1's role
      reference context.
- [ ] Fixture-feedback test: the learning-loop tests use an injected/temp feedback record and
      do not require Michael to leave real vault feedback.
- [ ] Confirm red before implementation.

### Implementation

- [ ] Nightly job: detect machine-readable feedback records (real vault tags may feed them;
      tests inject them), run a Jarvis-owned (not team-role) post-mortem that interviews each
      role as a witness and makes the attribution call.
- [ ] Capture: write one atomic, provenance-stamped, privacy-clean lesson into the attributed
      role's `memory.md` via a memory-scoped commit helper; allow "no lesson warranted".
- [ ] Confirm the compounding gate (run N → N+1) and record the outcome in the index row.

---

## Out of scope (recorded)

- Automating dispatch — `plan`/`work` stay manual in v1; the autonomous scheduler is deferred.
- Reimplementing the worktree / gen-eval-loop / cross-model adjudication / round cap /
  autonomous merge — these exist (project 08 Phase 6, project 11).
- Roles beyond the six; a general org-config runtime.
- A quality / engagement eval (deferred the project-12 way).
- A merge approval gate (merge is autonomous; revert by hand from usage).
- New model-dispatch machinery (model assignment goes through the existing model-policy).
- Requiring a real PM interview, real vault feedback, or a production merge of an arbitrary
  jarvis task for project completion; those are live smoke/usage checks outside the automated
  gate.
