# Library → Knowledge Base Specification

## Overview

Today, curated external content from Lenny's Newsletter (`library/lennys-podcast/`) and Paul Graham (`library/graham-essays/`) lives as a separate vault folder, totally disconnected from the knowledge base. The `/lenny` and `/pg` commands (`src/bot/commands/lenny.ts:1-54`, `src/bot/commands/pg.ts:1-54`) ripgrep those folders and one-shot synthesize an answer with `askClaudeOneShot`. The library is never enqueued into the KB — `determineRawDir()` (`src/kb/ingest.ts:166-176`) has no `library/*` route, so nothing from these sources ever becomes a wiki page, gets entity-linked, decays via `valid-until`, or shows up in a `/kb` query.

This project folds the library into the knowledge base on two fronts:

1. **Backfill into the KB.** All existing Lenny + PG markdown becomes raw sources for the existing concept-driven `wiki-compiler` pipeline. Topic and concept pages absorb their insights with citations back to the source files.
2. **Live ingestion via Lenny MCP.** Lenny exposes an MCP server at `https://mcp.lennysdata.com/mcp` publishing posts and podcast transcripts. A new `lenny-sync` agent polls it nightly, writes new items to the vault, and lets the existing nightly KB queue process them. Re-publishing of a post overwrites the raw copy so wiki citations stay current.

`/lenny` and `/pg` are deleted. Users run `/kb` for unified retrieval.

### Core Value Proposition

Every insight from Lenny and Paul Graham is one `/kb` query away, automatically refreshed as new Lenny content drops — no separate command, no separate folder, no manual ingestion.

### Goals

1. **Primary:** All existing `library/lennys-podcast/*.md` and `library/graham-essays/*.md` become wiki citations under the existing concept/entity/topic page model. A `/kb` query on a topic Lenny or PG has covered returns wikilinked synthesis with citations back to the source files.
2. **Secondary:** A nightly job pulls the latest Lenny posts + podcast transcripts via the Lenny MCP server, writes new items to `library/lenny/`, and enqueues them for KB ingestion. Re-publishing of an existing item overwrites the raw copy so the wiki stays current.
3. **Tertiary:** `/lenny` and `/pg` slash commands are removed; users rely on `/kb`. Skill registry, resolver, CLAUDE.md, and any docs referring to these commands are cleaned up.
4. **Quaternary:** A `/library-sync` manual trigger (CLI + TG slash) lets the user force an immediate Lenny pull outside the cron schedule, useful for backfills and debugging.

### Non-Goals

- **Per-source wiki pages.** We use the existing concept-driven `wiki-compiler` pattern. A Lenny post about pricing feeds into `pricing.md`, NOT a new `lenny-pricing-deep-dive.md` page.
- **PG ongoing fetcher.** PG essays get a one-time backfill of existing files. No scraper for paulgraham.com — new essays can be dropped into the folder manually.
- **Hybrid `/lenny` and `/pg` commands.** The commands are deleted, not preserved as filtered shortcuts. If `/kb` quality on Lenny-tagged content disappoints, revisit a thin alias in v1.1 (see Open Questions).
- **TG notifications on new Lenny content.** Quietly enqueue; no per-post Telegram ping. The existing nightly summary covers it.
- **Re-exposing the Lenny MCP via `jarvis-kb`.** The MCP is consumed by Jarvis only (used by the `lenny-sync` agent). Other Claude Code sessions read processed wiki pages via existing `kb_query` / `kb_search` tools.
- **Schema change to `wiki-compiler`.** The agent's instructions are unchanged. Only raw-source routing and ingestion-trigger sides change.
- **Migration of `library/` to a new vault location.** Existing folders stay where they are. The `library/lenny/` folder grows new subdirs (`posts/`, `podcasts/`) as fetched content lands.

### Scale Considerations

