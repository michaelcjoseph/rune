# Jarvis Identity Refactor Specification

## Overview

Jarvis's identity is documented in three places — `pkms/CLAUDE.md`, `jarvis/CLAUDE.md`, `jarvis/AGENTS.md` — with duplication between the Claude and Codex variants. After project 08, Jarvis is the orchestrator and the vault is one tool among many, but the docs still frame Jarvis as a vault layer. Top-level instructions are locked to model-specific filename conventions even though Jarvis already uses Claude and Codex with more agents likely.

This project **builds the machine and migrates jarvis itself**: a compiler that generates `CLAUDE.md` / `AGENTS.md` (and future model-specific variants) from a single canonical instruction source, plus jarvis's own canonical source. The four other repos (pkms, aura, assay, relay) each migrate via **their own per-repo project** that consumes the compiler — see "Consumer-repo migrations" below.

### Why decomposed (the central design decision)

The earlier draft of this project was one monolith spanning five repos. That doesn't match the execution model: a `/work --auto` run executes in an isolated worktree of **one** repo and classifies its work product against that repo's `baseSha..branch`. A run reaching into sibling repos can't commit there and can't have its cross-repo work counted — so every cross-repo phase hard-stopped (confirmed by run `20565e71`, 2026-06-01).

The compiler's wrapper design already enables the fix. Per requirements 8-10, any consumer repo compiles via `$JARVIS_HOME` pointing at a jarvis checkout, with **no jarvis source co-located**. So each repo's migration is naturally self-contained: create `instructions/`, author a manifest, run `compile-instructions --bootstrap` through the wrapper, commit source + generated together. We make the **unit of work match the unit of automation** — one repo per project, each dispatchable as its own `/work --auto` (aura, assay, relay are already in `policies/products.json`).

This is deliberately **not** solved by teaching the work-runner to write to multiple repos in one run (see Non-Goals).

### Core Value Proposition

One canonical source per repo, model-specific instruction files generated reproducibly, drift caught by CI. Jarvis's identity lives in the jarvis repo, not bleeding into the vault.

### Goals

1. **Primary:** Build a reproducible canonical-source → model-specific-file compiler in `jarvis/bin/compile-instructions`, plus the shareable wrapper, drift check, and a named-token regression smoke gate (a cheap machine check, not a behavior-preservation sign-off).
2. **Secondary:** Migrate jarvis itself — author `jarvis/instructions/`, generate `jarvis/CLAUDE.md` + `jarvis/AGENTS.md`, and author the orchestrator fragments that the pkms migration will later remove from `pkms/CLAUDE.md`.
3. **Tertiary:** Author the per-repo migration playbook so each consumer migration (pkms, aura, assay, relay) runs as its own self-contained project.

### Non-Goals

- Output formats beyond `CLAUDE.md` and `AGENTS.md`. Compiler architected so a new renderer is one file, but no new formats ship in v1.
- Changing `~/.claude/CLAUDE.md`. Stays hand-edited and natively loaded.
- Restructuring vault content within pkms beyond the section moves listed below.
- Compiling `.claude/agents/*.md` agent definitions. They remain hand-authored.
- Migrating "About Me" / "How to Help Me" to user-global. Stays in pkms canonical source for v1.
- Adding CI to repos that don't have it. Repos without CI are explicitly best-effort.
- Phrasing-level deduplication across `CLAUDE.md` / `AGENTS.md`. Editorial cleanup deferred unless duplication causes concrete maintenance problems.
- **Multi-repo work-runs.** Teaching the work-runner to check out and commit across sibling repos in a single run is explicitly rejected — large change to the worktree/classifier/GC model, made unnecessary by decomposition and the `$JARVIS_HOME` indirection.

---

## Execution model

The decomposition exists to keep every *build* run inside one repo. Three rules:

1. **Private content never lands in a public repo.** `jarvis` is **public**; `pkms` is **private** and `pkms/CLAUDE.md` carries personal PII (names, employer, project codenames). Pre-migration **snapshots are local-only audit artifacts** — written into `snapshots/` (gitignored via `.git/info/exclude`) purely as a diff aid, never committed. **Any artifact derived from a snapshot (inventory, ownership manifest) is also local-only unless it is scoped to jarvis-owned content only** — a section-by-section table of `pkms/CLAUDE.md` can carry PII in headings/notes, so the committed `ownership.md` contains only jarvis-bound rows; the full cross-repo analysis stays in the gitignored `snapshots/` tree. When orchestrator content moves out of `pkms/CLAUDE.md`, only the Jarvis/orchestrator sections move; "About Me" / "How to Help Me" and other personal content stay in pkms canonical source per the Non-Goals.

2. **Phase 1 is manual prep; Phases 2-5 are the auto build.** Phase 1 (snapshot + inventory + ownership) is inherently cross-repo **read-only** — it must read pkms/aura/assay to inventory what moves where. A single-repo `/work --auto` worktree cannot reach sibling repos, so Phase 1 is run **manually** (or by an orchestrator with multi-repo read access) and produces the local snapshots + the jarvis-scoped ownership manifest the build consumes. Phases 2-5 are jarvis-internal and fully `/work --auto`-runnable: they touch only jarvis files and never read a sibling repo.

3. **Consumer migrations + their stubs are separate single-repo runs.** This project does **not** scaffold projects into aura/assay/relay (that would be a cross-repo write, the very blocker we removed). It authors the *playbook* (`per-repo-migration.md`); each consumer stub is created by a run inside that consumer repo (or manually for pkms).

### Behavior preservation: smoke gate + human sign-off

