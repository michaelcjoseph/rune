# Rune Conversation Surface on the Claude App — Specification

## Overview

The conversation surface was never the moat. Claude is the brain, and the
defensible asset is the capture-and-compound funnel: everything Michael says
lands in one git-versioned vault that the nightly pipeline distills into the KB.
This project makes the chat surface portable into the Claude App while leaving
the funnel entirely owned by Rune and unchanged.

Today general and dev chat run through a custom Telegram conversation layer.
Rune's own KB engine, vault primitives, and nightly ingestion pipeline already
exist. This project exposes a small, deliberately lean MCP tool surface as a
Claude App connector so the App can read the live vault/KB mid-thread and write a
finished conversation back into today's journal (and, when worthy, into the KB
raw-source queue). The end state is dual-surface: the App becomes a first-class
chat surface for general and dev work, while Telegram keeps ambient quick-capture
and everything Rune pushes.

### Core Value Proposition

Make the Rune chat surface portable into the Claude App through a six-tool MCP
connector, at zero cost to the vault → pipeline → KB funnel that Rune still
fully owns.

### Goals

1. **Primary:** General and dev chat can happen in a Claude App thread instead of
   the custom Telegram conversation layer, with Rune's vault/KB read
   capabilities reachable mid-thread through an MCP connector.
2. **Secondary:** A conversation can be written back into today's journal (summary
   or full reconstruction) and, when kb-worthy, into the KB raw-source queue, all
   through the connector, with the nightly pipeline ingesting it unchanged.
3. **Tertiary:** Captured ideas and bugs are attributed to the correct product
   target via a routing function that never silently drops or mis-attributes an
   item.

### Non-Goals

- **Retiring Telegram.** It keeps ambient quick-capture (`/diet`, `/workout`) and
  everything Rune pushes (`/work` run updates, cron). The App is request-response
  and cannot initiate.
- **Reviews.** They stay server-orchestrated and skill-defined.
- **Nightly ingestion pipeline changes.** No new pipeline stage is introduced. The
  journal is already an ingestion input.
- **Goals tools** (`get_weekly_goals`, etc.). Deferred. No structured source of
  truth exists yet.
- **Cockpit redesign.** A separate workstream.
- **Verbatim transcripts in the App.** `mode:full` becomes a faithful
  reconstruction, not a byte-exact transcript, because no transcript file exists
  for the tool to read. Accepted tradeoff.

---

## User Journey

### Happy Path

```
Open Claude App thread → ask domain questions (kb_query / vault_search)
              ↓
        capture idea/bug (log_idea, routed to product) · crm_lookup · get_priorities
              ↓
        end thread → log_conversation (summary or full, kb_worthy?)
              ↓
        journal (+ KB raw-source queue) write lands in git
              ↓
        next nightly KB distillation picks it up, no new stage
```

1. **Entry point** — Michael opens a thread in the Claude App with the Rune
   connector enabled and asks a general or dev question.
2. **Mid-thread tools** — Claude calls `kb_query` and `vault_search` against the
   live vault/KB, captures ideas or bugs via `log_idea` (routed to a product
   target), and runs `crm_lookup` / `get_priorities` as needed.
3. **Outcome** — At the end of the thread Claude calls `log_conversation` to write
   the conversation into today's journal (summary or full), flagging kb-worthiness
   so the content also reaches the KB raw-source queue. The nightly pipeline
   ingests it unchanged.

### Entry Points

- A Claude App custom connector pointed at the remote MCP endpoint, authenticated
  as the single known user (Michael).

### Exit Points

- Today's journal in the live vault working tree (always), and
  `knowledge/raw/conversations/` plus the KB ingestion queue (when kb-worthy).
- The custom Telegram conversation layer remains available but is no longer the
  required surface for general/dev chat.

---

## Requirements

### log_conversation (R1)

1. WHEN `log_conversation` is called with `mode:full` THEN the supplied
   reconstructed transcript `content` is appended to today's journal (maps to
   `/fresh-full`).
2. WHEN `log_conversation` is called with `mode:summary` THEN the one-line
   `content` summary is appended as a single journal bullet (maps to `/fresh`).
3. WHEN `mode:summary` and `kb_worthy` is true THEN the content is additionally
   written to `knowledge/raw/conversations/` and enqueued to the KB.
4. WHEN the write completes THEN the tool returns confirmation of what was written
   (journal path, and KB queue id when enqueued).
5. WHEN the tool runs THEN it performs only the vault-write half. The judgment of
   summary text and kb-worthiness is the App Claude's job (server-side
   summarization moves into the App's project instructions).

### Mid-thread tool surface (R2)

6. WHEN the connector is registered THEN exactly six tools are exposed:
   `kb_query`, `vault_search`, `log_idea`, `crm_lookup`, `get_priorities`,
   `log_conversation`.
7. WHEN a tool returns THEN it conforms to the standard MCP text-content return
   shape.
