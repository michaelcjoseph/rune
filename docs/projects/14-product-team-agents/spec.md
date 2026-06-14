# Product-Team Orchestrated Work Specification

> **Status: REOPENED 2026-06-14 — Phase 10 (execution observability parity).**
> Phases 1-9 shipped the role substrate, planning, per-task orchestration, the live
> execution binding (Phase 8 — proof `live-acceptance-6abf35cf.md`), and the planning
> critique pass (Phase 9). Orchestrated runs now do real work — but they do it blind:
> the applier emits only a "starting" `log` and one terminal event, so codex and claude
> role activity never reaches the cockpit stream, and the supervision heartbeat goes
> stale mid-run (it advances only on `output`/`activity` events the orchestrated path
> never emits). Remaining scope is **Phase 10** below: stream role activity and advance
> the heartbeat for both executors, at first-class parity with the legacy `/work --auto`
> work-runner. Both Claude and Codex runs are observable and treated equally.
>
> *(Prior reopen, 2026-06-10: Phases 8-9 — live execution binding + planning critique —
> now DONE.)*

## What's shipping (working-backwards)

You work the way you do today: discuss an idea into a spec, then let it build. What changes
is who owns the work after that discussion. Jarvis becomes a small engineering workflow
engine backed by a simulated product team: PM, tech lead, QA, coder, reviewer, and designer.
Each role has a repo-local `SOUL.md` charter plus a compounding `memory.md` of lessons.

The PM writes the spec, interviewing only when the idea is underspecified. The tech lead
breaks the spec into task-sized slices and sizes which roles need to convene. Jarvis then
owns the project loop: it selects the next unchecked task, assembles bounded context, invokes
the team roles, performs a Jarvis-owned task closeout (`tasks.md` + `context.md` + commit),
and advances until the project is ready for the Project 15 finalizer.

This replaces the current shape where Jarvis starts one long `/work --auto` process and lets
that model own task selection, continuation, context management, implementation, review, and
wrap-up inside one accumulating conversation. The larger point is not just avoiding context
pressure. A large automated project should be coordinated by Jarvis, with explicit workflow
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

Jarvis coordinates a persistent product team across a whole project: explicit role gates,
fresh per-task execution contexts, compact project memory, atomic task closeouts, truthful
task/run records, gated finalization, and a feedback loop that lets the team compound from
real usage.

### Goals

1. **Primary:** create the product-team role substrate: `agents/<role>/{SOUL.md,
   memory.md}` (PROJECT_ROOT-relative, mirroring `agents/writer/` from Project 12) for PM,
   tech lead, QA, coder, reviewer, and designer.
2. **Primary:** make Jarvis own project execution per task rather than handing an entire
   project to one long `/work --auto` process.
3. **Primary:** maintain a bounded, durable `docs/projects/<project>/context.md` artifact
   that carries high-signal project continuity between fresh task executions.
4. **Secondary:** enforce role gates: QA before coder, tech-lead test review, cross-model
   reviewer independence, designer review for tech-lead-flagged front-end/designer-needed
   work, and objection-class hard gates.
5. **Secondary:** route models through the existing model-policy resolver; coder/reviewer
   independence is required by construction.
6. **Tertiary:** capture lessons from feedback through a neutral Jarvis-owned post-mortem
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
- **Unconditional merge.** Objection-class findings and failed finalizer gates block
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
| Jarvis-owned per-task orchestration | net-new | this project |
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
        -> Jarvis seeds context.md