- **Lenny MCP poll cost:** one MCP call per night listing posts + transcripts since `last_sync_at`. Likely <10 new items per night. Negligible.
- **Wiki-compiler invocation cost:** one `runAgent('wiki-compiler')` call per new item (~10 min timeout, typically much faster). Backfill of the existing library is the spike — count files first; if hundreds, the existing 15-item checkpoint loop in `processIngestionQueue()` paces it across nightly cycles.
- **Vault file growth:** Lenny posts are short markdown; podcast transcripts are 10–50KB. Estimate ~50–100 transcripts/year + ~200 posts/year ≈ <50MB/year. Trivial.
- **No new HTTP endpoints, no new cron registrations.** Reuses scheduler, ingestion queue, and wiki-compiler. Piggybacks on the existing nightly orchestrator.
- **One new MCP server registration** in `.claude/settings.json` (HTTP transport).
- **One new agent** (`lenny-sync`) plus one new nightly step (`stepLibrarySync`) plus one new TG / CLI surface (`library-sync`).

---

## User Journey

### Happy Path — A new Lenny post arrives overnight

```
Nightly orchestrator fires stepLibrarySync (before stepKBQueue)
         ↓
runAgent('lenny-sync', '') invokes the Lenny MCP via registered HTTP MCP
         ↓
Agent calls list_posts since last_sync_at, then list_transcripts since last_sync_at
         ↓
For each new item:
  - get_post / get_transcript fetches body
  - Agent writes library/lenny/{posts,podcasts}/<slug>.md with frontmatter
    (source, source-url, published-at, fetched-at, kind)
         ↓
Agent writes logs/lenny-sync-state.json with new last_sync_at
         ↓
TS-side step walks library/lenny/ for files modified since prior run, calls
enqueueKB() on each (mirrors stepJournalIngest pattern)
         ↓
Existing stepKBQueue runs processIngestionQueue() in the same nightly cycle
         ↓
Each new file flows through:
  - determineRawDir → knowledge/raw/lenny/{posts,podcasts}/
  - Copy to raw/ (mutable: overwrite if re-published)
  - runAgent('wiki-compiler') folds insights into existing concept/topic pages,
    cites the new source, updates last-verified
  - applyEntityLinks pass
         ↓
Next morning, /kb "what's Lenny saying about onboarding lately?" returns
synthesized answer with [[wikilinks]] to topic pages, themselves citing the
new posts.
```

### Happy Path — Backfill existing library

```
User runs `npm run library-backfill`
         ↓
Script walks library/lennys-podcast/*.md and library/graham-essays/*.md
         ↓
For each file, calls enqueue(path)
         ↓
Reply: "Enqueued N items. Run `npm run dev` overnight, or `npm run kb-process`
to ingest now."
         ↓
processIngestionQueue() chews through the queue serially with the existing
15-item checkpoint+lint cadence handling pacing.
         ↓
Each file → knowledge/raw/{articles,lenny}/, wiki-compiler runs, concept
pages absorb the content with citations.
```

### Happy Path — Manual `/library-sync` from Telegram

```
User sends "/library-sync" in TG
         ↓
Same as nightly stepLibrarySync: poll MCP, write new files, enqueue.
         ↓
Reply: "Pulled N new posts, M new transcripts. Enqueued for KB ingestion."
```

### Edge — Lenny re-publishes a post

```
MCP returns the post with same slug but updated content
         ↓
lenny-sync agent overwrites library/lenny/posts/<slug>.md
         ↓
enqueueKB(...) triggers re-ingest
         ↓
isMutableSource() returns true for library/lenny/* → raw copy overwrites
         ↓
wiki-compiler re-runs, updates citations, bumps last-verified on touched pages
```

### Edge — Lenny MCP is down

```
lenny-sync raises an error
         ↓
stepLibrarySync catches, logs, surfaces in the per-step nightly error summary
         ↓
Downstream nightly steps continue (stepKBQueue, etc.)
         ↓
Next night's run picks up where last_sync_at left off — no data loss
```

### Entry Points

- **Nightly cron**: `stepLibrarySync()` runs as part of the existing nightly orchestrator (`src/jobs/nightly.ts`), before `stepKBQueue()`.
- **TG slash command**: `/library-sync` via `src/bot/handlers/text.ts` for an on-demand pull.
- **CLI**: `npm run library-backfill` for the one-time backfill of existing files. (No CLI for the recurring sync — that runs through the scheduler.)
- **Resolver**: not in v1. `/library-sync` is operator-facing; no natural-language triggers.

### Exit Points

- New raw markdown files in `library/lenny/{posts,podcasts}/`.
- KB ingestion queue updated.
- Wiki pages under `knowledge/wiki/` updated with new citations.
- `logs/lenny-sync-state.json` updated with `last_sync_at`.
- TG reply to manual `/library-sync` (count of new items pulled + enqueued).

