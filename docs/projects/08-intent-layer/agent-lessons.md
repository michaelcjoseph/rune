# Planning Retrospective — 08-intent-layer

**Owner:** the project, written for the agent (or human) who plans the next one.
**Date:** 2026-05-24, after the Phase 6 sweep through A4.2.

## Context

This file exists because a planning audit during the Phase 6 sweep surfaced a
systematic gap. Phases 1–5 had shipped their deterministic cores under green
tests, but **none of them was reachable from a real user surface**. A 58-task
Phase 6 ("Live integration") had to be added retroactively on 2026-05-22
(commit `5779260`) to wire those cores into the runtime. Even Phase 6 turned
out to be UI-incomplete — its tasks cover engine wiring but not the cockpit
and Telegram surfaces that the spec promised but never designed.

The lessons below are the answer to "what would I do differently planning the
next project?" They have been distilled into
[`docs/projects/templates/planning-checklist.md`](../templates/planning-checklist.md)
and the user-reachability paragraph added to `CLAUDE.md` so future planning
sessions inherit them automatically.

---

## What was planned vs what shipped

| Original task wording (one bullet each) | Implementation reality |
|---|---|
| Phase 3 → "Git worktree per project; separate worktrees…" | A1.1 `sandbox-runtime.ts` + A1.4 `sandbox-fs.ts`, ~600 LOC, 60+ tests, two modules |
| Phase 3 → "Per-repo scoped credentials and egress allowlists" | A1.2 `credential-injector.ts` + A1.3 `egress-policy.ts` + a deferral ADR, ~400 LOC, 53 tests, two modules |
| Phase 3 → "Build the idea-to-spec conversation" | A4.1 `src/reviews/planning.ts` + A4.2 `src/reviews/planning-handler.ts` (+ A4.3–A4.5 still pending — `/plan` command, cockpit panel, scaffolding hook, abandon-on-clear), ~400 LOC so far |
| Phase 5 → "Run the loop nightly, extending the existing nightly vault review" | Pure cores shipped (`observation-loop.ts`, `observation-nightly.ts`, et al.). B1–B5 runtime wiring entirely unbuilt. |

Each original bullet describes a **capability**. Each implementation reality
is a **(pure core + runtime adapter + user surface)** triple — at minimum
two modules per capability, often more. The bullet-to-module ratio of ~1:3
is the gap.

---

## Spec gaps surfaced

Beyond the task-list breakdown, the spec itself is **engine-complete but
UX-incomplete**. Concrete missing pieces:

- **Planning mode in the cockpit is named but undefined.** §"Three Surfaces"
  and §"Phase 2" mention "cockpit's planning mode" but never describe what
  it looks like. The cockpit's Plan button currently stuffs text into the
  chat input as a placeholder.
- **Approval UI is named but undefined.** §"Three Surfaces" promises
  "Approvals for journal-intake proposals and for carried-over roadmap items"
  but gives no surface design. Today the webview shows a *count* of pending
  approvals with no per-proposal approve/reject UI.
- **In-flight Layer 2 visibility is unspecified.** §"v1 Wedge" says the
  cockpit shows "which projects are running and which are blocked on him"
  but says nothing about per-round progress, the `failedEvaluatorRounds`
  counter, the active model (Claude vs Codex), or per-project cost.
- **12 open questions in §"Open Questions and Risks" are deferred without
  triggers.** Several (planner-may-pin-a-model? capability tag vocabulary?
  cost visibility?) gate full usability and were never re-tasked.

The 2026-05-24 spec update (this same patch series) fills these gaps —
see new `### Cockpit UX in Detail` and `### Telegram UX in Detail`
sub-sections under §"Three Surfaces", and the user-reachability annotations
on §"Definition of done (v1 wedge)".

---

## Causes

### 1. Tasks written at the spec's capability abstraction, not at implementation reality

The original task list reads like rephrased spec bullets: "build the worktree
isolation," "build the idea-to-spec conversation," "build the supervision
visibility surface." Each is a *capability* — a single sentence that describes
what should be true when done. None is a *module list*.

The implementation phase then satisfied each capability by writing its **pure
deterministic core** (one module under `src/intent/`) and checking the box.
The runtime adapters needed to make those cores actually do anything — modules
under `src/jobs/`, the bot, the webview — were never tasked because the
original capability bullet didn't decompose into them.

This is the dominant cause of the Phase 6 retrofit. Every Phase 6 sub-task is
a runtime adapter that the original capability bullet glossed over.

### 2. Test plan tested the deterministic cores, not the integration points

