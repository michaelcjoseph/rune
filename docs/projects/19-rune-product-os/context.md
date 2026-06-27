# Project Context: Rune Product-OS

> Orchestration state for the `rune` project "Rune Product-OS".
> Owned by Rune's context curator — roles read a bounded slice and emit handoff
> notes; they do not author this file directly.

## Current State

Reframes the cockpit into a product operating system where every product — external (aura, assay, relay, writing, brand) and internal (Rune, Rune MCP) — is a first-class entity sharing one spine, with internal/external a top-level UI distinction. Four workstreams: W1 (MCP re-architecture), W2 (cockpit product-OS reframe), W3 (knowledge freshness), W4 (writing & brand migration). A prior pass shipped only the warm-index slice of W1; this project restores full scope and lands that slice as Phase 2.

## Key Decisions

- **Foundation:** cockpit-as-product-OS is the organizing model; the MCP standalone split is the backend unblocker for monitoring (telemetry) and writing (cross-repo KB access), so W1 Phase 1 leads the build.
- **MCP topology:** standalone, always-on service with a lifecycle independent of the cockpit. Cockpit restarts never drop the MCP OAuth session, so the Claude App never re-authenticates on a cockpit restart. The service owns KB access, the new functions, and metrics emission.
- **Monitoring data flow:** the cockpit reads MCP metrics from a **live MCP endpoint** (not a shared store) for real-time visibility.
- **Performance:** no vector DB. A long-lived process holds the corpus + an in-memory full-text/structured index (exploiting tags, frontmatter, `[[ ]]` links) resident and answers from warm state. The timeouts are architectural, not algorithmic. `knowledge/` is the curated semantic layer; vector is a deferred, additive option.
- **New MCP functions:** journal-range pulls, link-following, tag/date queries.
- **Monitoring scope:** internal products only (MCP call metrics + Rune run metrics); stubbed/empty container on external products so the shape stays consistent and external monitoring lands later without a structural change.
- **Containers already exist** (projects/ideas/bugs; operations/runs; chat) from project 17 — this project makes their contents product-aware. Rune MCP weights operations/runs heavier; writing keeps ideas only (no projects/bugs).
- **Writing is a real product** Rune orchestrates as work runs, not a Telegram-only skill.
- **`michaelcjoseph.com`** becomes a two-product repo: Brand (existing root single-page Next.js app, active) + Writing (`/rune/{topic}` page per content piece).
- **Writing migration boundary:** historical content stays in pkms; ideas migrate; workflow commands (`/blog`, `/writing-critique`, `/voice`, `/topics`) recreated in the writing product; writing leaves pkms entirely and consumes pkms only through the MCP.
- **Knowledge freshness** is in scope as a distinct curation workstream (Rune nightly reconciliation/invalidation), separate from MCP/cockpit/writing. The in-flight Jarvis→Rune rename drift is the canonical case to fix and prove the mechanism on.
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

Build: walk the vault root; include every `*.md` under every folder; skip `.git/` and non-markdown; read best-effort (skip unreadable files with a logged reason, never abort); build a fresh local corpus then assign the singleton once (atomic swap); intern the vault-relative path per file; log `{files,lines,bytes,heapUsed,buildMs}` per build; on refresh failure keep the previous complete index. Query: preserve `{file,line,content}` shape; case-insensitive regex-like per line with literal-substring fallback; `directory` as a vault-relative path-prefix filter; `maxResults` as output cap only; never use `directory`/`types` to decide index contents.

### W1 — Cutover (Phase 2)

`read-tools.ts`: remove `ALL_SEARCH_TYPES` as the default coverage gate; default no-types search queries the whole warm index; `types` becomes optional narrowing by top-level folder prefix. `mcp/server.ts`: broaden the `types` schema off the closed 3-value enum; update tool description to advertise whole-vault markdown search. `read-tools-deps.ts`: bind production `vault_search` to `queryVaultIndex`. Make an explicit `kb_query`/admin-stdio decision.

### W1 — Standalone service (Phase 1) & metrics (Phase 3)

The MCP runs as its own long-lived process; the cockpit consumes a live metrics endpoint (call volume, timeouts, latency). New functions: journal-range pulls, link-following, tag/date queries.

## Out Of Scope

- Vector / semantic embedding retrieval.
- External-product monitoring (analytics from external systems).
- Migration of historical writing content.
- New external products beyond writing and brand.
- macOS/account/launchd-label changes (owned by rebrand project 18).

## Known Risks

- Cross-repo orchestration: W4 touches `michaelcjoseph.com`, a separate repo from `rune`; the writing agent's commands and KB access must work from there via the MCP.
- W3 supersession heuristic is unspecified; over-aggressive invalidation could delete valid curated facts.

## Next Task Handoff

Start with W1 Phase 1: extract the MCP server into a standalone, long-lived process whose lifecycle is independent of the cockpit, so a cockpit restart never drops the MCP OAuth session (acceptance: restart cockpit, Claude App session survives, no reauth). Then W1 Phase 2 lands the warm retrieval core (the carried-forward warm-index work; see tasks.md Phase 2 and examples/qa.md for parity/acceptance intent).
