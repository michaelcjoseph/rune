# Writer Role — Compounding Memory — Tasks

See [spec.md](spec.md) for rationale and [test-plan.md](test-plan.md) for verification. Built
test-first: each phase opens with a **Tests (write first)** block, red before implementation.

## Phase 1 — Writer role + seed + read path

**Tests (write first)**

- [ ] Authority test: the composed call puts `SOUL.md` (+ voice) in `--append-system-prompt`
      and `memory.md` in the first user message; assert memory text is absent from the
      appended system prompt.
- [ ] Cold-start test: empty `memory.md` yields a valid prompt (SOUL + voice), no error.
- [ ] Budget test: a `memory.md` over `WRITER_MEMORY_CHAR_BUDGET` is truncated with a visible
      marker; under budget passes through whole.
- [ ] Path test: the loader reads SOUL/memory from `PROJECT_ROOT/agents/writer/`, not via
      `readVaultFile`.

**Implementation**

- [ ] Write `jarvis/agents/writer/SOUL.md` — charter referencing `writing/voice.md` (no
      duplication).
- [ ] Build the loader returning `{ systemInstructions: SOUL (+ existing voice:true),
      referenceContext: fenced memory.md }`; read from `PROJECT_ROOT/agents/writer/`; enforce
      `WRITER_MEMORY_CHAR_BUDGET` (~12–16k) with a truncation marker.
- [ ] Wire the loader into the `/blog` flow (`blog.ts`) at the entry point confirmed here;
      reference goes in the user turn, not `--append-system-prompt`.
- [ ] Add the **Seed sources** stub to `spec.md` for Michael; once filled, mine the list into a
      ≤20-bullet, provenance-stamped `memory.md` and have Michael approve the seed diff.

## Phase 2 — Feedback phase + lesson capture + auto-commit

> Depends on: Phase 1

**Tests (write first)**

- [ ] Sentinel test: when the writer emits the completion sentinel, `blogHandler` closes the
      session (phase → `done`, state cleared) and triggers capture; no reliance on literal
      assistant `/done`.
- [ ] Capture test: given a feedback payload, `captureLessons()` emits ≥1 provenance-stamped
      craft lesson.
- [ ] No-feedback test: no feedback supplied → no memory write.
- [ ] Dedup test: a candidate matching an existing entry is dropped.
- [ ] Privacy test: a candidate containing a raw excerpt / private name is blocked or
      abstracted by the TS filter; source is an opaque slug.
- [ ] Atomic-commit test (temp repo): the memory-scoped commit helper stages **only**
      `agents/writer/memory.md` and commits one batch as one commit with a clear message.

**Implementation**

- [ ] Add the mandatory feedback checkpoint to the writer lifecycle; the writer emits a
      completion sentinel after feedback.
- [ ] `blogHandler` detects the sentinel → runs capture → sets phase `done` → clears state.
- [ ] Build `captureLessons()`: model proposes candidates; TS does dedupe, privacy filter,
      provenance-stamp, budget check, append to `memory.md`.
- [ ] Build the memory-scoped commit helper (jarvis repo, stages only
      `agents/writer/memory.md`); call it from `captureLessons()`. No approval gate.

## Phase 3 — Loop-closure eval

> Depends on: Phase 1, 2

**Tests (write first)**

- [ ] Closure test: a fixture lesson (with an observable marker) captured on piece N appears in
      the `referenceContext` loaded for piece N+1.

**Implementation**

- [ ] Run a real piece that captures a lesson, then a second comparable piece; confirm the
      lesson is loaded into N+1's context (manual acceptance: the draft reflects it).
- [ ] Record the loop-closure outcome in the project's index row.

---

## Out of scope (recorded)

- Cross-product / per-product / global memory; typed schema; composer; conflict/expiry.
- The planning pipeline; additional roles; a general role-dispatch runtime.
- A quality A/B eval and engagement-driven lessons (`ideas.md`).
- An approval queue (capture auto-commits).
- An automated `git revert` test (atomic commits make manual revert the acceptance check).