8. WHEN ambient/health commands (`/diet`, `/workout`) or Rune-pushed updates are
   considered THEN they stay Telegram-only and are NOT exposed to the App.
9. WHEN `kb_query` is called THEN it reuses the existing KB query against the live
   KB (no re-implementation).

### Idea/bug routing (R3)

10. WHEN `log_idea` is called with an explicit `product` target THEN the target is
    validated against Rune's known product list (`policies/products.json`) and
    the item is filed there.
11. WHEN `product` is omitted THEN conversational Claude in the App infers the
    intended product from thread context and passes it; the routing function
    resolves the candidate against the known product list.
12. WHEN no confident target resolves THEN the item is filed to an explicit
    unrouted/inbox target that surfaces for later triage. It is never silently
    dropped or mis-attributed.
13. WHEN an idea is filed (App-filed or loop-filed) THEN it carries a `product`
    field so both share one attribution schema.

### Connector wiring + transport/auth (R4)

14. WHEN the Claude App connects THEN it reaches the MCP server over a remotely
    reachable HTTP transport (Streamable HTTP), not stdio.
15. WHEN any request hits the MCP endpoint THEN it is gated to a single-user secure
    connection that only Michael can use.
16. WHEN a tool reads or writes THEN it operates on the live vault working tree so
    writes land in the same git history the nightly pipeline reads.

### Summarization prompt port (R5)

17. WHEN the App produces a summary THEN it uses the ported `summarizeSession`
    prompt and kb-worthy heuristic (moved into the App project instructions) so
    summaries and kb-worthiness judgments are equivalent to today's server-side
    behavior.
18. WHEN the App path runs THEN the server session lifecycle (`getSession` /
    `deleteSession`) drops away. The server is stateless to the App.

---

## Technical Implementation

### MCP server factory

The existing `src/mcp/server.ts` builds a KB-tool MCP server consumed locally over
`StdioServerTransport` (entry `src/mcp/index.ts`). This project refactors
`createKBServer()` into a shared `createRuneMcpServer(opts)` factory that
registers a configurable tool set on one `McpServer` instance. The stdio entry
keeps working unchanged. App-surface tools are split from the `kb_*` admin tools so
the remote endpoint can expose exactly the six App tools while the local stdio
endpoint keeps its admin set.

### Tools

- **`log_conversation`** — reuses `vault/journal.ts`, `vault/git.ts`,
  `vault/files.ts`, `kb/queue.ts`, and `saveConversationSource`. Inputs: `mode`
  (`full` | `summary`), `content` (string), `kb_worthy` (boolean, optional,
  default false). Pure vault-writer: no server-side summarization.
- **`log_idea`** — handles ideas and bugs via a `kind` discriminator. Reuses
  `resolveProductTarget`, `deriveIdeaId` dedupe, `appendFiledIdeas`, and the git
  commit/push helpers. Returns the filed bullet and the resolved product target.
- **`vault_search`** — search across vault content (journals, pages, projects).
- **`crm_lookup`** — look up a person/company from `pages/crm.json`.
- **`get_priorities`** — return today's/this-week's priorities, parsing
  `#priorities` mirroring the `/priorities` command.
- **`kb_query`** — the existing KB query tool, re-registered through the factory.

### Product routing

