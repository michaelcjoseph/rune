# Jarvis Identity Refactor Specification

## Scope change (2026-06-02)

This project was rescoped from a build to a cleanup. The original spec (a five-repo
canonical-source compiler) is preserved in git history; this section records what changed
and why so the decision is auditable.

**What the project was.** Build a reproducible canonical-source → model-specific-file
compiler (`jarvis/bin/compile-instructions`) with an explicit IR, pure-function
`claude`/`agents` renderers, a YAML manifest, a `$JARVIS_HOME` wrapper, a named-token
inventory verifier, CI drift checks, and a per-repo migration playbook — then migrate
jarvis and four consumer repos (pkms, aura, assay, relay), each via its own project.

**What it is now.** Two surgical edits, no compiler:

1. Replace the drifting parallel `CLAUDE.md` / `AGENTS.md` files with a **symlink**
   (`AGENTS.md` → `CLAUDE.md`) in each repo that needs both. One physical file, drift
   impossible.
2. **Move** the orchestrator-identity sections out of `pkms/CLAUDE.md` (where they bleed
   vault and orchestrator concerns together) into `jarvis/CLAUDE.md`, leaving a one-line
   pointer behind.

**Why it changed.**

- **No divergence will ever exist between `CLAUDE.md` and `AGENTS.md`.** Confirmed
  2026-06-02: the same agent runs on Claude and Codex with *identical instructions* —
  what differs per model is the *prompt* the orchestrator sends, not the instruction
  file. A compiler whose two renderers are required to produce byte-identical output is
  a copy with extra steps. The entire manifest / IR / renderer / inventory-verifier /
  `$JARVIS_HOME` / CI-cascade layer existed only to manage divergence that the design
  rules out. A symlink delivers zero-drift for zero machinery.
- **The two real problems are small.** The acute pain is (a) the files have drifted
  (jarvis `AGENTS.md` frozen at 2026-05-19 while `CLAUDE.md` advanced through projects
  08–09; pkms also drifted) and (b) orchestrator identity lives in the wrong repo. Neither
  needs a compiler. (a) is a symlink; (b) is a deliberate cut-and-paste whose proof of
  correctness is the git diff — not a token-presence prover built for an *automated*
  migration that is no longer happening.
