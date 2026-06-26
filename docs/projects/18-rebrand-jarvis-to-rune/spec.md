# Rune Rebrand Specification

## Overview

The personal AI agent currently carries a retired public brand that is not trademark-clean
or distinctively ownable. This project cuts the public brand over to **Rune** across every
identity surface: the GitHub repository, the runtime-visible identity, public metadata, the
committed codebase, the env-var path layer, the local working checkout, and the launchd
daemon that runs it. The public handle `@runeai` is part of the brand-ownability premise and
must actually be secured for the cutover to count.

The cutover is intentionally narrow. Day-to-day behavior does not change. What changes is the
name the world sees, the names committed in code, and the path indirection that today leaks a
private checkout location into the repo. The macOS user account, the home directory, and the
`com.jarvis.daemon` launchd label stay as they are because they are machine-private functional
identifiers, not brand surfaces.

### Core Value Proposition

Cut the agent's public brand over from the retired name to Rune across the repo, runtime identity, env
vars, and the local checkout, with behavior unchanged and zero private paths left committed.

### Goals

1. **Primary:** The public GitHub repository is named `rune`, the local checkout runs from
   `~/workspace/rune/`, the `@runeai` handle is owned, and a case-insensitive grep for
   `jarvis` across committed content returns only the Phase 0 allowlisted survivors.
2. **Secondary:** Hardcoded private paths and stale `JARVIS_*` env-var names are gone. Paths
   resolve through `RUNE_*` env vars with computed defaults that commit no private absolute
   path and no old checkout name.
3. **Tertiary:** The launchd daemon is loaded and healthy from the renamed checkout, and a
   real routine agent operation succeeds end-to-end through the env-driven log path.

### Non-Goals

- Do not rename the macOS user account `jarvis` or the home directory. That is machine-wide
  and out of scope.
- Do not rename the launchd service label `com.jarvis.daemon`. Only its path line changes.
- Do not rename agent-definition filenames such as `kb-query.md` or `morning-prep.md`.
- Do not rewrite git history.
- Do not create a logo, color system, typography, or other visual identity.
- Do not add a transition period or compatibility alias unless a later approval changes
  this spec.

---

## User Journey

This is an infrastructure and identity project, so the "user" is the operator running the
cutover, and the journey is the sequenced operation rather than a runtime feature.

### Happy Path

```
Inventory + allowlist → path de-leak (verified) → brand + runtime sweep
                                                          ↓
   repo rename + handle claim (independent)        disk move + daemon cutover → acceptance
```

1. **Inventory** — The operator runs a case-insensitive `jarvis` inventory, classifies every
   hit, and produces the explicit acceptance allowlist.
2. **Path de-leak** — Hardcoded private paths move behind `RUNE_*` env vars with computed
   defaults; the change lands and is verified before any disk move.
3. **Sweep** — Brand text, public identifiers, and runtime-visible names rename to Rune in
   one disciplined pass each.
4. **Cutover** — Repo and handle are renamed independently; the verified path layer lets the
   local checkout move to `~/workspace/rune/` and the daemon reload cleanly.
5. **Acceptance** — The full Definition of Done is verified against the renamed, moved,
   env-driven checkout with no stubs on load-bearing components.

### Entry Points

- The operator running the cutover, branch by branch, against the live repo and machine.

### Exit Points

- A renamed repo and checkout where the agent presents as Rune everywhere public, behaves
  exactly as before, and leaks no private path.

---

## Requirements

### Inventory and Allowlist (Phase 0)

1. WHEN the cutover starts THEN run a case-insensitive inventory for `jarvis` across the repo
   and classify every hit into one of: brand text/prose/prompt to rewrite, public identifier
   to rename, private functional identifier kept as-is with written rationale, or excluded
   agent-definition filename.
2. WHEN the inventory is produced THEN it is the source of truth for the final acceptance
   allowlist, and it outputs the explicit allowlist that acceptance greps against.
3. WHEN the inventory is committed (rather than kept transient) THEN it is sanitized or
   excluded so it does not itself create final grep failures.

### Path De-Leak Through Env Vars (Phase 1)

4. WHEN a hardcoded `/Users/jarvis/workspace/jarvis/...` reference remains in code THEN it is
   extracted into a `RUNE_*` env var following the existing
   `process.env.<VAR> || <computedDefault>` style.
