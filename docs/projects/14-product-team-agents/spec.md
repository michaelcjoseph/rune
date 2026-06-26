# Product-Team Orchestrated Work Specification

> **Status: REOPENED 2026-06-14/16/18 — Phases 10-15 (observability, resilience, learning,
> outcome gating, severity convergence, project-completion finalization).**
> Phases 1-9 shipped the role substrate, planning, per-task orchestration, the live
> execution binding (Phase 8 — proof `live-acceptance-6abf35cf.md`), and the planning
> critique pass (Phase 9). Orchestrated runs now do real work — but they do it blind:
> the applier emits only a "starting" `log` and one terminal event, so codex and claude
> role activity never reaches the cockpit stream, and the supervision heartbeat goes
> stale mid-run (it advances only on `output`/`activity` events the orchestrated path
> never emits). The same project-17 run also exposed blind retries, non-resumable crash
> recovery, cold-start roles with no exemplars, binary outcome gating that treats every
> objection as a hard stop, human parking on findings the team can resolve itself, and silent
> project completion. Remaining scope is **Phases 10-15**
> below: stream role activity and advance the heartbeat for both executors, produce the
> finalizer substrate for gated auto-merge, make retries/restarts resilient, make gate
> failures teach future runs, and drive findings to severity convergence without human parking.
> Both Claude and Codex runs are observable and treated equally.
>
> *(Prior reopen, 2026-06-10: Phases 8-9 — live execution binding + planning critique —
> now DONE.)*

## What's shipping (working-backwards)

You work the way you do today: discuss an idea into a spec, then let it build. What changes
is who owns the work after that discussion. Rune becomes a small engineering workflow
engine backed by a simulated product team: PM, tech lead, QA, coder, reviewer, and designer.
Each role has a repo-local `SOUL.md` charter plus a compounding `memory.md` of lessons.

The PM writes the spec, interviewing only when the idea is underspecified. The tech lead
breaks the spec into task-sized slices and sizes which roles need to convene. Rune then
owns the project loop: it selects the next unchecked task, assembles bounded context, invokes
the team roles, performs a Rune-owned task closeout (`tasks.md` + `context.md` + commit),
and advances until the project is ready for the Project 15 finalizer.

This replaces the current shape where Rune starts one long `/work --auto` process and lets
that model own task selection, continuation, context management, implementation, review, and
wrap-up inside one accumulating conversation. The larger point is not just avoiding context
pressure. A large automated project should be coordinated by Rune, with explicit workflow
state and multi-model role separation, not delegated wholesale to one model process.

v1 proves the loop closes mechanically, not that quality is already better. A deterministic
fixture project goes from `plan` to multi-task orchestrated `work`, exercises at least one
review round that changes the diff, updates `context.md` between tasks, and hands the final
branch/run facts to the finalizer without a human merge button. **Correction
(2026-06-10):** the original spec treated a live real-task run as an optional smoke
check, not required for completion. That was the defect — it deferred the
load-bearing execution binding under an "optional" label. Completion now requires
at least one non-fixture run that drives a real task to a real diff (see Phase 8).

### Core value

Rune coordinates a persistent product team across a whole project: explicit role gates,
fresh per-task execution contexts, compact project memory, atomic task closeouts, truthful
task/run records, gated finalization, and a feedback loop that lets the team compound from
real usage.

### Goals

1. **Primary:** create the product-team role substrate: `agents/<role>/{SOUL.md,
   memory.md}` (PROJECT_ROOT-relative, mirroring `agents/writer/` from Project 12) for PM,
   tech lead, QA, coder, reviewer, and designer.
2. **Primary:** make Rune own project execution per task rather than handing an entire
   project to one long `/work --auto` process.
3. **Primary:** maintain a bounded, durable `docs/projects/<project>/context.md` artifact
   that carries high-signal project continuity between fresh task executions.
4. **Secondary:** enforce role gates: QA before coder, tech-lead test review, cross-model
   reviewer independence, designer review for tech-lead-flagged front-end/designer-needed
   work, and severity-aware objection-class gates.
5. **Secondary:** route models through the existing model-policy resolver; coder/reviewer
   independence is required by construction.
6. **Tertiary:** capture lessons from feedback through a neutral Rune-owned post-mortem
   into the relevant role's `memory.md`.

### Non-Goals

- **A new general org runtime.** v1 has six fixed roles and fixed review edges.
- **A quality eval.** v1 proves loop closure and learning-loop plumbing. Quality is judged
  later through usage/engagement, as in Project 12.
- **New foundation-model machinery.** Role/model assignment goes through the existing
  model-policy resolver. Coder/reviewer provider distinction is the required merge gate.
- **Replacing Project 15.** The finalizer owns project terminal classification, gated merge,
  push, cleanup, and terminal writes. This project defines an injectable finalizer handoff
  seam so its automated tests do not require Project 15 to be implemented first.
- **Unconditional merge.** Blocking objection-class findings and failed finalizer gates block
  autonomous landing.
- **Scheduler-driven dispatch.** A human or existing surface can start a run in v1; fully
  autonomous scheduling remains a later intent-layer concern.
- **Deleting the legacy `/work --auto` path immediately.** Keep it as a fallback while the
  orchestrated path is proven.

---

## The team

Six roles. Each is a `SOUL.md` with system-prompt authority plus a low-authority
`memory.md` loaded as reference in the first user turn.

| Role | Owns | Reviewed by |
| --- | --- | --- |
| **PM** | Product spec, assumptions, done definition, product-intent decisions | Tech lead for spec/tech-spec match |
| **Tech lead** | Tech spec, task breakdown, task sizing, technical coherence, context validation | PM for product-spec match |
| **QA** | Tests from the spec before coder starts | Tech lead |
| **Coder** | Implementation of one selected task | Tech lead + reviewer; designer if tech lead flags designer-needed |
| **Reviewer** | Independent code review, weighted to objection classes usage cannot surface | Independent check |
| **Designer** | UX/UI/front-end review | Independent check for tech-lead-flagged front-end/designer-needed work |

**Independence by construction.** The reviewer is a different foundation-model provider than
the coder. The reviewer reads the diff, spec, tests, task, and bounded project context, not
the coder's hidden reasoning.

**Independent judgment, shared facts.** Role memories hold craft lessons. Shared facts about
the codebase and current project are not hidden to manufacture independence; independence
comes from model/provider separation and role charter, not starving a role of relevant facts.

---

## Built on what exists

| Capability | Status | Where |
| --- | --- | --- |
| Worktree per run, sandboxed | exists | `sandbox-runtime.ts`, Project 11 |
| Generator -> Evaluator loop | exists | `gen-eval-loop-runner.ts` |
| Cross-model adjudication | exists | `intent/adjudication.ts`, `model-policy.ts` |
| Round cap -> escalation | exists | `intent/gen-eval-loop.ts`, escalation policy |
| Work-run observability | exists | Project 11 |
| Work-run finalizer | planned dependency | Project 15 owns terminal correctness and gated merge |
| Writer role loader pattern | exists for writer | Project 12 |
| Product-team role identities | net-new | this project |
| Rune-owned per-task orchestration | net-new | this project |
| `context.md` cross-task memory | net-new | this project |
| QA-first + objection gates | net-new | this project |
| Feedback -> role memory | net-new | this project |

---

## Planner: PM + Tech Lead

`plan` enriches the existing planner with PM and tech-lead role identities. It produces the
planning artifacts the rest of the system consumes: `spec.md`, `tasks.md`, and the initial
`context.md` seed.

```text
brief -> PM judges "specified enough?"
          yes -> PM writes spec and emits assumptions
          no  -> PM enters interview-needed / blocked-on-human state
        -> tech lead writes tech spec, task breakdown, role sizing, and test strategy
        -> PM reviews tech spec against product spec
        -> cross-model critique pass refines the assembled plan (Claude, then Codex)
        -> Rune seeds context.md
```

**Assumptions live in the spec.** When the PM judges a brief specified-enough and fills gaps,
those calls are listed in an **Assumptions** section. Silent PM invention is the risk; the
assumptions section turns it into a cheap scan surface.

**Human interview is explicit.** In production, an underspecified brief can block for a PM
interview. Automated tests use fixtures: one specified-enough path for loop closure and one
underspecified path that asserts Rune blocks rather than fabricating a spec.

### Planning critique pass

Planning closes with a cross-model critique that hardens the assembled plan before it
reaches the human approval gate. The PM/tech-lead flow answers "is this internally
coherent?" The critique answers the harder question: does the defined scope actually achieve
the stated goal, and does completing every task leave a project a real user can use? Both are
easy to pass with a plausible-looking spec and a task list that stops short of done — which
is exactly the failure the PM/tech-lead self-review does not catch, because no role critiques
its own write-up.

The pass is **sequential and cross-model**, one pass per model:

1. **Claude (Opus 4.8)** reads the assembled spec, tech spec, and tasks and runs the critique:
   restate the goal the spec and tasks define; check whether the scope achieves it and fix
   the scope if not; check whether the task list is comprehensive enough that completing
   every task makes the project done and user-usable, and add tasks if not; then critique
   spec and tasks and fix what it finds. It returns the revised artifacts.
2. **Codex (GPT-5.5)** reads Claude's revised artifacts and runs the same critique on them,
   returning the final revised artifacts.

Sequential, not parallel: the second model sees the first's work, so the two critiques
compound instead of colliding as two independent rewrites. One pass each — the pass does not
loop to convergence; the human approval gate catches residue.

**Degrade to Claude alone.** Codex is the optional second executor (gated by
`probeCodexProvider` — binary present and logged in). When it is unavailable, the critique
runs the Claude pass alone and records that the Codex pass was skipped. Planning never blocks
on the second model.

**Scope and gate position.** The critique operates on the in-memory spec / tech spec / tasks
the planner assembled, after the PM spec/tech-spec match gate and before `context.md` is
seeded. It runs before the human planning-approval gate, so every change it introduces is
still gated by the human approving the plan — the critique sharpens what the human approves,
it does not bypass approval. `test-plan.md` is authored by the setup-writer at scaffold time
and is out of this pass's scope; the critique covers spec, tech spec, and tasks. A critique
that yields no change returns the assembled plan unchanged (the no-op path is not an error),
and a critic reply that cannot be parsed falls back to the pre-critique plan rather than
dropping content.

This is a Rune-owned neutral step, not a seventh role — like the learning-loop post-mortem,
Rune runs it over the role artifacts rather than assigning it to one role, because the
question spans the whole plan (PM-owned spec and tech-lead-owned tasks together).

