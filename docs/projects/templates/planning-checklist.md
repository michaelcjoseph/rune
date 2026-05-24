# Project Planning Checklist

A pre-implementation checklist for any new project in `docs/projects/`. Run
through it after the spec is drafted but **before** `tasks.md` and
`test-plan.md` are written.

This document exists because the 08-intent-layer project shipped Phases 1–5
on green tests, then discovered none of it was user-reachable and had to
add a 58-task Phase 6 retrofit. The four lessons below distill what would
have prevented that. See
[`docs/projects/08-intent-layer/agent-lessons.md`](../08-intent-layer/agent-lessons.md)
for the full forensics.

---

## When to use this

- **Always** at the start of a new project, after `spec.md` exists.
- Optionally at the start of a new phase within a project, if the spec was
  updated and the next phase's task list hasn't been written yet.

The output is concrete edits to `tasks.md` and `test-plan.md` — not just
mental notes. If the checklist surfaces a gap, the gap becomes a task.

---

## 1. The decomposition pass

For every capability in the spec, name the triple:

- **Pure core** — the deterministic logic. Lives in `src/intent/`,
  `src/utils/`, or wherever pure modules belong in this codebase. No
  filesystem, no network, no LLM calls.
- **Runtime adapter** — the I/O wrapper. Reads/writes the deterministic
  core's inputs and outputs against the real world: files, subprocesses,
  network, the Claude/Codex CLI. Lives in `src/jobs/`, `src/reviews/`,
  or a similar runtime directory.
- **User surface** — the thing a real person triggers or observes. A
  cockpit panel, a Telegram command, a notification, a cron schedule,
  an API endpoint.

**Task all three.** If a capability genuinely needs only two (or one) of
the triple, say so **explicitly with one sentence on why**:

> "Pure-core only. This module is a deterministic policy consumed by
> existing call sites; no new runtime adapter or user surface is needed
> because the existing mutation pipeline already wires it in."

That single sentence is the gate that prevents an implicit deferral
becoming an invisible one.

**Failure mode this prevents:** the 08-intent-layer Phase 6 retrofit.
Phase 3 had three Layer-4 task bullets ("Git worktree per project; …",
"Per-repo scoped credentials …", "Untrusted inbound …"); each was
satisfied by writing the pure core in `src/intent/sandbox.ts` and
checking the box. The runtime adapters that actually create worktrees,
inject credentials, and guard fs writes (`sandbox-runtime.ts`,
`credential-injector.ts`, `egress-policy.ts`, `sandbox-fs.ts`) were
not tasked until Phase 6 — because the original bullets didn't decompose
into them.

---

## 2. Definition of done = user-reachability

**A phase is not complete when its tests pass against a pure module.** It
is complete when a real person can trigger the phase's capability from a
real surface (cockpit, Telegram, cron, CLI) and observe the outcome.

For every phase in `tasks.md`, end with the question:

> Can a user trigger this from cockpit, Telegram, cron, or CLI today?

If the honest answer is **no**, the phase is not done — even with a fully
green test suite. Either add the missing surface as a task in this phase,
or move the phase to "blocked on Phase N+1" with an explicit pointer.

**Failure mode this prevents:** the 08-intent-layer Phase 3 was marked
complete with green tests, while no user could trigger a worktree creation,
no Telegram command initiated a planning conversation, and no cockpit panel
showed an in-flight gen-eval-loop run. None of those existed.

---

## 3. Test-plan sections need integration verification

Every section in `test-plan.md` should have two halves:

- **Pure-core verification** — unit tests against the deterministic module.
  Usually written first, easy to pin.
- **Integration verification** — a scenario that names the user-action which
  exercises the core end-to-end. Can land last in execution order, but
  must exist in the plan.

The integration scenario looks like:

> **Integration verification:** clicking the cockpit Plan button on an
> Aura project opens the planning panel, the user sends three replies,
> the spec is proposed, the user clicks Approve, and the project's
> `spec.md` / `tasks.md` / `test-plan.md` appear in the Aura repo.

Writing that sentence forces you to name the runtime modules and user
surfaces the test will go through, which forces you to task them. **A
test plan that omits integration verification is the same false-done
signal as a green unit-test suite — it makes the pure-core completion
feel like the integration is also done.**

**Failure mode this prevents:** the 08-intent-layer §10 sandboxing test
plan had 7 bullets, all satisfied by unit tests on `worktreePathFor`.
None of them asked "does running a gen-eval-loop mutation actually
create a worktree on disk?" — because that question didn't exist in the
plan, the runtime that would answer it wasn't tasked.

---

## 4. Deferrals get ADRs and triggers

When scope is cut from a project — either at planning time or mid-execution
— the cut becomes invisible unless it is recorded. **Every deferral needs
a short doc** at `docs/projects/<project>/<topic>-deferral.md` that names:

- **Status** — "Deferred. <state> today; promote to <enforced state> when
  the trigger fires."
- **Context** — what the original task asked for, and what was actually
  shipped.
- **Decision** — what was deferred and what was shipped instead (often an
  audit hook, a documented gap, or a fallback).
- **Rationale** — why deferring is acceptable today.
- **Trigger to promote** — the specific condition that takes the deferral
  out of deferred state and back into active scope.

Template: [`docs/projects/08-intent-layer/egress-deferral.md`](../08-intent-layer/egress-deferral.md).

**Failure mode this prevents:** the 08-intent-layer spec deferred all UX
surface design ("we'll figure out the UI later") without a single ADR
or follow-up task. The deferral became invisible. The cockpit's Plan
button still stuffs placeholder text into the chat input months later
because no deferred-ADR was tracking it.

---

## 5. Spec audit before phase start

Before phase work begins, audit the spec for **user-facing surface
specification**. Concretely:

- Every cockpit panel the project will need: named **and** described
  (prose + ASCII mockup is enough).
- Every chat command the project will introduce: named **and** described
  (`/foo <args>` plus what it does and what it returns).
- Every proactive notification the project will send: named **and**
  described (when it fires, what it says, what action it offers).
- Every cron / scheduled job the project will add: named **and** described.

If any of these is named in the spec but not described, **add it to the
spec before drafting tasks**. A spec that says "the cockpit shows
in-flight run progress" without specifying what that looks like is a
deferred UI decision that will not get re-tasked unless an ADR captures
it (see §4 above).

**Failure mode this prevents:** 08-intent-layer's §"Three Surfaces" table
named the cockpit and chat surfaces without designing the planning panel,
approval inbox, in-flight run progress display, `/plan` command, or
engine-notification format. Each was deferred implicitly; each
re-surfaced as a Phase 6 Track C task months later.

---

## Quick checklist (copy into the PR or planning notes)

- [ ] Every capability in the spec has a (pure core, runtime adapter,
      user surface) triple in `tasks.md` — or an explicit "X-only"
      sentence saying why one or two is sufficient.
- [ ] Every phase in `tasks.md` ends with a "user-reachability" check —
      can a user trigger this today?
- [ ] Every section in `test-plan.md` has both pure-core verification
      bullets and an **Integration verification** scenario.
- [ ] Every scope cut has a deferral ADR at
      `docs/projects/<project>/<topic>-deferral.md` with a trigger.
- [ ] Every user-facing surface (cockpit panel, chat command,
      notification, cron) named in the spec is **described** in the
      spec — not just named.