5. WHEN `JARVIS_LOGS_DIR` is read anywhere THEN it is renamed to `RUNE_LOGS_DIR` and every
   consumer (including `logger.ts`) is updated in the same pass.
6. WHEN a new env var is introduced THEN it uses the `RUNE_*` prefix.
7. WHEN a `RUNE_*` env var is unset THEN its computed default preserves current behavior
   without committing a literal `/Users/jarvis`, `workspace/jarvis`, or stale `JARVIS_*` name;
   defaults are computed from repo/root helpers.
8. WHEN the known holdouts `scripts/hooks/block-nonresponse.cjs` and
   `src/server/static/product-deep-view-client.test.ts` are processed THEN they no longer
   carry hardcoded private paths.

### Brand and Identifier Sweep (Phase 2)

9. WHEN the retired agent name appears in docs, README, CLAUDE.md files, public package
   and lockfile metadata, CI/workflow files, committed GitHub URLs/badges, user-facing
   strings, or prose/prompts inside agent-definition files THEN it is replaced with "Rune",
   preserving casing and voice.
10. WHEN the public handle is the right reference THEN `@runeai` is used.
11. WHEN sweeping THEN the macOS username, the `com.jarvis.daemon` label, private env-var
    values, and agent-definition filenames are left untouched.

### Runtime Identifier Rename (Phase 3)

12. WHEN a public runtime identifier carries the old name (MCP/server names such as
    `jarvis-kb`, command or slug names, generated messages, HTTP/MCP metadata names, code-owned
    public labels) THEN it is renamed consistently in one pass with no compatibility alias
    unless the spec explicitly approves one.
13. WHEN runtime identifiers are renamed THEN focused tests cover command routing, MCP/server
    metadata, config resolution, and representative user-facing output.

### Repo, Remote, and Handle (Phase 5)

14. WHEN the GitHub repository is renamed to `rune` THEN the local remote URL is updated and
    remote operations are verified with `git fetch` plus an authenticated dry-run push or a
    real temporary-branch push.
15. WHEN the `@runeai` handle is unavailable THEN pause and escalate, because the
    brand-ownability premise has failed; do not silently proceed with a substitute handle.

### Private On-Disk Cutover (Phase 5)

16. WHEN Phase 1 is landed and still verified THEN the local checkout is renamed from
    `~/workspace/jarvis/` to `~/workspace/rune/`, deployed `RUNE_*` env values are updated, the
    single path line in `com.jarvis.daemon.plist` is updated, the label stays
    `com.jarvis.daemon`, and the daemon is reloaded.
17. WHEN the disk move fails or needs reverting THEN the rollback is the inverse path and env
    edit, since these are reversible config changes.

### Sequencing

18. WHEN ordering the work THEN the path de-leak lands and is verified before the disk move so
    the daemon never points at a dead path; the repo rename and handle claim may proceed
    independently of the disk move.

---

## Technical Implementation

### Inventory artifact

A case-insensitive sweep (`rg -i jarvis`) produces a classified table. Each row carries the
file, the matched string, and its class: `brand-rewrite`, `public-identifier`,
`private-functional`, or `excluded-filename`. The `private-functional` rows carry a written
rationale (the canonical example is the `com.jarvis.daemon` launchd label). The output is the
acceptance allowlist. If the artifact is committed, it must not contain bare `jarvis` tokens
that would trip the final grep gate, so it is either kept transient (an approval artifact) or
sanitized (escaped/fenced) so the gate stays green.

### Env-var path indirection

Today the repo hardcodes `/Users/jarvis/workspace/jarvis/...` in at least
`scripts/hooks/block-nonresponse.cjs` and
`src/server/static/product-deep-view-client.test.ts`, and reads `JARVIS_LOGS_DIR`. The pattern
to converge on:

```
const LOGS_DIR = process.env.RUNE_LOGS_DIR || computeDefaultFromRepoRoot();
```

- `computeDefaultFromRepoRoot()` derives the path from a repo/root helper (e.g. relative to
  `import.meta.url` or a resolved project root), never a literal private absolute path.
- `JARVIS_LOGS_DIR` → `RUNE_LOGS_DIR`, with `logger.ts` and every consumer updated in the same
  commit so no reader is left on a stale name.