---

## Project Execution: Rune-Owned Per-Task Loop

Rune owns the project loop.

```text
for each unchecked task in tasks.md:
  select the first unchecked task
  assemble bounded context
  run the team-task workflow in a fresh execution context
  record task result, commit, role verdicts, and gates
  update context.md through a Rune-owned context curator
  advance, retry, escalate, or block

when no unchecked tasks remain:
  hand branch/run facts to the Project 15 finalizer
```

The task executor does not choose arbitrary work. Rune selects the task before spawning the
workflow. Each task receives a fresh model/process context with bounded handoff input rather
than the prior task's accumulated conversation.

### Team-task workflow

For one selected task:

```text
QA writes or updates tests from the spec, or records a reviewed no-test rationale
  -> tech lead reviews test intent
  -> coder implements
  -> reviewer + tech lead review the diff
  -> designer reviews if tech-lead sizing flags front-end/designer-needed
  -> objection-class gates resolve per Outcome gating
  -> ready-for-closeout / blocked / failed verdict
```

The workflow returns structured task evidence: task id/text, attempt id, roles invoked,
model/provider choices, transcript ids, changed files/diff summary, review verdicts,
objection findings, handoff notes, and gate decisions. It does not mark the task complete,
write `context.md`, or merge to main. Rune owns task closeout.

### Task closeout

When the workflow returns `ready-for-closeout`, Rune performs one closeout sequence:

```text
verify gates still pass
apply/update context.md through the context curator
mark exactly the selected task complete in tasks.md
run closeout checks
create or record the task closeout commit
verify the worktree is clean
advance to the next task
```

This keeps the branch coherent for the finalizer. A task may not advance with uncommitted
changes, a missing closeout commit, or a `tasks.md` checkbox that does not correspond to the
selected task.

Closeout checks are task-scoped: the QA-authored tests or reviewed no-test rationale, plus any
configured fast validation commands for the product/task type. The Project 15 finalizer still
owns the full project-level merge gate.

### Retry bounds

Retries are bounded by convergence, not by a human escalation cap. Each selected task runs the
coder/reviewer severity loop with the findings ledger from prior rounds. The task exits when
all open findings are `low` or resolved, when max severity stagnates for 3 consecutive rounds,
or at the 4-round hard budget. Terminal handling logs unresolved `>low` findings and holds only
for non-reversible high/critical residue. Rune must never spin indefinitely on one task, and
no per-task path routes to PM wrap-up or `blocked-on-human`.

### Task test strategy

QA-first does not mean inventing meaningless tests. The tech lead's task sizing includes a
test strategy:

- `code-tests-required` - QA writes/updates tests before coder starts.
- `docs-or-config-only` - QA records a no-code-test rationale and the tech lead reviews it.
- `tests-as-deliverable` - QA/test work is the task output; later implementation tasks turn
  those tests green.

The no-test path is explicit evidence, not a silent skip.

### Fallback

The legacy long-process `/work --auto` path remains available behind configuration or
operator choice while the orchestrated path is being validated. Fallback is explicit and
recorded; it must not silently masquerade as orchestrated execution.

### Finalizer handoff seam

Project 15 owns the real finalizer. Project 14 defines the handoff contract and uses an
injected finalizer adapter in tests. If the real finalizer is unavailable at runtime, Rune
must stop in a durable branch-complete/blocked state with the handoff payload recorded; it
must not implement an independent merge path as a shortcut.

---

## Triggering & Surfaces

Orchestrated work is not a new surface; it reuses the ones that already start a project run.
Naming them here is deliberate — a spec that ships an engine without a trigger and a discovery
surface is the false-done failure the planning checklist (§1, §5) exists to prevent.

- **Plan trigger (existing).** `/plan <product>` on Telegram and the cockpit per-project Plan
  button already start a planning conversation. Project 14 enriches that flow with PM and
  tech-lead role identities; the entry point does not change.
- **Work trigger (existing surface, new dispatch).** The cockpit per-project start action
  (`app.js` confirm-modal → `POST /api/mutations {kind:'work-run', payload:{projectSlug,
  product}}`) is the orchestrated-run trigger. v1 routes that same start action to the
  orchestrated applier (a new mutation kind or a per-product/config toggle on `work-run`)
  instead of spawning one long `/work --auto`. The legacy applier stays reachable as the
  recorded fallback. No new button is required for v1; the toggle decides which applier runs.
- **Discovery surface.** The cockpit project card already renders run status, work-run
  outcome, and transcript links (Project 11), so an orchestrated run is observable there with
  no new panel. The gap to close is mode visibility: the project card or Start confirmation
  must say whether Start will dispatch orchestrated work or legacy `/work --auto`, and a
  fallback run must show that it was a fallback and why. The operator/agent documentation also
  needs the orchestrated-vs-legacy toggle and the selected mutation contract described in
  `CLAUDE.md` so future agents and the operator know the path exists and how to select it.

Fully autonomous scheduler dispatch remains out of scope for v1 (see **Deferrals**); a human
or an existing surface starts every run.

## Context Handoff

Rune owns `docs/projects/<project>/context.md`. It is orchestration state, not a seventh
role and not role memory. Roles may read a bounded slice of it as low-authority reference and
may emit handoff notes. They do not directly author the file.

Recommended shape:

```md
# Project Context

## Current State
What is now true in the codebase.

## Key Decisions
Important implementation/product decisions and why they were made.

## Interfaces & Contracts
APIs, schemas, invariants, command behavior, file formats.

## Known Risks
Things future tasks must not break or assume incorrectly.

## Next Task Handoff
Specific notes for the next unchecked task.
```

The context curator updates the file during task closeout. Updates must be concise,
decision-oriented, bounded, and not a transcript dump. Technical contract changes require
tech-lead validation. Product-intent changes require PM validation when flagged.

---

## Objection Classes

> **Phase 14 (2026-06-18) restructures this taxonomy.** The `irreversibility` class is removed and
> replaced by two orthogonal ideas: an `outbound` detection class (effects that leave the system)
> and a per-finding `reversible` boolean (can a git revert undo the effect). The baseline classes
> become `security`, `privacy`, `data-integrity`, `concurrency`, `outbound`, `cost-perf`. See
> "Phase 14: Severity loop to convergence" and requirements 71-82.

Some defects do not show up in normal usage until they matter: security holes, data-integrity
bugs, concurrency races, outbound side effects, privacy leaks, and cost/perf regressions.
These are the objection classes — the findings the reviewer is specifically charged to surface.

- The reviewer role's verdict is structured: alongside the outcome it carries a
  machine-readable objection payload (class, severity, location, rationale) that the
  orchestrator gates on. This is a property of the reviewer-role agent invoked inside the
  team-task workflow, not a change to the standalone `/review` skill — if the workflow later
  reuses `/review` as the reviewer harness, that skill must emit the same payload shape, and
  that wiring is its own task.
- An objection's SEVERITY decides how the loop behaves — see "Severity loop to convergence"
  below (Phase 14). Severity is not advisory metadata: `critical`/`high`/`medium` drive another
  coder/reviewer round, while `low` ships as a recorded warning.
- Reversibility decides the terminal merge hold. Remaining high/critical findings with
  `reversible: false` hold the branch; reversible findings are logged and the gated auto-merge may
  proceed. No per-task path parks `blocked-on-human`. A finding that omits or malforms `reversible`
  is normalized to `reversible: false` (the conservative value), so a missing flag fails safe to a
  HOLD rather than a silent merge of a high/critical finding.
- Per-product additions can extend the global baseline class list.

## Outcome gating

> **Phase 14 (2026-06-18) supersedes the `block` outcome and the human-park model below.** The team
> resolves all findings itself; nothing escalates to a human. `block` is removed (`critical`/`high`
> now map to `fail`), the per-task loop runs to severity convergence under a stagnation backstop and
> a hard round budget, and the only non-merge terminal is a branch HOLD for a non-reversible
> high/critical finding. The Phase 13 model below is the prior state. See "Phase 14: Severity loop to
> convergence" and requirements 71-82.

> Refines the binary objection gate after the 2026-06-15 Codex-stream failure, where one reviewer
> objection — caused by a redaction artifact, not a real defect — short-circuited retries and
> discarded an otherwise-complete run. Two flaws compounded: a reviewer can always find
> *something*, and any objection (any severity) was a one-shot, run-ending hard gate that mapped
> to `failed` with the worktree destroyed.

A reviewing gate returns one of four outcomes. Phase 13 introduces a shared `GateVerdict`
contract for reviewer, tech-lead diff review, and designer gates; existing simple boolean
adapters must be normalized at the boundary so downstream code gates on one shape.

| Outcome | Meaning | Effect |
| --- | --- | --- |
| `pass` | No concerns | Proceed |
| `pass-with-warnings` | Non-blocking concerns recorded | Proceed; warnings travel with the handoff + finalizer record |
| `fail` | Contract not satisfied, fixable in place | Feedback-threaded retry within the round cap; PM wrap-up at the cap |
| `block` | Hard stop the team can't clear autonomously | One dedicated corrective round; surviving block parks `blocked-on-human`, worktree + branch preserved |

**Severity drives the outcome — severity now has teeth.** An objection-class finding maps by
severity: `critical`/`high` → `block`; `medium` → `fail`; `low` → `pass-with-warnings`. This
closes the "someone can always find issues" stall: finding issues is fine, but only high/critical
findings stop the line. If multiple findings are present, the strictest mapped outcome wins
(`block` > `fail` > `pass-with-warnings` > `pass`).

**Reviewer-produced blocks get one corrective round, then a human — never a silent discard.**
Today an objection short-circuits retries entirely (one-shot) and renders as `failed` with the
worktree destroyed.
Under this model a `block` first delivers its already-built feedback to the coder for one
dedicated corrective round. This is a separate block-correction budget, not the general
non-objection round cap: after the first `block` verdict, exactly one feedback-threaded coder
round is allowed; if that verdict still maps to `block`, it parks. A genuine block survives it,
while a transport artifact (e.g. a redacted fixture) gets fixed. A surviving block parks
`blocked-on-human` with worktree and branch preserved — aligning the code with the Retry-bounds
intent ("all objection-class findings enter blocked-on-human"), which the `maybeParkedRun`
`objectionOpen` exclusion and the `mapResultToTerminal` blocked→failed mapping currently
violate.

**Operational fail-safe blocks park immediately.** Unknown outcomes, malformed severities, and
warning/acceptance recording failures are not coder-fixable defects. They still degrade to
`block`, but they park with a durable reason rather than spending the coder's corrective round.

