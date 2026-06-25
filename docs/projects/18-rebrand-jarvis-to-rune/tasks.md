# Rebrand Jarvis to Rune — Tasks

Not started. See [spec.md](spec.md) for architecture and [test-plan.md](test-plan.md) for verification.

> **Test-first by default.** Phases with code-test tasks open with a **Tests (write first)**
> block; those tests mirror the matching [test-plan.md](test-plan.md) sections and must fail
> (red) before implementation begins. Docs-or-config-only tasks record a reviewed no-code-test
> rationale instead. A phase's implementation is done when its test-plan sections pass.

## Phase 0 — Inventory

> Depends on: nothing.

### Tests (write first)

- [x] No code-test-required tasks — `jarvis-inventory-and-allowlist` is `docs-or-config-only`;
      record and review the no-code-test rationale (test-plan.md §1).

### Implementation

- [x] **jarvis-inventory-and-allowlist** — Produce an authoritative case-insensitive inventory
      of every `jarvis` occurrence across the repo and classify each into: brand
      text/prose/prompt to rewrite, public identifier to rename (package metadata, committed
      repo URLs/badges, CI/workflow references, MCP/server names such as `jarvis-kb`,
      command/slug names, runtime-visible names), private functional identifier kept as-is with
      written rationale (e.g. `com.jarvis.daemon`), or excluded agent-definition filename.
      Output the explicit final allowlist acceptance greps against; if committed, sanitize so it
      does not itself trip the final grep gates.

## Phase 1 — Path De-Leak

> Depends on: Phase 0.

### Tests (write first)

- [ ] Write the test suite for **env-var-path-extraction** — test-plan.md §2. Prove that unset
      `RUNE_*` defaults resolve to working computed paths and that overrides win.
- [ ] Confirm the suite fails (red) before implementation begins.

### Implementation

- [ ] **env-var-path-extraction** — Extract remaining hardcoded
      `/Users/jarvis/workspace/jarvis/...` references into `RUNE_*` env vars following the
      existing `process.env.<VAR> || <computedDefault>` style. In the same pass, rename
      `JARVIS_LOGS_DIR` to `RUNE_LOGS_DIR`, update `logger.ts` and every consumer, and convert
      the known holdouts in `scripts/hooks/block-nonresponse.cjs` and
      `src/server/static/product-deep-view-client.test.ts`. Defaults must preserve current
      behavior without committing literal `/Users/jarvis`, `workspace/jarvis`, or stale
      `JARVIS_*` names; compute defaults from repo/root helpers.

## Phase 2 — Brand Sweep

> Depends on: Phase 0.

### Tests (write first)

- [ ] No code-test-required tasks — both brand-sweep tasks are `docs-or-config-only`; record and
      review the no-code-test rationale (test-plan.md §3).

### Implementation

- [ ] **brand-sweep-docs-metadata** — Per the Phase 0 inventory, replace agent-name "Jarvis"
      with "Rune" across docs, README, every CLAUDE.md file, public package metadata,
      lockfile/package-manager metadata where applicable, CI/workflow files, committed
      `github.com/.../jarvis` URLs, badges, and repository descriptions. Preserve casing and
      voice; use `@runeai` only where the public handle is the right reference. Do not touch the
      macOS username, the `com.jarvis.daemon` label, private env-var values, agent-definition
      file contents, or runtime identifiers owned by other tasks.
- [ ] **brand-sweep-agent-defs** — Replace agent-name "Jarvis" with "Rune" in prose and prompts
      inside agent-definition files (`.claude/agents/*.md`, `.agents/`, `agents/`,
      `.codex/agents/`, and `src/intent/agent-def.ts`). Change only brand text in prose or
      prompt bodies; do not rename files and do not alter prompt logic, role behavior, tool
      contracts, or personal-specific content beyond the brand name.

## Phase 3 — Runtime Rename

> Depends on: Phase 0.

### Tests (write first)

- [ ] Write the test suite for **runtime-identifier-and-string-rename** — test-plan.md §4. Cover
      command routing, MCP/server metadata, config resolution, and representative user-facing
      output affected by the rename.
- [ ] Confirm the suite fails (red) before implementation begins.

### Implementation

- [ ] **runtime-identifier-and-string-rename** — Per the Phase 0 inventory, rename public
      runtime identifiers and user-visible strings that carry the old name, including MCP/server
      names such as `jarvis-kb`, command/slug names, generated messages, HTTP/MCP metadata
      names, and code-owned public labels. Update all references in one pass with no
      compatibility alias unless explicitly approved by the spec.

## Phase 4 — Repo Rename

> Independent of the disk move.

### Tests (write first)

- [ ] No code-test-required tasks — `github-repo-remote-rename` is `docs-or-config-only`; record
      and review the no-code-test rationale (test-plan.md §5).

### Implementation

- [ ] **github-repo-remote-rename** — Rename the public GitHub repository to `rune`, update the
      local git remote URL, and verify remote operations from the renamed checkout with
      `git fetch` plus either an authenticated dry-run push or a real temporary-branch push.
      Update any local repo metadata that depends on the remote name. May proceed independently
      of the disk move; normal branch and commit discipline applies.

## Phase 5 — Handle Ownership

> Independent of the disk move.

### Tests (write first)

- [ ] No code-test-required tasks — `secure-runeai-handle` is `docs-or-config-only`; record and
      review the no-code-test rationale (test-plan.md §5).

### Implementation

- [ ] **secure-runeai-handle** — Claim and secure the public `@runeai` handle on the intended
      public platform under a controlled login, then record ownership details privately. If the
      handle is no longer available, escalate immediately and pause approval because the
      brand-ownability premise has failed; do not silently proceed with a substitute handle.

## Phase 6 — On-Disk Cutover

> Depends on: Phase 1 landed and still verified.

### Tests (write first)

- [ ] No code-test-required tasks — `disk-move-and-daemon-cutover` is `docs-or-config-only`;
      verification is a daemon liveness check and grep gates (test-plan.md §6).

### Implementation

- [ ] **disk-move-and-daemon-cutover** — Before touching disk, confirm the worktree is clean
      enough for cutover and no long-running daemon work would be interrupted. Stop or unload
      the daemon as needed, rename `~/workspace/jarvis/` to `~/workspace/rune/`, update the
      deployed `RUNE_*` env-var values to the new path, update the single path line in
      `com.jarvis.daemon.plist` (leave the label as `com.jarvis.daemon`), then reload/start the
      daemon. Rollback is the inverse path and env edit.

## Phase 7 — Acceptance

> Depends on: all prior phases.

### Tests (write first)

- [ ] Write the acceptance verification suite — test-plan.md §7. Tests-as-deliverable: the
      verification itself is the deliverable, run with no stubs on load-bearing components.

### Implementation

- [ ] **cutover-acceptance-verification** — Run the full Definition of Done against the
      renamed, env-driven, moved checkout: GitHub repo and remote are `rune`; fetch and
      authenticated push work from `~/workspace/rune/`; `@runeai` is secured; case-insensitive
      grep for `jarvis` returns only Phase 0 allowlisted survivors; greps for `/Users/jarvis`,
      `workspace/jarvis`, and `JARVIS_` return zero committed-code hits; the launchd daemon is
      loaded and healthy from the renamed checkout; and a real routine agent operation succeeds
      while reading/writing through the env-driven log path.