The original §10 "Sandboxing and security" test plan had 7 high-level bullets
("Each project runs in its own git worktree…"). Those bullets were satisfied
by `src/intent/sandbox.test.ts`'s tests on `worktreePathFor` — pure functions
returning distinct paths. The actual integration property — *that running a
gen-eval-loop mutation creates a real worktree on disk via `git worktree add`*
— was not testable from the original test plan because the runtime modules
didn't exist yet.

**Tests that pass before the integration exists give false comfort.** The
green suite produced a "Phase 3 complete" signal that wasn't true at the
user-reachability level.

### 3. "Deterministic core first" was the right strategy and the wrong scope signal

The `src/intent/` (pure) vs `src/jobs/` (I/O) split is genuinely good — it's
why this sweep landed 15 modules cleanly with no regressions. But the task
list inherited a side effect: when the pure modules are done and the suite
is green, **it feels like the layer is done**. Phase 3 was checked off
completely before anyone noticed that the runtime (sandbox-runtime,
credential-injector, supervision-store, supervision-recovery, stall-check,
gen-eval-loop-runner) did not exist.

This is a strategy/signal mismatch, not a strategy error. Build the
deterministic core first; just don't let its completion fire the
phase-complete signal.

### 4. UX surfaces were deferred implicitly; the deferrals were never re-tasked

The spec's §"Three Surfaces" table is a one-page summary, not a design. The
original task list inherited this — Phase 2 tasked the cockpit *registry view*
but not the *planning panel* or *approval panel*. The deferral was implicit:
"we'll figure out the UI later." Then "later" never came. The cockpit's Plan
button still stuffs placeholder text into the chat input because no task
ever required it to do otherwise.

Every Phase 6 Track C task (C1–C8) is a UX surface that should have been
tasked in Phase 2 or Phase 3, with an explicit deferral if it was being
moved out.

### 5. The `--auto` agent skipped a sub-task without surfacing the skip