**Override authority.** PM adjudicates `fail`, `pass-with-warnings`, and `medium` escalations, and
may accept-with-rationale. A `block` (high/critical) is not auto-clearable by PM, but a human can
accept-it-with-recorded-rationale through an injected override seam. Real cockpit/Telegram inbox
wiring may ship separately; Phase 13's required surface is the core override contract and durable
record, not live UI interaction. Every acceptance is logged in the task/run record — an audit
trail of what shipped with known caveats.

**Warnings ledger.** `pass-with-warnings` findings and accepted-block rationales are recorded in
the task run record and carried into the finalizer handoff, so the operator sees what shipped with
open caveats.

---

## Learning Loop

The build loop gets the work done. The learning loop makes the team better.

```text
usage reveals an issue -> feedback record exists
  -> nightly Rune-owned post-mortem
  -> attribute the miss to a stage/role
  -> write one atomic, provenance-stamped lesson to that role's memory.md
```

Rune runs the post-mortem, not a team role. It can interview roles as witnesses, but Rune
makes the attribution call. No feedback means no post-mortem. "No lesson warranted" is a valid
outcome. Captured lessons are privacy-clean, low-authority, and revertable one commit at a
time.

**Feedback records are explicit input.** v1 does not infer feedback from arbitrary chat,
transcripts, or usage logs. The nightly loop reads a configured machine-readable feedback
source through an injected reader seam. Each record carries at minimum: project slug, optional
run/task id, source, createdAt, issue summary, evidence, expected/actual behavior when
applicable, and optional reporter stage hint. Malformed records are skipped with a durable
reason, not silently treated as no feedback. The Phase 6 discovery task documents the real
path/source and format in `CLAUDE.md`; automated tests use temp/injected records.

---

## Requirements

### Role substrate

1. WHEN a role is invoked THEN `SOUL.md` is passed as system-prompt authority and `memory.md`
   is passed as low-authority reference context.
2. WHEN `memory.md` is empty THEN the role still runs with SOUL only.
3. WHEN `memory.md` exceeds the role budget THEN the loaded reference is truncated with a
   visible marker without deleting disk entries.
4. WHEN memory contradicts SOUL THEN SOUL wins.

### Planning

5. WHEN a brief is underspecified THEN PM enters an explicit interview-needed /
   blocked-on-human state rather than fabricating a spec.
6. WHEN PM makes assumptions THEN the generated `spec.md` contains an **Assumptions** section.
7. WHEN tech lead produces task breakdown THEN it includes role sizing and test strategy per
   task, and the role sizing carries an explicit front-end / designer-needed flag so designer
   routing (req 24) is deterministic rather than inferred at runtime.
8. WHEN tech lead produces task breakdown THEN PM reviews the tech spec against the product
   spec before planning completes.
8a. WHEN the PM spec/tech-spec match gate passes THEN a cross-model critique pass refines the
    assembled spec/tech-spec/tasks before `context.md` is seeded: Claude (Opus 4.8) critiques
    and revises first, then Codex (GPT-5.5) critiques and revises Claude's output — one pass
    per model, no looping.
8b. WHEN Codex is unavailable (binary missing or not logged in) THEN the critique degrades to
    the Claude pass alone and records that the Codex pass was skipped; planning never blocks
    on the second model.
8c. WHEN the critique pass completes THEN its revised artifacts feed both the context seed and
    the human approval surface, so every critique-introduced change is still human-gated before
    scaffold; a no-op critique returns the plan unchanged and an unparseable critic reply falls
    back to the pre-critique plan.
9. WHEN planning completes THEN Rune seeds `context.md`.

### Orchestration

10. WHEN a project run starts THEN Rune selects the first unchecked task from `tasks.md`.
11. WHEN a task starts THEN Rune creates a fresh execution context and passes only bounded
    handoff input.
12. WHEN a task workflow completes successfully THEN Rune performs task closeout: update
    `context.md`, mark exactly the selected task complete in `tasks.md`, create/record the
    closeout commit, run closeout checks, verify the worktree is clean, and then advance.
13. WHEN task closeout cannot produce a clean checkpoint THEN Rune blocks durably and does
    not advance.
14. WHEN a task workflow returns remaining findings above `low` THEN Rune continues the
    severity loop until the all-low primary exit, the stagnation backstop, or the hard round
    budget; it does not skip the task.
15. WHEN the severity loop reaches terminal handling THEN Rune resolves through reqs 81-82:
    remaining findings are logged, non-reversible high/critical findings hold the branch, and no
    per-task path routes to PM wrap-up or `blocked-on-human`.
16. WHEN no unchecked tasks remain THEN Rune hands branch/run facts to the Project 15
    finalizer.
17. WHEN the real finalizer is unavailable THEN Rune records the handoff payload and stops
    in a durable branch-complete/blocked state; it does not self-merge.
18. WHEN orchestrated mode is disabled THEN the legacy `/work --auto` fallback remains
    available and is recorded as fallback.
19. WHEN the cockpit Start surface is rendered THEN the user can see whether Start will use
    orchestrated work or legacy fallback, and fallback runs expose the fallback reason.

### Role gates

20. WHEN implementation begins on a `code-tests-required` task THEN QA tests already exist
    and tech lead has reviewed their intent.
21. WHEN a task is `docs-or-config-only` THEN QA records a no-code-test rationale and tech
    lead reviews that rationale before coder starts.
22. WHEN coder output is ready THEN reviewer receives diff/spec/tests/task/context, not coder
    hidden reasoning.
23. WHEN no distinct-provider reviewer can be resolved at runtime (e.g. the cross-provider
    executor is unavailable) THEN the task blocks rather than accepting a same-provider
    review; independence is fail-closed, never silently downgraded.
24. WHEN the tech-lead sizing flags a task as front-end / designer-needed THEN designer review
    is required; non-flagged tasks do not invoke the designer by default.
25. WHEN objection-class findings remain open THEN they gate per the Phase 14 severity loop
    (reqs 71-82): `critical`/`high`/`medium` findings continue the loop until terminal handling,
    `low` findings proceed as warnings, and only non-reversible high/critical terminal findings
    hold the branch.

### Context and recovery

26. WHEN context is updated THEN all required sections remain present and bounded.
27. WHEN role handoff notes are emitted THEN the context curator may use them, but roles do
    not write `context.md` directly.
28. WHEN the server restarts THEN Rune can reconstruct a partial project run from durable
    task records, commits, `tasks.md`, and `context.md`.

### Learning

29. WHEN no valid feedback record exists THEN no post-mortem runs and no memory is written.
30. WHEN a feedback record is malformed THEN Rune records a durable skip reason and does
    not treat it as valid feedback.
31. WHEN feedback identifies a catchable miss THEN Rune attributes it to a stage and writes
    one atomic lesson into that role's `memory.md`.
32. WHEN a later run invokes that role THEN the captured lesson appears in low-authority
    reference context.

### Project closeout

33. WHEN the project is ready to close THEN every deferral named in the spec has an ADR with
    status, context, decision, rationale, and trigger-to-promote sections.
34. WHEN the project is ready to close THEN `agent-lessons.md` exists with propagated lessons
    or an explicit "no new lessons" rationale.
35. WHEN the project is marked done THEN the Phase 5 trigger-surface dispatch and
    mode-visibility checks have passed, so closeout cannot hide a non-user-reachable
    orchestration path.

### Execution observability (Phase 10)

36. WHEN an orchestrated run is executing a task THEN the applier emits `output`/`activity`
    mutation events as roles work, not only at run start and terminal.
37. WHEN a role artifact session (codex or claude) runs THEN its incremental output streams as
    events while the session is alive, so the supervision heartbeat advances mid-run and a
    working run is never read as quiet.
38. WHEN a role stage transitions (QA → tech-lead review → coder → reviewer → designer → PM
    wrap-up) THEN the orchestrator emits a labeled event naming the role.
39. WHEN an activity line is emitted THEN it carries role + provider + model attribution and is
    path/secret-scrubbed before it leaves the process.
40. WHEN the codex executor runs THEN `runCodex` surfaces incremental output through a streaming
    callback rather than only a final buffered result.
41. WHEN a claude artifact-role session runs inside orchestration THEN it streams through the
    same stream-json → display mapping as the legacy work-runner, so claude and codex roles are
    observable on equal terms.

### Auto-merge (Phase 10)

42. WHEN an orchestrated run completes THEN it produces the finalizer substrate — a durable
    `transcript.jsonl`, `summary.json`, and a computed work-product classification — under the
    run's `WORK_RUNS_DIR` directory, the same artifacts a legacy `/work` run produces.
43. WHEN an orchestrated run reaches a clean `branch-complete` outcome (commits exist,
    `tasksRemaining == 0`) THEN Rune invokes the Project 15 finalizer in `gated-merge` mode
    rather than holding for an operator.
44. WHEN the finalizer gate passes THEN the branch merges `--no-ff` onto its base under the
    per-base merge lock and is pushed; WHEN the gate fails THEN the run holds branch-complete,
    records the gate reason, and never touches the base branch.
45. WHEN terminal handling finds a remaining `critical`/`high` finding with `reversible: false`
    OR the work product is not `branch-complete` THEN the run holds with the handoff payload
    recorded and does not merge (reqs 17, 25, 71-82 preserved). Reversible remaining findings are
    logged to `docs/projects/bugs.md` and do not by themselves block the gated merge.
46. WHEN the orchestrated finalizer wiring lands THEN the Phase 8 `unavailable` hold stub is
    gone and cannot reappear without failing a regression test.

### Orchestration resilience (Phases 11A + 11B)

> Reqs 47-49 → Phase 11A (feedback retries + park-not-kill; built out of band, first). Reqs 50-53 →
> Phase 11B (crash recovery & resumable runs; via the orchestrator, after Phase 10).

47. WHEN a role gate rejects (tech-lead test intent, reviewer, tech-lead diff, designer) THEN
    the rejection's structured feedback is threaded into that role's next attempt; no retry
    re-runs a role with identical inputs and no feedback.
48. WHEN the tech lead rejects QA's test intent THEN QA revises against the feedback in a
    bounded rewrite loop before the task escalates, rather than the run blocking on the first
    rejection.
49. WHEN corrective retries still cannot clear the task THEN the worktree and branch are
    preserved; Phase 14 supersedes the old `blocked-on-human` terminal with terminal handling
    through reqs 81-82.
50. WHEN the server restarts mid-run THEN a still-`running` orchestrated mutation resumes from
    durable state (persisted records + branch commits + `tasks.md`) rather than being orphaned.
