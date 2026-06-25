# Tech Spec: Jarvis to Rune Rebrand

All implementation work lands in the product repo under normal branch, review, and commit discipline. The name decision is final.

## Sequencing Contract

```
Phase 0  inventory and allowlist
Phase 1  env-var path extraction, landed and verified
Phase 2  brand text, metadata, prompt, runtime identifier rename
Phase 3  GitHub repo/remote rename and @runeai ownership
Phase 4  disk move, env value update, launchd path update
Phase 5  no-stub acceptance verification
```

Phase 4 is gated on Phase 1. Before the checkout moves, path resolution must already work through `RUNE_*` vars and computed defaults.

## Inventory Contract

The Phase 0 inventory owns every case-insensitive `jarvis` hit. It must classify each hit as rewrite, rename, keep-with-rationale, or excluded filename.

The final grep allowlist comes from this inventory. The inventory artifact must not make the final committed grep fail; keep it outside the committed repo or sanitize/exclude it deliberately.

## Env-Var Contract

Use the existing style:

```ts
process.env.RUNE_VAR || computedDefault
```

Do not commit literal `/Users/jarvis`, `workspace/jarvis`, or stale `JARVIS_*` names.

| Var | Purpose | Default |
| --- | --- | --- |
| `RUNE_LOGS_DIR` | Replaces `JARVIS_LOGS_DIR`; used by logger and log-path consumers | Computed repo-root `logs/` path |
| `RUNE_WORKSPACE_DIR` | Workspace/root override where a real root path is needed | Computed current repo root |

Implementation should prefer a shared path helper for TypeScript code. CJS scripts may use a local equivalent if importing TS helpers would add build risk.

Tests must cover both unset defaults and set overrides.

## Brand and Runtime Rename

Split the work by risk:

- Docs/metadata sweep: README, docs, CLAUDE.md files, package metadata, lockfiles where applicable, CI/workflow references, URLs, and badges.
- Runtime identifier sweep: MCP/server names, command or slug names, generated user-facing strings, HTTP/MCP metadata names, and code-owned labels.
- Agent-definition sweep: prose and prompt bodies only.

Runtime identifier changes require focused code tests. Prompt-body edits should preserve role behavior and avoid unrelated prompt rewrites.

## Exclusions

Do not change:

- macOS username or home directory.
- Launchd label `com.jarvis.daemon`.
- Agent-definition filenames.
- Git history.
- Visual identity.

## Repo and Handle

Rename the GitHub repository to `rune`, update `origin`, and verify with `git fetch` plus authenticated push verification. A dry-run push or temporary branch push is acceptable if there is no real branch ready to push.

Claim `@runeai` on the intended public platform and record ownership privately.

## On-Disk Cutover

Before moving the directory:

- Confirm Phase 1 tests still pass.
- Confirm the worktree and daemon state are acceptable for maintenance.
- Stop or unload the daemon if needed to avoid interrupting active work.

Then:

- Rename `~/workspace/jarvis/` to `~/workspace/rune/`.
- Update deployed `RUNE_*` env-var values.
- Update the path line in `com.jarvis.daemon.plist`.
- Keep the label `com.jarvis.daemon`.
- Reload/start the daemon and verify health.

Rollback is the inverse path/env/plist edit.

## Acceptance

Acceptance is not stubbed. It must verify:

- Remote operations work against the renamed repo.
- `@runeai` is owned.
- `grep -i jarvis` returns only Phase 0 allowlisted survivors.
- Greps for `/Users/jarvis`, `workspace/jarvis`, and `JARVIS_` return zero committed-code hits.
- Env defaults and overrides both work.
- Launchd reports the daemon loaded and healthy from `~/workspace/rune/`.
- A real routine agent run succeeds while using the env-driven log path.