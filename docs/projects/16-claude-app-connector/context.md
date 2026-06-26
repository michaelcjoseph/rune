# Project Context: Move the Rune conversation surface to the Claude App via a remote MCP connector

> Orchestration state for the `rune` project "Move the Rune conversation surface to the Claude App via a remote MCP connector".
> Owned by Rune's context curator — roles read a bounded slice and emit handoff
> notes; they do not author this file directly.

## Current State

- Tool count: I locked the App-exposed surface at exactly six (kb_query, vault_search, log_idea, crm_lookup, get_priorities, log_conversation) per the brief's '~6 is right' framing. Final count/signatures are to be confirmed in discussion topic A.
- Bug capture: the brief names log_idea but routing is described for 'ideas/bugs'. I assumed bug capture is handled either by log_idea generalizing to ideas+bugs or by a thin sibling tool — without expanding the exposed count beyond the lean target. Tech lead to confirm whether bugs need a distinct tool.
- Routing contract (R3): I assumed an optional explicit `product` param, with App-Claude inference + resolution against Rune's known product list when omitted, and an explicit unrouted/inbox fallback rather than a guess. This is a product call standing in for topic A's final decision.
- kb_worthy determination: I assumed the kb-worthy judgment is made by the App Claude (via the ported heuristic) and passed to log_conversation as a boolean, rather than re-derived server-side.
- Auth/hosting (R4): I deliberately did NOT specify transport, host, or auth mechanism — that is the tech lead's architectural fork (topic B). I only asserted the product constraints: single-user secure access for Michael, and live-vault read/write into the same git history the pipeline reads.
- mode:full content: I assumed the App passes the reconstructed transcript text as the tool's `content` input (since no transcript file exists remotely), making the tool a pure vault-writer.

## Key Decisions

- Tool count: I locked the App-exposed surface at exactly six (kb_query, vault_search, log_idea, crm_lookup, get_priorities, log_conversation) per the brief's '~6 is right' framing. Final count/signatures are to be confirmed in discussion topic A.
- Bug capture: the brief names log_idea but routing is described for 'ideas/bugs'. I assumed bug capture is handled either by log_idea generalizing to ideas+bugs or by a thin sibling tool — without expanding the exposed count beyond the lean target. Tech lead to confirm whether bugs need a distinct tool.
- Routing contract (R3): I assumed an optional explicit `product` param, with App-Claude inference + resolution against Rune's known product list when omitted, and an explicit unrouted/inbox fallback rather than a guess. This is a product call standing in for topic A's final decision.
- kb_worthy determination: I assumed the kb-worthy judgment is made by the App Claude (via the ported heuristic) and passed to log_conversation as a boolean, rather than re-derived server-side.
- Auth/hosting (R4): I deliberately did NOT specify transport, host, or auth mechanism — that is the tech lead's architectural fork (topic B). I only asserted the product constraints: single-user secure access for Michael, and live-vault read/write into the same git history the pipeline reads.
- mode:full content: I assumed the App passes the reconstructed transcript text as the tool's `content` input (since no transcript file exists remotely), making the tool a pure vault-writer.

## Interfaces & Contracts

# Tech Spec — Rune Conversation Surface on the Claude App

## Grounding (verified in repo)
- MCP server today: `rune/src/mcp/server.ts` exports `createKBServer()` using `McpServer` (`@modelcontextprotocol/sdk@^1.29.0`) over **`StdioServerTransport`**; entry `rune/src/mcp/index.ts`. Registered tools: `kb_query`, `kb_search`, `kb_ingest`, `kb_stats`, `kb_lint`. Only `kb_query` is in the App surface today.
- Tool return shape is `{ content: [{ type:'text', text }], isError? }` — every new tool conforms.
- Vault primitives (`rune/src/vault/`): `appendToJournal(text): string`; `gitCommitAndPush(message): Promise<void>` (auto-heals to `main`, never throws); `readVaultFile/writeVaultFile/appendVaultFile/vaultFileExists/listVaultFiles/getVaultPath` (all path-validated via `assertWithinVault`).
- KB queue (`rune/src/kb/queue.ts`): `enqueue(source, guidance?)`, `getPriority()` (gives `conversation` paths priority 20), `dequeue()`. Raw-source path convention: `knowledge/raw/conversations/conversation-YYYY-MM-DD-HHMMSS.md`.
- Conversation layer (`rune/src/bot/commands/fresh.ts`, `fresh-full.ts`): `closeConversation()`, `parseKBWorthy(summary)`, `saveConversationSource(text)`. Summarizer prompt + kb-worthy heuristic live in `rune/src/ai/claude.ts` `summarizeSession()` (~lines 704-715). Sessions in `rune/src/vault/sessions.ts`.
- Idea routing: product registry `rune/policies/products.json` (`aura`, `assay`, `rune`, `relay`). `ProjectIdea = { title, friction, id }` — **no `product` field** (the attribution gap). Ideas filed to `pkms/projects/ideas.md` `## Loop-filed` section via `readFiledIdeas()/appendFiledIdeas()/deriveIdeaId()` (`rune/src/intent/observation-ideas-io.ts`).
- Daemon HTTP server: `rune/src/server/http.ts` `startHttpServer()` on `127.0.0.1:3847`, runs inside the daemon process that already holds the live `VAULT_DIR` working tree. Auth `rune/src/server/auth.ts` `verifyAuth()` (Bearer/cookie, timing-safe) + `RUNE_ALLOWED_HOSTS`. No remote MCP transport today.