```

**Assumptions live in the spec.** When the PM judges a brief specified-enough and fills gaps,
those calls are listed in an **Assumptions** section. Silent PM invention is the risk; the
assumptions section turns it into a cheap scan surface.

**Human interview is explicit.** In production, an underspecified brief can block for a PM
interview. Automated tests use fixtures: one specified-enough path for loop closure and one
underspecified path that asserts Jarvis blocks rather than fabricating a spec.

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

This is a Jarvis-owned neutral step, not a seventh role — like the learning-loop post-mortem,
Jarvis runs it over the role artifacts rather than assigning it to one role, because the
question spans the whole plan (PM-owned spec and tech-lead-owned tasks together).

---

## Project Execution: Jarvis-Owned Per-Task Loop

Jarvis owns the project loop.

```text
for each unchecked task in tasks.md:
  select the first unchecked task
  assemble bounded context
  run the team-task workflow in a fresh execution context
  record task result, commit, role verdicts, and gates
  update context.md through a Jarvis-owned context curator
  advance, retry, escalate, or block

when no unchecked tasks remain:
  hand branch/run facts to the Project 15 finalizer
```

The task executor does not choose arbitrary work. Jarvis selects the task before spawning the
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
  -> objection-class gates must clear
  -> ready-for-closeout / blocked / failed verdict
```

The workflow returns structured task evidence: task id/text, attempt id, roles invoked,
model/provider choices, transcript ids, changed files/diff summary, review verdicts,
objection findings, handoff notes, and gate decisions. It does not mark the task complete,
write `context.md`, or merge to main. Jarvis owns task closeout.

### Task closeout

When the workflow returns `ready-for-closeout`, Jarvis performs one closeout sequence:

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

Retries are bounded. Each selected task has an attempt cap from configuration or escalation
policy. A retry can reuse the same task id with a new attempt id and the prior attempt's
evidence. When the cap is reached, non-objection disagreement routes to PM wrap-up; unresolved
PM decisions and all objection-class findings enter blocked-on-human. Jarvis must never spin
indefinitely on one task.

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
injected finalizer adapter in tests. If the real finalizer is unavailable at runtime, Jarvis
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

Jarvis owns `docs/projects/<project>/context.md`. It is orchestration state, not a seventh
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

Some defects do not show up in normal usage until they matter: security holes, data-integrity
bugs, concurrency races, irreversible operations, and cost/perf regressions. These are hard
gates.

- An open objection-class finding blocks task completion and project finalization.
- PM wrap-up authority does not extend to unresolved objection-class findings.
- The reviewer role's verdict is structured: alongside pass/fail it carries a
  machine-readable objection-class payload (class, severity, location, rationale) that the
  orchestrator gates on. This is a property of the reviewer-role agent invoked inside the
  team-task workflow, not a change to the standalone `/review` skill — if the workflow later
  reuses `/review` as the reviewer harness, that skill must emit the same payload shape, and
  that wiring is its own task.
- Per-product additions can extend the global baseline list.

---

## Learning Loop

The build loop gets the work done. The learning loop makes the team better.

```text
usage reveals an issue -> feedback record exists
  -> nightly Jarvis-owned post-mortem
  -> attribute the miss to a stage/role
  -> write one atomic, provenance-stamped lesson to that role's memory.md
```

Jarvis runs the post-mortem, not a team role. It can interview roles as witnesses, but Jarvis
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
9. WHEN planning completes THEN Jarvis seeds `context.md`.

### Orchestration

10. WHEN a project run starts THEN Jarvis selects the first unchecked task from `tasks.md`.
11. WHEN a task starts THEN Jarvis creates a fresh execution context and passes only bounded
    handoff input.
12. WHEN a task workflow completes successfully THEN Jarvis performs task closeout: update
    `context.md`, mark exactly the selected task complete in `tasks.md`, create/record the
    closeout commit, run closeout checks, verify the worktree is clean, and then advance.
13. WHEN task closeout cannot produce a clean checkpoint THEN Jarvis blocks durably and does
    not advance.
14. WHEN a task workflow returns blocked, failed, or objection-open THEN Jarvis retries only
    within the configured attempt cap, escalates, or stops durably; it does not skip the task.
15. WHEN the attempt cap is reached THEN non-objection disagreement routes to PM wrap-up, and
    unresolved or objection-class cases enter blocked-on-human.
16. WHEN no unchecked tasks remain THEN Jarvis hands branch/run facts to the Project 15
    finalizer.
