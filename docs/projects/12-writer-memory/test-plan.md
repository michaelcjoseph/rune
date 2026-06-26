# Writer Role — Compounding Memory — Test Plan

Verification for the writer role, its read path (low-authority memory), the feedback-driven
auto-commit write path, and the loop-closure gate. See [spec.md](spec.md) and
[tasks.md](tasks.md).

## Priority Levels

- 🔴 **Critical**: breaks the authority boundary, writes memory without feedback, or breaks the
  read path / session closure.
- 🟡 **High**: weakens capture quality, dedup, privacy, atomicity, or budget behavior.
- 🟢 **Low**: cosmetic.

---

## 0. Seed-source prerequisite

- [ ] 🔴 `spec.md` contains 20-50 seed links before Phase 1 starts; fewer than 20 fails with a
      clear prerequisite error, more than 50 fails with a clear cap error, and the seeding
      helper does not invent sources.
- [ ] 🔴 The seed helper mines only the supplied links and emits ≤20 provenance-stamped
      bullets.
- [ ] 🟡 Unfetchable supplied URLs are skipped with a note and do not create a human blocker
      once the 20-link prerequisite is satisfied.

---

## 1. Read path + authority (Phase 1)

- [ ] 🔴 `SOUL.md` (+ voice) goes in `--append-system-prompt`; `memory.md` goes in the first
      user message; memory text is absent from the appended system prompt.
- [ ] 🔴 The loader reads SOUL/memory from `PROJECT_ROOT/agents/writer/`, not via
      `readVaultFile`.
- [ ] 🟡 Cold start (empty `memory.md`) yields a valid SOUL + voice prompt, no error.
- [ ] 🟡 `memory.md` over `WRITER_MEMORY_CHAR_BUDGET` truncates with a visible marker; under
      budget passes whole; truncation applies to loaded `referenceContext`, not by deleting
      entries from `memory.md`.
- [ ] 🟢 `SOUL.md` references `voice.md` without duplicating its content.

## 2. Write path (Phase 2)

- [ ] 🔴 The completion sentinel closes the session server-side (phase → `done`, state cleared)
      and triggers capture; no reliance on a literal assistant `/done`.
- [ ] 🔴 Only a final-line `[[WRITER_MEMORY_COMPLETE]]` sentinel counts; it is stripped from
      the user-visible reply and capture runs at most once per session.
- [ ] 🔴 No feedback supplied → no memory write.
- [ ] 🔴 `captureLessons()` accepts only a fenced `writer-memory-candidates` JSON block with
      `feedbackSeen`, `sourceSlug`, and `lessons`; malformed or missing blocks do not write.
- [ ] 🔴 Captured lessons are provenance-stamped (date + opaque source slug) and committed
      atomically via the memory-scoped helper (stages only `agents/writer/memory.md`, does not
      stage unrelated dirty files, no push required).
- [ ] 🟡 A candidate matching an existing entry is deduped.
- [ ] 🟡 A candidate with a raw excerpt / private name is blocked or abstracted by the TS
      privacy filter; source slugs must be opaque and match the slug regex.
- [ ] 🟢 A junk lesson is removable by reverting its single commit after the fact; this is not
      an implementation gate.

## 3. Loop-closure gate (Phase 3)

- [ ] 🔴 A fixture lesson (observable marker) captured on piece N is present in piece N+1's
      loaded `referenceContext`.
- [ ] 🔴 The loop-closure test is fully automated: no real Telegram session, real post, or
      subjective prose-quality judgment.
- [ ] 🟡 The loop-closure outcome is recorded in the project index row.

---

## Integration verification

> With 20-50 seed links already present, run the automated fixture flow through `/blog` prompt
> composition and capture seams. The writer loads SOUL + seeded memory (memory as user-turn
> reference, not system prompt). A fixture feedback/candidate block plus final sentinel closes
> the session; `captureLessons()` writes abstract, stamped lessons and commits only
> `agents/writer/memory.md` to the rune repo. A later composed `/blog` start loads one of
> those lessons into its `referenceContext` — the loop is closed. Quality (does it write
> better) is deferred to the engagement-metrics phase in `ideas.md`.