- **Don't rebuild the monolith.** The original project's own founding decision (decompose
  so each unit of work fits one repo's `/work --auto`) argues against folding richer agent
  concerns back in. The agent-identity ideas that motivated a heavier instruction system —
  persistent role agents (PM, tech-lead, marketing) defined by per-agent memory artifacts,
  a `SOUL.md` charter layer, the lessons write/read loop — are **a separate project**
  (see `docs/projects/ideas.md` → "Better agentic systems"). This project stays the
  minimal substrate change beneath that future work.

**Dropped deliberately (not deferred):** the compiler, IR, renderers, YAML manifest,
`$JARVIS_HOME` wrapper, named-token inventory verifier, CI drift-check cascade, the
`per-repo-migration.md` playbook, snapshots / `ownership.md` audit artifacts, and the
aura/assay/relay consumer-migration projects. None ship. If real per-model divergence
ever appears, let it pull a compiler into existence then.

---

## Overview

Jarvis's identity is documented in parallel `CLAUDE.md` / `AGENTS.md` files that have
drifted, and orchestrator-specific instructions live in `pkms/CLAUDE.md` even though
Jarvis (not the vault) owns them. This project removes the drift mechanism and relocates
the misplaced content. Output: one canonical instruction file per repo (the model-specific
filename is a symlink to it), and Jarvis's orchestrator identity living in the jarvis repo.

### Core value

- **Drift becomes structurally impossible**, not merely discouraged — `CLAUDE.md` and
  `AGENTS.md` are the same inode.
- **Identity lives where it's owned** — orchestrator mechanics in jarvis, vault mechanics
  in pkms.

### Goals

1. **Primary:** In every repo that needs both files, make `AGENTS.md` a symlink to
   `CLAUDE.md`. Core repos: jarvis, pkms. Best-effort: aura, assay.
2. **Secondary:** Move the orchestrator-identity sections from `pkms/CLAUDE.md` to
   `jarvis/CLAUDE.md`; leave a pointer in pkms.

### Non-Goals

- A compiler, manifest, renderers, or any generated-file machinery. (See Scope change.)
- CI drift checks, pre-commit hooks, `$JARVIS_HOME` wrappers.
- Per-model divergence between `CLAUDE.md` and `AGENTS.md` — ruled out by design.
- The persistent-role-agent / `SOUL.md` / per-agent-memory architecture — its own project.
- Editing `~/.claude/CLAUDE.md` — stays hand-edited and natively loaded; unchanged.
- relay — has no instruction files; nothing to do.
- Restructuring vault content within pkms beyond removing the orchestrator sections.
- Phrasing-level cleanup of the moved content beyond what the move requires.

---

## Problems being solved (with evidence)

1. **Drift.** `jarvis/CLAUDE.md` (408 lines, last edited 2026-06-01, carries the project
   08–09 cockpit / planning-session / mutation-pipeline updates) vs `jarvis/AGENTS.md`
   (331 lines, frozen 2026-05-19). The stale file is not just old — it is wrong: it
   references `ai/Codex.ts` and `.Codex/agents/` where the real files are `ai/claude.ts`
   and `ai/codex.ts`. pkms is also drifted (`CLAUDE.md` 289 lines vs `AGENTS.md` 276).
   Root cause: a human edits one file and forgets the other. A symlink removes the second
   file entirely.

2. **Misplaced identity.** `pkms/CLAUDE.md` carries `## Jarvis` (agent split, KB
   raw-source routing, `loadAgentDef` order) and `### How Reviews Work` (the
   prep → interview → outline → write-up + post-agent pipeline). These describe how the
   Jarvis *orchestrator* behaves, not how the *vault* is structured. They belong in jarvis.

---

## Approach

### 1. Drift → symlink

In each repo that needs both files, keep `CLAUDE.md` as the single real file (it is the
current, maintained one everywhere) and replace `AGENTS.md` with a symlink to it:

```
git rm AGENTS.md            # if one exists
ln -s CLAUDE.md AGENTS.md
git add AGENTS.md           # git stores the symlink as a tiny blob
```

After this, `CLAUDE.md` and `AGENTS.md` resolve to the same bytes forever. Editing
instructions means editing `CLAUDE.md`; `AGENTS.md` follows for free.

**Per-repo plan:**

| Repo  | Current state                       | Action                                              |
| ----- | ----------------------------------- | --------------------------------------------------- |
| jarvis | both files, drifted                | `git rm AGENTS.md` → symlink to `CLAUDE.md`          |
| pkms  | both files, drifted                 | symlink **after** the content move below             |
| assay | both files, trivially drifted       | `git rm AGENTS.md` → symlink (best-effort)           |
| aura  | `CLAUDE.md` only                    | `ln -s CLAUDE.md AGENTS.md` to create it (best-effort)|
| relay | neither                             | none                                                |

A neutral third canonical filename (e.g. `INSTRUCTIONS.md` with both as symlinks) was
considered and rejected: it adds a file for an aesthetic gain. `CLAUDE.md` as the real
file is the minimal change.

### 2. Identity location → hand-move

Cut the orchestrator sections from `pkms/CLAUDE.md`, paste them into `jarvis/CLAUDE.md`,
leave a pointer in pkms. One commit per repo. The git diff is the proof nothing was lost —
read it.

**Moving out of `pkms/CLAUDE.md` → into `jarvis/CLAUDE.md`:**

- The entire `## Jarvis` section — automation ownership (morning prep, nightly job),
  the agent split (generic tooling agents in jarvis vs personal-specifics agents in
  pkms `.claude/agents/`), KB raw-source routing, and `loadAgentDef` lookup order.
- The `### How Reviews Work` mechanics — the prep → interview → outline →
  write-up + post-agent pipeline and the specialist updaters (`review-writer`,
  `project-updater`, `playbook-updater`, `worldview-updater`, `psychology-updater`,
  `json-updater`).

**Staying in `pkms/CLAUDE.md`:** repository overview, Git discipline, About Me, What I'm
Working On, vault structure, journal format, reference system, tags, JSON schemas, the
Review Cadence and End-of-Month tables (when to review — user-facing), Tags to Watch,
Worldview & Investments, Detailed System Docs, file conventions, the Claude Code Commands
tables. Incidental agent-name references that remain (e.g. the worldview "propose-only"
note) are acceptable and need not be hunted down.

**Pointer left in pkms** (replacing the moved sections):

> Jarvis orchestration — the agent split, KB raw-source routing, `loadAgentDef` order,
> and the review write-up pipeline — is documented in `jarvis/CLAUDE.md`.

**Order:** do the content move first (so `pkms/CLAUDE.md` reaches its final state), then
symlink `pkms/AGENTS.md` → `CLAUDE.md`, so the symlink reflects the post-move file.

---

## Risks & verification

- **Does Codex read through the symlink?** Almost certainly yes — it opens `AGENTS.md`
  by path and the OS resolves the link transparently. This is the one assumption to
  confirm before committing the jarvis symlink (test-plan §1). **Fallback if it does
  not:** a three-line `cp CLAUDE.md AGENTS.md` regenerate step plus a `diff` check, still
  a fraction of the original machinery. Do not build the fallback unless the symlink fails.
- **git symlink support.** macOS/Linux only (jarvis runs on both); `core.symlinks`
  defaults to true. No Windows consumers. No risk.
- **Content loss in the move.** Mitigated by reading the two-repo git diff: the moved
  sections must appear verbatim in `jarvis/CLAUDE.md` and be absent from `pkms/CLAUDE.md`,
  with the pointer present.

---

## Implementation phases

Two phases, both single-repo-or-fewer, no `/work --auto` orchestration required — small
enough to execute by hand in one sitting.

### Phase 1 — Content move (pkms ↔ jarvis)

- [ ] Append the `## Jarvis` and `### How Reviews Work` sections to `jarvis/CLAUDE.md`
      (placed coherently within its existing structure).
- [ ] Remove those sections from `pkms/CLAUDE.md`; insert the pointer.
- [ ] Read the diff in both repos; confirm the moved content is present in jarvis, absent
      in pkms, and the pointer is in place.
- [ ] Commit each repo to `main` (pkms: straight to `main` per its no-branch rule).

### Phase 2 — Symlink AGENTS.md → CLAUDE.md

- [ ] **jarvis:** `git rm AGENTS.md`; `ln -s CLAUDE.md AGENTS.md`; `git add`.
- [ ] **Verify Codex loads through the symlink** in jarvis before proceeding (see Risks).
- [ ] **pkms:** `git rm AGENTS.md`; `ln -s CLAUDE.md AGENTS.md`; `git add` (after Phase 1).
- [ ] **Best-effort:** symlink assay (`git rm` + link) and aura (create the link).
- [ ] Confirm `CLAUDE.md` and `AGENTS.md` resolve to identical bytes in each touched repo.
- [ ] Commit each repo to `main`.

---

## Success metrics

| Metric | Target | How measured |
| ------ | ------ | ------------ |
| `AGENTS.md` is a symlink to `CLAUDE.md` | jarvis + pkms (core); assay + aura (best-effort) | `test -L AGENTS.md && readlink AGENTS.md` = `CLAUDE.md` |
| `CLAUDE.md` ≡ `AGENTS.md` bytes | identical in every touched repo | `diff CLAUDE.md AGENTS.md` exits 0 |
| Codex loads through the symlink | confirmed | manual Codex session in jarvis reads orchestrator identity |
| Orchestrator sections moved, not lost | 100% present in jarvis, absent in pkms | git diff review across both repos |
| pkms pointer present | yes | grep for the pointer line in `pkms/CLAUDE.md` |
| `~/.claude/CLAUDE.md` unchanged | sha256 unchanged | `shasum` before/after |

---

## Edge cases

- **Symlink committed but Codex can't follow it** → apply the `cp` + `diff` fallback
  (Risks); revert the jarvis symlink, regenerate `AGENTS.md` as a copy, add the diff check.
- **An editor or tool rewrites `AGENTS.md` in place** (breaking the symlink into a real
  file) → caught by the byte-identical check; re-establish the link.
- **A future need for one model-specific line** → that is the trigger to revisit a compiler,
  in a new project, not here. Until then the symlink holds.
- **pkms symlinked before the content move** → the symlink would capture the pre-move file;
  enforce the Phase 1 → Phase 2 order.

---

## Open questions

None. Symlink over copy (settled — copy is the documented fallback only), `CLAUDE.md` as
the real file (settled), core vs best-effort repo split (settled), the move boundary
(settled above), and the separation of the agent-memory architecture into its own project
(settled) are all decided.
