# Product-Team Role-Agents — Test Plan

Verification for the role-agent substrate, the `plan` and `work` commands layered on the
existing gen-eval-loop, the objection-class merge gates, the loop-closure gate, and the
vault-driven learning loop. See [spec.md](spec.md) and [tasks.md](tasks.md).

This project is **test-first**: each numbered section below is written by a phase's **Tests
(write first)** task in [tasks.md](tasks.md), and those tests must fail (red) before that phase's
implementation begins. A phase is done when its sections pass.

> See also: [Cross-cutting test plan](../../tech/test-plan.md) for shared guidelines,
> monitoring, and security checks.

## Priority Levels

- 🔴 **Critical**: breaks the authority boundary, merges past a hard gate, merges without
  independent review, or writes memory without feedback.
- 🟡 **High**: weakens QA-first, attribution, dedup, privacy, atomicity, or cap behavior.
- 🟢 **Low**: cosmetic.

---

## 1. Role substrate (Phase 1)

- [ ] 🔴 For each of the six roles, the loader puts `SOUL.md` in `--append-system-prompt` and
      `memory.md` in the first user message; memory text is absent from the appended system
      prompt.
- [ ] 🔴 The loader reads `SOUL.md`/`memory.md` from `PROJECT_ROOT/agents/<role>/`, not via
      `readVaultFile`.
- [ ] 🟡 Cold start (empty `memory.md`) yields a valid SOUL-only prompt, no error.
- [ ] 🟡 `memory.md` over the per-role char budget truncates with a visible marker; under budget
      passes whole.
- [ ] 🟡 jarvis is registered as a targetable product in `policies/products.json`.
- [ ] 🟢 Each `SOUL.md` states its role's review edges per the spec's team table.

## 2. `plan` — PM + tech lead (Phase 2)

- [ ] 🔴 An underspecified brief triggers the PM interview path; the PM does not emit a silent
      spec.
- [ ] 🔴 A produced `spec.md` carries an **Assumptions** section enumerating the unspecified
      calls the PM resolved on its own.
- [ ] 🟡 The tech lead's tech spec is reviewed by the PM against the product spec; a mismatch is
      flagged, not passed.
- [ ] 🟡 The tech lead's output includes a task breakdown and a sizing decision (which roles
      convene for `work`).
- [ ] 🟢 Raw assumptions stay in the spec artifact; only distilled lessons reach `memory.md`.

## 3. `work` — QA + coder + reviewer + designer (Phase 3)

- [ ] 🔴 QA tests exist and are tech-lead-reviewed **before** the first coder round runs.
- [ ] 🔴 An open objection-class finding (security / data integrity / concurrency /
      irreversibility / cost) blocks merge and the loop keeps iterating.
- [ ] 🔴 The reviewer resolves to a different provider than the coder and reviews the diff +
      spec + tests, not the coder's reasoning.
- [ ] 🔴 The PM's round-cap wrap-up does **not** clear an open objection-class finding; only its
      resolution (or Michael) does.
- [ ] 🟡 A single `work` run is bounded by a global round cap across review edges; at the cap
      with non-objection disagreement, the PM decides.
- [ ] 🟡 `/review` emits a structured objection-class signal the merge contract can read (beyond
      `VERDICT: PASS/FAIL`).
- [ ] 🟢 The designer reviews front-end diffs only when the task is sized as having FE work.

## 4. Loop-closure gate (Phase 4)

- [ ] 🔴 A real jarvis task driven `plan` → `work` reaches autonomous merge to main with no
      human at the merge.
- [ ] 🔴 At least one review round actually changed the diff (independent review had teeth).
- [ ] 🟡 The loop-closure outcome is recorded in the project index row.

## 5. Learning loop (Phase 5)

- [ ] 🔴 No vault feedback → no post-mortem → no memory write.
- [ ] 🔴 Captured lessons are provenance-stamped (date + opaque slug), privacy-clean, and
      committed atomically (one lesson per commit) into the attributed role's `memory.md`.
- [ ] 🟡 Given feedback on a known miss, the Jarvis-owned post-mortem attributes it to the
      correct stage and routes the lesson to that role's `memory.md`.
- [ ] 🟡 A miss the retro judges uncatchable produces a "no lesson warranted" outcome and writes
      nothing.
- [ ] 🟡 A lesson captured from run-N feedback loads into run N+1's role reference context (the
      compounding gate).
- [ ] 🟢 A mis-attributed lesson is removable by reverting its single commit (manual acceptance).

---

## Integration verification

> Discuss a small jarvis idea into `plan`: the PM writes a spec (with assumptions), the tech
> lead breaks it into tasks, the PM confirms the match. Run `work`: QA writes the tests first
> (tech-lead-reviewed), the coder implements on a worktree branch, the cross-model reviewer and
> tech lead review (designer if FE), objection-class gates clear, and the work merges to main
> autonomously after at least one review round that changed the code — no human at the merge.
> Later, leave feedback in the vault about something the run missed; that night Jarvis runs a
> neutral post-mortem, attributes the miss to a stage, and writes one atomic lesson into that
> role's `memory.md`. A subsequent run loads that lesson into the role's reference context — the
> team compounded. Whether the output is *better* is deferred to usage/engagement, the project-12
> way.
