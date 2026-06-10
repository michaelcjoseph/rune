# Product-Team Orchestrated Work Specification

> **Status: INCOMPLETE — reopened 2026-06-10.** Phases 1-7 shipped the
> orchestration scaffolding and a reachable dispatch path, but the live role-spawn
> execution binding was left stubbed: the orchestrated applier returns a hardcoded
> `blocked` for every task (`orchestrated-work-runner.ts:169`) and reports the
> finalizer `unavailable` (`:215`). So an orchestrated run does no real work. The
> closeout treated live execution as an "optional smoke check" — it is the engine.
> Remaining scope is **Phase 8** below.

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
        -> Jarvis seeds context.md
```

**Assumptions live in the spec.** When the PM judges a brief specified-enough and fills gaps,
those calls are listed in an **Assumptions** section. Silent PM invention is the risk; the
assumptions section turns it into a cheap scan surface.

**Human interview is explicit.** In production, an underspecified brief can block for a PM
interview. Automated tests use fixtures: one specified-enough path for loop closure and one
underspecified path that asserts Jarvis blocks rather than fabricating a spec.

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
| PM | anthropic | Fable 5 |
| Tech Lead | anthropic | Fable 5 |
| QA | openai | GPT-5.5 (codex) |
| Coder | openai | GPT-5.5 (codex) |
| Reviewer | anthropic | Fable 5 |
| Designer | anthropic | Fable 5 |

**Work items.**

1. Build the production execution-agent primitive: a tool-using, worktree-scoped session
   (reuse the legacy work-runner spawn machinery) that takes a selected task plus the resolved
   model and returns a captured `git diff`. This backs the artifact roles (coder, QA test
   authoring).
2. Wire the text-judgment seams (tech-lead test/diff review, reviewer verdict, designer, PM
   wrap-up) on the existing `defaultRoleModelCall` text round-trip pattern from `/plan`.
3. Replace the `runTaskWorkflow` stub (`orchestrated-work-runner.ts:169`) to call the real
   `runTeamTaskWorkflow` with a production `TeamTaskDeps`.
4. Add model-registry entries for `fable` (anthropic/claude) and `gpt-5.5` (openai/codex) and
   populate `roleDefaults` for all six roles per the table above.
5. Wire the Project 15 finalizer in place of the `finalize` stub (`:215`), or keep the durable
   branch-complete hold if Project 15 is still unwired.
6. Add an acceptance test that exercises the real end-to-end path on a non-fixture task — the
   stub-free proof that this gap cannot recur.

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
