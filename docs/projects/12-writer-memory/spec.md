# Writer Role — Compounding Memory — Specification

## What's shipping (working-backwards)

You write the way you do today: type `/blog`, work through the piece in conversation. What
changes is underneath. The blog flow now runs the **writer role** — a persistent
content-writing agent with a hand-authored charter (`SOUL.md`) and a `memory.md` of craft
lessons that grows from every piece. Before finishing, the writer asks for your feedback,
revises, captures what it learned as durable lessons, then the session closes itself. The
next piece starts from that accumulated craft instead of a blank slate.

v1 proves one thing: the loop closes. A lesson learned on one piece shows up in the next.
Whether that makes the writing *good* is a question for later, when engagement metrics from
the platforms become the judge.

### Core value

A content-writer role-agent that accumulates craft across pieces, so writing assistance
compounds instead of resetting every time.

### Goals

1. **Primary:** a writer role (`SOUL.md` + `memory.md`) in the jarvis repo, running behind
   the `/blog` flow, that loads its charter as instructions and its memory as reference
   before writing.
2. **Secondary:** a feedback-then-capture step — the writer solicits your feedback before
   finishing, then auto-commits the lessons drawn from it.
3. **Tertiary (the gate):** demonstrate loop closure — a lesson captured on piece N is
   loaded into piece N+1's context.

### Non-Goals