51. WHEN orchestrated run state is persisted THEN `TaskRunRecord`s and a run cursor are written
    to disk so a partial run is reconstructable via `reconstructRun`.
52. WHEN crash recovery runs THEN it never writes a terminal for a run that will resume, and the
    pipeline never lands two terminal records for one mutation id; a single-run lease prevents
    concurrent double-resume of the same mutation.
53. WHEN a run is marked for resume THEN the orphan-worktree sweep preserves its worktree (or the
    branch-resume path rebuilds it on re-dispatch).

### Role learning & exemplars (Phase 12)

54. WHEN a role is invoked THEN it receives reference exemplars of good output (a permanent
    baseline plus any per-project exemplars) as a low-authority channel alongside SOUL and memory.
55. WHEN the tech lead completes planning THEN it emits per-project exemplars for the relevant
    roles, persisted with the project.
56. WHEN a gate rejects THEN a structured rejection record (rejecting role, counterpart role, what
    failed, actionable notes) is produced — the same object threaded into the Phase 11A retry.
57. WHEN a gate-rejection record exists THEN the rejecting role drafts a candidate lesson for the
    counterpart role.
58. WHEN a candidate lesson is drafted THEN a neutral Rune validation pass privacy-filters,
    dedupes, attributes, and fails safe to no-lesson before any write; roles never write memory
    directly.
59. WHEN validation passes THEN the lesson is written to the counterpart role's memory via the
    existing `writeRoleLesson` path, synchronously at gate-time.
60. WHEN a role is invoked after a gate-time lesson was written THEN that lesson appears in its
    low-authority reference context (the Phase 6 compounding path).
61. WHEN both the nightly loop and the gate-time path can write a lesson THEN they share one write
    path and do not double-write the same lesson.
62. WHEN exemplar loading, lesson drafting, validation, or memory writing fails THEN Rune
    records a durable skip/error and continues the current corrective retry path.

### Outcome gating (Phase 13)

63. WHEN a reviewing role returns its verdict THEN the outcome is exactly one of `pass`,
    `pass-with-warnings`, `fail`, or `block`, carried as a structured field rather than inferred
    from a bare boolean.
64. WHEN an objection-class finding is present THEN its severity determines the outcome:
    `critical`/`high` → `block`, `medium` → `fail`, `low` → `pass-with-warnings`; a reviewer
    cannot produce `block` from a `low` or `medium` finding, and multiple findings resolve to
    the strictest mapped outcome.
65. WHEN the outcome is `pass-with-warnings` THEN the task proceeds and the warnings are recorded
    in the task run record and carried into the finalizer handoff.
66. WHEN the outcome is `fail` THEN the coder receives the structured feedback and retries within
    the round cap; at the cap a non-cleared `fail` routes to PM wrap-up (reqs 47, 19 preserved).
67. WHEN a valid reviewing verdict maps to `block` THEN the coder gets exactly one
    feedback-threaded corrective round from the dedicated block-correction budget before the task
    parks; a reviewer-produced block is never short-circuited with zero corrective attempts.
68. WHEN a `block` survives its corrective round THEN the task parks `blocked-on-human` with
    worktree and branch preserved, and the run never maps an open blocking objection to
    `failed` with a destroyed worktree (supersedes the `maybeParkedRun` `objectionOpen` exclusion and the
    blocked→failed terminal mapping).
69. WHEN a human (or PM, for non-`block` outcomes) accepts a finding through the injected
    override seam THEN the acceptance and its rationale are recorded in the task/run record and
    the task proceeds as `pass-with-warnings`.
70. WHEN severity-to-outcome mapping or warning/acceptance recording fails THEN Rune fails safe
    to the stricter outcome (treat as an operational `block`), records a durable reason, and
    parks without consuming a coder corrective round.

### Severity loop to convergence (Phase 14)

71. WHEN a reviewing role returns its verdict THEN the outcome is exactly one of `pass`,
    `pass-with-warnings`, or `fail`; the `block` outcome is removed and no gate maps any finding to
    `block` (supersedes reqs 63-64, 67-68).
72. WHEN an objection-class finding is present THEN its severity maps to an outcome:
    `critical`/`high`/`medium` → `fail`, `low` → `pass-with-warnings`; multiple findings resolve to
    the strictest mapped outcome.
73. WHEN a review gate emits a finding THEN it carries `{class, severity, location, rationale,
    reversible}`, where `class` is one of `security`, `privacy`, `data-integrity`, `concurrency`,
    `outbound`, `cost-perf` (the `irreversibility` class is removed, `outbound` is added) and
    `reversible` states whether a git revert undoes the effect. A finding (from any gate — reviewer,
    tech-lead diff, or designer) that omits or malforms `reversible` is normalized to
    `reversible: false`, never dropped — a missing flag must not let a high/critical finding slip
    past the terminal HOLD.
74. WHEN the per-task loop runs THEN it has no outer attempt cap, no PM-wrap-up terminal, and no
    `blocked-on-human` terminal; each round is coder → review gates (reviewer plus tech-lead diff
    and designer when applicable) (supersedes the Phase 3 attempt cap and reqs 49, 66, 69-70's
    human/PM terminals).
75. WHEN a round completes and the maximum open severity is `low` or none THEN the task exits the
    loop and proceeds to closeout (primary exit).
76. WHEN the maximum open severity does not strictly decrease for 3 consecutive rounds THEN the loop
    stops (stagnation backstop) and routes to terminal handling.
77. WHEN the loop reaches the hard round budget of 4 rounds with any open finding above `low` THEN
    the loop stops and routes to terminal handling.
78. WHEN the coder addresses review-gate findings THEN it receives the ledger sorted by severity
    (highest first), attempts every open finding, prioritizes the highest severity, and reports
    which findings it addressed.
79. WHEN the reviewer re-reviews after a coder round THEN it first verifies each open prior finding
    against the new diff (regression pass, citing the specific finding) before scanning for new
    issues (discovery pass); a previously `resolved` finding that reappears is marked `regressed`.
80. WHEN the review gates maintain per-task memory THEN a findings ledger persists across rounds
    with `{id, sourceGate, class, severity, location, rationale, reversible, raisedRound, status:
    open|resolved|regressed}` and is threaded into reviewer input plus any gate prompt that can
    verify prior findings each round; ids are stable across re-review so repeated sightings update
    a row rather than creating duplicate findings.
80a. WHEN tech-lead diff review or designer review runs THEN any findings they produce normalize
     into the same findings ledger with `sourceGate` attribution; Phase 14 must not bypass those
     gates merely because reviewer is the primary discovery gate.
81. WHEN the loop reaches terminal handling THEN the orchestrator drains the ledger's remaining
    findings above `low` and authors one detailed entry per finding in the Rune orchestrating
    repo's `docs/projects/bugs.md` (NOT the product worktree, which may not carry that convention),
    written through the existing backlog safe-write substrate (`withFileLock` +
    `assertBacklogWriteAllowed` + `writeFileAtomic` from `backlog-write-lock.ts`) so the record is
    durable whether the run subsequently HOLDS or merges. Each entry carries finding id, source
    gate, class, severity, location, rationale, reversible flag, and run/task id, deduped by
    run/task/finding id.
82. WHEN any remaining open finding at terminal is `critical`/`high` with `reversible: false` THEN
    the orchestrator HOLDS the branch (no auto-merge; finalizer handoff), preserving the work;
    otherwise the run proceeds through the gated auto-merge and advances to the next task, never
    blocking on a human (supersedes reqs 25, 45).
83. WHEN a terminal is reached by an OPERATIONAL failure rather than a finding — malformed/unparseable
    gate output, a closeout commit or checkpoint-persist failure, a rejected context update, or a
    dirty worktree after closeout — THEN the run terminates as a durable non-merge HOLD with the
    operational reason recorded and branch/worktree preserved; it never auto-merges a broken
    closeout and never routes to a human-gated `blocked-on-human` park (the "no human gate" rule of
    reqs 71-82 is about findings; an infrastructure failure still stops the run, it just is not a
    findings HOLD).
84. WHEN an orchestrated run is classified `branch-complete` inside the gated finalizer (all tasks
    checked, finding/operational HOLDs already excluded, gate not yet run) AND the feature worktree
    contains a `docs/projects/index.md` THEN Rune sets the matching project's status to `Done` in
    BOTH the table Status cell AND the `## <slug> — <status>` section heading (preserving any
    parenthetical suffix on the heading) and records exactly one dedicated commit for that edit on
    the feature branch as a finalizer step, AFTER the eligibility classification and BEFORE the
    final terminal summary/index writes and gate, so the gate validates and the merge carries the
    exact `Done` content. The final terminal event, summary, and work-run index row are refreshed or
    re-stamped after this commit so commit counts/head sha include the project-Done commit. The
    writer edits only the matched project's two status tokens, preserves the project link/summary
    columns, table header/alignment row, section body, and row order byte-for-byte, and is idempotent
    when the project is already `Done` (no edit, no empty commit). A `docs/projects/index.md` that
    is ABSENT from the worktree is a graceful skip — the run still merges, because the project-index
    convention is Rune-repo-specific and a product need not carry it. An index that is PRESENT but
    malformed, or has zero or multiple rows/headings matching the slug, is an operational HOLD: do
    not guess, do not edit the base branch, and leave no uncommitted index edit behind. A merge
    conflict on `docs/projects/index.md` when the finalizer merges to the base branch aborts the
    merge and HOLDs operationally (work preserved on the branch), never a half-merged base.
85. WHEN the gated finalizer successfully merges and pushes a merge-bound orchestrated run to its
    base branch THEN Rune emits exactly one best-effort operator success notification naming the
    project and base branch. The notification fires only after `pushBranch` succeeds and finalizer
    cleanup has been attempted (including crash-resume from an already-pushed phase), before
    run-end; it is deduped by run id + branch + pushed phase. Event publication failure records
    durable skip/error metadata without failing or rolling back the run; downstream transport
    delivery failure is logged by the sender and remains non-blocking. This success notification is
    the single operator claim that the run landed — the orchestrated terminal mutation message must
    not independently assert a merge, so the operator never sees a double "merged" alert.
86. WHEN a per-task closeout commit succeeds THEN Rune emits one best-effort progress event bound
    to that commit sha, carrying project slug, selected task label/text, short sha, commit subject,
    and live `tasks.md` remaining/total counts. The event is deduped by commit sha across replay,
    never emitted for a task without a closeout commit, and event-publication or transport-delivery
    failures never block task advancement.

---

## Implementation Phases

