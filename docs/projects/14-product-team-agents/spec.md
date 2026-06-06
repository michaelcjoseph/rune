# Product-Team Role-Agents — Specification

## What's shipping (working-backwards)

You work the way you do today: discuss an idea into a spec, then let it build. What changes is
who's on the other side. A coding task is now run by a **simulated product team** — six
role-agents, each defined by a repo-local charter (`SOUL.md`) plus a compounding `memory.md`
of lessons, the project-12 pattern generalized from one writer to a whole team. The PM writes
the spec (interviewing you only where it's underspecified), the tech lead breaks it into tasks,
QA writes the tests before any code exists, the coder implements, the reviewer and tech lead
review, the designer checks any front-end, and when every gate clears the work merges to main —
with no human touching the merge.

Your involvement in normal usage is the idea discussion and, only when needed, the PM interview
when a spec runs out. Everything after that is the team's. For implementation, those human
interactions are represented by deterministic fixtures/test doubles so an agent can run the
project through completion without waiting for Michael. You find the issues you care about by
using the product and from user feedback, and that feedback feeds back into the team's memory
through the nightly so the same class of miss doesn't recur.

v1 proves one thing: the loop closes end to end. The implementation gate is a deterministic
jarvis fixture task that goes `plan` → `work` → autonomous merge in a controlled repo path,
with at least one review round that actually changed the diff and no human at the merge button.
A live real-task smoke run is useful evidence, but it is not required for project completion.

### Core value

A persistent product team of role-agents that take a spec to a merged, reviewed implementation
autonomously, and get sharper every cycle because each role's memory compounds from your
feedback.

### Goals

1. **Primary:** a role-agent substrate — `jarvis/agents/<role>/{SOUL.md, memory.md}` for PM,
   tech lead, QA, coder, reviewer, designer — running behind the existing human-invoked
   commands (`plan` pulls PM + tech lead; `work` pulls the rest), built on the existing
   gen-eval-loop (project 08) and role loader (project 12). Human-invoked means the scheduler
   does not auto-start new work in v1; once a run starts, completion gates are automated unless
   an explicit blocked-on-human state is reached.
2. **Secondary:** the safety rails that make autonomous merge defensible — QA writes tests
   first, objection classes are hard merge gates, and a round cap routes non-objection
   deadlock to the PM, then to blocked-on-human if unresolved.
3. **Tertiary (the compounding):** the learning loop — your vault feedback drives a neutral
   nightly post-mortem that attributes the miss to a stage and writes an atomic lesson into
   that role's `memory.md`.

### Non-Goals

- Automating dispatch/scheduling. v1 keeps `plan` and `work` as human-invoked commands; the
  autonomous scheduler that fires the team without a human invoking it is a later phase. This
  is not a project-completion blocker because tests and fixture runs call the same command
  handlers/runtime seams directly.
- Rebuilding the loop. The worktree, the Generator→Evaluator round structure, cross-model
  adjudication, the round cap, and the autonomous `git merge --no-ff` + push **already exist**
  in `gen-eval-loop-runner.ts`. v1 layers role identity, QA-first, and objection-class gates
  onto that substrate, it does not reimplement it.
- A quality eval. v1 proves the loop closes and the team's memory compounds, not that the
  output is better. "Better" is engagement/usage, judged the way project 12 defers it.
- New foundation-model machinery. Model assignment per role goes through the existing
  model-policy resolver. The coder/reviewer pair is already distinct-by-construction
  (anthropic generator, cross-provider evaluator).
- Roles beyond the six. No general org-config runtime; the team and its review edges are fixed.
- A merge approval gate. Merge is autonomous once every gate clears; you review the result in
  usage and revert by hand after the fact (atomic commits make this one commit at a time).
  Revert-by-hand is not part of the implementation gate.

---

## The team

Six roles. Each is a `SOUL.md` (stable repo charter, system-prompt authority) plus a
`memory.md` (compounding lessons, low-authority reference). The review **edges** — not the
node count — are where the complexity lives, so they're enumerated and fixed:

| Role | Owns | Reviewed by |
| --- | --- | --- |
| **PM** | product spec; the "done" call; emits its assumptions into the spec | tech lead (spec ↔ tech-spec match) |
| **Tech lead** | tech spec, task breakdown, sizing/which-roles-convene | PM (spec match) |
| **QA** | tests written from the spec **before** the coder starts | tech lead |
| **Coder** | implementation of the tech spec + tasks | tech lead + reviewer; designer if front-end |
| **Reviewer** | code review, weighted to the objection classes usage can't surface | — (the independent check) |
| **Designer** | UX/UI, front-end decisions | — (reviews coder's FE) |

**Independence by construction.** The reviewer is a different foundation model from the coder
(the existing loop already resolves the evaluator to a distinct provider — Claude codes, Codex
reviews). The reviewer reads the diff + spec + tests, not the coder's reasoning, so it can't
ratify the coder's misreading. Model diversity, not just prompt diversity, is what decorrelates
their blind spots.

**Independent judgment, shared facts.** Each role's `memory.md` holds its own craft lessons
(how-I-review ≠ how-I-code). Facts about the codebase's landmines are not hidden from a role to
manufacture independence — independence comes from the model and the adversarial charter, not
from starving a role of things it should know.

---

## Built on what exists (the honest delta)

| Capability | Status | Where |
| --- | --- | --- |
| Worktree per run, sandboxed | exists | `sandbox-runtime.ts`, project 11 |
| Generator (`/work --auto`) → Evaluator (`/review`) loop | exists | `gen-eval-loop-runner.ts` |
| Cross-model adjudication (Claude vs Codex) | exists | `intent/adjudication.ts`, `model-policy.ts` |
| Round cap → escalate to human | exists | `intent/gen-eval-loop.ts`, escalation policy |
| Autonomous `git merge --no-ff` + push, branch cleanup | exists | `realMergeBranch` |
| Merge contract holds when cross-model review is unavailable | exists | `evaluateMergeContract` |
| Role-agent loader (`SOUL.md` authority + `memory.md` user-turn reference, char-budgeted) | exists for the writer | project 12 |
| **Role identities for PM / tech lead / QA / coder / reviewer / designer** | **net-new** | this project |
| **`plan` = PM + tech lead; `work` = the rest** | **net-new wiring** | this project |
| **QA writes tests first, reviewed by tech lead** | **net-new** | this project |
| **Objection classes as hard merge gates** | **net-new** | this project (extends the merge contract) |
| **Vault → nightly post-mortem → per-role memory capture** | **net-new** | this project |

The substrate is real and shipping. Project 14 is the team-and-memory layer on top.

---

## `plan` command (PM + tech lead)

`plan` is the existing planner enriched with the PM and tech-lead role identities. It produces
the planning artifacts (`spec.md`, `tasks.md`) the planner already scaffolds.

```
brief → PM judges "specified enough?"
          ├─ yes → PM writes spec, emits assumptions into it
          └─ no  → PM enters interview-needed state; after response, writes spec
        → tech lead: tech spec + task breakdown + sizing (which roles convene)
        → PM reviews tech spec against the product spec (match check)
```

**Assumptions live in the spec.** When the PM judges a task specified-enough and skips the
interview, it still emits the unspecified calls it resolved on its own as an **Assumptions**
section of the spec. The danger isn't over-interviewing — it's the PM deciding it has enough
when it doesn't and filling the gap silently. The assumptions list turns that silent gap into
something you scan in 30 seconds. The raw per-task assumptions stay in the spec artifact; only
distilled lessons reach `memory.md`.

**Human interview is an explicit block, not an implementation blocker.** In production, an
underspecified brief can pause in a PM-interview state and wait for Michael. In the automated
project gate, fixtures use a specified-enough brief for the full run and a separate
underspecified fixture that asserts the PM-interview state is reached without fabricating a
spec. The agent does not need Michael to answer an interview to finish this project.

---

## `work` command (QA + coder + reviewer + designer)

`work` is the existing gen-eval-loop with the team's roles wired in and two gates added.

```
QA writes tests from the spec (before coder)  →  tech lead reviews tests
   → coder implements (Generator)
   → reviewer (Evaluator, cross-model) + tech lead review; designer reviews FE
   → objection-class gates must clear
   → ≤ N rounds, else PM decides non-objection disagreement or blocks
   → autonomous merge to main
```

**QA-first is the load-bearing separation.** Tests written from the spec by an independent role
*before* the coder starts mean the coder can't grade its own homework — "done" is a mechanical
check it didn't author. This converts "did the coder build the right thing" into a gate the
coder didn't write.

**Round cap.** The existing per-loop cap (default 3) still bounds Evaluator rounds. Project 14
adds a **global** cap across all review edges in a single `work` run so a task can't ping-pong
between reviewers forever. At the cap, the PM makes a bounded wrap-up decision for
non-objection disagreement. If the PM cannot resolve it, the run enters the existing
blocked-on-human/escalation path. Unresolved objection-class issues bypass PM wrap-up and block
merge directly (see below).

---

## Objection classes (hard gates)

Some defects never show up in your dogfooding until they detonate: security holes, data-integrity
bugs, concurrency races, irreversible operations, cost/perf regressions. Your oracle (usage +
user feedback) is structurally blind to these, which makes the reviewer the **sole** safety net
for them. So they are **hard gates**, not advisory:

- An open objection-class finding **blocks merge** and keeps the loop iterating.
- The PM's round-cap wrap-up authority **does not extend** to objection-class findings. Only
  their resolution (or an explicit blocked-on-human override outside the autonomous gate)
  clears them.
- This extends the existing `evaluateMergeContract` — which already holds the merge when
  cross-model review is unavailable — with an objection-class dimension.

The canonical list is a global baseline (security, data integrity, concurrency, irreversibility,
cost/perf) plus any per-product additions.

---

## The learning loop (vault → nightly → role memory)

The build loop above gets the work *done*. This is what makes the team get *better*.

```
Michael hits an issue in usage → leaves feedback in the vault
   → nightly: Jarvis runs a post-mortem (only if feedback exists)
   → attributes the miss to a stage ("which role should have caught this?")
   → writes one atomic lesson into that role's memory.md
```

**Jarvis runs the post-mortem, not a team role.** The post-mortem owner must be independent of
the agents being judged — a tech lead investigating its own breakdown miss runs the same blind
spot that caused it. Jarvis is the neutral retro: it represents Michael's thinking, interviews
each role as a witness ("could you have caught this? why didn't you?"), makes the attribution
call, and routes the lesson to the right `memory.md`.

**Properties:**

- **Feedback-gated.** No feedback → no post-mortem → no lesson. Michael's attention is the
  trigger; the memory layer never drifts on its own.
- **Fixture-backed.** The implementation gate uses a synthetic feedback record in a temp vault
  or injected feedback reader. Real user feedback is a production trigger, not a required
  manual step for project completion.
- **"No lesson warranted" is allowed.** Some bugs are genuinely uncatchable by any stage. The
  retro can write nothing rather than manufacture a hyper-specific lesson that bloats a role and
  makes it slower and more paranoid.
- **Atomic writes.** One lesson per commit (project-12 style) so a mis-attributed lesson reverts
  cleanly, one commit at a time.
- **Provenance-stamped, privacy-clean.** Same discipline as the writer's `captureLessons()` —
  abstract craft only, opaque source slugs.

---

## Authority + memory model (inherited from project 12)

- `SOUL.md` is the only role content with system-prompt authority. `memory.md` loads as
  reference in the first user turn, never via `--append-system-prompt`, so accumulated content
  can't silently become rules. On any SOUL ↔ memory contradiction, SOUL wins.
- The role loader (generalized from the writer's) reads `SOUL.md` + `memory.md` from
  `PROJECT_ROOT/agents/<role>/`, applies a per-role load-time char budget with a truncation
  marker, and returns `{ systemInstructions, referenceContext }`.
- Cold start (empty `memory.md`) degrades to SOUL only, no error.

---

## Eval gate (loop closure, not quality)

v1's gate is mechanical: **a deterministic jarvis fixture task goes `plan` → `work` →
autonomous merge in a controlled repo path, with at least one review round that actually
changed the diff, and no human touching the merge.** That proves the whole chain closed once —
spec authored, tests written first, independent cross-model review that *changed* the code,
every gate cleared, autonomous merge. Whether the output is *good* is deferred to
usage/engagement, the project-12 way.

A secondary gate proves the compounding: a lesson captured from fixture feedback on run N is
loaded into the relevant role's reference context on run N+1.

---

## Implementation phases (test-first per phase)

### Phase 1 — Role substrate

Generalize the writer's loader to N roles. Draft the six `SOUL.md` charters from this spec;
create empty `memory.md` files. The loader reads from `PROJECT_ROOT/agents/<role>/`, enforces
a load-time char budget with a truncation marker, returns `{ systemInstructions,
referenceContext }`, and degrades on cold start. Confirm jarvis is registered as a product the
loop can target; add it only if absent.

### Phase 2 — `plan` (PM + tech lead)

> Depends on: Phase 1

Wire PM and tech-lead identities into the planner. PM authors the spec, judges specified-enough,
enters an explicit interview-needed state when not, emits an Assumptions section when it makes
calls on its own. Tech lead produces tech spec + task breakdown + sizing. PM reviews for spec
match. Automated full-run fixtures use the specified-enough path; the interview path is tested
as a blocked state.

### Phase 3 — `work` (QA + coder + reviewer + designer) on the existing loop

> Depends on: Phase 1, 2

Wire QA, coder, reviewer, designer identities into the gen-eval-loop. QA writes tests first
(tech-lead-reviewed) before the coder round. Add the global round cap and the objection-class
gate to the merge contract. Coder = Generator, reviewer = cross-model Evaluator, designer
reviews FE. The PM wrap-up path is deterministic in tests: non-objection disagreement can be
resolved by a PM decision; objection-class disagreement cannot.

### Phase 4 — Loop-closure gate

> Depends on: Phase 1, 2, 3

Run the deterministic jarvis fixture task through `plan` → `work` → autonomous merge in a
controlled repo path with ≥1 diff-changing review round and no human at the merge. Record the
outcome in the index row. A real jarvis task may be run as a live smoke check, but the project
does not depend on it.

### Phase 5 — The learning loop

> Depends on: Phase 4

Nightly post-mortem driven by feedback records: Jarvis attributes the miss to a stage, writes
one atomic, provenance-stamped lesson into that role's `memory.md`, allows a "no lesson"
outcome. Automated tests use fixture feedback through an injected/temp-vault reader. Prove the
compounding: a lesson from run N loads into run N+1's role context.

---

## Success metrics

| Metric | Target | How measured |
| --- | --- | --- |
| Loop closes (the gate) | yes | A deterministic jarvis fixture task: `plan` → `work` → autonomous merge, ≥1 diff-changing review round, no human merge |
| Memory stays low-authority | always | SOUL in `--append-system-prompt`, memory in the user turn; memory text absent from the appended system prompt |
| QA-first enforced | always | Tests exist and are tech-lead-reviewed before the first coder round |
| Objection classes block merge | enforced | An open security/data/concurrency/irreversibility/cost finding holds the merge; PM cannot wave it through |
| Reviewer independent | always | Reviewer resolves to a different provider than the coder; reviews diff+spec+tests, not coder reasoning |
| Deadlock escalates | enforced | Global round cap reached → PM decides for non-objection disagreement; unresolved or objection-class cases enter blocked-on-human |
| Compounding works | yes | A lesson captured from fixture run-N feedback loads into run N+1's role reference context |
| Post-mortem is neutral | always | Jarvis (not a team role) owns attribution; "no lesson warranted" is a valid outcome |
| Cold start safe | no error | Empty `memory.md` → valid SOUL-only prompt |

---

## Edge cases & error handling

- Empty `memory.md` → SOUL only, no error.
- `memory.md` over budget → loaded `referenceContext` truncates with a visible marker.
- Memory contradicts SOUL → SOUL wins.
- PM judges specified-enough but is wrong → the emitted assumptions surface the gap for cheap
  human catch; the miss otherwise flows to the learning loop.
- Cross-model review unavailable (evaluator unresolved) → merge contract holds (existing
  behavior), run enters blocked-on-human/failed surface rather than merging.
- Objection-class finding open at the round cap → loop continues; PM cannot wrap it up.
- Global round cap reached with non-objection disagreement → PM decides.
- Post-mortem mis-attributes a lesson → atomic commit reverts it one at a time.
- Feedback absent on the nightly → no post-mortem, no lesson (allowed).
- Bad autonomous merge caught in usage → revert the merge by hand after the fact; the learning
  loop captures the miss. This is production recovery, not a project completion gate.

---

## Settled implementation decisions

- Role identity wiring points are implementation tasks, not open questions: planner calls get
  PM/tech-lead role context; `gen-eval-loop-runner.ts` gets QA/coder/reviewer/designer role
  context through injectable seams so tests can run without real model calls.
- The global cap is separate from the existing evaluator-round cap. The run stops when either
  cap reaches its bound; objection-class findings still block merge.
- `/review` emits a machine-readable objection-class payload in addition to `VERDICT:
  PASS/FAIL`; the merge contract reads the structured payload.
- PM, tech lead, QA, and designer may share a provider in v1 unless a test explicitly checks
  coder/reviewer independence. Only coder/reviewer cross-provider independence is a merge gate.
- Feedback ingestion uses a machine-readable feedback record parsed by the nightly/post-mortem
  job. Real vault tags can feed that record, but tests inject records directly.
- Scheduler-driven autonomous dispatch remains deferred.