Behavior preservation is **not** fully machine-checkable — presence of a named token does not prove its surrounding behavior survived (a `/daily` command can remain while its constraints vanish; a route can remain while its auth/cancel semantics are dropped; a *rule* like "never write outside `knowledge/`" isn't a token at all). So two layers, neither of which silently strands a run:

- **Named-token smoke gate (machine, blocking).** The inventory verifier extracts every heading, agent name, command, and route from the snapshot and asserts each appears in the generated output. It catches *gross* regressions (a whole section dropped) cheaply and deterministically. It is a regression smoke test, **not** a sign-off replacement.
- **Human semantic sign-off (residual, non-blocking for the build).** A reviewer confirms no behavior/rule was silently lost. For an `--auto` run this is surfaced as a `blocked-on-human` Telegram checkpoint rather than an auto-denied hard-stop — **dependent on the work-run `blocked-on-human` outcome (filed in `docs/projects/bugs.md`); until that ships, the sign-off is done manually after the run, off the blocking path.**

### Consumer-repo migrations (separate projects)

Each consumer repo migrates via its own project, instantiated from `per-repo-migration.md` (the playbook authored in Phase 5). All are single-repo and self-contained.

| Repo | Project home | Execution | Source material |
| ---- | ------------ | --------- | --------------- |
| pkms | `pkms/docs/projects/` | **MANUAL** — pkms is private, not in `policies/products.json`, and its CLAUDE.md forbids branches; a worktree run can't run there. Includes removing the moved orchestrator sections from `pkms/CLAUDE.md` and adding the pointer to jarvis. | existing `pkms/CLAUDE.md` (vault-only remainder) |
| aura | `aura/docs/projects/` | `/work --auto` in aura | existing `aura/CLAUDE.md` |
| assay | `assay/docs/projects/` | `/work --auto` in assay | existing `assay/CLAUDE.md` + `assay/AGENTS.md` |
| relay | `relay/docs/projects/` | `/work --auto` in relay | none — fresh scaffold |

---

## User Journey

The "user" here is a developer (me) editing instructions, plus Claude Code / Codex sessions consuming them.

### Happy Path

```
Edit fragment in instructions/ → run compile-instructions → commit source + generated
                                          ↓
                       CI runs --check on PR → passes (no drift)
```

1. **Edit instructions** — developer edits a fragment in `instructions/` and updates the manifest if adding/removing fragments.
2. **Regenerate** — runs `scripts/compile-instructions` locally; updates `CLAUDE.md` and (if applicable) `AGENTS.md` at repo root.
3. **Commit + PR** — stages source and generated files in the same commit; opens PR. CI runs `--check`; passes.
4. **Merge** — Claude Code and Codex sessions opening the repo load the regenerated instructions.

### Entry Points

- Local: `scripts/compile-instructions` (with optional `--check`) invoked from any consuming repo via `$JARVIS_HOME`.
- CI: drift check step on every PR (repos with CI).
- Pre-commit (optional): hook that runs `--check` before commits.

### Exit Points

- Generated `CLAUDE.md` / `AGENTS.md` loaded by Claude Code / Codex sessions in each repo.
- CI failure → developer regenerates and re-commits.

---

## Requirements

### Compiler behavior

1. WHEN canonical source is unchanged AND compiler is invoked twice THEN outputs are byte-identical.
2. WHEN manifest references a missing fragment, contains a duplicate `(file, renderer)` pair, names an unknown renderer, or is malformed YAML THEN compiler exits non-zero with a clear error naming the offending location.
3. WHEN a fragment's manifest entry has `renderers: [claude]` THEN the fragment appears in `CLAUDE.md` and not in `AGENTS.md`.
4. WHEN compiler is invoked with `--check` THEN it compiles to a temp directory, diffs against on-disk generated files, exits 0 if identical, exits 1 with a unified diff on stdout otherwise.
5. WHEN compiler attempts to overwrite a generated file that lacks the autogenerated header THEN compiler refuses unless invoked with `--bootstrap`.
6. WHEN manifest no longer produces content for the agents renderer AND `AGENTS.md` exists on disk THEN compiler errors with a clear "manifest no longer renders AGENTS.md; delete it" message (or, with `--bootstrap`, deletes the orphan).
7. WHEN a fragment contains frontmatter THEN compiler exits non-zero (frontmatter banned in fragments).

### Wrapper behavior

8. WHEN `$JARVIS_HOME` is set to a valid path containing an executable `bin/compile-instructions` THEN the wrapper execs it, forwarding all arguments.
9. WHEN `$JARVIS_HOME` is unset, points to a non-existent path, or names a non-executable compiler THEN wrapper exits non-zero with a clear error.
10. WHEN `$JARVIS_HOME` is a relative path THEN wrapper resolves it to an absolute path. Symlinks are followed. Spaces in paths are supported via quoting.

### Determinism

11. Generated files use LF line endings, end with exactly one trailing newline, follow manifest order, and contain no normalization of fragment content beyond concatenation. If a fragment doesn't end in LF, a single LF is inserted between it and the next fragment.

### Behavior preservation (smoke gate + human sign-off)

12. The inventory verifier extracts every heading, named agent, command, and route from a repo's pre-migration snapshot and asserts each appears in that repo's generated output; a missing token fails non-zero, naming the token and the snapshot it came from. This is a **named-token regression smoke test** (catches gross drops), **not** a behavior-preservation sign-off — token presence does not prove the surrounding behavior or any non-token rule survived. Human semantic sign-off remains required (off the blocking path; see Execution model).
13. For every row in a repo's `ownership.md`, the named fragment file exists in that repo's `instructions/` and the row's `notes` substrings appear in that fragment.

### jarvis migration

14. After Phase 3, `jarvis/CLAUDE.md` and `jarvis/AGENTS.md` are generated (header present) and `compile-instructions --check` exits 0 in jarvis.
15. The orchestrator fragments authored in jarvis (`## Jarvis`, `### How Reviews Work`, morning-prep ownership) carry the content slated for removal from `pkms/CLAUDE.md`, so the later pkms removal loses nothing. These fragments are **authored fresh in jarvis** from the Phase 1 ownership decisions and jarvis's own runtime knowledge — the auto build does **not** read the pkms snapshot (it lives in the local, gitignored `snapshots/` tree, outside the jarvis worktree). The Phase 1 prep step pre-sanitizes the moved content into the ownership manifest's jarvis-owned rows.

### CI integration (per repo, where CI exists)

16. WHEN a PR in a CI-configured repo includes a hand-edited generated file (header present, content drifted) and unchanged source THEN CI fails.
17. WHEN a PR includes edited source but unchanged generated files THEN CI fails.
18. WHEN a PR includes both source and generated files updated together THEN CI passes.
19. WHEN a **consumer** repo's CI workflow runs THEN it successfully checks out jarvis as a sibling and resolves `$JARVIS_HOME` to that path. (jarvis's own CI needs no sibling — `$JARVIS_HOME` is the checkout under test.)

