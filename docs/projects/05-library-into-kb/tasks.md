# Library → Knowledge Base — Tasks

Not started. See [spec.md](spec.md) for details and [test-plan.md](test-plan.md) for verification.

## Phase A — Routing + backfill

> KB ingestion of existing library files. No MCP dependency. Independently shippable.

### Routing changes

- [x] Update `src/kb/ingest.ts` `determineRawDir()` (lines 166–176): add three prefix checks
  - `library/lenny/*` → `knowledge/raw/lenny`
  - `library/lennys-podcast/*` → `knowledge/raw/lenny` (legacy folder routes alongside new)
  - `library/graham-essays/*` → `knowledge/raw/articles`
- [x] Update `src/kb/ingest.ts` `isMutableSource()` (lines 180–185): add `library/lenny/*` to the mutable set; leave the legacy folders immutable
- [x] Vitest in `src/kb/ingest.test.ts` (or new file if absent): cover the three new routes for `determineRawDir` and the mutability flag for all three prefixes

### Backfill script + npm wiring

- [x] Add `scripts/library-backfill.ts`. Walks `library/{lennys-podcast,graham-essays,lenny}/**/*.md` via `fs.readdirSync` recursive, calls `enqueue(path)` for each, prints final count. Mirror the style of `scripts/run-intent-scan.ts` (env loading, structured logger, exit code).
- [x] Add npm script in `package.json`: `"library-backfill": "tsx --env-file-if-exists=.env.local scripts/library-backfill.ts"`
- [x] Confirm `enqueue()` in `src/kb/queue.ts` is idempotent for duplicate paths before relying on backfill safety; if not, add dedupe in the script

### Smoke test

- [x] Run `npm run library-backfill` against the live vault; capture the count
- [x] Trigger ingestion (let nightly run, or invoke `processIngestionQueue()` manually via a one-off script if needed)
- [x] Inspect `knowledge/log.md` for `[INGEST]` and `[CHECKPOINT]` entries proportional to backfill count
- [x] Spot-check 2–3 random topic pages to confirm citations to library raw files

### Documentation (Phase A only — minimal)

- [x] Update `CLAUDE.md` § **KB raw-source routing** with the three new routes (mutable/immutable noted)

## Phase B — Lenny MCP integration

> Depends on: Phase A complete.

### MCP discovery

- [x] Inspect `https://mcp.lennysdata.com/mcp` to enumerate exact tool names + arg schemas. Options: register first then run `claude mcp list-tools`, or use a one-shot agent that calls MCP introspection. Capture the tool list verbatim before writing the agent.
- [x] Determine auth requirements — does the server require a header / bearer? If yes, source the credential and add `LENNY_MCP_TOKEN` to `.env.local`.

### Settings + agent

- [x] Update `.claude/settings.json` to register `mcpServers.lenny` with HTTP transport pointing at `https://mcp.lennysdata.com/mcp`. (Confirm the Claude CLI's HTTP-MCP config schema during impl — fields may include `transport: "http"`, `url`, optional `headers`.) — Note: used Bash+curl approach instead; MCP tools inaccessible from vault cwd, token added to .env.local and config.ts instead
- [x] Author `.claude/agents/lenny-sync.md` (Jarvis-resident, NOT vault-resident):
  - `tools:` frontmatter allow-lists the inspected MCP tools plus `Read`, `Write`, `Bash`
  - Body instructs: read `logs/lenny-sync-state.json` for `last_sync_at`; list posts + transcripts since that timestamp; for each new item, fetch body and write to `library/lenny/{posts,podcasts}/<slug>.md` with the prescribed frontmatter (`source`, `source-url`, `published-at`, `fetched-at`, `kind`); on completion write the new state file
  - Failure semantics: raise (non-zero) without advancing `last_sync_at`

### Nightly orchestrator

- [x] Add `stepLibrarySync()` to `src/jobs/nightly.ts`, ordered BEFORE `stepKBQueue()`. Responsibilities:
  1. `await runAgent('lenny-sync', '')`
  2. Walk `library/lenny/{posts,podcasts}/` for files modified since the prior orchestrator run, call `enqueue(path)` for each
  3. Catch errors, log them, surface in the existing per-step nightly summary; do not block downstream steps
- [x] Confirm step ordering by reading the existing nightly file end-to-end before inserting

### Manual TG slash

- [x] Add `src/bot/commands/library-sync.ts` — invokes the same `stepLibrarySync()` function as the nightly job; replies with summary `"Pulled N new posts, M new transcripts. Enqueued for KB ingestion."` (or the error)
- [x] Register `/library-sync` in `src/bot/handlers/text.ts`
- [x] Add `/library-sync` entry to `src/bot/skill-registry.ts` `SLASH_COMMAND_METADATA`

### Smoke + resilience

- [ ] Manual `/library-sync` from TG: confirm new files in `library/lenny/`, state file written, queue processes them on next nightly cycle, `/kb` query reflects new content
- [ ] Resilience: temporarily point MCP URL at a bad host; trigger nightly; confirm error is logged + surfaced and `stepKBQueue` still runs

## Phase C — Decommission `/lenny` + `/pg` + docs

> Depends on: Phase A. (Phase B optional — `/kb` already serves Lenny + PG queries after backfill.)

### Code removal

- [ ] Delete `src/bot/commands/lenny.ts`
- [ ] Delete `src/bot/commands/pg.ts`
- [ ] Remove `/lenny` and `/pg` cases from `src/bot/handlers/text.ts`
- [ ] Remove `lenny` and `pg` entries from `src/bot/skill-registry.ts` `SLASH_COMMAND_METADATA`
- [ ] Grep the codebase for any other reference to `lenny` or `pg` slash commands (e.g., in `src/bot/resolver.ts` if hardcoded), clean up

### Documentation

- [ ] Update `CLAUDE.md` § **Project Structure**:
  - Remove `lenny.ts` and `pg.ts` rows from the `commands/` block
  - Add `library-sync.ts` row
- [ ] Update `CLAUDE.md` § **Agents** Runtime Agents table: add `lenny-sync` row
- [ ] Update `docs/projects/index.md`: add `05-library-into-kb` row with status
- [ ] `grep -r "/lenny\|/pg" docs/` and clean up any remaining references
- [ ] `grep -r "/lenny\|/pg" .claude/` for any agent or hook referencing them

### Smoke test

- [ ] Boot the bot in dev mode; verify `/help` no longer lists `/lenny` or `/pg`
- [ ] Send a free-text TG message containing "lenny" — confirm resolver gracefully routes to `/kb` or replies "no skill matched", no crash
- [ ] All existing tests still pass (`npm test`)
