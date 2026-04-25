# Library → Knowledge Base Test Plan

Error-handling and behavior checklist for the new raw-source routes, the `lenny-sync` agent, the nightly `stepLibrarySync` step, the `/library-sync` slash, and the `/lenny` + `/pg` decommission.

> See also: existing tests in `src/kb/queue.test.ts`, `src/kb/engine.test.ts` (if present), `src/bot/handlers/text.test.ts`, `src/jobs/nightly.test.ts`.

## Priority Levels

- 🔴 **Critical**: Blocks the loop — wrong file routing, queue corruption, agent crash, lost state.
- 🟡 **High**: Degrades the workflow — silent skips, malformed state, missing citations.
- 🟢 **Low**: Cosmetic or rare — log formatting, edge-case path handling.

## 1. Raw-source routing (Phase A)

### `determineRawDir()`

- [ ] 🔴 `library/lenny/posts/foo.md` → `knowledge/raw/lenny`
- [ ] 🔴 `library/lenny/podcasts/bar.md` → `knowledge/raw/lenny`
- [ ] 🔴 `library/lennys-podcast/legacy.md` (legacy folder) → `knowledge/raw/lenny`
- [ ] 🔴 `library/graham-essays/essay.md` → `knowledge/raw/articles`
- [ ] 🟡 `library/some-future-thing/foo.md` (unknown subdir) → `knowledge/raw/notes` (existing fallback)
- [ ] 🟡 `library/lenny.md` (top-level file, no subdir) → `knowledge/raw/notes` (does NOT match the `library/lenny/` prefix)
- [ ] 🟢 Pre-existing routes (`Readwise/`, `journals/`, `world-view/`, `pages/playbook.md`, `projects/`) unchanged — no regression in routing tests

### `isMutableSource()`

- [ ] 🔴 `library/lenny/posts/foo.md` → `true` (Lenny posts can be re-published upstream)
- [ ] 🔴 `library/lenny/podcasts/bar.md` → `true`
- [ ] 🔴 `library/lennys-podcast/legacy.md` → `false` (immutable; one-time backfill)
- [ ] 🔴 `library/graham-essays/essay.md` → `false` (PG essays immutable)
- [ ] 🟡 Pre-existing mutable sources (`world-view/*`, `pages/playbook.md`, `journals/*`, `projects/*` non-archive) still return `true` — no regression

## 2. Backfill script (Phase A)

### `npm run library-backfill`

- [ ] 🔴 Walks `library/lennys-podcast/`, `library/graham-essays/`, and `library/lenny/` (when present); enqueues every `*.md` found
- [ ] 🔴 Re-running the script is idempotent — second run does NOT double-enqueue (relies on `enqueue()` dedupe in `src/kb/queue.ts`; verify before relying)
- [ ] 🔴 Script exits 0 on success, prints final count
- [ ] 🟡 Empty `library/lenny/` directory (typical pre-Phase-B state) → script doesn't error, just enqueues `library/lennys-podcast/` and `library/graham-essays/` content
- [ ] 🟡 Missing `library/` directory entirely → script logs a clear "no library found" message and exits 0
- [ ] 🟢 Symlinks or non-`.md` files inside `library/` are skipped, not enqueued

### Post-backfill ingestion

- [ ] 🔴 `processIngestionQueue()` drains the queue without crashing on any backfilled file
- [ ] 🔴 `knowledge/log.md` gains `[INGEST]` entries proportional to backfill count
- [ ] 🔴 `[CHECKPOINT]` markers appear every 15 successful ingestions (existing pacing)
- [ ] 🟡 Spot-check 2–3 random topic pages — citations to library raw files are present
- [ ] 🟡 `applyEntityLinks()` runs without error against the new raw files (no schema surprises)
- [ ] 🟢 Wiki-compiler doesn't choke on PG essays' inline HTML / non-markdown formatting (PG raw files have HTML traces from scraping)

## 3. Lenny MCP integration (Phase B)

### MCP registration

- [ ] 🔴 `.claude/settings.json` `mcpServers.lenny` registers without parse error; bot starts cleanly
- [ ] 🔴 Claude CLI can list the Lenny MCP tools after registration (manual verification: `claude mcp list-tools` or equivalent)
- [ ] 🟡 If auth required: `LENNY_MCP_TOKEN` is loaded from `.env.local` and passed to the MCP server config; missing token fails fast with a clear error, not a silent 401

### `lenny-sync` agent