`resolveProductTarget()` validates an explicit target against the known product
list in `policies/products.json`, infers nothing on its own (inference is the App
Claude's job), and falls back to an explicit inbox/unrouted target when no
confident match resolves. `ProjectIdea` and the `ideas.md` bullet writer gain a
`product` field so loop-filed and App-filed ideas share one attribution schema.

### Remote transport + auth

`StreamableHTTPServerTransport` mounts at a new `/mcp` route on the existing daemon
HTTP server (`src/server/http.ts`), backed by the shared
`createRuneMcpServer` instance exposing only the six App-surface tools and
conforming to the existing host-allowlisting. Single-user OAuth 2.1 (DCR plus
authorization-code flow via the SDK auth helpers) gates the endpoint on
`RUNE_HTTP_SECRET` and binds issued access tokens to the one known user id;
every `/mcp` request validates its bearer token before the transport handles it. A
named Cloudflare Tunnel exposes only the `/mcp` route at a stable HTTPS hostname
with TLS at the edge and no inbound ports on the host.

> The exact transport/host/auth mechanism is the tech lead's architectural fork
> (topic B). The product constraints are fixed: a single-user secure connection
> that only Michael can use, and live-vault read/write into the same git history
> the pipeline reads. The implementation above is the planned resolution.

### App wiring + prompt port

The remote MCP server is registered as a Claude App custom connector; the OAuth
handshake completes and exactly the six tools are discoverable and callable. The
`summarizeSession` prompt and kb-worthy heuristic are ported verbatim into the
App's project instructions so the App produces equivalent summary text and a
`kb_worthy` boolean and passes them to `log_conversation`.

---

## Implementation Phases

> The phase-by-phase task breakdown lives in [tasks.md](tasks.md) and the
> verification checklist in [test-plan.md](test-plan.md); both follow the phase
> structure below. The project is built **test-first** — every phase in tasks.md
> opens with a **Tests (write first)** block whose tests must fail (red) before
> that phase's implementation begins, and a phase is done when its test-plan
> sections pass.

### Phase 1: Core tool surface

- [ ] Refactor `createKBServer()` into a shared `createRuneMcpServer(opts)`
      factory; keep the stdio entry working; split App-surface from `kb_*` tools.
- [ ] Implement `resolveProductTarget()` with explicit-target validation and an
      explicit inbox/unrouted fallback; add a `product` field to `ProjectIdea` and
      the `ideas.md` bullet writer.
- [ ] Implement the `log_idea` tool (ideas + bugs via `kind`).
- [ ] Implement the `log_conversation` tool (R1).
- [ ] Implement the read-tools trio: `vault_search`, `crm_lookup`,
      `get_priorities`.

### Phase 2: Remote transport + auth

> Depends on: Phase 1

- [ ] Mount `StreamableHTTPServerTransport` at `/mcp` on the daemon HTTP server,
      exposing only the six App-surface tools.
- [ ] Implement single-user OAuth 2.1 for `/mcp` (DCR + authorization-code,
      gated on `RUNE_HTTP_SECRET`, bearer-validated per request).
- [ ] Stand up a named Cloudflare Tunnel exposing only `/mcp` at a stable HTTPS
      hostname; document config, secret handling, and runbook.

### Phase 3: App wiring + prompt port

> Depends on: Phase 2

- [ ] Register the remote MCP server as a Claude App custom connector; complete
      the OAuth handshake; verify exactly six tools are discoverable and callable.
- [ ] Port the `summarizeSession` prompt and kb-worthy heuristic into the App
      project instructions; document that the session lifecycle drops for the App
      path.

### Phase 4: E2E validation

> Depends on: Phase 3

- [ ] Documented, repeatable acceptance test: from a Claude App thread, run read
      tools, capture a routed idea, `log_conversation` (summary + kb_worthy), and
      confirm the journal/KB write lands in git and is picked up by the next
      nightly KB distillation with no new pipeline stage.

---

## Success Metrics

### Core KPIs

| Metric | Target | How Measured |
| ------ | ------ | ------------ |
| App connector tools live | Exactly 6 discoverable + callable | Claude App connector tool list against the live endpoint |
| Funnel intact end-to-end | A thread logged from the App appears in the next nightly KB distillation | E2E acceptance test (DoD #5) |
| Routing correctness | 0 silently-dropped or mis-attributed captures | Routing-function tests + inbox fallback inspection |
| Surface portability | General/dev chat no longer requires Telegram | Dual-surface usage in production |

---

## Edge Cases & Error Handling

### Vault writes

- 🔴 Journal file for today does not exist yet — the tool initializes it before
  appending (reuses existing journal primitives), never fails the write.
- 🔴 Vault working tree is unwritable or the git commit fails — the tool surfaces a
  clear error rather than reporting a phantom success; the conversation is not
  lost from the thread.
- 🟡 KB enqueue fails after the journal write succeeds — the journal write is
  reported as done and the queue failure is surfaced distinctly so a partial write
  is never read as a full success.

### Routing

- 🔴 Explicit `product` target is unknown — reject the invalid target and fall back
  to the inbox/unrouted target rather than filing under a non-existent product.
- 🟡 Inferred candidate does not confidently resolve — file to the explicit
  inbox/unrouted target for later triage.
- 🟢 Duplicate idea content — `deriveIdeaId` dedupe prevents a second bullet.

### Transport + auth

- 🔴 A request without a valid bearer token reaches `/mcp` — reject before the
  transport handles it; never expose tools to an unauthenticated caller.
- 🔴 A non-Michael user id presents a token — reject; tokens are bound to the one
  known user id.
- 🟡 The Cloudflare Tunnel is down — the App connector reports unreachable; no
  inbound host port is ever opened as a fallback.

### Tool surface

- 🟡 A malformed tool input (bad `mode`, missing `content`) — validated and
  rejected with a clear MCP error, no partial vault write.
- 🟢 The stdio admin path must keep working unchanged after the factory refactor —
  covered by a no-behavior-change test.

---

## Open Questions

- [ ] Final tool count and exact signatures (inputs/outputs/types) for the six
      App-exposed tools — confirmed in discussion topic A.
- [ ] Whether bug capture is `log_idea` generalizing to ideas+bugs via `kind` or a
      thin sibling tool, without expanding the exposed count beyond six.
- [ ] Exact resolution mechanism for the routing function (relates to the
      expand-cockpit-fix-autorun product-attribution problem) — finalized in topic A.
- [ ] Transport/host/auth specifics — the tech lead's architectural fork (topic B);
      the product constraints are fixed (single-user secure, live-vault read/write).