---

## Architecture Decisions

| Decision | Choice |
|---|---|
| Wiki page granularity | **Concept-only** (existing `wiki-compiler` pattern). Lenny/PG content lives in `knowledge/raw/`, cited by topic pages. |
| PG source | **Re-ingest existing files only**, no scraper. New essays dropped manually. |
| Fate of `/lenny`, `/pg` | **Remove entirely.** Users use `/kb`. Resolver, skill registry, CLAUDE.md updated. |
| Lenny MCP transport | **HTTP** at `https://mcp.lennysdata.com/mcp`. Registered in `.claude/settings.json`. |
| Lenny MCP exposure scope | **Jarvis only** (consumed by `lenny-sync`). Not re-exposed via `jarvis-kb`. |
| TG notifications on new content | **None.** Quiet ingest. Nightly summary already surfaces KB activity. |
| Recurring schedule | **Piggyback on the existing nightly orchestrator**, no new cron registration. |

---

## Requirements

### Raw-source routing

1. WHEN a source path begins with `library/lenny/` THEN `determineRawDir()` returns `knowledge/raw/lenny/`.
2. WHEN a source path begins with `library/lennys-podcast/` (legacy folder) THEN `determineRawDir()` returns `knowledge/raw/lenny/`.
3. WHEN a source path begins with `library/graham-essays/` THEN `determineRawDir()` returns `knowledge/raw/articles/`.
4. WHEN a source path begins with `library/lenny/` THEN `isMutableSource()` returns `true` (Lenny posts can be re-published upstream).
5. WHEN a source path begins with `library/graham-essays/` or `library/lennys-podcast/` THEN `isMutableSource()` returns `false` (immutable once captured).

### Lenny MCP registration

6. WHEN the bot or any agent runs THEN `.claude/settings.json` exposes the Lenny MCP server (HTTP transport, URL `https://mcp.lennysdata.com/mcp`) under `mcpServers.lenny`.
7. WHEN authentication is required (header / bearer token) THEN credentials are loaded from `LENNY_MCP_TOKEN` in `.env.local` and passed via the MCP server config; this requirement is conditional on what the MCP server actually requires (see Open Questions).
8. WHEN `lenny-sync` is invoked THEN its `tools:` frontmatter limits MCP access to the specific tools it needs; no other agent gets Lenny MCP access by default.

### `lenny-sync` agent

9. WHEN `lenny-sync` runs THEN it reads `logs/lenny-sync-state.json` for `last_sync_at` (ISO 8601). Missing file → treat as full historical backfill (or a recent cap like 30 days; decide during impl based on MCP response sizes).
10. WHEN `lenny-sync` runs THEN it lists posts and podcast transcripts published since `last_sync_at` via the Lenny MCP and fetches each new item's body.
11. WHEN a new item is fetched THEN `lenny-sync` writes it to `library/lenny/posts/<slug>.md` (post) or `library/lenny/podcasts/<slug>.md` (podcast) with frontmatter:
    ```yaml
    source: lenny-mcp
    source-url: <permalink>
    published-at: <iso>
    fetched-at: <iso>
    kind: post | podcast
    ```
12. WHEN an item with the same slug already exists locally THEN `lenny-sync` overwrites it (re-publication semantics; mutability handled downstream by `isMutableSource`).
13. WHEN `lenny-sync` finishes THEN it writes `logs/lenny-sync-state.json` with `{last_sync_at, last_post_count, last_transcript_count, last_run_status, last_error}`.
14. WHEN `lenny-sync` fails (MCP error, network) THEN it raises non-zero so the calling step can surface the error; state file's `last_sync_at` is NOT advanced.

### Nightly integration

15. WHEN the nightly orchestrator runs THEN `stepLibrarySync()` executes BEFORE `stepKBQueue()` so newly-fetched files are processed in the same cycle.
16. WHEN `stepLibrarySync()` runs THEN it invokes `runAgent('lenny-sync', '')` and then walks `library/lenny/{posts,podcasts}/` for files modified since the prior orchestrator run, calling `enqueue(path)` for each.
17. WHEN `stepLibrarySync()` errors THEN the error is logged and surfaced in the existing nightly per-step error summary; downstream steps continue.