17. WHEN the real finalizer is unavailable THEN Jarvis records the handoff payload and stops
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
25. WHEN objection-class findings remain open THEN the task cannot complete autonomously.

### Context and recovery

26. WHEN context is updated THEN all required sections remain present and bounded.
27. WHEN role handoff notes are emitted THEN the context curator may use them, but roles do
    not write `context.md` directly.
28. WHEN the server restarts THEN Jarvis can reconstruct a partial project run from durable
    task records, commits, `tasks.md`, and `context.md`.

### Learning

29. WHEN no valid feedback record exists THEN no post-mortem runs and no memory is written.
30. WHEN a feedback record is malformed THEN Jarvis records a durable skip reason and does
    not treat it as valid feedback.
31. WHEN feedback identifies a catchable miss THEN Jarvis attributes it to a stage and writes
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
    `tasksRemaining == 0`) THEN Jarvis invokes the Project 15 finalizer in `gated-merge` mode
    rather than holding for an operator.
44. WHEN the finalizer gate passes THEN the branch merges `--no-ff` onto its base under the
    per-base merge lock and is pushed; WHEN the gate fails THEN the run holds branch-complete,
    records the gate reason, and never touches the base branch.
45. WHEN an objection-class finding is open OR the outcome is not `branch-complete` THEN the run
    holds with the handoff payload recorded and does not merge (reqs 17, 25 preserved).
46. WHEN the orchestrated finalizer wiring lands THEN the Phase 8 `unavailable` hold stub is
    gone and cannot reappear without failing a regression test.

### Orchestration resilience (Phase 11)

47. WHEN a role gate rejects (tech-lead test intent, reviewer, tech-lead diff, designer) THEN
    the rejection's structured feedback is threaded into that role's next attempt; no retry
    re-runs a role with identical inputs and no feedback.
48. WHEN the tech lead rejects QA's test intent THEN QA revises against the feedback in a
    bounded rewrite loop before the task escalates, rather than the run blocking on the first
    rejection.
49. WHEN a task cannot pass after its feedback-retry cap THEN it parks blocked-on-human with the
    worktree and branch preserved; the committed work is not discarded and the project run holds
    at that task rather than ending destructively.
50. WHEN the server restarts mid-run THEN a still-`running` orchestrated mutation resumes from
    durable state (persisted records + branch commits + `tasks.md`) rather than being orphaned.
51. WHEN orchestrated run state is persisted THEN `TaskRunRecord`s and a run cursor are written
    to disk so a partial run is reconstructable via `reconstructRun`.
52. WHEN crash recovery runs THEN it never writes a terminal for a run that will resume, and the
    pipeline never lands two terminal records for one mutation id.
53. WHEN a run is marked for resume THEN the orphan-worktree sweep preserves its worktree (or the
    branch-resume path rebuilds it on re-dispatch).

---

## Implementation Phases

### Phase 1: Role substrate

Generalize the Project 12 writer loader to PM, tech lead, QA, coder, reviewer, and designer.
Create each role's `SOUL.md` and empty-or-seeded `memory.md`. Confirm Jarvis is registered as
a targetable product if needed.

### Phase 2: Planner roles

Wire PM and tech-lead identities into planning. PM writes specs or blocks for interview. Tech
lead writes task breakdown, role sizing, and test strategy. PM checks spec/tech-spec match.
Planning seeds the initial `context.md`.

### Phase 3: Context and orchestrator substrate

Define `context.md`, bounded context assembly, task-run records, task-closeout semantics,
attempt caps, restart reconstruction, finalizer handoff payloads, and fallback configuration.
Jarvis owns task selection and per-task execution state.

### Phase 4: Team-task workflow

Wire QA, tech lead, coder, reviewer, and designer into a task-sized workflow. Enforce
QA-first/test-strategy evidence, reviewer independence, designer routing, objection-class
gates, and global round caps. The workflow returns structured task evidence and does not mark
tasks complete, write context, or merge to main.

### Phase 5: Multi-task orchestration and finalizer handoff