---

## Technical Implementation

### Source format

**Fragments + manifest** (single-file tag-based approach rejected: more parser edge cases, harder to share fragments, worse diffs).

Per repo:
- `instructions/` — directory of markdown fragments
- `instructions/manifest.yaml` — ordered list, each entry `{ file: <path>, renderers: [claude, agents] }` (default `[claude, agents]`)
- `CLAUDE.md` — generated at repo root
- `AGENTS.md` — generated at repo root, only when manifest produces content for it
- `scripts/compile-instructions` — committed shell wrapper

### Compiler architecture

Pure-core / runtime-adapter / user-surface split:

- **Pure core** — parser produces an explicit intermediate representation (IR): list of `{ content, renderers }` tuples. Renderers are pure functions over the IR filtered to their target → markdown text. Lives in jarvis source files invoked by the binary.
- **Runtime adapter** — `jarvis/bin/compile-instructions` reads `instructions/manifest.yaml`, loads fragments from disk, invokes parser + renderers, writes generated files (or diffs them in `--check` mode). Handles `--bootstrap` orphan deletion.
- **User surface (developer)** —
  - Trigger: `scripts/compile-instructions` wrapper in each repo; CI step invoking `--check`; optional pre-commit hook.
  - Discovery: each repo's contributor docs / CLAUDE.md section explaining how to edit instructions and regenerate.

### Inventory verifier

Ships with the compiler (`compile-instructions --verify-inventory <snapshot> <generated>` or a sibling binary). Tokenizes a snapshot into headings (`^#+`), agent names (from `.claude/agents/` references and `agent` mentions in the snapshot), commands (`/<name>` and the command tables), and routes (`(GET|POST) /api/...`). Asserts each token is present in the generated file. Reusable by every consumer migration, so behavior-preservation is a machine gate in each repo's project, not a human bottleneck.

### Generated-file header

Every generated `CLAUDE.md` / `AGENTS.md` begins with:

```
<!-- AUTOGENERATED by compile-instructions. Edit instructions/ and regenerate. -->
```

Compiler refuses to overwrite a file lacking this header unless `--bootstrap` is passed.

### Wrapper contract

- POSIX shell.
- Unset `$JARVIS_HOME` → error and exit 1.
- Relative `$JARVIS_HOME` resolved to absolute.
- Symlinks followed.
- Non-executable compiler at `$JARVIS_HOME/bin/compile-instructions` → error.
- Spaces in paths supported via quoting.

### CI setup

Each **consumer** repo with CI checks out jarvis as a sibling (e.g., second `actions/checkout` step into `../jarvis`) and runs `scripts/compile-instructions --check` with `$JARVIS_HOME=../jarvis`. **For jarvis's own CI (Phase 4), no sibling checkout is needed — `$JARVIS_HOME` is the checkout under test itself**, so `--check` runs against the in-tree compiler (no risk of testing a different jarvis revision than the PR). Failure mode for compiler-output changes is intentional: "regenerate, commit, merge" is a sub-5-minute fix. SHA pinning rejected as ongoing maintenance overhead.

### Sections moving from pkms to jarvis canonical source

Final fragment filenames decided in Phase 1. These are **authored into jarvis** in Phase 3; the matching **removal from `pkms/CLAUDE.md`** happens in the (manual) pkms migration. Inbound:

- `## Jarvis` section (agent split, KB raw-source routing, loadAgentDef order) — likely splits into `jarvis-overview.md`, `jarvis-agent-loading.md`, `jarvis-kb-routing.md`.
- `### How Reviews Work` (specialist updater pipeline) → likely `jarvis-review-pipeline.md`.
- Morning prep ownership reference → likely `jarvis-morning-prep.md`.

Staying in pkms canonical source: repository overview, vault structure, journal format, reference system, tags, JSON schemas, file conventions, review-cadence and command tables, "About Me", "How to Help Me", `### End-of-Month Reviews` table (with reference to Jarvis as runtime), links to per-folder index docs.

### Behavior inventory

`ownership.md` (Phase 1 output) doubles as a behavior inventory. Columns: heading | snapshot file | new owner repo | target fragment | notes. Behaviors that live in paragraphs/tables/examples without a clean heading get their own row with `notes` carrying the description. The inventory verifier (req 12) consumes the snapshot directly; `ownership.md` drives the per-fragment substring assertion (req 13).

---

## Implementation Phases

> This project = Phase 1 (manual prep) + Phases 2-5 (jarvis-internal, `/work --auto`-runnable). Consumer migrations are separate per-repo projects (see Execution model). Task breakdown lives in [tasks.md](tasks.md); verification in [test-plan.md](test-plan.md). Test-first: each phase opens with a **Tests (write first)** block.

### Phase 1: Snapshot + inventory + ownership decision  ·  **MANUAL (cross-repo read-only prep)**

> Not `/work --auto`-runnable: inventorying what moves where requires reading pkms/aura/assay, outside any single-repo worktree. Run by hand (or an orchestrator with multi-repo read access). Output feeds the auto build in Phases 2-5.

- [ ] Snapshot all existing instruction files into `snapshots/` (local-only, gitignored — never committed; pkms is private, jarvis is public).
- [ ] Produce section-by-section table via `tools/list-sections.sh` into the gitignored `snapshots/` tree (it spans private content).
- [ ] Refine inbound section list into `ownership.md`. **Commit only the jarvis-owned rows** (orchestrator content moving into jarvis, pre-sanitized of PII); keep any pkms-derived analysis in the local `snapshots/` tree.
- [ ] Choose canonical phrasing for each Claude/Codex duplicate.

### Phase 2: Compiler, wrapper, and inventory verifier  ·  `--auto`

> Depends on: Phase 1.

- [ ] Build compiler in `jarvis/bin/compile-instructions` with explicit IR + pure-function renderers.
- [ ] Implement claude and agents renderers (identical text per fragment in v1; divergence via manifest).
- [ ] Ship wrapper template at `jarvis/bin/wrapper-template.sh`.
- [ ] Build the inventory verifier (req 12) — the reusable named-token regression smoke gate.

### Phase 3: Migrate jarvis itself  ·  `--auto`

> Depends on: Phase 2. Single-repo: jarvis only.