### Manual triggers

18. WHEN `npm run library-backfill` runs THEN a one-time script enqueues every `*.md` under `library/{lennys-podcast,graham-essays,lenny}/` via `enqueue()`. It is idempotent (re-running is safe; `enqueue()` dedupes paths).
19. WHEN `/library-sync` is sent in TG THEN the same `stepLibrarySync()` logic runs and the bot replies with the count of new posts + transcripts pulled and enqueued.

### Decommission `/lenny` and `/pg`

20. WHEN the bot starts THEN `/lenny` and `/pg` are NOT registered as commands. The files `src/bot/commands/lenny.ts` and `src/bot/commands/pg.ts` are deleted, removed from `src/bot/handlers/text.ts`, and removed from `src/bot/skill-registry.ts` `SLASH_COMMAND_METADATA`.
21. WHEN a free-text TG message contains "lenny" or "paul graham" THEN the resolver gracefully routes to `/kb` (or no skill match) — no crash on missing skill.
22. WHEN docs are read THEN `CLAUDE.md` no longer lists `/lenny` or `/pg`; it lists `/library-sync` and the `lenny-sync` agent.

### State file

23. WHEN `logs/lenny-sync-state.json` is written THEN it conforms to:
    ```json
    {
      "last_sync_at": "<ISO-8601>",
      "last_post_count": <number>,
      "last_transcript_count": <number>,
      "last_run_status": "ok" | "error",
      "last_error": null | "<message>"
    }
    ```
24. WHEN the file does not exist THEN `lenny-sync` treats `last_sync_at` as a sentinel (e.g., 30 days ago) for the first run; subsequent runs advance it.

---

## Technical Implementation

### Phase A — Routing + backfill (no MCP dependency)

**Modified files:**

- `src/kb/ingest.ts`:
  - `determineRawDir()` (lines 166–176): add three new prefix checks for `library/lenny/`, `library/lennys-podcast/`, `library/graham-essays/`.
  - `isMutableSource()` (lines 180–185): add `library/lenny/*` to the mutable set.

**New files:**

- `scripts/library-backfill.ts` — walks `library/{lennys-podcast,graham-essays,lenny}/**/*.md`, calls `enqueue(path)` for each. Mirrors style of `scripts/run-intent-scan.ts`. Logs the count and exits.
- `package.json` adds `"library-backfill": "tsx --env-file-if-exists=.env.local scripts/library-backfill.ts"`.

**Doc update:**

- `CLAUDE.md` § **KB raw-source routing** gains the three new routes.

### Phase B — Lenny MCP integration

**Modified files:**

