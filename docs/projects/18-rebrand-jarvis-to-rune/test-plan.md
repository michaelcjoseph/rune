# Rebrand Jarvis to Rune Test Plan

Error handling checklist for the brand/identity cutover from Jarvis to Rune: inventory and
allowlist, env-var path de-leak, brand and runtime renames, repo/remote/handle ownership,
on-disk cutover, and final acceptance.

This project is **test-first** where code is involved: §2, §4, and §7 are written by a phase's
**Tests (write first)** task and must fail (red) before that phase's implementation begins. The
docs-or-config-only sections (§1, §3, §5, §6) record a reviewed no-code-test rationale and are
verified by grep gates and a daemon liveness check.

> See also: [Cross-cutting test plan](../../tech/test-plan.md) for shared guidelines, monitoring, and security checks.

## Priority Levels

- 🔴 **Critical**: Blocks user progress, requires immediate attention
- 🟡 **High**: Degrades experience significantly, should be handled gracefully
- 🟢 **Low**: Non-blocking, can fail silently with logging

## 1. Inventory and Allowlist (docs/config — reviewed rationale)

### Inventory completeness

- [ ] 🔴 The inventory misses a committed `jarvis` hit and acceptance fails later. Re-run
      `rg -i jarvis` over the full tree (not just `src/`) and confirm every hit is classified.
- [ ] 🟡 A hit is misclassified as private-functional when it is actually a public brand
      surface. Require a written rationale per kept survivor and review it.
- [ ] 🟢 The committed inventory artifact itself contains bare `jarvis` tokens and would trip
      the final grep gate. Keep it transient or sanitize/escape the tokens.

## 2. Env-Var Path De-Leak (code-tests-required — write first)

### Default resolution

- [ ] 🔴 A `RUNE_*` env var is unset and its computed default throws or resolves to a wrong/dead
      path. Test that every unset default resolves to a working path computed from a repo/root
      helper, never a literal private path.
- [ ] 🔴 A consumer of the old `JARVIS_LOGS_DIR` is missed and reads `undefined` after the
      rename. Test that `RUNE_LOGS_DIR` is the only var read and that `logger.ts` plus every
      consumer resolve through it.
- [ ] 🟡 An override is set but ignored. Test that a set `RUNE_*` value wins over the computed
      default.
- [ ] 🟡 The known holdouts (`scripts/hooks/block-nonresponse.cjs`,
      `src/server/static/product-deep-view-client.test.ts`) still carry a hardcoded private
      path. Test/grep that they resolve through env vars with computed defaults.
- [ ] 🟢 A computed default accidentally encodes the old checkout name `jarvis`. Assert the
      default string contains no `jarvis` segment.

## 3. Brand Sweep (docs/config — reviewed rationale)

No executable red test is required for this phase. The two selected brand-sweep tasks only
rewrite docs, metadata, and agent-definition prose/prompt bodies; they do not change runtime
logic, filenames, command routing, or generated behavior. Correctness is reviewed from the
text diff and later verified by the acceptance grep gates for retired-brand survivors and
private path/env-var regressions.

### Brand text and metadata

- [ ] 🔴 A user-facing string, README, or CLAUDE.md still says "Jarvis" as the agent name.
      Grep confirms only allowlisted survivors remain.
- [ ] 🟡 A casing or voice regression (e.g. "rune" mid-sentence where "Rune" is correct, or a
      mangled committed URL). Review the diff for casing and link integrity.
- [ ] 🟡 An agent-definition filename or prompt logic was changed instead of just brand prose.
      Confirm only prose/prompt brand text changed and filenames/logic are intact.
- [ ] 🟢 A badge or repository-description reference to the old name is missed. Grep CI/workflow
      and metadata files for `jarvis`.

## 4. Runtime Identifier Rename (code-tests-required — write first)

### Public runtime identifiers

- [ ] 🔴 A renamed MCP/server name (e.g. `jarvis-kb`) breaks command routing or tool
      resolution. Test command routing and MCP/server metadata against the new name.
- [ ] 🔴 A user-facing generated message still emits the old name. Test representative
      user-facing output for the new brand.
- [ ] 🟡 Config resolution still keys on an old identifier. Test config resolution against the
      renamed identifiers.
- [ ] 🟢 A compatibility alias was introduced without spec approval. Confirm no alias exists
      unless explicitly approved.

## 5. Repo, Remote, and Handle (docs/config — reviewed rationale)

### Remote operations and handle

- [ ] 🔴 After the GitHub rename, the local remote URL is stale and push/fetch fail. Verify
      `git fetch` plus an authenticated dry-run or temporary-branch push from the renamed
      checkout.
- [ ] 🔴 `@runeai` is unavailable. Escalate and pause approval; do not substitute a handle
      silently.
- [ ] 🟡 Ownership of `@runeai` is claimed but not recorded. Record ownership details privately.
- [ ] 🟢 Local repo metadata depending on the remote name is missed. Update and re-verify.

## 6. On-Disk Cutover (docs/config — daemon liveness check)

### Disk move and daemon

- [ ] 🔴 The disk move runs before the path layer is verified, leaving the daemon pointed at a
      dead path. Gate the move on a verified Phase 1; never move first.
- [ ] 🔴 The daemon does not come back healthy from `~/workspace/rune/`. Roll back via the
      inverse path and env edit, then diagnose before retrying.
- [ ] 🟡 A long-running daemon job is interrupted by the move. Confirm no in-flight work and
      stop/unload cleanly before renaming.
- [ ] 🟡 The launchd label was changed along with the path line. Confirm the label stays
      `com.jarvis.daemon` and only the path line changed.
- [ ] 🟢 A deployed `RUNE_*` env value still points at the old path. Update all deployed values
      to the new checkout path.

## 7. Acceptance (tests-as-deliverable — no stubs)

### Full Definition of Done

- [ ] 🔴 GitHub repo and remote are `rune`, and fetch + authenticated push verification work
      from `~/workspace/rune/`.
- [ ] 🔴 Case-insensitive grep for `jarvis` across committed content returns only Phase 0
      allowlisted survivors (e.g. `com.jarvis.daemon`).
- [ ] 🔴 Greps for `/Users/jarvis`, `workspace/jarvis`, and `JARVIS_` return zero
      committed-code hits.
- [ ] 🔴 The launchd daemon is loaded and healthy from the renamed checkout.
- [ ] 🟡 `RUNE_*` env vars resolve correctly when set, and computed defaults work when unset.
- [ ] 🟡 A real routine agent operation succeeds end-to-end while reading/writing through the
      env-driven log path.
- [ ] 🟢 `@runeai` ownership is confirmed and recorded.