**Autonomy constraint for reopened phases.** Phases 10-15 must be executable by an
autonomous `/work --auto` run with no operator decisions, no manual repo setup, no production
push in tests, and no interactive approval. Where an implementation choice is needed, this
spec names the default and a deterministic fallback. Live acceptance uses self-contained
temporary repositories and local bare remotes unless it is explicitly exercising the normal
production runtime path through injected seams.

**Execution sequencing (decided 2026-06-15).** Phase 11A (gate-rejection feedback retries) is built
FIRST and OUT OF BAND — a direct `/work` run in the CLI (codex or claude), or by hand — not the
orchestrator. It is the retry-with-feedback resilience the orchestrator lacks, so building it through
the orchestrator hits the one-shot-gate deadlock it fixes: any mid-build gate rejection is terminal,
and a blind restart re-runs identical inputs with no feedback. Once 11A lands on main, the
orchestrator runs the rest in dependency order — Phase 10 → Phase 11B → Phase 12 → Phase 13 →
Phase 14 → Phase 15 — with gate rejections becoming corrective retries. Only Phases 10, 11B, 12,
13, 14, and 15 are `/work --auto` targets.

### Phase 1: Role substrate

Generalize the Project 12 writer loader to PM, tech lead, QA, coder, reviewer, and designer.
Create each role's `SOUL.md` and empty-or-seeded `memory.md`. Confirm Rune is registered as
a targetable product if needed.

### Phase 2: Planner roles

Wire PM and tech-lead identities into planning. PM writes specs or blocks for interview. Tech
lead writes task breakdown, role sizing, and test strategy. PM checks spec/tech-spec match.
Planning seeds the initial `context.md`.

### Phase 3: Context and orchestrator substrate

Define `context.md`, bounded context assembly, task-run records, task-closeout semantics,
attempt caps, restart reconstruction, finalizer handoff payloads, and fallback configuration.
Rune owns task selection and per-task execution state.

### Phase 4: Team-task workflow

Wire QA, tech lead, coder, reviewer, and designer into a task-sized workflow. Enforce
QA-first/test-strategy evidence, reviewer independence, designer routing, objection-class
gates, and global round caps. The workflow returns structured task evidence and does not mark
tasks complete, write context, or merge to main.

### Phase 5: Multi-task orchestration and finalizer handoff

Run deterministic fixture projects through at least two tasks with a closeout commit and
context update that affect later input. Prove Rune advances, blocks/retries correctly,
reconstructs after restart, and hands completed project facts to Project 15 rather than
self-merging.

### Phase 6: Learning loop

Implement feedback-record source/reader validation, Rune-owned post-mortem attribution,
atomic role-memory writes, "no lesson warranted", and compounding into the next role
invocation.

### Phase 7: Project closeout and checklist compliance

Write the deferral ADRs, write `agent-lessons.md`, and run the final completion gate that
rechecks the Phase 5 user-triggerable dispatch path before the project can be marked done.

### Phase 8: Live execution binding (reopened 2026-06-10)

Phases 1-7 closed with the per-task workflow's production seams stubbed: the orchestrated
applier returns a hardcoded `blocked` for every task (`orchestrated-work-runner.ts:169`) and
reports the finalizer `unavailable` (`:215`). The orchestration logic, dispatch path, and mode
visibility are real and fixture-proven; live execution is not wired. This phase makes
orchestrated `/work` actually do work.

**Definition of done (corrected).** At least one non-fixture run drives a real task to a real
diff through the gated workflow and lands (or durably holds) — no stub on the load-bearing
component. Per the new PM/tech-lead/QA charter lessons, a fixture-green suite is not sufficient
evidence of completion.

**Model assignment.** Each role binds to a model through `policies/model-policy.json`
`roleDefaults`. Coder and reviewer resolve to different providers (independence is fail-closed).

| Role | Provider | Model |
| --- | --- | --- |
| PM | anthropic | Opus 4.8 |
| Tech Lead | anthropic | Opus 4.8 |
| QA | openai | GPT-5.5 (codex) |
| Coder | openai | GPT-5.5 (codex) |
| Reviewer | anthropic | Opus 4.8 |
| Designer | anthropic | Opus 4.8 |

**Work items.**

1. Build the production execution-agent primitive: a tool-using, worktree-scoped session
   (reuse the legacy work-runner spawn machinery) that takes a selected task plus the resolved
   model and returns a captured `git diff`. This backs the artifact roles (coder, QA test
   authoring).
2. Wire the text-judgment seams (tech-lead test/diff review, reviewer verdict, designer, PM
   wrap-up) on the existing `defaultRoleModelCall` text round-trip pattern from `/plan`.
3. Replace the `runTaskWorkflow` stub (`orchestrated-work-runner.ts:169`) to call the real
   `runTeamTaskWorkflow` with a production `TeamTaskDeps`.
4. Bind `roleDefaults` judgment roles to `opus` (anthropic/claude, Opus 4.8) and add the
   `gpt-5.5` (openai/codex) artifact-role entry; populate `roleDefaults` for all six roles per
   the table above.
5. Wire the Project 15 finalizer in place of the `finalize` stub (`:215`), or keep the durable
   branch-complete hold if Project 15 is still unwired.
6. Add an acceptance test that exercises the real end-to-end path on a non-fixture task — the
   stub-free proof that this gap cannot recur.

### Phase 11A: Gate-rejection feedback retries (reopened 2026-06-14) — build first, out of band

> **Sequencing.** Built before Phase 10 and outside the orchestrator (direct CLI `/work`, codex or
> claude). It is the retry resilience the orchestrator lacks — see the Execution sequencing note
> above. Once it lands on main, gate rejections in every later orchestrated phase become corrective
> retries instead of terminal blocks.

**Retries discard the feedback that would fix them.** The overnight project-17 run — and again the
2026-06-14 Phase 10 run — blocked on a one-shot tech-lead test-intent rejection. The tech-lead
rejected with precise, actionable feedback; that feedback was recorded in `blockedReason` and then
thrown away. The QA → tech-lead test-intent gate is one-shot (`team-task-workflow.ts:195` — a
rejection returns `blocked`, no rewrite loop), and although the orchestrator retries the whole
workflow up to the attempt cap (`decideAttemptOutcome` → `retry` while below cap,
`orch-attempt-cap.ts:50`), every retry re-invokes `qaWriteTests({task, spec})` with identical inputs
and zero feedback — blind redos of the same mistake, then the entire project run blocks. The coder
round loop has the same defect: `deps.coder({task, spec, context, tests})`
(`team-task-workflow.ts:208`) re-runs on reviewer/tech-lead disagreement without the reviewer's
notes. A human reads the feedback and fixes the work; the orchestration cannot.

**Definition of done.** A gate rejection threads its structured feedback into the rejected role's
next attempt, so QA/coder revise *with* the feedback rather than blindly redoing; a task that still
can't pass after bounded feedback-retries parks blocked-on-human with its worktree preserved, instead
of ending the whole project run.

**Work items.**

1. **Carry rejection feedback in the evidence.** The workflow already records `blockedReason`/role
   notes; surface them as structured `feedback` the orchestrator can pass back (which role, what it
   rejected, the actionable notes).
2. **Thread feedback into the retrying role.** On retry, `qaWriteTests` receives the tech-lead's
   test-intent rejection notes; the coder receives the reviewer + tech-lead-diff notes from the
   failed round; designer likewise where it gates. The retry is corrective, not a blind redo.
3. **Make the QA → tech-lead test gate a bounded rewrite loop**, not a one-shot block — QA revises
   against the tech-lead's notes up to a small cap, mirroring the coder→reviewer round loop, before
   the task escalates.
4. **Park, don't kill, on exhausted retries.** When a task can't pass after its feedback-retry cap,
   route it to blocked-on-human with the worktree preserved (reuse the Project 13 parked-run
   machinery); the project run holds at that task and the committed work and branch are not discarded.

### Phase 10: Execution observability parity (reopened 2026-06-14)

Phase 8 made orchestrated `/work` do real work. The work is invisible while it runs. The
orchestrated applier yields exactly two events — a `log` "starting" line
(`orchestrated-work-runner.ts:347`) and one terminal `completed`/`failed` (`:373`) — with the
entire multi-task loop executing inside a single `await deps.runOrchestration(...)`. No
`output` or `activity` event flows between those two points.

Two consequences:

- **The supervision heartbeat goes stale.** The mutation pipeline upserts
  `lastHeartbeatAt`/`lastOutputAt` only on `output`/`activity` events
  (`transport/mutations.ts:364`). An orchestrated run emits neither while it works, so
  supervision reads a healthy run as quiet — and risks tripping the quiet-nudge /
  quiet→cancel backstop the legacy work-runner explicitly documents and guards against
  (`work-runner.ts:1290`). *(First Phase-10 task verifies whether the backstop can actually
  cancel a working orchestrated run today — a possible active bug, not only a visibility gap.)*
- **The cockpit stream is dark.** Minutes of QA-writes-tests, coder-implements,
  reviewer-reviews work render nothing between "starting" and the terminal event.

This bites hardest on the codex artifact roles — QA and coder bind to GPT-5.5/codex per the
Phase 8 model table, which is where the run spends its wall-clock. But the gap is structural,
not codex-specific. The legacy claude `/work --auto` work-runner streams every stream-json
envelope as an `output`/`activity` event (`work-runner.ts:1284-1313`); the orchestrated path
streams nothing for either executor. The execution-agent primitive
(`execution-agent.ts:121`) returns its output only at completion (no event sink), and
`runCodex` (`ai/codex.ts:229`) buffers stdout and resolves at `close` (no incremental
callback). Neither claude nor codex role activity is observable inside orchestration.

**Definition of done.** Two things, both required:

1. **Observable.** A live orchestrated run streams role activity to the cockpit and advances
   the supervision heartbeat continuously, for BOTH executors, with role/provider/model
   attribution on each line — first-class parity with the legacy work-runner. Because the
   heartbeat now advances on real activity, the quiet-nudge and quiet→cancel backstop no longer
   fire on a working orchestrated run (the streaming IS the fix — see below). The two-event gap
   cannot reappear without failing a regression test.
2. **Landable.** A clean orchestrated run auto-merges onto its base branch through the
   Project 15 gated finalizer — no operator hold — producing the full artifact substrate the
   finalizer needs (durable transcript, `summary.json`, work-product classification). A failing
   gate or a non-reversible high/critical terminal finding still holds the branch; the merge
   always goes through the finalizer's gates, never an independent path (spec req 17/25 preserved). This reverses
   the Phase 8 deliberate-hold decision (`orchestrated-work-runner.ts:234`), which deferred the
   merge only because orchestrated runs did not yet produce that substrate.