During the Phase 6 Track C sweep, the `/work --auto` cycle for C2 ("Cockpit
approval inbox") shipped only the second of two unchecked sub-task lines.
Commit `053cf5b` (2026-05-25 08:22 UTC) ticked the REST endpoints sub-task
(`GET /api/approvals` + `POST /api/approvals/:id/{approve,reject}`) and
committed. The agent's transcript at that point reads *"Just completed C2.2
(commit 053cf5b) … Just read C3 task definition"* — meaning it treated C2 as
"done" and jumped to C3, even though the C2 panel UI sub-task at line 360 of
`tasks.md` was still `- [ ]`.

The gap persisted for ~8 hours through subsequent commits (C3, C5, C6, C7,
C8) until the user manually flagged the missing panel. Commit `2940975`
finally shipped it.

The /work skill's step 2 says *"Find the first unchecked task (`- [ ]`)"* —
a literal document-order rule. The agent's heuristic was *"this section just
shipped, move on"* — a section-level shortcut that violates the per-line
contract. Two compounding factors made the skip easier to miss:

1. **Pre-existing scaffolding masked the gap.** The cockpit already had a
   `#panel-approvals` placeholder section, a `state.pendingApprovals` count
   tuple in `state-snapshot.ts`, and a count-only `renderState` writing
   *"1 playbook · 2 proposal"* to the panel. The surface "appeared to
   work" — the agent likely did not compare the visible behavior to the
   task contract (per-row Approve/Reject/Open buttons per ASCII mockup)
   sentence-by-sentence.
2. **Internal Plan-phase sub-task ordering escaped the skill's rule.** The
   agent's Plan phase had decomposed C2 into "endpoints first because UI
   depends on them" — a rational dependency ordering. After endpoints
   landed, step 20's loop-back should have re-found the panel sub-task as
   the first unchecked line; the section-level heuristic let the agent
   skip it.

Cause #2 is independent and worth its own lesson; cause #1 is the dominant
root cause. The gap was not a regression — the agent satisfied a literal
`/work` cycle on the second sub-task — but it was a violation of the
*spirit* of step 2 because a literal earlier line was left unchecked.

### 6. The C4 `/plan` command landed without updating `/start`

Track C4 ("Telegram `/plan` command") shipped `handlePlan` in
`src/bot/commands/plan.ts`, wired it into the `text.ts` dispatcher (the
`if (text === '/plan' …)` branch around line 173), and registered it in
`SLASH_COMMAND_METADATA` (`src/bot/skill-registry.ts:168`) so the
free-text resolver could fuzzy-route to it. But the **canonical
user-facing command catalog** — the `/start` help text in `handleStart`
(`src/bot/handlers/text.ts:571–628`) — was never touched. C4's task
description named the command file, the dispatcher wiring, and the
resolver metadata, but did not list the help-text update as a sub-task,
so the omission survived all four C4 sub-task ticks and shipped invisibly.

The user discovered the gap the obvious way: they asked Jarvis how to
start a planning conversation and the answer was not in `/start`.
Same class of failure as Cause #5 (multi-sub-task atomicity) but a
different surface: the command works, the user just cannot find it.
It's a discoverability failure rather than a UX-completion failure.
The fix shipped in a later commit that both added the three missing
lines (`/plan`, `/approve`, `/cancel`) to `/start` and reorganized the
help into smaller scan-friendly sections.

`/approve` and `/cancel` had the same gap — they had been live in the
dispatcher for weeks without ever being listed in `/start`.

---

## Lessons

Each lesson is now applied somewhere. The cross-reference points at where
to look to confirm the lesson has stuck.

### Lesson 1 — Decompose every capability into (pure core, runtime adapter, user surface)

A project task list needs a **decomposition pass** before any work starts.
For every capability in the spec, name the triple — pure core, runtime
adapter, user surface — and task all three. If one of the three is "nothing
needed," say so explicitly with one sentence on why ("this is a config-only
change, no UI needed").

**Applied at:**
[`docs/projects/templates/planning-checklist.md`](../templates/planning-checklist.md)
§"The decomposition pass".

### Lesson 2 — Test-plan sections need both pure-core verification and integration verification

Every test-plan section should have two halves. Unit tests against the pure
core (what `src/intent/` provides), and an integration verification scenario
that names the user-action that exercises the core end-to-end. The
integration scenario can land last in execution order — what matters is that
it exists in the plan, because writing it forces you to name the runtime
modules and user surfaces the test will go through, which forces you to
task them.

**Applied at:**
[`docs/projects/templates/planning-checklist.md`](../templates/planning-checklist.md)
§"Test-plan sections need integration verification", and at this project's
own `test-plan.md` where every §1–§16 section now carries an
**Integration verification** sub-bullet.

### Lesson 3 — Definition of done is user-reachability, not test-passing

A phase is not complete when its tests pass against pure modules. It is
complete when a user can trigger the capability from a real surface
(cockpit, Telegram, cron) and observe the outcome. Phase boundaries in
`docs/projects/*/tasks.md` should only be checked off after that bar
is met.

**Applied at:** `CLAUDE.md` (new paragraph under "Project work is
test-first") and
[`docs/projects/templates/planning-checklist.md`](../templates/planning-checklist.md)
§"Definition of done = user-reachability".

### Lesson 4 — Deferrals get ADRs and triggers

When scope is cut from a project, the cut becomes invisible unless it is
recorded. Every deferral needs a short doc at
`docs/projects/<project>/<topic>-deferral.md` (template:
[`egress-deferral.md`](egress-deferral.md)) naming what was deferred,
why, and the trigger that would put it back in scope. An implicit
"we'll figure out the UI later" without a follow-up task is the failure
mode that produced Phase 6's UX-incomplete Track C.

**Applied at:**
[`docs/projects/templates/planning-checklist.md`](../templates/planning-checklist.md)
§"Deferrals get ADRs and triggers".

### Lesson 5 — Re-scan from the top after every commit; sections are not atomic units

The `/work` step 2 contract — *"Find the first unchecked task (`- [ ]`)"*
— means **the literal next `- [ ]` line in document order**, top-down,
regardless of which section was last worked. A multi-sub-task section is
not "done" after one of its sub-task lines ticks; it is done when zero
`- [ ]` lines remain inside it.

Before advancing past a section, re-read `tasks.md` from the top and
confirm the next unchecked line is genuinely the first one in document
order — not just the first one in the next untouched section. The
section-as-unit heuristic is the failure mode that left the C2 panel
sub-task unchecked for 8 hours after `053cf5b` shipped the C2 REST
endpoints. The fix is structural: the re-scan rule is now an explicit
step in the skill rather than something the agent has to remember.

**Applied at:**
- `.claude/skills/work/SKILL.md` step 2 (literal-document-order
  clarification) and step 20 (explicit re-scan check before picking the
  next task).
- [`docs/projects/templates/planning-checklist.md`](../templates/planning-checklist.md)
  §"Multi-sub-task sections are atomic" (new).

### Lesson 6 — Existing scaffolding ≠ implemented contract

A pre-existing placeholder UI — a panel section with stub content, a
count-only summary, an empty `<div>` — can create false-completion bias
under `--auto`. The agent sees *something* on the surface and infers the
task is "already in some form done." It is not. Before deciding a UI or
integration task is done, compare the visible behavior to the **task's
contract sentences**: the ASCII mockup, the explicit button list, the
response-shape spec. "There's something on the screen" is not "the
contract is met."

The C2 case: the placeholder showed *"1 playbook · 2 proposal"* (a
3-counter summary). The task contract called for per-row Approve / Reject
/ Open buttons per the mockup. The two are different in kind, not just
in polish — the agent only had to read the next sentence of the task
description to see the gap. The defense is upstream of vigilance: at
plan time, name the *specific behavior gap* between placeholder and
target, so the task can't read as "is the panel there at all" but
rather "does it match this contract."

**Applied at:**
- [`docs/projects/templates/planning-checklist.md`](../templates/planning-checklist.md)
  §"Spec audit before phase start" (placeholder-UI paragraph).
- The same checklist's Quick checklist gains a bullet requiring that any
  task touching a surface with existing scaffolding name the specific
  behavior gap to close, not just "build X".

### Lesson 7 — Every new user-facing command needs a discovery-surface task

When a project adds a new slash command (or a new chat-message intent,
or a new cockpit action, or a new cron-triggered notification), the
task list must explicitly include "update the canonical discovery
surface(s)" as a sub-task — not assume the developer will remember.
A command that works but is not documented is a half-shipped command:
the user can't reach what they don't know exists.

The canonical surfaces per channel:

- **Telegram slash commands** → the `/start` help text in
  `src/bot/handlers/text.ts handleStart` (the in-app command catalog).
- **Free-text intents that should resolver-route** →
  `SLASH_COMMAND_METADATA` in `src/bot/skill-registry.ts` (the
  fuzzy-match registry).
- **Cockpit actions / panels** → the appropriate panel header / hover
  help / placeholder copy in `src/server/static/{index.html, app.js}`.
- **Crons / scheduled notifications** → the relevant section of
  `CLAUDE.md` so future agents know it exists.

The C4 `/plan` rollout (see Cause #6) wired the dispatcher and the
resolver registry but missed the `/start` catalog. The fix needs to be
upstream: at plan time, the "user surface" leg of the (pure core,
runtime adapter, user surface) triple should include an explicit
sub-task naming each discovery surface the new capability needs to
appear on. Not just the surface that runs the command — the surface
that *advertises* it.

**Applied at:**
- [`docs/projects/templates/planning-checklist.md`](../templates/planning-checklist.md)
  §"The decomposition pass" — the "user surface" leg now explicitly
  covers both the *trigger surface* (where the capability runs) and the
  *discovery surface* (where the user finds out it exists), with a
  per-channel list of canonical discovery surfaces. The checklist's
  "Failure modes this prevents" section was extended with the C4
  `/start` gap as the second worked example.

---

## What we did about it

Concrete artifacts shipped in the same patch as this file:

- **`CLAUDE.md`** — added one paragraph under "Project work is test-first"
  defining user-reachability as the definition-of-done criterion.
- **[`docs/projects/templates/planning-checklist.md`](../templates/planning-checklist.md)**
  (new) — pre-implementation checklist codifying the four lessons.
- **This project's `spec.md`** — added `### Cockpit UX in Detail` and
  `### Telegram UX in Detail` sub-sections under §"Three Surfaces", with
  prose + ASCII mockups. Added user-reachability annotations to
  §"Definition of done (v1 wedge)".
- **This project's `tasks.md`** — added Track C (user surfaces, C1–C8) under
  Phase 6, parallel to Track A and Track B. Track C is what makes A and B
  user-reachable.
- **This project's `test-plan.md`** — added §19 (Cockpit UX), §20 (Telegram
  UX), §21 (Journal-to-intent end-to-end), and **Integration verification**
  sub-bullets to existing §1–§16.

The same patch does **not** modify the project doc templates themselves
(`docs/projects/templates/{spec,tasks,test-plan}.md`) — the lessons live
in `CLAUDE.md` and `planning-checklist.md` so future projects pick them
up via process, not via mandatory template fields.

A follow-up patch (post-Phase 6 Track C) extended the same set after the
C2 panel skip surfaced Lessons 5 and 6:

- **`.claude/skills/work/SKILL.md`** — step 2 gains a clarification
  sentence that *"first unchecked task"* means the literal next `- [ ]`
  line in document order (not the first line in the next untouched
  section). Step 20 gains an explicit re-scan check before picking up
  the next task, so the agent can't shortcut past an unfinished
  earlier sub-task by treating its section as "done."
- **[`docs/projects/templates/planning-checklist.md`](../templates/planning-checklist.md)**
  — new §6 *"Multi-sub-task sections are atomic"* codifies the rule for
  future projects, plus a paragraph in §5 about placeholder UIs (the
  task that builds a surface with existing scaffolding must name the
  specific behavior gap, not just "build the panel"). The Quick
  checklist at the bottom gains two corresponding bullets.
