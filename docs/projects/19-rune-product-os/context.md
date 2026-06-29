# Project Context: Rune Product-OS

> Orchestration state for the `rune` project "Rune Product-OS".
> Owned by Rune's context curator — roles read a bounded slice and emit handoff
> notes; they do not author this file directly.

## Current State

Reframes the cockpit into a product operating system where every product — external (aura, assay, relay, writing, brand) and internal (Rune, Rune MCP) — is a first-class entity sharing one spine, with internal/external a top-level UI distinction. Four workstreams: W1 (MCP re-architecture), W2 (cockpit product-OS reframe), W3 (knowledge freshness), W4 (writing & brand migration). A prior pass shipped only the warm-index slice of W1; this project restores full scope and lands that slice as Phase 2.

## Key Decisions

- **Foundation:** cockpit-as-product-OS is the organizing model; the MCP standalone split is the backend unblocker for monitoring (telemetry) and writing (cross-repo KB access), so W1 Phase 1 leads the build.
- **MCP topology:** standalone, always-on service on `127.0.0.1:3848`, launchd label `com.jarvis.rune-mcp`, lifecycle independent of the cockpit. Cockpit restarts never drop the MCP OAuth session, so the Claude App never re-authenticates on a cockpit restart. One-time exception: the daemon uses a separate `RUNE_MCP_OAUTH_STORE_FILE` and does not migrate the web server's existing tokens, so the cutover forces exactly one reauth on first connect. Claude App connects directly to the MCP service through Tailscale Funnel/Serve; the Rune web server does not proxy `/mcp`. MCP has a small HTTP `/health` service-status endpoint only; product functionality stays in MCP tools/resources.
- **MCP metrics:** a timeout is a call exceeding `RUNE_MCP_TOOL_TIMEOUT_MS` (default 30000), counted as both error and timeout; p50/p95/p99 latency is computed over a bounded per-tool ring buffer (no unbounded sample arrays in the long-lived process).
- **Admin-stdio boundary (resolved):** the per-session local admin stdio MCP server stays on cold ripgrep and never builds the warm index; only the long-lived daemon holds warm state and routes daemon-internal broad `kb_query` through `queryVaultIndex` after readiness.
- **Monitoring data flow:** the cockpit polls MCP metrics from a `mcp_metrics_snapshot` MCP tool once per second while monitoring is visible; no shared metrics store and no separate `/metrics` HTTP endpoint.
- **Performance:** no vector DB. A long-lived process holds the corpus + an in-memory full-text/structured index (exploiting tags, frontmatter, `[[ ]]` links) resident and answers from warm state. Build on startup, refresh every 15 minutes, fall back to cold ripgrep until ready, follow symlinks, and index markdown files fully. `knowledge/` is the curated semantic layer; vector is a deferred, additive option.
- **New MCP functions:** `journal_range`, `follow_wikilinks`, `tag_date_query`, `refresh_vault_index`, and `mcp_metrics_snapshot`.
- **Monitoring scope:** internal products only (MCP call metrics + Rune run metrics); stubbed/empty container on external products so the shape stays consistent and external monitoring lands later without a structural change.
- **Containers already exist** (projects/ideas/bugs; operations/runs; chat) from project 17 — this project makes their contents product-aware. Rune MCP weights operations/runs heavier; writing keeps ideas only (no projects/bugs).
- **Writing is a real product** Rune orchestrates as work runs, not a Telegram-only skill.
- **`michaelcjoseph.com`** becomes a two-product repo: Brand (existing root single-page Next.js app, active) + Writing (`/rune/{topic}` page per content piece).
- **Writing migration boundary:** historical content stays in pkms; ideas migrate to `michaelcjoseph.com/docs/rune/writing-ideas.md`; `/blog` (today a `startReview(...,'blog')` review flow) is rebuilt on the specialized writing pipeline and its old review type is removed/redirected; `/writing-critique` is added as a Rune command. `/topics` and `/voice` are **not existing commands** — only their pkms content migrates (`writing/topics.md` ideas, `writing/voice.md` voice guidance); the retirement action is a confirmation that no such command exists, not code removal. Writing leaves pkms entirely and consumes pkms only through the MCP. Writing branches use `rune-writing/{slug}`; v1 publish means committed to the branch, not externally deployed.
- **Writing safety:** the writing work run inherits standard sandbox credential isolation (only `writing`'s own creds reach the child); published pages synthesize pkms material and must never surface raw personal content (planted-marker negative test enforces this). `michaelcjoseph.com` is a separate repo outside the `rune` tree — cross-repo write access is a Phase 6 environment prerequisite.
- **Knowledge freshness** is in scope as a distinct curation workstream (Rune nightly reconciliation/invalidation), separate from MCP/cockpit/writing. V1 scope is the **rename / identity-drift class** (deterministic token/alias match against a known supersession term), not general free-prose semantic contradiction; the LLM adjudicator only confirms candidates the finder surfaced. The pass runs **immediately after the `KB queue` step** (fixed index, ahead of the unrelated Whoop/observation/learning steps, before `KB lint`). The in-flight Jarvis→Rune rename drift is the canonical proof case, plus a required over-invalidation near-miss (a still-valid historical reference to the prior identity must be left unchanged).
- **Warm-index slice carried forward:** "full vault" = every `*.md` under every folder, no allow/deny list; folder in scope by existing; `library/` (0B) stays in scope as a no-op; coverage-parity floor is ripgrep-over-everything.

## Interfaces & Contracts

### W1 — Warm retrieval core (Phase 2)

New module `src/kb/vault-index.ts`:

```ts
buildVaultIndex(): void
refreshVaultIndex(): void
queryVaultIndex(query: string, options?: { directory?: string; maxResults?: number }): IndexedLine[]
// IndexedLine = { file: string; line: number; content: string }
```

Build: walk the vault root; include every `*.md` under every folder; skip `.git/` and non-markdown; read best-effort (skip unreadable files with a logged reason, never abort); follow symlinks with a visited real-path/inode guard so cycles cannot cause a non-terminating walk; build a fresh local corpus then assign the singleton once (atomic swap); intern the vault-relative path per file; log `{files,lines,bytes,heapUsed,buildMs}` per build; on refresh failure keep the previous complete index. Query: preserve `{file,line,content}` shape; case-insensitive regex-like per line with literal-substring fallback; `directory` as a vault-relative path-prefix filter; `maxResults` as output cap only; never use `directory`/`types` to decide index contents.

### W1 — Cutover (Phase 2)

`read-tools.ts`: remove `ALL_SEARCH_TYPES` as the default coverage gate; default no-types search queries the whole warm index; `types` becomes optional narrowing by top-level folder prefix. `mcp/server.ts`: broaden the `types` schema off the closed 3-value enum; update tool description to advertise whole-vault markdown search. `read-tools-deps.ts`: bind production `vault_search` to `queryVaultIndex`. Admin-stdio boundary is resolved: admin stdio stays on cold ripgrep and builds no warm index; only the daemon holds warm state.

### W1 — Standalone service (Phase 1) & metrics (Phase 3)

The MCP runs as its own long-lived process on `127.0.0.1:3848` under launchd label `com.jarvis.rune-mcp`; the cockpit polls a MCP metrics snapshot tool while monitoring is visible (call volume, timeouts, latency, active sessions, index health). New functions: journal-range pulls, link-following, tag/date queries.

## Out Of Scope

- Vector / semantic embedding retrieval.
- External-product monitoring (analytics from external systems).
- Migration of historical writing content.
- New external products beyond writing and brand.
- macOS account changes or changes to the existing Rune web launchd label. A new MCP launchd job is in scope.

## Known Risks

- Cross-repo orchestration: W4 touches `michaelcjoseph.com`, a separate repo from `rune`; the writing agent's commands and KB access must work from there via the MCP.
- W3 uses conservative LLM adjudication before auto-editing, but over-aggressive invalidation could still rewrite valid curated facts if candidate selection/adjudication is too loose.

## Next Task Handoff

- npx vitest run src/mcp/daemon.test.ts --reporter verbose`
- `npx vitest run src/mcp/mcp-metrics-snapshot.test.ts --reporter verbose`
- `npx vitest run src/mcp/server.test.ts --reporter verbose`

Note: the staged QA test files were already staged in the worktree; I left them as-is and did not commit.
