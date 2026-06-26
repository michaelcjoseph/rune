# Writer Role — Compounding Memory — Specification

## What's shipping (working-backwards)

You write the way you do today: type `/blog`, work through the piece in conversation. What
changes is underneath. The blog flow now runs the **writer role** — a persistent
content-writing agent with a repo-local charter (`SOUL.md`) and a `memory.md` of craft
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

1. **Primary:** a writer role (`SOUL.md` + `memory.md`) in the rune repo, running behind
   the `/blog` flow, that loads its charter as instructions and its memory as reference
   before writing.
2. **Secondary:** a feedback-then-capture step — the writer solicits your feedback before
   finishing, then auto-commits the lessons drawn from it.
3. **Tertiary (the gate):** demonstrate loop closure — a lesson captured on piece N is
   loaded into piece N+1's context.

### Non-Goals

- Cross-product / per-product memory, a global tier. One role, rune repo only.
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
rune/agents/writer/
  SOUL.md      # charter — stable repo file, system-prompt authority
  memory.md    # craft notes — accumulating, low-authority reference
```

**SOUL.md** — the charter: who the writer is, its mandate (prose in Michael's voice per
`writing/voice.md`), standards, non-negotiables, how it works. v1 may be drafted by the
implementation agent from this spec, then reviewed later like normal repo code. References
`voice.md`, doesn't restate it.

**memory.md** — accumulating craft lessons (hooks that landed, structures that worked,
mistakes corrected). Whole-file markdown. Each entry provenance-stamped:
`- [YYYY-MM-DD · source: <slug>] <lesson>`. **Abstract craft only** — no raw excerpts, no
private names, opaque source slugs. Capped at a fixed load-time char budget
(`WRITER_MEMORY_CHAR_BUDGET`, ~12–16k); past it, the loaded reference context truncates with a
visible marker.

Both files live in the **rune repo** at `PROJECT_ROOT/agents/writer/`. They are read from
that path directly, **not** via the vault's `readVaultFile`.

---

## Authority model (memory stays low-authority)

`SOUL.md` is the only writer content with system-prompt authority. `memory.md` loads as
**reference in the first user message**, not via `--append-system-prompt`, so accumulated
content can't silently become rules. We start here deliberately — it's where we'd land once
memory ingests less-trusted input (the engagement phase), so we begin there and watch how
adherence holds. On any SOUL ↔ memory contradiction, SOUL wins.

The load-bearing detail: `src/reviews/blog.ts` today builds one system prompt and calls
`askClaudeWithContext()`; `askClaudeWithContext()` appends that prompt plus the existing
`voice:true` block via `--append-system-prompt`. The loader must return two fields —
`systemInstructions` (SOUL + existing blog instructions/context) and `referenceContext`
(fenced memory) — and the reference goes in the user turn. A test asserts memory text is
absent from the appended system prompt.

---

## Read path

A `/blog` session composes the writer prompt in `src/reviews/blog.ts`: `SOUL.md`
(instructions) + existing blog instructions/context + `voice:true` (central voice injection) +
`memory.md` (delimited reference, in the user turn). The loader reads SOUL and memory from
`PROJECT_ROOT/agents/writer/`, applies the load-time char budget (truncating the
`referenceContext` with a visible marker), and returns `{ systemInstructions,
referenceContext }`. Cold start (missing or empty memory) degrades to SOUL + voice, no error.
`memory.md` itself is append-only for v1; budget trimming is applied to the loaded context,
not by deleting older entries from disk.

---

## Write path (auto-commit, review later)

The writer's lifecycle:

```
draft → request feedback (mandatory checkpoint) → revise → capture lessons → session closes
```

**Closure is server-owned.** The model cannot issue a command — `src/reviews/blog.ts` only
ends a session on *user* text `/done`, and model output is just sent back. So the writer emits
a **completion sentinel** in its output; `blogHandler` detects the sentinel, strips it from
the user-visible reply, runs capture, sets the session phase to `done`, deletes the prompt
cache, and clears session state. No literal assistant "/done".

The sentinel format is a single final line:

```text
[[WRITER_MEMORY_COMPLETE]]
```

Only a final-line sentinel counts. The handler ignores earlier appearances in prose, strips
the final sentinel before sending the assistant text, and triggers capture at most once for a
session.

**Capture is TypeScript-owned.** `askClaudeWithContext` only returns text, so the model
**proposes** candidate lessons in a fenced `writer-memory-candidates` JSON block; a TS
`captureLessons()` function does the rest deterministically: parse the candidate block, dedupe
against existing entries, privacy filter, provenance-stamp, append to `memory.md`, and make
**one atomic commit** via a memory-scoped commit helper that stages **only**
`agents/writer/memory.md` in the rune repo (not the vault's `git add -A` helper, which runs
in `VAULT_DIR` and can't guarantee atomicity here).

Candidate block contract:

````text
```writer-memory-candidates
{
  "sourceSlug": "blog-YYYY-MM-DD-short-topic",
  "feedbackSeen": true,
  "lessons": [
    "Abstract craft lesson, no raw excerpt, no private name."
  ]
}
```
````

`feedbackSeen: false`, a missing block, an empty `lessons` array, or a failed privacy filter
means no memory write and no commit. `sourceSlug` must match `^[a-z0-9][a-z0-9-]{2,80}$`; the
handler can derive a fallback opaque slug from the session topic/date when the candidate slug
is invalid. Privacy filtering is deterministic in TS: reject lessons containing configured
private names (`config.FAMILY_NAMES` plus obvious variants present in tests), markdown links,
wikilinks, email/phone patterns, or quoted/raw excerpt spans longer than a small threshold.

The feedback Michael gives at the checkpoint is the capture input — the concrete source
(today `/done` stores no transcript). **No approval gate**: Michael reviews `memory.md` or the
git log later and hand-edits. **No feedback → no lessons** that round. Atomic commits mean a
junk lesson is reverted by hand one commit at a time.

---

## Seed (v1)

Before the first run, seed `memory.md` with a craft baseline mined from a list of writers,
their online presences, and writing-lesson links. Michael's only manual prerequisite is adding
20-50 seed links below before the agent starts Phase 1. After those links exist, the agent
mines only the supplied links, distills them into **at most 20** provenance-stamped memory
bullets, and proceeds without a second approval gate. The input-source list may grow to 50 for
coverage; the output memory stays compact. No autonomous crawling beyond the supplied links. If
a supplied link is unfetchable, the agent skips it with a note and continues; seed mining must
not block the core read/write/closure implementation once the 20-link minimum is satisfied.

### Seed sources (Michael to add before agent run)

> _The writers, online presences, and writing-lesson links to mine for the initial
> `memory.md` baseline. Michael fills this in with 20-50 links before Phase 1 begins._

#### Best works — long-form essays
- https://www.eugenewei.com/blog/2019/2/19/status-as-a-service
- https://www.eugenewei.com/blog/2018/5/21/invisible-asymptotes
- https://stratechery.com/2015/aggregation-theory/
- https://www.notboring.co/p/most-human-wins
- https://collabfund.com/blog/the-psychology-of-money/
- https://waitbutwhy.com/2013/10/why-procrastinators-procrastinate.html
- https://waitbutwhy.com/2015/11/the-cook-and-the-chef-musks-secret-sauce.html
- https://www.kalzumeus.com/2012/01/23/salary-negotiation/
- https://nav.al/rich
- https://perell.com/essay/the-ultimate-guide-to-writing-online/
- https://vitalik.eth.limo/general/2021/12/06/endgame.html
- https://thenetworkstate.com/the-network-state-in-one-essay
- https://andrewchen.com/the-law-of-shitty-clickthroughs/
- https://avc.com/2011/03/airbnb/

#### Best works — tweet threads
- https://x.com/naval/status/1002103360646823936
- https://x.com/Julian/status/1460306494159609856
- https://x.com/trq212/status/2052809885763747935
- https://x.com/andrewchen/status/1743309075096723681
- https://www.lennysnewsletter.com/p/head-of-claude-code-what-happens
- https://creatoreconomy.so/

#### Hooks, headlines, virality
- https://www.julian.com/guide/write/ideas
- https://www.julian.com/guide/write/intro
- https://copyblogger.com/how-to-write-headlines-that-work/
- https://marketingexamples.com/copywriting/tips
- https://marketingexamples.com/copywriting
- https://www.ship30for30.com/post/how-to-write-viral-twitter-thread-hooks-with-6-clear-examples
- https://www.tweetarchivist.com/how-to-write-viral-twitter-threads

#### Quality, clarity, finishing
- https://www.julian.com/guide/write/rewriting
- https://www.julian.com/guide/write/style
- https://paulgraham.com/talk.html
- https://www.paulgraham.com/writing44.html
- https://paulgraham.com/useful.html
- https://sive.rs/book/SenseOfStyle
- https://www.animalz.co/blog/how-to-write-a-blog-post-outline
- https://www.animalz.co/blog/steal-this-strategy
- https://perell.com/essay/my-writing-syllabus/

#### Newsletter / distribution craft
- https://on.substack.com/p/how-lenny-rachitsky-earned-65000
- https://www.lennysnewsletter.com/p/how-i-built-a-1m-subscriber-newsletter
- https://growthinreverse.com/lenny/
- https://www.notboring.co/about

#### Tweet-thread mechanics
- https://www.ship30for30.com/post/how-to-write-a-twitter-thread
- https://www.ship30for30.com/post/how-to-start-writing-online-the-ship-30-for-30-ultimate-guide
- https://typeshare.co/Nishtar/posts/my-twitter-writing-system-inspired-by-dickie-bush-and-nicolas-cole

#### Editing & revision craft
- https://www.julian.com/guide/write/first-draft
- https://www.kalzumeus.com/greatest-hits/

#### Narrative structure for nonfiction
- https://www.acquired.fm/episodes/not-boring-with-packy-mccormick

---

## Eval gate (loop closure, not quality)

"Good writing" means engagement on the platform, which isn't wired up yet, and feedback
improving a piece is too subjective to gate on. So v1's gate is mechanical: **a lesson
captured from piece N is stored, loaded into piece N+1's reference context.** The automated
assertion uses a fixture candidate with an observable marker and verifies capture → store →
load. The test does not judge prose quality or require a real post. The quality question moves
to the engagement phase (`ideas.md`), where metrics make it objective.

---

## Implementation phases (test-first per phase)

### Phase 0 — Human seed-source prerequisite

- Michael adds 20-50 seed links under **Seed sources**. This is the only intentional human
  blocker before an agent can run the implementation through the end.

### Phase 1 — Writer role + seed + read path

- `SOUL.md` (references `voice.md`); the loader reading from `PROJECT_ROOT/agents/writer/` and
  returning `{ systemInstructions, referenceContext }` with the char budget + truncation
  marker; wired into the `/blog` flow.
- Mine the filled seed-source list into a ≤20-bullet `memory.md`; the source list can contain
  up to 50 links, but memory output remains capped. No second manual approval gate.

### Phase 2 — Feedback phase + lesson capture + auto-commit

> Depends on: Phase 1

- The mandatory feedback checkpoint, and the **completion sentinel** the writer emits;
  `blogHandler` detects it, closes the session, and triggers capture.
- `captureLessons()`: model proposes candidates; TS does dedupe, privacy filter,
  provenance-stamp, append, and one atomic commit via the memory-scoped commit
  helper. No approval.

### Phase 3 — Loop-closure eval

> Depends on: Phase 1, 2

- Run an automated fixture flow that captures a lesson, then composes a second `/blog` start;
  assert the lesson is in the second piece's loaded `referenceContext`. Record the outcome in
  the project's index row.

---

## Success metrics

| Metric | Target | How measured |
| --- | --- | --- |
| Memory stays low-authority | always | Composed call has SOUL in `--append-system-prompt`, memory in the user turn; memory text absent from the appended system prompt |
| Lesson capture works | ≥1 per feedback session with valid candidate lessons | `captureLessons()` emits a stamped, privacy-clean lesson, atomically committed to the rune repo |
| No phantom writes | enforced | No feedback → no memory write |
| Loop closes (the gate) | yes | An automated fixture lesson from piece N is present in piece N+1's `referenceContext` |
| Cold start safe | no error | Empty memory → valid SOUL + voice prompt |
| Budget respected | enforced | Oversized memory truncates with a visible marker |

---

## Edge cases

- Empty memory → SOUL + voice only.
- Memory contradicts SOUL → SOUL wins.
- Candidate lesson carries private detail → privacy filter blocks or abstracts it (TS-enforced).
- Duplicate lesson → deduped.
- `memory.md` over budget → loaded `referenceContext` truncates with a visible marker.
- Bad auto-committed lesson → revert that single commit by hand after the fact; not part of
  the implementation gate.
- Session reaches closure with no feedback → no lessons that round (allowed).

---

## Open questions

- When `memory.md` outgrows the char budget, what retrieval replaces whole-file loading.
- When to give the writer its own entry point beyond `/blog` (Twitter/Substack).