- [ ] Install wrapper in jarvis at `scripts/compile-instructions`.
- [ ] Author `jarvis/instructions/` fragments from the Phase 1 ownership manifest's jarvis-owned rows + jarvis's own runtime knowledge (authored fresh — no pkms-snapshot read; req 15).
- [ ] Author `jarvis/instructions/manifest.yaml`.
- [ ] Generate `jarvis/CLAUDE.md` + `jarvis/AGENTS.md` via `--bootstrap`; stage canonical + generated together (the run's work product; the runner classifies the diff).
- [ ] Inventory smoke gate passes for jarvis; human semantic sign-off recorded after the run (off the blocking path).

### Phase 4: Drift check (CI) for jarvis  ·  `--auto`

> Depends on: Phase 2. Can land alongside Phase 3.

- [ ] Add the drift-check step to jarvis CI (`scripts/compile-instructions --check`).
- [ ] Ship optional pre-commit hook via `scripts/install-hooks.sh`.

### Phase 5: Per-repo migration playbook (jarvis-internal)  ·  `--auto`

> Depends on: Phases 2-4. Authors a jarvis doc only — does **not** write to any sibling repo.

- [ ] Author `per-repo-migration.md` — the template each consumer project (pkms, aura, assay, relay) is instantiated from: install wrapper, author `instructions/`, generate via `--bootstrap`, run inventory smoke gate, human sign-off, add CI/pointer. Includes per-repo source material + the relay (fresh) / pkms (manual + section removal) special cases.
- [ ] Update jarvis-internal docs referencing the old structure (project 08 docs, `agent-lessons.md`).
- [ ] Verify `snapshots/` remains on disk as a local-only audit artifact.

> **Consumer stubs + migrations are out of this project's scope** — each is created by a separate single-repo run (aura/assay/relay via `/work --auto` in that repo; pkms manually). See the Consumer-repo migrations table.

---

## Success Metrics

### Core KPIs

| Metric | Target | How Measured |
| ------ | ------ | ------------ |
| `compile-instructions --check` exit 0 in jarvis | pass | CLI invocation post-Phase-3 |
| Inventory smoke gate green for jarvis | 100% of snapshot tokens present | `--verify-inventory` exit 0 (smoke test, not sign-off) |
| Human semantic sign-off (jarvis) | recorded | reviewer note after the jarvis migration run |
| Behavior inventory rows preserved | 100% of `ownership.md` rows assert green | Phase 3 fragment-existence + substring assertions |
| CI catches drift (jarvis) | 3/3 fixture cases pass | Local fixture tests in Phase 4 |
| ~/.claude/CLAUDE.md unchanged | sha256 unchanged from project start | `shasum` comparison |
| Per-repo migration playbook exists | `per-repo-migration.md` present | Phase 5 deliverable (stubs themselves are separate per-repo runs) |

### Observational metrics (post-merge, 3-run window)

- Morning prep produces today's journal `# Morning prep` heading on each of the next 3 scheduled runs with no error-level log lines.
- Codex opening jarvis loads the regenerated `AGENTS.md` with the orchestrator identity intact.

---

## Edge Cases & Error Handling

### Compiler

- Manifest references a fragment that doesn't exist → error naming the file.
- Same `(file, renderer)` pair listed twice in manifest → error naming the duplicate.
- Manifest names an unknown renderer → error listing valid renderers.
- Malformed YAML → error with line number.
- Fragment contains frontmatter → error naming the fragment.
- Generated file lacks autogenerated header and `--bootstrap` not passed → error.
- Orphaned `AGENTS.md` (manifest no longer renders it) → error unless `--bootstrap`.

### Wrapper

- Unset `$JARVIS_HOME` → clear error message naming the env var.
- `$JARVIS_HOME` points to non-existent directory → error.
- Compiler file is not executable → error.

### Inventory verifier

- Snapshot token absent from generated output → non-zero, names the token + snapshot.
- Snapshot file missing for a repo that should have one → non-zero (catches a skipped Phase 1 snapshot).

### CI

- A consumer repo's jarvis sibling-checkout step fails → CI fails the workflow (no silent skip of the drift check). (jarvis's own CI has no sibling step.)
- Compiler version produces different output than committed → drift check fails on next PR; developer regenerates as part of normal PR flow.

### Consumer migrations (in their own projects)

- A consumer migration that needs a judgment call emits a `blocked-on-human` checkpoint (Telegram) instead of hard-stopping — **once that work-run outcome ships (filed in `docs/projects/bugs.md`); until then the sign-off is done manually after the run, off the blocking path.**
- pkms migration is manual: a worktree run cannot operate in pkms (private, not in `products.json`, no-branch rule).

---

## Open Questions

None. Source format (fragments + manifest), compiler location (jarvis/bin), versioning model (no formal versioning, CI-enforced lock-step), pre-commit posture (optional), `~/.claude/CLAUDE.md` treatment (untouched), the decomposition into per-repo projects, and pkms-as-manual are all settled.