## Architecture decision (R4): extend, don't fork
**Decision: one server, one process.** Refactor `createKBServer()` into a shared `createRuneMcpServer(opts)` factory that registers the full tool set, then expose it two ways from the SAME `McpServer` instance:
1. **stdio** (`mcp/index.ts`) — unchanged, for the daemon's CLI spawns.
2. **Streamable HTTP** — a new `/mcp` route mounted on the existing daemon HTTP server using the SDK's `StreamableHTTPServerTransport`.

Rationale: the daemon process already runs on the machine with the live vault working tree and git history the nightly pipeline reads (satisfies R4(b) for free). Standing up a separate server would duplicate vault access, config, and git-safety. Mounting on `http.ts` reuses `verifyAuth`, host-allowlisting, and the running event loop.

**Remote reachability:** the daemon binds `127.0.0.1`. Expose `/mcp` at a stable HTTPS hostname via a named tunnel (Cloudflare Tunnel preferred — stable hostname, no inbound ports, TLS terminated at edge). The tunnel is the only public surface; it forwards only `/mcp`.

**Auth (R4(a), single-user):** Claude App custom connectors require OAuth 2.1 for remote MCP. Implement a minimal single-user authorization server on the daemon using the SDK auth helpers (`mcpAuthRouter` + a single-tenant `OAuthServerProvider`): support Dynamic Client Registration + authorization-code flow, but the authorize step gates on the existing `RUNE_HTTP_SECRET` (only Michael possesses it) and issues access tokens bound to the single known user id. Every `/mcp` request validates the bearer token before the transport handles it. No multi-user/account model — tokens map to the one user.

## Tool surface (R2) — exactly six
All six registered on the shared server; only these are exposed on the HTTP/App transport (stdio may also carry the existing kb_* admin tools, which are NOT in the App surface). Each tool is a thin wrapper over existing primitives; no business logic lives in the transport layer.

| Tool | Inputs | Behavior | Output |
|---|---|---|---|
| `kb_query` | `{ question }` | exists — `queryKB()` | text answer |
| `vault_search` | `{ query, types?: string[], maxResults? }` | search journals/pages/projects via existing vault search/grep over `listVaultFiles` | ranked snippets w/ paths |
| `crm_lookup` | `{ name }` | read+match `pages/crm.json` | matched person/company record(s) |
| `get_priorities` | `{}` | parse `#priorities` from journal (mirrors `/priorities`) | today/this-week priorities |
| `log_idea` | `{ title, friction, product?, kind?: 'idea'|'bug' }` | route via R3, dedupe by `deriveIdeaId`, append to `pkms/projects/ideas.md`, commit+push | filed bullet + resolved product target |
| `log_conversation` | `{ mode:'full'|'summary', content, kb_worthy?: boolean=false }` | R1 | journal path + KB queue id |

## R1 — log_conversation contract
- `mode:'full'`: `appendToJournal(content)` where `content` is the App-reconstructed transcript (no remote transcript file — faithful reconstruction, accepted tradeoff), then `gitCommitAndPush`.
- `mode:'summary'`: `appendToJournal('- ' + content)`; if `kb_worthy`, also `saveConversationSource(content)` → `knowledge/raw/conversations/...` then `enqueue(sourcePath)`; commit+push.
- Reuses `closeConversation`'s write half but takes `content`/`kb_worthy` as INPUTS (the App's Claude produces summary text and the kb-worthy boolean via the ported heuristic — server does NO summarization, NO session read). `summarizeSession`/`parseKBWorthy`/session lifecycle are bypassed on this path.
- Output: `{ journalPath, kbQueueId? }` rendered as confirmation text.

## R3 — idea/bug routing function
- New `resolveProductTarget(candidate?: string): { product: string, confidence }` over `policies/products.json` known list.
- Explicit `product` input → validate against list; if unknown, treat as unresolved.
- Omitted/unresolved → file to an explicit `inbox`/`unrouted` target (never dropped, never guessed). Add `inbox` as a reserved target.
- Extend `ProjectIdea` (and the ideas.md bullet writer) to carry `product` so loop-filed + App-filed ideas share one attribution schema. `log_idea` generalizes to ideas AND bugs via `kind` (no extra exposed tool — keeps the lean six).

## R5 — prompt port
- Lift the `summarizeSession` prompt text + kb-worthy heuristic verbatim into the Claude App project instructions so the App produces equivalent summary + boolean. Server becomes stateless to the App; `getSession/deleteSession` are not on this path.

## Sequencing
Phase 1 builds and tests the full tool surface over stdio (no transport/auth dependency) — fast feedback. Phase 2 adds the remote transport + OAuth + tunnel. Phase 3 wires the App connector and ports the prompt. Phase 4 proves the funnel end-to-end (DoD #5). Phases 2's tasks depend on Phase 1's shared-server refactor; Phase 3 depends on Phase 2; Phase 4 depends on all.

## Non-goals honored
No new pipeline stage (journal/KB writes are existing ingestion inputs). Telegram retained for ambient/pushed flows. Goals tools deferred. Session lifecycle dropped for the App path only.

## Risks
- OAuth surface is the highest-risk seam — single-user scoping must be airtight (token bound to one user id; tunnel forwards only `/mcp`).
- Git-write concurrency: App writes and nightly pipeline both touch the working tree — rely on existing `gitCommitAndPush` main-branch auto-heal; serialize writes within the daemon.
- Reconstruction fidelity for `mode:full` is bounded by App context, not byte-exact — accepted.

## Known Risks

_None yet._

## Next Task Handoff

Start with: Refactor createKBServer() into a shared createRuneMcpServer(opts) factory that registers a configurable tool set on one McpServer instance. Keep the stdio entry (mcp/index.ts) working unchanged and split App-surface tools from kb_* admin tools. No behavior change to existing tools.
