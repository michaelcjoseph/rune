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

## Phase 1 — Role substrate

> Depends on: nothing.

### Tests (write first)

- [ ] Loader authority test: the composed call puts a role's `SOUL.md` in
      `--append-system-prompt` and its `memory.md` in the first user message; memory text is
      absent from the appended system prompt — test-plan.md §1.
- [ ] Cold-start test: empty `memory.md` yields a valid SOUL-only prompt, no error.
- [ ] Budget test: a `memory.md` over the per-role char budget truncates with a visible marker.
- [ ] Path test: the loader reads `SOUL.md`/`memory.md` from `PROJECT_ROOT/agents/<role>/` for
      each of the six roles, not via `readVaultFile`.
- [ ] Confirm all suites above are red before implementation.

### Implementation

- [ ] Generalize the writer loader (project 12) into a role loader keyed by role name; per-role
      char budget + truncation marker; returns `{ systemInstructions, referenceContext }`.
- [ ] Hand-author `jarvis/agents/<role>/SOUL.md` for PM, tech lead, QA, coder, reviewer,
      designer — each charter states the role's mandate, standards, and its review edges per the
      spec's team table. Create empty `memory.md` for each.
- [ ] Register jarvis as a product the loop can target (`policies/products.json`), so `work` can
      run against this repo as the v1 test bed.

## Phase 2 — `plan` (PM + tech lead)

> Depends on: Phase 1.

### Tests (write first)

- [ ] Assumptions test: when the PM judges a brief specified-enough, the produced `spec.md`
      contains an **Assumptions** section enumerating the unspecified calls it resolved —
      test-plan.md §2.
- [ ] Interview-gate test: an underspecified brief triggers the PM interview path rather than a
      silent spec.
- [ ] Spec-match test: the tech lead's tech spec is reviewed by the PM; a mismatch is flagged,
      not passed.
- [ ] Confirm red before implementation.

### Implementation

- [ ] Wire the PM and tech-lead role identities into the planner behind `plan`.
- [ ] PM: judge specified-enough → write spec (with Assumptions section) or interview Michael
      first; own the "done" definition for the task.
- [ ] Tech lead: produce tech spec + task breakdown + sizing (which roles convene for `work`).
- [ ] PM reviews the tech spec against the product spec (match check) before `plan` completes.

## Phase 3 — `work` (QA + coder + reviewer + designer) on the existing loop

> Depends on: Phase 1, 2.

### Tests (write first)

- [ ] QA-first test: the QA tests exist and are tech-lead-reviewed **before** the first coder
      round runs — test-plan.md §3.
- [ ] Objection-gate test: an open objection-class finding (security / data / concurrency /
      irreversibility / cost) holds the merge and the loop keeps iterating; the PM's round-cap
      wrap-up does not clear it.
- [ ] Global-cap test: a single `work` run is bounded by a global round cap across review edges;
      at the cap with non-objection disagreement, the PM decides.
- [ ] Independence test: the reviewer resolves to a different provider than the coder and is
      given the diff + spec + tests, not the coder's reasoning.
- [ ] Confirm red before implementation.

### Implementation

- [ ] Wire QA, coder, reviewer, designer role identities into `gen-eval-loop-runner.ts`
      (coder = Generator, reviewer = cross-model Evaluator).
- [ ] QA round writes tests from the spec before the coder round; tech-lead review of the tests.
- [ ] Extend `evaluateMergeContract` with the objection-class dimension: an open finding blocks
      merge; PM wrap-up authority excludes objection classes.
- [ ] Add a structured objection-class signal to the `/review` verdict (beyond `VERDICT:
      PASS/FAIL`).
- [ ] Add the global per-run round cap; on cap reached, route to PM decide → escalate to Michael.
- [ ] Designer reviews front-end diffs when the task is sized as having FE work.

## Phase 4 — Loop-closure gate

> Depends on: Phase 1, 2, 3.

### Tests (write first)

- [ ] Gate assertion: a real jarvis task driven `plan` → `work` reaches autonomous merge to main
      with ≥1 review round that changed the diff and no human at the merge — test-plan.md §4.

### Implementation

- [ ] Pick a real, small jarvis task; run it end to end through `plan` then `work`.
- [ ] Confirm the merge landed on main autonomously, ≥1 review round changed the code, no human
      touched the merge. Record the outcome in the index row.

## Phase 5 — The learning loop

> Depends on: Phase 4.

### Tests (write first)

- [ ] Attribution test: given vault feedback on a known miss, the nightly post-mortem attributes
      it to a stage and writes one atomic, provenance-stamped lesson into that role's `memory.md`
      — test-plan.md §5.
- [ ] No-feedback test: no vault feedback → no post-mortem → no memory write.
- [ ] No-lesson test: a miss the retro judges uncatchable produces a "no lesson warranted"
      outcome and writes nothing.
- [ ] Compounding test: a lesson captured from run-N feedback loads into run N+1's role
      reference context.
- [ ] Confirm red before implementation.

### Implementation

- [ ] Nightly job: detect vault feedback (tag/format settled in the Plan step), run a
      Jarvis-owned (not team-role) post-mortem that interviews each role as a witness and makes
      the attribution call.
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