- New env vars use `RUNE_*`.
- Tests prove both directions: an unset var resolves to a working computed default, and a set
  override wins.

### Brand and runtime identifier renames

Two distinct passes, scoped by the Phase 0 inventory:

- **Brand text:** README, docs, every `CLAUDE.md`, `package.json` / lockfile metadata where
  applicable, CI/workflow files, committed retired-repo URLs and badges, repository
  descriptions, user-facing strings, and prose/prompts inside agent-definition file *bodies*
  (`.claude/agents/*.md`, `agents/`, `.agents/`, `.codex/agents/`, `src/intent/agent-def.ts`).
  Filenames and prompt logic are untouched.
- **Runtime identifiers:** public functional names such as the `jarvis-kb` MCP server name,
  command or slug names, HTTP/MCP metadata names, and code-owned public labels rename in one
  pass with no compatibility alias. Focused tests cover command routing, MCP/server metadata,
  config resolution, and representative user-facing output so the rename is proven, not assumed.

### Repo, remote, and handle

The GitHub repo rename and `@runeai` handle claim are independent of the disk move. After the
repo rename, `git remote set-url origin <new>` updates the local remote and verification runs
`git fetch` plus an authenticated dry-run (or temporary-branch) push from the renamed checkout.
The handle is claimed under a controlled login and recorded privately; an unavailable handle
escalates and pauses rather than substituting silently.

### Private on-disk cutover

Gated on the verified path layer. The sequence: confirm a clean-enough worktree and no
in-flight daemon work, stop/unload the daemon, `mv ~/workspace/jarvis ~/workspace/rune`, update
deployed `RUNE_*` env values to the new path, edit the single path line in
`com.jarvis.daemon.plist` (label unchanged), then reload/start the daemon. Rollback is the
inverse path and env edit.

---

## Implementation Phases

> The phase-by-phase task breakdown lives in [tasks.md](tasks.md) and the verification
> checklist in [test-plan.md](test-plan.md); both follow the phase structure below. The
> project is built **test-first** — every phase in tasks.md opens with a **Tests (write
> first)** block whose code-test tasks must fail (red) before implementation begins, or whose
> no-code-test rationale is recorded and reviewed.

### Phase 0: Inventory

- [ ] Produce the authoritative case-insensitive `jarvis` inventory.
- [ ] Classify every hit (brand-rewrite / public-identifier / private-functional /
      excluded-filename) with rationale for kept survivors.
- [ ] Output the explicit final allowlist used by acceptance, sanitized if committed.

### Phase 1: Path De-Leak

> Depends on: Phase 0.

- [ ] Extract remaining hardcoded `/Users/jarvis/workspace/jarvis/...` paths into `RUNE_*` env
      vars with computed defaults.
- [ ] Rename `JARVIS_LOGS_DIR` to `RUNE_LOGS_DIR` and update `logger.ts` plus every consumer.
- [ ] Convert the known holdouts in `scripts/hooks/block-nonresponse.cjs` and
      `src/server/static/product-deep-view-client.test.ts`.
- [ ] Verify unset defaults work and overrides win.

### Phase 2: Brand Sweep

> Depends on: Phase 0.

- [ ] Rewrite retired agent-name references to "Rune" across docs, README, CLAUDE.md files, package and
      lockfile metadata, CI/workflow files, committed URLs/badges, and repository descriptions.
- [ ] Rewrite brand text in agent-definition prose/prompt bodies without renaming files or
      altering prompt logic.

### Phase 3: Runtime Rename

> Depends on: Phase 0.

- [ ] Rename public runtime identifiers (MCP/server names such as `jarvis-kb`, command/slug
      names, generated messages, HTTP/MCP metadata, code-owned public labels) in one pass.
- [ ] Add or update focused tests for command routing, MCP/server metadata, config
      resolution, and representative user-facing output.

### Phase 4: Exhaustive Per-Instance Rename

> Depends on: Phases 0–3. Supersedes the prematurely-checked Phase 3 runtime rename.

Phase 3 was marked complete while ~1,400 `jarvis` tokens remained in shipping source,
tests, and docs (including user-facing CLI strings and the `jarvis-kb` MCP name). This
phase tracks **every remaining occurrence as its own task** in [tasks.md](tasks.md) so no
instance can be silently skipped. Each task renames one occurrence to `rune`, preserving
casing (`Jarvis`→`Rune`, `JARVIS`→`RUNE`).