Run deterministic fixture projects through at least two tasks with a closeout commit and
context update that affect later input. Prove Jarvis advances, blocks/retries correctly,
reconstructs after restart, and hands completed project facts to Project 15 rather than
self-merging.

### Phase 6: Learning loop

Implement feedback-record source/reader validation, Jarvis-owned post-mortem attribution,
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
   gate or an open objection-class finding still holds the branch; the merge always goes through
   the finalizer's gates, never an independent path (spec req 17/25 preserved). This reverses
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
   **Decision required:** raw-line streaming (cheap, ships now) vs `codex exec --json` (JSONL
   event stream — codex's analog to claude's `--output-format stream-json`). Recommend
   `--json` with a label mapper analogous to `streamJsonToDisplay`, so codex activity renders
   as cleanly and structured as claude's. Record the choice and the fallback.
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
    gate, never an independent merge (req 17). An open objection-class finding or a failed gate
    holds the branch at branch-complete with the handoff payload recorded (req 25). Auto-merge
    is the clean-run terminal, not an unconditional one.
16. **Extend the live acceptance harness again** to drive a clean orchestrated run all the way
    to a merged base branch (gated), and a deliberately-gate-failing run to a recorded hold —
    proving both terminals. This supersedes the Phase 8 "branch-complete held" acceptance.

### Phase 11: Orchestration resilience (reopened 2026-06-14)

The overnight project-17 orchestrated run exposed two failure modes that make orchestrated runs
brittle in ways the task content didn't cause. Both are structural in the loop. Forensics:
`mutations.jsonl` shows the run as `pending → failed/orphaned → failed/orchestration-blocked`,
and the identical pattern repeats on the 2026-06-10 run — so both are systemic, not one-offs.