**Work items.**

1. **Confirm the quiet→cancel harm, then let streaming fix it.** The streaming work below IS
   the fix: once role activity flows as `output`/`activity`, `lastOutputAt` advances, so
   `isQuietRun` never trips and the quiet-nudge / quiet→cancel backstop
   (`stall-check-runner.ts`, `WORK_RUN_QUIET_CANCEL_AFTER_MS` = 20min after a 5min quiet nudge)
   stops firing on a working run. First, reproduce the current harm (a working orchestrated run
   gets a spurious quiet nudge at ~5min and is SIGTERM-eligible at ~25min) and capture it as a
   regression test that the streaming fix turns green. Also emit `keep-alive` on a ticker for
   full parity, so `lastChildAliveAt` (the truer liveness signal `isStalled` prefers) stays
   fresh through a long single role call.
2. **Plumb an event sink through the orchestration call stack.** Add an injected
   `emit(event)` sink to `OrchestrationDeps` and convert the applier's single
   `await runOrchestration` into a queue-drained pump: `apply()` races the orchestration
   promise and yields queued events as they arrive (mirror the legacy work-runner's
   `enqueue`/generator pattern). Thread `emit` down through `runProjectOrchestration`
   (`intent/project-orchestrator.ts`) and `runTeamTaskWorkflow`
   (`intent/team-task-workflow.ts`) so each layer can report progress.
3. **Emit orchestration-granularity events** from the loop: task selected (`output`:
   `"Task N: <text>"`), attempt start/retry, closeout commit sha, finalizer handoff/hold, and
   block reason. This gives the stream a coarse spine even before per-session streaming.
4. **Emit role-transition events** from the team-task workflow: QA → tech-lead test review →
   coder → reviewer → designer → PM wrap-up, plus each role's verdict summary and any
   objection findings. This is the layer that makes "codex is writing tests" appear as a line.
5. **Stream the codex executor.** Add an incremental `onStdout`/`onEvent` callback to
   `runCodex` fired per line as data arrives (the `child.stdout` handler at `codex.ts:273`
   already accumulates — split into lines and fire, mirroring `work-runner.ts:1316-1321`).
   Implement `codex exec --json` first, with a label mapper analogous to
   `streamJsonToDisplay`, so codex activity renders as cleanly and structured as claude's.
   If the installed Codex CLI does not support `--json` or emits malformed JSONL, fall back
   automatically to scrubbed raw-line streaming and record that fallback in the run metadata.
   No human decision is allowed on this path.
6. **Stream the claude artifact path for parity.** `spawnClaudeAgent` (`execution-agent.ts:198`)
   spawns `claude -p` with plain stdio and accumulates `stdout`. Route it through
   `--output-format stream-json --verbose` and the same `streamJsonToDisplay` → `output`/
   `activity` mapping the legacy work-runner uses, so claude artifact roles inside
   orchestration are observable on equal terms with codex (and with legacy `/work`).
7. **Forward executor activity through the execution-agent.** Add an `onActivity` callback to
   `ExecutionAgentIO` so the per-session incremental output (item 5/6) flows up as
   `activity`/`output` events while the session is alive — the mechanism that keeps the
   heartbeat advancing during a long codex or claude session.
8. **Attribute every line.** Emitted activity carries role + provider + model alias
   (e.g. `coder (codex/gpt-5.5): writing impl/sum.mjs`, `reviewer (claude/opus): …`),
   path/secret-scrubbed via the existing `tool-labels`/`redactSecrets` path. Attribution is
   the visible payoff of "treated equally."
9. **Verify the cockpit + heartbeat surfaces** (mostly free once events flow): the webview
   projection (`server/webview.ts`) populates the orchestrated run's `lastOutput`/transcript
   tail, the project card renders role activity, and the heartbeat advances mid-run with no
   quiet-stall misclassification.
10. **Extend the Phase 8 live acceptance harness** (`__acceptance__/orchestrated-live.acceptance.ts`)
    to assert the run produced ≥N intermediate stream events from BOTH executors and that
    `lastHeartbeatAt` advanced during execution (never stale). This is the stub-free proof the
    observability gap is closed.

**Auto-merge: producing the finalizer substrate (in scope).** The Phase 8 hold
(`orchestrated-work-runner.ts:234`) deferred the gated merge only because orchestrated runs did
not produce the artifacts `runFinalizer` consumes. Streaming (above) supplies the missing piece
— the transcript — and the rest is computable from the run's worktree git state, which already
holds the per-task closeout commits. The `runFinalizer` entry point
(`work-run-finalizer.ts:283`) is cleanly seamed behind `FinalizerEffects`, so wiring it for
orchestrated runs is binding effects, not new merge logic.

11. **Persist a durable transcript.** Pipe the streamed events (work items 2-8) into a
    transcript sink (`createTranscriptSink`, `work-run-transcript.ts` →
    `<WORK_RUNS_DIR>/<runId>/transcript.jsonl`), exactly as the legacy runner does
    (`work-runner.ts:399`). This is where streaming pays a second dividend — the same events
    that light up the cockpit become the durable record.
12. **Produce work-product classification.** Run `computeWorkProduct` + `classifyWorkProduct`
    (`work-run-classify.ts:216,260`) over the orchestrated branch to derive the `WorkOutcome`
    (`branch-complete` when commits exist and `tasksRemaining == 0`). The orchestrated loop
    already commits per task and tracks the `tasks.md` delta, so the inputs exist.
13. **Write `summary.json`.** Build the `WorkRunSummary` (`work-run-store.ts:28`) via
    `buildSummary` from the terminal event + work-product facts + base SHA + timestamps, and
    write it to `<WORK_RUNS_DIR>/<runId>/summary.json`.
14. **Wire `runFinalizer` in `gated-merge` mode**, replacing the `unavailable` stub. Bind the
    `FinalizerEffects`: `classify`, `flushTranscript`, `writeSummary`, `appendIndexRow`,
    `recordPhase`/`readLastPhase` (crash-resume), and `gate` = `withBaseBranchLock(product,
    baseBranch, () => runGate({...validationCommands, tasksRemaining}))` — the same per-base
    merge lock and validation gate the legacy runner uses (`work-runner.ts:815,892`), plus
    `mergeBranch`/`pushBranch`/`deleteBranch`. A `branch-complete` outcome that passes the gate
    merges `--no-ff` and pushes; any other outcome or a failed gate holds and alerts.
15. **Preserve the no-self-merge and objection invariants.** The merge path is the finalizer's
    gate, never an independent merge (req 17). A non-reversible high/critical terminal finding
    or a failed gate holds the branch at branch-complete with the handoff payload recorded
    (req 25). Auto-merge is the clean-run terminal, not an unconditional one.
16. **Extend the live acceptance harness again** to drive a clean orchestrated run all the way
    to a merged base branch (gated) in a self-contained temp repo with a local bare remote, and
    a deliberately-gate-failing run to a recorded hold — proving both terminals without
    production push credentials or operator action. This supersedes the Phase 8
    "branch-complete held" acceptance.

### Phase 11B: Crash recovery & resumable runs (reopened 2026-06-14)