- [ ] Rename all 1,427 enumerated `jarvis` occurrences to `rune` — one task per instance,
      grouped by file in tasks.md.
- [ ] Excluded from rename (must keep): the macOS username in `/Users/jarvis/…` and the
      `com.jarvis.daemon` launchd label. This project's own docs are excluded as
      self-referential. `workspace/jarvis` path references stay in scope (they become
      `workspace/rune`).

### Phase 5: Operational Cutover, Handle Ownership & Acceptance

> The final phase. Depends on: Phase 4 landed, plus Phase 1 verified for the disk move.
> These are the existing operational tasks the orchestrated run could not perform; the first
> three require a human operator.

- [ ] **Repo rename** (was Phase 4): rename the GitHub repo to `rune`, update the local
      remote, verify `git fetch` plus an authenticated push.
- [ ] **Handle ownership** (was Phase 5): claim and secure `@runeai` under a controlled
      login, record ownership privately; escalate and pause if unavailable.
- [ ] **On-disk cutover** (was Phase 6): stop the daemon, rename `~/workspace/jarvis/` to
      `~/workspace/rune/`, update deployed `RUNE_*` values and the single `com.jarvis.daemon.plist`
      path line (label unchanged), then reload.
- [ ] **Acceptance** (was Phase 7): run the full Definition of Done with no stubs on
      load-bearing components.

---

## Success Metrics

### Core KPIs

| Metric | Target | How Measured |
| ------ | ------ | ------------ |
| Public repo + remote renamed | `rune`, fetch + authenticated push verified from `~/workspace/rune/` | `git remote -v`, `git fetch`, dry-run push |
| Handle secured | `@runeai` owned under a controlled login | Login verification + private record |
| Brand grep clean | Only Phase 0 allowlisted survivors (e.g. `com.jarvis.daemon`) | `rg -i jarvis` against committed content |
| Private path grep clean | Zero hits | `rg '/Users/jarvis'`, `rg 'workspace/jarvis'`, `rg 'JARVIS_'` |
| Env-var resolution | `RUNE_*` overrides win; computed defaults work unset | Phase 1 tests |
| Daemon healthy | Loaded and healthy from renamed checkout | `launchctl` status + liveness check |
| End-to-end op | A real routine agent operation succeeds through the env-driven log path | Live run against `RUNE_LOGS_DIR` |

---

## Edge Cases & Error Handling

### Inventory and allowlist

- The committed inventory artifact itself contains `jarvis` tokens and trips the final grep
  gate. Keep it transient or sanitize/escape the tokens.
- A hit is ambiguous between brand and private-functional. Default to the more conservative
  classification and record the rationale rather than guessing a rename.

### Path de-leak

- A consumer of `JARVIS_LOGS_DIR` is missed and reads a now-undefined var. The same-pass
  consumer sweep plus the unset-default test catch this; the computed default must not throw.
- A computed default accidentally encodes the old checkout name. Derive from repo-root helpers,
  not string interpolation of the current path.

### Repo, remote, and handle

- `@runeai` is unavailable. Escalate and pause; do not substitute silently.
- Remote push verification fails after the rename (stale credential or URL). Re-verify the
  remote URL and auth before proceeding to the disk move.

### Disk move and daemon

- The disk move happens before the path layer is verified, leaving the daemon pointed at a dead
  path. The sequencing requirement forbids this; Phase 6 is gated on verified Phase 1.
- The daemon does not come back healthy after reload. Roll back via the inverse path and env
  edit, then diagnose before retrying.
- A long-running daemon job is interrupted by the move. Confirm no in-flight work and
  stop/unload cleanly before the rename.

---

## Open Questions

- [ ] Is the inventory artifact kept transient (approval-only) or committed sanitized? Decide
      before Phase 0 closes so the acceptance grep stays green.
- [ ] Are there public identifiers beyond `jarvis-kb` (e.g. additional MCP/server names or
      command slugs) that the inventory surfaces and that need their own rename rationale?
- [ ] Does any external consumer reference the retired GitHub URL such that a
      redirect or note is warranted, or is GitHub's automatic redirect sufficient?
