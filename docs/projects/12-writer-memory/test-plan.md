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

## 1. Read path + authority (Phase 1)

- [ ] 🔴 `SOUL.md` (+ voice) goes in `--append-system-prompt`; `memory.md` goes in the first
      user message; memory text is absent from the appended system prompt.
- [ ] 🔴 The loader reads SOUL/memory from `PROJECT_ROOT/agents/writer/`, not via
      `readVaultFile`.
- [ ] 🟡 Cold start (empty `memory.md`) yields a valid SOUL + voice prompt, no error.
- [ ] 🟡 `memory.md` over `WRITER_MEMORY_CHAR_BUDGET` truncates with a visible marker; under
      budget passes whole.
- [ ] 🟢 `SOUL.md` references `voice.md` without duplicating its content.

## 2. Write path (Phase 2)

- [ ] 🔴 The completion sentinel closes the session server-side (phase → `done`, state cleared)
      and triggers capture; no reliance on a literal assistant `/done`.
- [ ] 🔴 No feedback supplied → no memory write.
- [ ] 🔴 Captured lessons are provenance-stamped (date + opaque source slug) and committed
      atomically via the memory-scoped helper (stages only `agents/writer/memory.md`).
- [ ] 🟡 A candidate matching an existing entry is deduped.
- [ ] 🟡 A candidate with a raw excerpt / private name is blocked or abstracted by the TS
      privacy filter.
- [ ] 🟢 A junk lesson is removable by reverting its single commit (manual acceptance).

## 3. Loop-closure gate (Phase 3)

- [ ] 🔴 A fixture lesson (observable marker) captured on piece N is present in piece N+1's
      loaded `referenceContext`.
- [ ] 🟡 The N+1 draft visibly reflects the captured lesson (manual acceptance).
- [ ] 🟡 The loop-closure outcome is recorded in the project index row.

---

## Integration verification

> Write a real post through `/blog`. The writer loads SOUL + seeded memory (memory as
> user-turn reference, not system prompt). At the feedback checkpoint Michael gives notes; the
> writer emits its completion sentinel; the server closes the session and `captureLessons()`
> writes abstract, stamped lessons and auto-commits them to the jarvis repo. A later comparable
> post loads one of those lessons into its reference context and reflects it — the loop is
> closed. Quality (does it write better) is deferred to the engagement-metrics phase in
> `ideas.md`.