- `.claude/settings.json` — register `mcpServers.lenny` with HTTP transport pointing at `https://mcp.lennysdata.com/mcp`. (Exact field shape depends on the Claude CLI's HTTP-MCP config schema; confirm during impl.)
- `src/jobs/nightly.ts` — add `stepLibrarySync()` between the existing daily-tags step and `stepKBQueue()`. The new step:
  1. `await runAgent('lenny-sync', '')`
  2. Walk `library/lenny/{posts,podcasts}/` for files modified since the prior orchestrator run, `enqueue()` each.
  3. Catch + log + surface errors per the existing per-step error summary pattern.
- `src/bot/handlers/text.ts` — register `/library-sync` slash dispatch.
- `src/bot/skill-registry.ts` — add `library-sync` entry to `SLASH_COMMAND_METADATA`.

**New files:**

- `.claude/agents/lenny-sync.md` — Jarvis-resident (NOT vault-resident; no personal info). Frontmatter `tools:` allow-lists the specific Lenny MCP tool names plus `Read`, `Write`, `Bash` for filesystem writes. Body instructs the agent to read the state file, list since-timestamp, fetch each new item, write with frontmatter, update the state file.
- `src/bot/commands/library-sync.ts` — TG slash that calls the same `stepLibrarySync()` function and replies with the count summary.
- `logs/lenny-sync-state.json` — auto-created on first run. (`logs/` is gitignored.)

### Phase C — Decommission `/lenny` + `/pg` + docs

**Deleted files:**

- `src/bot/commands/lenny.ts`
- `src/bot/commands/pg.ts`

**Modified files:**

- `src/bot/handlers/text.ts` — remove any switch cases routing to `lenny` / `pg`.
- `src/bot/skill-registry.ts` — remove `lenny` / `pg` entries from `SLASH_COMMAND_METADATA`.
- `CLAUDE.md`:
  - **Project Structure** § — remove `lenny.ts` + `pg.ts` rows; add `library-sync.ts` row; add `lenny-sync` row to **Runtime Agents** table.
  - **KB raw-source routing** § — already updated in Phase A.
- `docs/projects/index.md` — add `05-library-into-kb` row with status; update if any references to `/lenny` or `/pg` exist there.
- Any other prose doc referencing `/lenny` or `/pg` (grep for them as part of this phase).

### Coordination notes

- **Phase A is independently shippable** — no MCP dependency. Even if Phase B slips, the existing library content gets KB benefits on its own.
- **No new cron registration.** `stepLibrarySync()` runs inside the existing nightly orchestrator. The orchestrator's existing error handling and Telegram summary patterns apply.
- **Nightly order matters.** `stepLibrarySync()` MUST run before `stepKBQueue()` so newly-fetched files are processed in the same nightly cycle (otherwise we wait an extra 24h for first appearance in the wiki).
- **Wiki-compiler is unchanged.** Concept-driven compilation is the right shape for Lenny/PG insights; no agent edits required.
- **`/lenny` and `/pg` removal is decoupled from Phase A/B.** Could ship Phase C any time after Phase A — the existing commands keep working until deleted, since they ripgrep `library/` and the underlying files are still present.

---

## Implementation Phases

### Phase A — Routing + backfill

> KB ingestion of existing library files. No MCP dependency. Independently shippable.

- [ ] Add `library/lenny/`, `library/lennys-podcast/`, `library/graham-essays/` routes to `determineRawDir()`
- [ ] Add `library/lenny/*` to `isMutableSource()`
- [ ] Vitest: `determineRawDir` returns expected paths for all three prefixes
- [ ] Vitest: `isMutableSource` returns expected mutability flags for all three prefixes
- [ ] Add `scripts/library-backfill.ts` and the npm script
- [ ] Run backfill against the actual library; spot-check `knowledge/log.md` for `[INGEST]` and `[CHECKPOINT]` entries
- [ ] Spot-check 2–3 random topic pages to confirm citations to library raw files

### Phase B — Lenny MCP integration

> Depends on: Phase A.

- [ ] Inspect Lenny MCP `list_tools` response (manually, via `claude mcp list-tools` or a one-shot agent) to enumerate exact tool names + arg schemas
- [ ] Register `mcpServers.lenny` in `.claude/settings.json` (HTTP transport)
- [ ] Add `LENNY_MCP_TOKEN` env var if auth required; document in CLAUDE.md
- [ ] Author `.claude/agents/lenny-sync.md` with the inspected tool list, frontmatter `tools:` allow-list, and instructions for state-file lifecycle
- [ ] Add `stepLibrarySync()` to `src/jobs/nightly.ts`, ordered before `stepKBQueue()`
- [ ] Add `src/bot/commands/library-sync.ts` and register in `src/bot/handlers/text.ts` + `src/bot/skill-registry.ts`
- [ ] Manual `/library-sync` test: confirm new files in `library/lenny/`, state file written, queue processes them, `/kb` reflects new content
- [ ] Resilience test: point MCP URL at a bad host, confirm nightly logs the error and continues

### Phase C — Decommission `/lenny` + `/pg` + docs

> Depends on: Phase A. (B optional — `/kb` already serves Lenny + PG queries after backfill.)

- [ ] Delete `src/bot/commands/lenny.ts` and `src/bot/commands/pg.ts`
- [ ] Remove `/lenny` and `/pg` from `src/bot/handlers/text.ts`
- [ ] Remove `lenny` / `pg` from `src/bot/skill-registry.ts` `SLASH_COMMAND_METADATA`
- [ ] Update `CLAUDE.md` Project Structure (remove rows, add `library-sync.ts`); add `lenny-sync` to Runtime Agents
- [ ] Update `CLAUDE.md` § **KB raw-source routing** with the new routes
- [ ] Update `docs/projects/index.md` with `05-library-into-kb` status; grep + update any `/lenny` or `/pg` references in other prose docs
- [ ] Boot the bot, verify `/lenny` and `/pg` are absent from `/help` and resolver registry
- [ ] Resolver smoke test: free-text "what does lenny say about pmf" routes to `/kb` or replies "no skill matched" without crashing

---

## Edge Cases & Error Handling

### Routing

- **Unknown `library/` subdir** (e.g., `library/some-future-thing/foo.md`): falls through to the existing `knowledge/raw/notes/` fallback. Acceptable; future-proof by adding routes when new subdirs appear.
- **File at exactly `library/lenny.md`** (top-level, no subdir): doesn't match the `library/lenny/` prefix; falls back to `notes/`. If this matters, tighten the prefix logic. Unlikely in practice.

### Lenny MCP

- **MCP server returns malformed response** (missing fields, partial JSON): `lenny-sync` raises; state file is NOT advanced; nightly logs the error.
- **Rate limiting / 429s**: agent retries with backoff (instructed via the agent prompt). If retries exhaust, raise — state file unchanged.
- **Auth token expired or invalid**: agent reports the error explicitly; user is alerted via the nightly TG summary.
- **MCP returns post with empty body**: skip the item; log a warning; continue with the rest of the batch.
- **Filename collision** (two posts with the same slug from different dates): newer published-at wins (overwrites); log the collision.

### Backfill

- **Large library** (hundreds of files): the existing 15-item checkpoint+lint pacing in `processIngestionQueue()` handles it. Backfill enqueues everything; ingestion drains over multiple nightly cycles.
- **A library file fails to compile** (wiki-compiler agent error on one item): existing `processIngestionQueue()` already logs the error and continues with the next item. No special handling needed.

### `/library-sync` slash

- **MCP fails during a manual `/library-sync`**: TG reply includes the error message verbatim. State file unchanged.
- **No new items**: TG reply: "No new posts or transcripts since `<last_sync_at>`."

### Decommission

- **Stale references in CLAUDE.md or other docs** to `/lenny` / `/pg`: caught by a final grep before merging Phase C.
- **Resolver classifies a free-text message to `/lenny`** after deletion: currently `runResolver()` uses the registry; once registry no longer has `lenny`, resolver simply won't return it. Confirm no hardcoded mention of `lenny` outside the registry.

---

## Open Questions

- [ ] **Lenny MCP tool surface.** Need to inspect `https://mcp.lennysdata.com/mcp` `list_tools` to get exact tool names + arg schemas. Probably `list_posts`, `get_post`, `list_transcripts`, `get_transcript`, but should not be assumed. Resolve by registering the MCP and listing tools as the very first Phase B task.
- [ ] **Lenny MCP authentication.** HTTP MCP servers may require an API key or bearer header. If so, add `LENNY_MCP_TOKEN` to `.env.local` and reference it in the `.claude/settings.json` MCP entry. Resolve by visiting the Lenny MCP docs / inspecting an unauthenticated handshake response.
- [ ] **Frontmatter on existing library files.** Backfill currently leaves them as-is (no frontmatter). Wiki-compiler handles raw markdown fine. Question is whether to retroactively decorate them with `source` / `published-at` to match newly-fetched ones. v1 leaves them untouched; revisit if citation quality suffers.
- [ ] **`/kb` answer quality post-backfill.** After backfill, spot-check whether wiki-compiler's concept-page outputs preserve enough Lenny-specific voice and quotes to be useful. If too lossy, add a thin `/lenny` alias that pre-filters `/kb` to `tags: [lenny]`. Explicitly de-scoped now, but a known fallback if v1 underdelivers.
- [ ] **First-run `last_sync_at` sentinel.** When `logs/lenny-sync-state.json` is missing, what date does `lenny-sync` use? Options: (a) 30 days ago — keeps first run small; (b) explicit "do nothing, set last_sync_at=now" so the user runs the backfill script for historical content; (c) earliest-publication sentinel — full historical pull. Recommend (b) — clean separation between backfill (script) and ongoing sync (agent). Confirm during Phase B.
- [ ] **Wiki tag for Lenny sources.** Should the `wiki-compiler` add a `lenny` (or `external-source`) tag to pages that cite Lenny content, to enable a future filtered `/kb` view? Not required in v1, but a one-line agent-prompt nudge would set up the option. Defer until Open Question #4 forces the decision.