**A. Retries discard the feedback that would fix them.** The run blocked because QA fed
*already-redacted* placeholder strings (`sk-<redacted>`, `Bearer <redacted>`) as test inputs,
producing self-contradictory and vacuous redaction assertions. The tech-lead rejected with
precise, actionable feedback ("use real secret-shaped tokens; assert the raw token is absent
while the redacted placeholder is present"). That feedback was recorded in `blockedReason` and
then thrown away. The QA → tech-lead test-intent gate is one-shot (`team-task-workflow.ts:196` —
a rejection returns `blocked`, no rewrite loop), and although the orchestrator retries the whole
workflow up to the attempt cap (`decideAttemptOutcome` → `retry` while below cap,
`orch-attempt-cap.ts:50`), every retry re-invokes `qaWriteTests({task, spec})` with identical
inputs and zero feedback — three blind redos of the same mistake, then the entire project run
blocks. The coder round loop has the same defect: `deps.coder({task, spec, context, tests})`
(`team-task-workflow.ts:208`) re-runs on reviewer/tech-lead disagreement without the reviewer's
notes. No role learns from the rejection that triggered its retry. A human reads the feedback
and fixes the tests; the orchestration cannot.

**B. A server restart amputates the run instead of resuming it.** When the server restarted
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

**Definition of done.** (1) A gate rejection threads its structured feedback into the rejected
role's next attempt, so QA/coder revise *with* the feedback rather than blindly redoing; a task
that still can't pass after bounded feedback-retries parks blocked-on-human with its worktree
preserved, instead of ending the whole project run. (2) A server restart mid-run resumes the
orchestrated run from durable state (persisted records + branch commits + `tasks.md`) rather than
orphaning it, and no run ever lands two terminal records.

**Work items — A. Feedback-threaded retries.**

1. **Carry rejection feedback in the evidence.** The workflow already records `blockedReason`/
   role notes; surface them as structured `feedback` the orchestrator can pass back (which role,
   what it rejected, the actionable notes).
2. **Thread feedback into the retrying role.** On retry, `qaWriteTests` receives the tech-lead's
   test-intent rejection notes; the coder receives the reviewer + tech-lead-diff notes from the
   failed round; designer likewise where it gates. The retry is corrective, not a blind redo.
3. **Make the QA → tech-lead test gate a bounded rewrite loop**, not a one-shot block — QA
   revises against the tech-lead's notes up to a small cap, mirroring the coder→reviewer round
   loop, before the task escalates.
4. **Park, don't kill, on exhausted retries.** When a task can't pass after its feedback-retry
   cap, route it to blocked-on-human with the worktree preserved (reuse the Project 13 parked-run
   machinery) so a human can intervene on that task. The project run holds at that task; the
   committed work and branch are not discarded.

**Work items — B. Crash recovery & resumable runs.**

5. **Persist orchestrated run state.** Build the `TaskRunRecord` JSONL store
   (`orch-run-record.ts`'s header already promises it) plus a run cursor, so a partial run is
   reconstructable from disk. Reuse Phase 10's durable transcript as part of the record set.
6. **Resume, don't orphan, on boot.** Route a still-`running` orchestrated mutation through
   `reconstructRun` (`orch-reconstruct.ts`) + a re-dispatch against its existing branch, instead
   of the blind `reconcileOrphans` flip. Resume from `tasks.md` + branch commits + records.
7. **Make orphaning idempotent and orchestration-aware.** `reconcileOrphans` must not write a
   terminal for a run that will resume, and the pipeline must never land two terminals for one id
   (skip-if-already-terminal guard). Add a graceful-shutdown drain that flips in-flight
   orchestrated runs to a durable `resumable` state rather than leaving a bare `running` line.
8. **Don't sweep a resumable run's worktree** (or rely on `createWorktree`'s branch-resume to
   rebuild it) — `cleanupOrphanWorktrees` must skip a run marked for resume.
9. **Live acceptance:** a restart injected mid-run resumes to completion with no orphaned record
   and exactly one terminal; and a forced gate rejection drives a corrective QA retry that
   *passes* on the feedback (not a blind redo) — the stub-free proof both failure modes are
   closed.

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
| Objection classes block | enforced | Security/data/concurrency/irreversibility/cost findings hold completion |
| Finalizer owns landing | always | Completed project hands off to Project 15; no independent merge path |
| Branch stays finalizer-ready | always | Every advanced task has a clean closeout commit including task/context state |
| Task retries are bounded | always | Attempt cap reached -> PM wrap-up or blocked-on-human, never infinite retry |
| Learning compounds | yes | Fixture feedback writes a role lesson loaded into the next run |
| Checklist closeout satisfied | always | Deferral ADRs and `agent-lessons.md` exist, and final completion rechecks user-reachability |
| Orchestrated run is observable | always | Cockpit stream shows role activity between start and terminal for both executors |
| Heartbeat advances mid-run | always | `lastHeartbeatAt`/`lastOutputAt` advance during a live orchestrated run; a working run never reads quiet, never quiet→cancelled |
| Provider parity | always | Codex and claude role activity stream and are attributed equally (role/provider/model per line) |
| Orchestrated run produces substrate | always | `transcript.jsonl` + `summary.json` + classification written under `WORK_RUNS_DIR`, as a legacy run does |
| Clean run auto-merges | yes | A clean `branch-complete` orchestrated run lands on base through the Project 15 gated finalizer, no operator hold |
| Merge stays gated | always | Failed gate or open objection holds the branch; merge only ever via the finalizer's gates, never an independent path |
| Retries are corrective | always | A gate rejection threads its feedback into the role's next attempt; no blind same-input redo |
| Rejection parks, not kills | always | A task that exhausts feedback-retries parks blocked-on-human with worktree preserved; work is never discarded |
| Restart resumes | always | A restart mid-run resumes from durable state; no orphaned record, exactly one terminal per run id |

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

Originally captured as Project 14 (product-team role agents) from the 2026-06-05 Jarvis
conversation extending Projects 08 and 12. Folded in the 2026-06-07 Project 16
Jarvis-orchestrated-work idea after reframing: the useful product is not standalone role
agents, but Jarvis coordinating a role-agent product team across an entire project with
explicit context handoff.