Runs via the orchestrator after Phase 10 (it reuses Phase 10's durable transcript) and after Phase
11A has landed. The feedback-retry failure mode that was bundled here moved to **Phase 11A** above;
this section is the crash-recovery half. Forensics: `mutations.jsonl` shows the project-17 run as
`pending → failed/orphaned → failed/orchestration-blocked`, and the identical pattern repeats on the
2026-06-10 run — systemic, not a one-off.

**A server restart amputates the run instead of resuming it.** When the server restarted
mid-run, crash recovery flipped the still-`running` mutation to `failed/orphaned`
(`reconcileOrphans`, `mutations-log.ts:45`, called at `index.ts:70`) — blind to whether the run
is resumable. The Phase 3 reconstruction primitive (`orch-reconstruct.ts`) is **dead code**:
imported only by its own test, wired into no runtime path, and dependent on `TaskRunRecord`s that
are **never persisted** (in-memory only, `project-orchestrator.ts:90`). The committed per-task
closeout commits and ticked `tasks.md` survive on the branch (resumable in principle —
`createWorktree` even has a branch-resume path, `sandbox-runtime.ts:303`), but nothing
re-dispatches the run, and `cleanupOrphanWorktrees` (`index.ts:92`) then sweeps the worktree dir.
The double-terminal is the same disconnect: `reconcileOrphans` rewrites the on-disk `running`
line in place while the still-draining generator later appends its own terminal
(`mutations.ts:415`), with no idempotency guard — two terminals for one id.

**Definition of done.** A server restart mid-run resumes the orchestrated run from durable state
(persisted records + branch commits + `tasks.md`) rather than orphaning it, and no run ever lands
two terminal records. (The feedback-retry definition of done moved to Phase 11A.)

**Work items.**

5. **Persist orchestrated run state.** Build the `TaskRunRecord` JSONL store
   (`orch-run-record.ts`'s header already promises it) plus a run cursor and resume marker
   keyed by mutation id/run id, so a partial run is reconstructable from disk. Reuse Phase 10's
   durable transcript as part of the record set. The marker must include enough product,
   branch, base, worktree, cursor, findings ledger, and round-history data to resume without
   asking an operator.
6. **Resume, don't orphan, on boot.** Route a still-`running` or `resumable` orchestrated
   mutation through `reconstructRun` (`orch-reconstruct.ts`) + a re-dispatch against its
   existing branch, instead of the blind `reconcileOrphans` flip. Resume from `tasks.md` +
   branch commits + records under a single-run lease so two server processes cannot resume the
   same mutation concurrently.
7. **Make orphaning idempotent and orchestration-aware.** `reconcileOrphans` must not write a
   terminal for a run that will resume, and the pipeline must never land two terminals for one id
   (skip-if-already-terminal guard before every terminal append). Add a graceful-shutdown drain
   that flips in-flight orchestrated runs to a durable `resumable` state rather than leaving a
   bare `running` line.
8. **Don't sweep a resumable run's worktree** (or rely on `createWorktree`'s branch-resume to
   rebuild it) — `cleanupOrphanWorktrees` must skip a run marked for resume.
9. **Live acceptance:** a restart injected mid-run resumes to completion with no orphaned record
   and exactly one terminal; and a forced gate rejection drives a corrective QA retry that
   *passes* on the feedback (not a blind redo) — the stub-free proof both failure modes are
   closed.

### Phase 12: Role learning & exemplars (reopened 2026-06-14)

The project-17 run exposed that the team has no memory and no model of "good." All six role
memories are cold-start (`agents/qa/memory.md` is 1 byte), no role receives an exemplar of good
output, and a gate rejection leaves zero durable residue — so the same mistake recurs every run.
Where Phase 11A makes a rejection *fix the current attempt*, Phase 12 makes it *teach the next
one*.

**A. No model of "good output."** A role receives two channels (`composeRoleContext`,
`loader.ts:142`): SOUL (charter prose) + memory (lessons — empty today). There are no reference
exemplars — no golden examples, nothing the tech-lead tailors per project. QA fed already-redacted
placeholders as test inputs partly because it had no example of a correctly-pinned redaction test
to mirror; it gets charter prose + an empty memory + a `testStrategy` enum, none of which shows
the shape the tech-lead would approve.

**B. Gate rejections leave no durable lesson.** The learning loop (Phase 6) runs only nightly,
fed exclusively by externally-authored feedback records (`feedback-record.ts:5` — feedback is
"never inferred from arbitrary chat, transcripts, or usage logs"). There is no path from an in-run
gate block to a feedback record — the block produces in-memory `TaskEvidence` and nothing else
(`team-task-workflow.ts:196`). So the system cannot learn from its own gate failures, and the
tech-lead's precise redaction feedback taught QA nothing.

**Definition of done.** Every role receives reference exemplars of good output (a permanent
baseline plus per-project exemplars), and every gate rejection produces a neutral-validated lesson
written into the *counterpart's* memory at gate-time and loaded into that role's next invocation.
The QA→tech-lead redaction failure that blocked project-17 leaves both a QA lesson and an exemplar
that a re-run uses to pass.

**Work items — A. Role exemplars.**

1. **Author a permanent per-role exemplar baseline** under `agents/<role>/examples/`, starting
   with QA — a correctly-pinned security-boundary test (real secret-shaped token in; raw token
   asserted absent while the redacted placeholder is present), the exact shape project-17 lacked.
2. **Tech-lead emits per-project exemplars** during planning (extends the test-strategy step it
   already owns), tailored to the project's conventions, persisted with the project.
3. **Add an exemplar channel to `composeRoleContext`** (`loader.ts`): charter + memory +
   exemplars, as low-authority reference, budget-bounded like memory.

**Work items — B. Gate-triggered learning (hybrid authoring, neutral guard preserved).**

4. **Emit a structured gate-rejection record** at each gate block in `team-task-workflow.ts`
   (QA←tech-lead test intent, coder←reviewer, coder←tech-lead diff, designer): the rejecting
   role, the counterpart role, what failed, and actionable notes — the SAME object Phase 11A
   threads into the retry, reused not duplicated.
5. **The rejecting role drafts a candidate lesson** for the counterpart from that record — it
   has the most context on what was wrong.
6. **A neutral Rune validation pass writes it.** Run the existing post-mortem attribution model
   (`runPostMortem`, `postmortem.ts:3` — "roles are witnesses, not the judge") synchronously at
   gate-time: privacy-filter, dedupe, attribute, fail safe to no-lesson, then write via
   `writeRoleLesson` (`memory-writer.ts:78`) into the counterpart's memory. Roles never write
   memory directly — the neutral guard stays.
7. **Make the learning loop gate-triggered, not only nightly.** The gate-time path and the
   nightly loop share one write path (`writeRoleLesson`) and must not double-write the same
   lesson (the dedupe in `memory-writer.ts` is the guard).
8. **Live acceptance:** a forced QA→tech-lead redaction rejection writes a validated QA lesson and
   the exemplar is present; a re-run loads both into QA's reference context and the QA output
   passes the gate — stub-free proof the team now learns from a gate failure.
9. **Fail safe without blocking the task path.** If exemplar loading, lesson drafting,
   validation, or memory writing fails, record a durable skip/error and continue the Phase 11
   corrective retry path. Gate-time learning must improve future runs, not make the current
   run depend on a memory write.

### Phase 13: Outcome gating (reopened 2026-06-16)

Runs via the orchestrator after Phase 12. This phase replaces the current binary gate logic with
one shared verdict contract and severity-aware outcomes.

1. **Introduce `GateVerdict`.** Reviewer, tech-lead diff review, and designer gates normalize to
   `{ outcome, findings, notes }`, where outcome is one of `pass`, `pass-with-warnings`, `fail`,
   or `block`. Legacy `{ pass: boolean }` role adapters are normalized at their boundary; internal
   orchestration no longer infers behavior from booleans plus `objections.length`.
2. **Make severity the single source of truth.** Add one mapping helper for objection-class
   findings: `critical`/`high` -> `block`, `medium` -> `fail`, `low` ->
   `pass-with-warnings`; multiple findings choose the strictest outcome.
3. **Treat warnings as shippable evidence.** `pass-with-warnings` advances the task, but warnings
   are written into `TaskRunRecord` and the finalizer handoff so terminal summaries can show the
   caveats that shipped.
4. **Retry reviewer-produced blocks once, then park.** A valid `block` verdict feeds the existing
   `GateRejectionFeedback` to the coder for exactly one corrective round from a dedicated
   block-correction budget. If it survives, the run parks `blocked-on-human` with branch and
   worktree preserved; it must not become a failed terminal with deleted work.
5. **Record accepted risk.** The core override seam accepts a finding only with a rationale and
   records the acceptance in the task/run record. PM may use it for non-`block` outcomes; human
   acceptance of `block` remains an injected seam for this phase, with cockpit/Telegram wiring
   allowed as a follow-up.
6. **Fail closed on malformed gates.** Unknown outcome, malformed severity, or failed warning /
   acceptance recording degrades to an operational `block` with a durable reason and parks
   immediately because the coder cannot fix that class of failure.

---

### Phase 14: Severity loop to convergence (reopened 2026-06-18)

Runs via the orchestrator after Phase 13. Replaces the `block`/park-on-human model with a bounded
coder↔review-gates convergence loop that never blocks on a human. Triggered by the 2026-06-17
orchestrated run, which built the full Phase 13 severity gate and then parked `blocked-on-human` on
a real `high`/`irreversibility` finding — a gate the team is capable of resolving itself. The
thesis: the coder and review gates can resolve findings; the loop should converge on severity, and
the only thing a human gate ever bought was a backstop against a non-reversible bad merge, which a
branch HOLD covers.

1. **Remove the `block` outcome.** `GateVerdict.outcome` becomes `pass | pass-with-warnings | fail`.
   The severity mapper becomes `critical`/`high`/`medium` → `fail`, `low` → `pass-with-warnings`.
   Delete the `block` branch, the dedicated block-correction budget, and every `blocked-on-human`
   terminal in the per-task path.
2. **Restructure the objection taxonomy.** Drop the `irreversibility` class; add `outbound`. Classes
   are detection lenses: `security`, `privacy`, `data-integrity`, `concurrency`, `outbound`,
   `cost-perf`. Add a `reversible: boolean` to every finding — whether a git revert undoes the
   effect — decoupling "can we undo it" from the class name. Update `agents/reviewer/SOUL.md` to hunt
   the new class set and set `reversible` per finding.
3. **Bound the loop by convergence, not a fixed cap.** Delete the outer attempt cap
   (`decideAttemptOutcome`) and the PM-wrap-up-at-cap terminal. Each round is coder → review gates:
   reviewer always, tech-lead diff always, designer when the task is designer-needed. All findings
   feed the same ledger. Exit precedence: (a) max open severity ≤ `low` → pass to closeout; (b) no
   strict drop in max severity for 3 consecutive rounds → terminal; (c) hard budget of 4 rounds →
   terminal.
4. **Give the review gates per-task memory.** A findings ledger `{id, sourceGate, class, severity, location,
   rationale, reversible, raisedRound, status}` persists across rounds and threads into
   `ReviewerInput` and any gate prompt that can verify prior findings. Finding ids are stable
   across re-review and terminal bug logging. The reviewer runs regression-first (verify each open
   finding fixed, cite it; mark a reappearing resolved finding `regressed`), then discovery. The
   ledger is **intra-task in-memory state** — it lives for the rounds of one task, not across a
   server restart. Crash recovery (Phase 11B) resumes at *task* granularity: a task interrupted
   mid-loop re-runs from round 1 and rebuilds its ledger (no closeout commit was made mid-loop, so
   no work is lost). The persisted run cursor therefore carries no ledger and no round history; it
   also **drops the now-removed outer attempt-cap field** (see item 3), and cursor resume must stay
   backward-tolerant of an older cursor that still carries `attemptCap`.
5. **Fix in severity order.** The coder receives the ledger severity-sorted, must attempt every open
   finding highest-severity-first, and reports which it addressed — making the critical→low descent
   hold by construction rather than by luck.
6. **Terminal handling is orchestrator-owned and never human-gated.** At terminal, the orchestrator
   drains the remaining `>low` findings into the Rune repo's `docs/projects/bugs.md` (one
   detailed, deduped entry each, via the backlog safe-write substrate — see req 81). If any
   remaining `critical`/`high` finding is `reversible: false`, it HOLDS the branch (no auto-merge,
   finalizer handoff). Otherwise the gated auto-merge proceeds and the run advances. No
   `blocked-on-human` on a *finding*, ever. The one other non-merge terminal is an **operational
   failure** (malformed gate output, a closeout/persist failure, or a dirty worktree — req 83):
   that also HOLDS to preserve work, but it is an infrastructure stop, distinct from the findings
   HOLD and still never a human-gated park. So the reversible-finding HOLD is the sole non-merge
   path *driven by a finding*, not the sole non-merge terminal overall.

This supersedes the Phase 13 `block` outcome and retires the Phase 13 task "Update
Objection-Classes / Auto-merge consumers (reqs 25, 45) to severity-aware gating" into Phase 14:
that consumer gate is rewritten on the `reversible` flag, which subsumes the multi-finding
gate-bypass defect the 2026-06-17 reviewer surfaced (single-finding `.find` check →
all-blocking-findings `.every`).

> **Sequencing:** runs via the orchestrator AFTER Phase 13. Depends on Phase 4 (team-task workflow),
> Phase 11A (reuses `GateRejectionFeedback` for the coder rounds), and Phase 10 (the auto-merge /
> finalizer consumer it rewrites). A `/work --auto` target — no operator decisions in the automated
> path, since the design removes every human terminal.

---

### Phase 15: Project-completion finalization and progress alerts (reopened 2026-06-18)

Runs via the orchestrator after Phase 14. Closes the last operator-visibility gaps in the
auto-merge path: a finished project must mark its project-index row `Done` as part of the branch
that lands, and a long run must narrate closeout commits as they happen.

1. **Mark the project Done on the branch, before merge.** Add an idempotent `docs/projects/index.md`
   writer that locates the single project by slug/link and sets its status to `Done` in BOTH the
   table Status cell AND the `## <slug> — <status>` section heading (the index carries the status
   twice — flipping only the table cell leaves the prose heading lying). The heading's parenthetical
   suffix (e.g. `(reopened 2026-06-14)`) is preserved. It runs as a finalizer step inside the
   gated-merge sequence — AFTER an eligibility `classify()` proves the run is actually
   `branch-complete` (an all-tasks-checked-but-zero-commit run classifies `noop` and must not flip
   or merge) and BEFORE the final terminal summary/index writes and gate. Because the step creates a
   new commit, the finalizer must refresh or re-stamp the terminal event/work-product facts after it
   so `summary.json`, the work-runs index row, and the terminal payload include the project-Done
   commit. Already-`Done` is a no-op with no empty commit, which also makes crash-resume safe (a
   resume re-reads the worktree and sees `Done`). An **absent** `docs/projects/index.md` is a
   graceful skip — the run still merges, because the index convention is Rune-repo-specific and a
   target product need not carry it. A **present-but-ambiguous** index (malformed table, zero
   matching rows/headings, or multiple) is an operational HOLD: do not guess, write the base branch
   directly, or leave an uncommitted edit behind.
2. **Keep finalizer ownership.** The index-Done step is a new finalizer phase (recorded for
   crash-resume, e.g. `project-marked-done`, slotted after the eligibility classification and before
   `summary-written`/`index-appended`), not a new merge path. Startup recovery must treat
   `project-marked-done` and any later pre-merge phase (`summary-written`/`index-appended`) as a
   resumable gated-merge state for a branch-complete run — it must re-enter the gate/merge path
   without human intervention, not downgrade the run to a hold merely because the process restarted
   before `merged-not-pushed`. The Project 15 gated finalizer still owns classify → … → gate → merge
   → push → worktree removal → branch delete → terminal. A gate HOLD, finding HOLD, or operational
   HOLD skips both the index flip and the success notification. Because every completing project now
   writes the same shared `docs/projects/index.md`, a merge of two near-simultaneous landings can
   conflict on that one file: the finalizer's merge step must abort a conflicting `git merge` and
   HOLD operationally (work preserved on the branch), never leave a half-merged dirty base.
3. **Announce successful landing after push and cleanup.** Add a finalizer success callback
   symmetrical to the existing gate-fail `alert`, but fire it only after `pushBranch` succeeds (or
   crash recovery resumes from a phase proving the push already landed) and worktree/branch cleanup
   has been attempted. Deduplicate by run id + branch + pushed phase so restart/replay cannot
   double-send. Event publication remains best-effort: record a durable skip/error if publication
   fails, and let transport-level delivery failures be logged by the sender, but never fail or roll
   back a landed merge because a notification could not be sent.
4. **Emit closeout-commit progress.** After each successful `commitCloseout`, emit a progress event
   bound to the returned commit sha. The payload includes project slug, task label/text, short sha,
   commit subject, and live remaining/total counts derived from the checked `tasks.md` state after
   closeout. No commit means no progress alert. Deduplicate by commit sha across resume/replay, and
   make event-publication and transport-delivery failures non-blocking.
5. **Use existing local-operator plumbing.** Reuse the mutation/activity event stream and
   `transport/telegram-sender.ts` sender surface instead of introducing a second bot or direct
   Telegram dependency inside orchestration. The dedupe (commit sha for progress, run id + branch +
   pushed phase for merge-success) is enforced at the run/artifact layer — the layer that owns the
   per-run artifact dir and finalizer phase store — BEFORE the event is published, so the
   `telegram-sender` stays stateless and a redelivered or replayed event cannot double-send. The
   orchestrated terminal must route so it does not itself claim a merge (req 85), keeping the
   merge-success notification the single landing alert. Automated acceptance injects the
   notification sink; it never requires real Telegram or a production push.

> **Sequencing:** runs via the orchestrator AFTER Phase 14. Depends on Phase 10 finalizer wiring and
> durable transcript, Phase 11B resume state, and Phase 14 terminal HOLD semantics. A `/work --auto`
> target — no operator decisions in the path.

---

## Success Metrics

| Metric | Target | How measured |
| --- | --- | --- |
| Role authority boundary | always | SOUL in system prompt; memory/context in low-authority reference |
| QA-first enforced | always | Tests exist and are tech-lead-reviewed before coder starts |
| Reviewer independent | always | Reviewer provider differs from coder and reviews diff/spec/tests/context; if no distinct-provider reviewer is available the task blocks (fail-closed), never a same-provider review |
| Context stays useful | always | Required sections preserved, bounded, no transcript dumps |
| Multi-task loop closes | yes | Fixture runs through at least two task closeouts, context update, and finalizer handoff |
| Start surface is truthful | always | Cockpit Start/confirmation shows orchestrated vs legacy mode and fallback reason |
| Objection classes gate by severity | always | Security/privacy/data/concurrency/outbound/cost findings map to warning or retry by severity |
| Finalizer owns landing | always | Completed project hands off to Project 15; no independent merge path |
| Branch stays finalizer-ready | always | Every advanced task has a clean closeout commit including task/context state |
| Severity loop is bounded | always | All-low exit, 3-round stagnation backstop, or 4-round hard budget; never infinite retry |
| Learning compounds | yes | Fixture feedback writes a role lesson loaded into the next run |
| Checklist closeout satisfied | always | Deferral ADRs and `agent-lessons.md` exist, and final completion rechecks user-reachability |
| Orchestrated run is observable | always | Cockpit stream shows role activity between start and terminal for both executors |
| Heartbeat advances mid-run | always | `lastHeartbeatAt`/`lastOutputAt` advance during a live orchestrated run; a working run never reads quiet, never quiet→cancelled |
| Provider parity | always | Codex and claude role activity stream and are attributed equally (role/provider/model per line) |
| Orchestrated run produces substrate | always | `transcript.jsonl` + `summary.json` + classification written under `WORK_RUNS_DIR`, as a legacy run does |
| Clean run auto-merges | yes | A clean `branch-complete` orchestrated run lands on base through the Project 15 gated finalizer, no operator hold |
| Merge stays gated | always | Non-branch-complete work or non-reversible high/critical terminal findings hold the branch; merge only ever via the finalizer's gates |
| Retries are corrective | always | A gate rejection threads its feedback into the role's next attempt; no blind same-input redo |
| Holds preserve work | always | A non-reversible high/critical terminal finding holds with branch/worktree preserved; work is never discarded |
| Restart resumes | always | A restart mid-run resumes from durable state; no orphaned record, exactly one terminal per run id |
| Roles have exemplars | always | Each role invocation includes reference exemplars of good output (baseline + per-project) |
| Gate failures teach | always | Every gate rejection yields a neutral-validated lesson in the counterpart's memory at gate-time |
| Neutral guard preserved | always | Roles never write memory directly; a neutral Rune pass attributes and filters every lesson |
| Learning failures are non-blocking | always | Exemplar/lesson failures record durable skip/error metadata and do not block the current corrective retry |
| Loop never blocks on a human | always | No per-task path reaches `blocked-on-human`; `block` outcome, outer attempt cap, and PM-wrap-up terminal are removed |
| Loop converges on severity | yes | A task exits when max open severity ≤ `low`, or on the stagnation backstop (no drop for 3 rounds), or at the 4-round hard budget |
| Findings are reversibility-tagged | always | Every finding carries `class` + `severity` + `reversible`; the terminal HOLD keys on `reversible: false`, not on class name |
| Coder fixes highest severity first | always | Coder receives the ledger severity-sorted, attempts every open finding, and reports which it addressed |
| Reviewer verifies its own fixes | always | Re-review runs regression-first (each open finding checked + cited) before discovery; reappearing resolved findings mark `regressed` |
| Unresolved findings are logged, not lost | always | At terminal the orchestrator writes each remaining `>low` finding to `docs/projects/bugs.md` with stable dedupe; non-reversible high/critical findings also HOLD the branch |
| Project index completion is branch-owned | always | A merge-bound `branch-complete` run commits the `docs/projects/index.md` Status→Done edit (table cell + section heading) on the feature branch before the finalizer gate; an absent index skips gracefully, an ambiguous index HOLDs, and HOLD paths skip the flip |
| Operator progress is narrated | always | Each closeout commit emits one deduped progress alert, and a pushed merge emits exactly one success alert; publication failures are recorded, sender delivery failures are logged, and both are non-blocking |

---

## Deferrals

Scope cut from v1. Each needs a short ADR at `docs/projects/14-product-team-agents/
<topic>-deferral.md` (written at closeout, template:
[`08-intent-layer/egress-deferral.md`](../08-intent-layer/egress-deferral.md)) so the cut
does not become invisible.

- **Autonomous scheduler dispatch.** Deferred — a human or existing surface starts every run
  in v1. *Trigger to promote:* the intent layer is ready to select and dispatch project runs
  without a human start action, and orchestrated loop closure is proven on real tasks.
- **Legacy `/work --auto` removal.** Deferred — the legacy applier stays reachable as the
  recorded fallback. *Trigger to promote:* the orchestrated path has run N consecutive real
  projects to a clean finalizer handoff with no fallback, at which point legacy dispatch is
  removed.
- **Quality / engagement eval.** Deferred — v1 gates on loop closure, not output quality.
  *Trigger to promote:* loop closure is stable and usage data exists to judge whether the
  team's output is actually better (the Project 12 path).

## Open Questions

- **Smallest useful context handoff:** how aggressively should `context.md` compress decisions,
  interfaces, risks, and next-task handoff without losing coherence?
- **v1 role subset:** full workflow is the target, but v1 may invoke designer/PM only when
  tech-lead sizing or the orchestration state requires them.
- **Fallback selection:** operator flag, config rollout, dependency check, or per-product
  policy.
- **Task granularity:** tech-lead-authored `tasks.md` must produce tasks that are neither too
  fragmented nor too broad for one fresh execution context.

## Provenance

Originally captured as Project 14 (product-team role agents) from the 2026-06-05 Rune
conversation extending Projects 08 and 12. Folded in the 2026-06-07 Project 16
Rune-orchestrated-work idea after reframing: the useful product is not standalone role
agents, but Rune coordinating a role-agent product team across an entire project with
explicit context handoff.
