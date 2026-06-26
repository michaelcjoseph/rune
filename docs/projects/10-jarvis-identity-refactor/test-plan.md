# Rune Identity Refactor Test Plan

Verification for the rescoped project: symlink the model-specific instruction files and
relocate orchestrator identity. See [spec.md](spec.md) for rationale, [tasks.md](tasks.md)
for steps.

> **Rescoped 2026-06-02.** The prior compiler/wrapper/verifier/CI/playbook test sections
> are dropped along with the build they verified. What remains is a handful of checkable
> facts, mostly one-line shell assertions plus one manual confirmation (Codex follows the
> symlink) and one diff review (nothing lost in the move).

## Priority Levels

- 🔴 **Critical**: Breaks an instruction file's loading or loses content.
- 🟡 **High**: Leaves drift possible or the move incomplete.
- 🟢 **Low**: Cosmetic / best-effort.

---

## 1. Symlink correctness

- [ ] 🔴 In jarvis and pkms, `AGENTS.md` is a symlink to `CLAUDE.md`:
      `test -L AGENTS.md && [ "$(readlink AGENTS.md)" = "CLAUDE.md" ]` succeeds.
- [ ] 🔴 In every touched repo, `diff CLAUDE.md AGENTS.md` exits 0 (same bytes via the link).
- [ ] 🔴 **Manual:** open a Codex session in jarvis; confirm it loads instructions through
      `AGENTS.md` (the symlink) — the orchestrator identity is present in context. This is
      the one assumption gating the symlink approach (spec.md → Risks). If it fails, the
      `cp` + `diff` fallback applies and this plan's symlink assertions are replaced by a
      copy-equality assertion.
- [ ] 🔴 **Manual:** open Claude Code in jarvis; confirm `CLAUDE.md` loads as before.
- [ ] 🟢 Best-effort: assay and aura have `AGENTS.md` as a symlink to `CLAUDE.md` (same
      assertions). relay has neither file (nothing to assert).
- [ ] 🟡 Git stores the symlink as a link, not a copied regular file:
      `git ls-files -s AGENTS.md` shows mode `120000`.

## 2. Content move (pkms → jarvis)

- [ ] 🔴 The `## Rune` section and the `### How Reviews Work` mechanics appear in
      `jarvis/CLAUDE.md` after the move.
- [ ] 🔴 Both sections are absent from `pkms/CLAUDE.md` after the move.
- [ ] 🔴 The pointer line ("Rune orchestration … is documented in `jarvis/CLAUDE.md`")
      is present in `pkms/CLAUDE.md`.
- [ ] 🔴 The "staying" sections from spec.md remain intact in `pkms/CLAUDE.md`: repository
      overview, vault structure, journal format, reference system, tags, JSON schemas, the
      Review Cadence + End-of-Month tables, the Claude Code Commands tables, About Me,
      What I'm Working On, Git discipline.
- [ ] 🟡 The move is content-preserving: a git diff review across both repos shows the moved
      text is the same text (allowed deltas: heading-level adjustment and surrounding prose
      to fit jarvis's structure). Read the diff — it is the proof, replacing the dropped
      named-token verifier.
- [ ] 🟢 Incidental agent-name references left in pkms (e.g. the worldview "propose-only"
      note) are acceptable and need not be removed.

## 3. No collateral damage

- [ ] 🔴 `~/.claude/CLAUDE.md` sha256 is unchanged from project start
      (`shasum ~/.claude/CLAUDE.md` before vs after).
- [ ] 🟡 No compiler, manifest, wrapper, verifier, CI step, or `per-repo-migration.md`
      was created (verify against git log — the rescope dropped all of it).
- [ ] 🟢 relay is untouched (no instruction files added).

---

## Integration verification

> After both phases: a developer (or Codex/Claude session) opening jarvis loads a single
> canonical instruction file under either name, with the orchestrator identity now present.
> Opening pkms loads vault-only instructions plus a one-line pointer to jarvis. Editing
> `CLAUDE.md` in any touched repo updates `AGENTS.md` for free — drift is structurally
> impossible.