- [ ] 🔴 First run (state file missing) uses the agreed sentinel (per Open Question #5; recommend `now` so backfill handles history) and writes a fresh state file
- [ ] 🔴 Subsequent run reads `last_sync_at` from `logs/lenny-sync-state.json` and only fetches items newer than that timestamp
- [ ] 🔴 Each new item is written to `library/lenny/{posts,podcasts}/<slug>.md` with the prescribed frontmatter (`source`, `source-url`, `published-at`, `fetched-at`, `kind`)
- [ ] 🔴 On success, `logs/lenny-sync-state.json` is updated with the new `last_sync_at`, counts, `last_run_status: "ok"`
- [ ] 🔴 On failure (MCP error, network, malformed response), state file's `last_sync_at` is NOT advanced; `last_run_status: "error"`, `last_error` populated
- [ ] 🟡 Re-publication of an existing slug overwrites the local file (no append, no rename)
- [ ] 🟡 Filename collisions (different posts, same slug) — newer `published-at` wins; collision logged
- [ ] 🟡 Empty MCP response (no new content) → state file's `last_sync_at` advances to "now"; counts are zero; success
- [ ] 🟡 Item with empty body is skipped with a warning; rest of the batch proceeds
- [ ] 🟢 Agent's `tools:` frontmatter is the smallest workable allow-list — no over-broad MCP access

### Nightly `stepLibrarySync()`

- [ ] 🔴 Runs BEFORE `stepKBQueue()` so newly-fetched files are processed in the same cycle
- [ ] 🔴 Walks `library/lenny/{posts,podcasts}/` for files modified since the prior orchestrator run, calls `enqueue(path)` for each
- [ ] 🔴 On agent failure, the step logs the error and downstream steps continue (`stepKBQueue`, etc.)
- [ ] 🟡 Errors surface in the existing per-step nightly TG summary — not silent
- [ ] 🟡 No double-enqueue on a re-run within the same nightly cycle (mtime comparison must be strict)
- [ ] 🟢 If no new files were fetched, step completes quickly with a no-op enqueue

## 4. `/library-sync` slash + CLI (Phase B)

- [ ] 🔴 `/library-sync` in TG invokes the same function as `stepLibrarySync()`; reply contains the count of new posts + transcripts
- [ ] 🔴 Resolver does NOT match free-text to `/library-sync` (operator-facing only); only the explicit slash invokes it
- [ ] 🟡 `/library-sync` while a nightly is in flight does not double-run the agent (lock or naive idempotence — decide during impl)
- [ ] 🟡 Manual run with no new content replies clearly: "No new posts or transcripts since `<last_sync_at>`."
- [ ] 🟡 MCP error during manual run: TG reply contains the error message verbatim; state file unchanged
- [ ] 🟢 Reply respects existing TG message-chunking (`sendLongMessage` if the count or summary grows long)

## 5. Decommission `/lenny` and `/pg` (Phase C)

### Removal

- [ ] 🔴 `src/bot/commands/lenny.ts` and `src/bot/commands/pg.ts` are deleted
- [ ] 🔴 `src/bot/handlers/text.ts` no longer routes `/lenny` or `/pg`
- [ ] 🔴 `src/bot/skill-registry.ts` `SLASH_COMMAND_METADATA` does not contain `lenny` or `pg`
- [ ] 🔴 Bot starts cleanly with no missing-file or missing-command errors
- [ ] 🔴 `/help` does NOT list `/lenny` or `/pg`
- [ ] 🟡 `npm test` passes — no test still imports or references the deleted commands

### Resolver behavior post-removal

- [ ] 🔴 Free-text "what does lenny say about pmf" routes to `/kb` (or no-skill-matched), does not crash on missing `lenny` skill entry
- [ ] 🔴 Free-text "give me the paul graham take on startups" routes to `/kb` or no-match — no `pg` skill leak
- [ ] 🟡 Resolver registry output (whatever debug surface it has) shows the registry without orphan entries pointing at deleted files

### Docs cleanup

- [ ] 🔴 `CLAUDE.md` § Project Structure: `lenny.ts` and `pg.ts` rows removed; `library-sync.ts` row added
- [ ] 🔴 `CLAUDE.md` § Agents: `lenny-sync` added to Runtime Agents
- [ ] 🔴 `CLAUDE.md` § KB raw-source routing: three new routes documented
- [ ] 🟡 `docs/projects/index.md`: `05-library-into-kb` row added
- [ ] 🟡 `grep -r "/lenny\|/pg" docs/` returns no stale references
- [ ] 🟡 `grep -r "/lenny\|/pg" .claude/` returns no stale references
- [ ] 🟢 No README or top-level doc references the removed commands

## 6. Integration with existing pipeline

- [ ] 🔴 Existing nightly orchestrator passes end-to-end with `stepLibrarySync()` inserted (no regressions in `stepDailyTags`, `stepKBQueue`, `stepWhoopActivity`, `stepGitCommit`, etc.)
- [ ] 🔴 `processIngestionQueue()` `[CHECKPOINT]` cadence (every 15 ingestions) still triggers `lintKB()` correctly with library files in the mix
- [ ] 🔴 `applyEntityLinks()` runs against new wiki pages without throwing — JSON alias map (CRM, books, places, family) still resolves
- [ ] 🟡 `/kb "what does Lenny say about pricing?"` returns wikilinked synthesis with Lenny raw-source citations after backfill
- [ ] 🟡 `/kb "what does Paul Graham say about taste?"` returns synthesis with PG raw-source citations after backfill
- [ ] 🟡 `kb_query` MCP tool (the one Jarvis exposes outward) returns the same enriched results to other Claude Code sessions — no schema mismatch
- [ ] 🟢 Morning prep is unaffected (does not invoke library sync, KB query, or these commands)

## 7. Resilience

- [ ] 🔴 Lenny MCP returns 5xx → `lenny-sync` raises; nightly logs the error; downstream steps continue; next night picks up unchanged `last_sync_at`
- [ ] 🔴 Lenny MCP returns 401/403 → clear auth-failure message in nightly summary; no partial state-file advance
- [ ] 🟡 Lenny MCP returns malformed JSON → agent raises; state file unchanged
- [ ] 🟡 Network timeout mid-fetch (one item succeeds, next item times out) → already-written items remain in vault; state file's `last_sync_at` is NOT advanced (so retried next night, possibly causing overwrites — acceptable since posts are mutable)
- [ ] 🟢 Disk write failure during agent (e.g., vault path permission) → agent surfaces error; nothing partial enters the queue