- Cross-product / per-product memory, a global tier. One role, jarvis repo only.
- Typed schema, cascade composer, conflict/expiry engine. Whole-file markdown.
- The planning pipeline — its own project (`ideas.md`).
- Additional roles beyond the writer; a general role-dispatch runtime (v1 is the blog flow only).
- A quality A/B eval. v1 proves the loop runs, not that output improved (that's the engagement phase).
- Engagement-driven lessons — accepted future direction, tracked in `ideas.md`.
- An approval queue for memory writes — capture auto-commits; Michael reviews later.
- Duplicating `voice.md` — `SOUL.md` references it.
- Generalizing the writer entry beyond `/blog` (Twitter/Substack) — later.

---

## The writer role

```
jarvis/agents/writer/
  SOUL.md      # charter — hand-authored, system-prompt authority
  memory.md    # craft notes — accumulating, low-authority reference
```

**SOUL.md** — the charter: who the writer is, its mandate (prose in Michael's voice per
`writing/voice.md`), standards, non-negotiables, how it works. Hand-authored, stable, edited
by Michael. References `voice.md`, doesn't restate it.

**memory.md** — accumulating craft lessons (hooks that landed, structures that worked,
mistakes corrected). Whole-file markdown. Each entry provenance-stamped:
`- [YYYY-MM-DD · source: <slug>] <lesson>`. **Abstract craft only** — no raw excerpts, no
private names, opaque source slugs. Capped at a fixed char budget (`WRITER_MEMORY_CHAR_BUDGET`,
~12–16k); past it, truncate with a visible marker.

Both files live in the **jarvis repo** at `PROJECT_ROOT/agents/writer/`. They are read from
that path directly, **not** via the vault's `readVaultFile`.

---

## Authority model (memory stays low-authority)

`SOUL.md` is the only writer content with system-prompt authority. `memory.md` loads as
**reference in the first user message**, not via `--append-system-prompt`, so accumulated
content can't silently become rules. We start here deliberately — it's where we'd land once
memory ingests less-trusted input (the engagement phase), so we begin there and watch how
adherence holds. On any SOUL ↔ memory contradiction, SOUL wins.

The load-bearing detail: `blog.ts` today funnels everything into one `--append-system-prompt`
string (`claude.ts:~371`). The loader must return two fields — `systemInstructions` (SOUL +
the existing `voice:true`) and `referenceContext` (fenced memory) — and the reference goes in
the user turn. A test asserts memory text is absent from the appended system prompt.

---

## Read path

A `/blog` session composes the writer prompt: `SOUL.md` (instructions) + `voice.md`
(referenced) + `memory.md` (delimited reference, in the user turn). The loader reads SOUL and
memory from `PROJECT_ROOT/agents/writer/`, applies the char budget (truncating with a visible
marker), and returns `{ systemInstructions, referenceContext }`. Cold start (empty memory)
degrades to SOUL + voice, no error. Exact wiring point in the blog skill is confirmed in
Phase 1.

---

## Write path (auto-commit, review later)

The writer's lifecycle:

```
draft → request feedback (mandatory checkpoint) → revise → capture lessons → session closes
```

**Closure is server-owned.** The model cannot issue a command — `blog.ts:87` only ends a
session on *user* text `/done`, and model output is just sent back (`:119`). So the writer
emits a **completion sentinel** in its output; `blogHandler` detects the sentinel, runs
capture, sets the session phase to `done`, and clears session state. No literal assistant
"/done".

**Capture is TypeScript-owned.** `askClaudeWithContext` only returns text (`claude.ts:~411`),
so the model **proposes** candidate lessons as text; a TS `captureLessons()` function does the
rest deterministically: dedupe against existing entries, privacy filter (reject or abstract
raw excerpts / private names, force opaque slugs), enforce the char budget, append to
`memory.md`, and make **one atomic commit** via a memory-scoped commit helper that stages
**only** `agents/writer/memory.md` in the jarvis repo (not the vault's `git add -A` helper,
which runs in `VAULT_DIR` and can't guarantee atomicity here).

The feedback Michael gives at the checkpoint is the capture input — the concrete source
(today `/done` stores no transcript). **No approval gate**: Michael reviews `memory.md` or the
git log later and hand-edits. **No feedback → no lessons** that round. Atomic commits mean a
junk lesson is reverted by hand one commit at a time.

---

## Seed (v1)

Before the first run, seed `memory.md` with a craft baseline mined from a list of writers,
their online presences, and writing-lesson links. The agent proposes **at most 20**
provenance-stamped bullets; Michael approves the diff once. No autonomous crawling beyond the
supplied links.

### Seed sources (Michael to add)

> _The writers, online presences, and writing-lesson links to mine for the initial
> `memory.md` baseline. Michael fills this in._

---

## Eval gate (loop closure, not quality)

"Good writing" means engagement on the platform, which isn't wired up yet, and feedback
improving a piece is too subjective to gate on. So v1's gate is mechanical: **a lesson
captured from piece N is stored, loaded into piece N+1's reference context.** The automated
assertion uses a **fixture lesson with an observable marker** (e.g. "never use word X" →
assert X absent from the loaded context's influence) so the pass condition is mechanical, not
a judgment of whether the draft "feels" improved. Capture → store → load → use. The quality
question moves to the engagement phase (`ideas.md`), where metrics make it objective.

---

## Implementation phases (test-first per phase)

### Phase 1 — Writer role + seed + read path

- `SOUL.md` (references `voice.md`); the loader reading from `PROJECT_ROOT/agents/writer/` and
  returning `{ systemInstructions, referenceContext }` with the char budget + truncation
  marker; wired into the `/blog` flow.
- Seed-sources stub for Michael; mine the filled list into a ≤20-bullet `memory.md`; Michael
  approves the seed diff.

### Phase 2 — Feedback phase + lesson capture + auto-commit

> Depends on: Phase 1

- The mandatory feedback checkpoint, and the **completion sentinel** the writer emits;
  `blogHandler` detects it, closes the session, and triggers capture.
- `captureLessons()`: model proposes candidates; TS does dedupe, privacy filter,
  provenance-stamp, budget check, append, and one atomic commit via the memory-scoped commit
  helper. No approval.

### Phase 3 — Loop-closure eval

> Depends on: Phase 1, 2

- Run a piece that captures a fixture lesson, then a second piece; assert the lesson is in the
  second piece's loaded `referenceContext`. Record the outcome in the project's index row.

---

## Success metrics

| Metric | Target | How measured |
| --- | --- | --- |
| Memory stays low-authority | always | Composed call has SOUL in `--append-system-prompt`, memory in the user turn; memory text absent from the appended system prompt |
| Lesson capture works | ≥1 per real feedback session | `captureLessons()` emits a stamped, privacy-clean lesson, atomically committed to the jarvis repo |
| No phantom writes | enforced | No feedback → no memory write |
| Loop closes (the gate) | yes | A fixture lesson from piece N is present in piece N+1's `referenceContext` |
| Cold start safe | no error | Empty memory → valid SOUL + voice prompt |
| Budget respected | enforced | Oversized memory truncates with a visible marker |

---

## Edge cases

- Empty memory → SOUL + voice only.
- Memory contradicts SOUL → SOUL wins.
- Candidate lesson carries private detail → privacy filter blocks or abstracts it (TS-enforced).
- Duplicate lesson → deduped.
- `memory.md` over budget → truncate with a visible marker.
- Bad auto-committed lesson → revert that single commit by hand.
- Session reaches closure with no feedback → no lessons that round (allowed).

---

## Open questions

- Exact wiring point in the blog flow (confirmed in Phase 1).
- When `memory.md` outgrows the char budget, what retrieval replaces whole-file loading.
- When to give the writer its own entry point beyond `/blog` (Twitter/Substack).
