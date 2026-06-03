# Jarvis Identity Refactor — Tasks

See [spec.md](spec.md) for the rescope rationale and approach, and [test-plan.md](test-plan.md)
for verification.

> **Rescoped 2026-06-02.** This is no longer a compiler build — it is two surgical edits:
> symlink `AGENTS.md` → `CLAUDE.md` per repo, and move orchestrator identity from
> `pkms/CLAUDE.md` to `jarvis/CLAUDE.md`. The prior compiler/manifest/verifier/CI/playbook
> tasks are dropped (see spec.md → Scope change). Small enough to do by hand in one sitting;
> no `/work --auto` orchestration needed.

## Phase 0 — Remove the original-scope tests

> The prior compiler-era plan was test-first and left one red test file behind. It asserts
> dropped artifacts (snapshots, `tools/list-sections.sh`, `inventory.md`, `ownership.md`),
> so it can never pass under the rescope. Delete it before anything else.

- [x] Delete `scripts/identity-refactor-phase1.test.ts` (the only spec-10 test; the
      `'10-jarvis-identity-refactor'` string in `src/jobs/supervision-store.test.ts` is
      unrelated test data — leave it). _(Already removed in the rescope commit `ffd7178`;
      verified absent.)_
- [x] Confirm the test suite is green without it (`npm test` or the repo's runner).
      _(2946 passing; the lone failure — `claude.test.ts` "does not set JARVIS_WORKSPACE_DIR"
      — is a pre-existing env-pollution issue unrelated to spec-10: a Jarvis-spawned session
      exports `JARVIS_WORKSPACE_DIR` into `process.env`, which the spawn env spread leaks into
      the child. Passes in a normal terminal/CI. Not introduced by this project.)_

## Phase 1 — Content move (pkms ↔ jarvis)

> Depends on: Phase 0. Order matters: this precedes the pkms symlink in Phase 2.

- [x] Append the `## Jarvis` section (automation ownership, agent split, KB raw-source
      routing, `loadAgentDef` order) from `pkms/CLAUDE.md` into `jarvis/CLAUDE.md`, placed
      coherently within its existing structure. _(New `## Jarvis` section after
      `## Architecture`; framing adapted "this vault" → "the pkms vault" per test-plan §2.7.)_
- [x] Append the `### How Reviews Work` mechanics (prep → interview → outline →
      write-up + post-agent pipeline; the specialist updaters) into `jarvis/CLAUDE.md`.
- [x] Remove both sections from `pkms/CLAUDE.md`.
- [x] Insert the pointer in `pkms/CLAUDE.md` where the sections were: "Jarvis orchestration
      … is documented in `jarvis/CLAUDE.md`."
- [x] Verify against the move boundary in spec.md: the listed "staying" sections remain in
      pkms (overview, vault structure, journal format, reference system, tags, schemas,
      cadence tables, command tables, About Me, etc.).
- [x] Read the git diff in both repos — moved content present in jarvis, absent in pkms,
      pointer present (test-plan §2). _(Diffs reviewed; PII/secret leak check on the added
      public-repo content passed.)_
- [x] Commit jarvis to `main`. Commit pkms straight to `main` (no-branch rule). _(jarvis
      lands on the work branch `jarvis-work/2d0534db` → merges to main downstream, the
      standard `/work` flow; pkms committed straight to `main` with selective staging —
      only `CLAUDE.md`, leaving live journal edits untouched; nothing pushed.)_

## Phase 2 — Symlink AGENTS.md → CLAUDE.md

> Depends on: Phase 1 (so the pkms symlink captures the post-move file).

### Core repos

- [ ] **jarvis:** `git rm AGENTS.md`; `ln -s CLAUDE.md AGENTS.md`; `git add AGENTS.md`.
- [ ] **Verify Codex reads through the symlink** in jarvis — open a Codex session, confirm
      it loads the orchestrator identity — **before** rolling the pattern to other repos
      (test-plan §1). If it fails, apply the `cp` + `diff` fallback (spec.md → Risks) and
      stop.
- [ ] **pkms:** `git rm AGENTS.md`; `ln -s CLAUDE.md AGENTS.md`; `git add AGENTS.md`.

### Best-effort repos

- [ ] **assay:** `git rm AGENTS.md`; `ln -s CLAUDE.md AGENTS.md`; `git add`.
- [ ] **aura:** `ln -s CLAUDE.md AGENTS.md`; `git add` (creates the previously-absent file).
- [ ] **relay:** no action (no instruction files).

### Verify + commit

- [ ] In each touched repo, confirm `diff CLAUDE.md AGENTS.md` exits 0 and
      `readlink AGENTS.md` = `CLAUDE.md` (test-plan §1).
- [ ] Confirm `~/.claude/CLAUDE.md` sha256 is unchanged from project start (test-plan §3).
- [ ] Commit each repo to `main`.

---

## Out of scope (recorded so the rescope is explicit)

Dropped from the prior plan; not deferred, not tracked elsewhere under this project:

- The `compile-instructions` compiler, IR, `claude`/`agents` renderers, YAML manifest.
- The `$JARVIS_HOME` wrapper and `wrapper-template.sh`.
- The named-token inventory verifier and `ownership.md` / snapshot audit artifacts.
- CI drift-check steps and the optional pre-commit hook.
- `per-repo-migration.md` and the aura/assay/relay consumer-migration *projects* (the
  best-effort symlinks above are one-line commits, not migrations).

The persistent-role-agent / `SOUL.md` / per-agent-memory architecture is a **separate
project** (`docs/projects/ideas.md` → "Better agentic systems"), not part of this one.
