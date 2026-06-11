# Jarvis Conversation Surface on the Claude App — Tasks

In progress. See [spec.md](spec.md) for architecture and [test-plan.md](test-plan.md) for verification.

> **Test-first by default.** Every phase below opens with a **Tests (write first)** block.
> Those tests mirror the matching [test-plan.md](test-plan.md) sections and must fail (red)
> before any implementation task in the phase begins. A phase's implementation is done when
> its test-plan sections pass.
>
> Granularity here is the meaningful deliverable — not a granular sub-task. Per-task file
> layout, schemas, and signatures are settled in `/work`'s Plan phase, against the spec.

## Phase 1 — Core tool surface

> Depends on: nothing.

### Tests (write first)

- [x] Write the test suite for **mcp-server-shared-factory** — test-plan.md §1. (src/mcp/server.test.ts: 8 red factory-contract tests + 3 green admin no-behavior-change pins)
- [x] Write the test suite for **product-routing-fn** — test-plan.md §2. (src/intent/product-routing.test.ts: 13 red resolveProductTarget/product-field tests + 6 green legacy pins)
- [x] Write the test suite for **log-idea-tool** — test-plan.md §3. (src/mcp/tools/log-idea.test.ts: 10 red logIdea handler-contract tests, input shape per tech-spec.md)
- [x] Write the test suite for **log-conversation-tool** — test-plan.md §4. (src/mcp/tools/log-conversation.test.ts: 9 red logConversation handler-contract tests; missing-journal init delegated to journal.test.ts pin)
- [x] Write the test suite for **read-tools-trio** — test-plan.md §5. (src/mcp/tools/read-tools.test.ts: 14 red tests for vaultSearch/crmLookup/getPriorities + shared MCP-shape pin)
- [x] Confirm every suite above fails (red) before starting the implementation blocks. (Verified 2026-06-10: server 8R/3G pins, product-routing 13R/6G pins, log-idea 10R, log-conversation 9R, read-tools 14R — all reds are clean "implementation pending" assertions, zero import crashes)

### Implementation

- [x] **mcp-server-shared-factory** — Refactor `createKBServer()` into a shared `createJarvisMcpServer(opts)` factory that registers a configurable tool set on one `McpServer` instance. Keep the stdio entry (`mcp/index.ts`) working unchanged and split App-surface tools from `kb_*` admin tools. No behavior change to existing tools. (server.test.ts 11/11 green; App tools registered with real schemas + placeholder handlers pending their tasks)
- [x] **product-routing-fn** — Implement `resolveProductTarget()` over the `policies/products.json` known list with explicit-target validation and an explicit inbox/unrouted fallback (never drop, never guess). Extend `ProjectIdea` and the `ideas.md` bullet writer with a `product` field so loop-filed and App-filed ideas share one attribution schema. (src/intent/product-routing.ts + writer/reader round-trip; product-routing.test.ts 19/19 green)
- [x] **log-idea-tool** — Implement the `log_idea` MCP tool (ideas + bugs via `kind`) reusing `resolveProductTarget`, `deriveIdeaId` dedupe, `appendFiledIdeas`, and `gitCommitAndPush`. Returns the filed bullet and resolved product target. (log-idea.test.ts 10/10 green; wired into TOOL_REGISTRY via lazy production deps — vault projects/ideas.md + strict gitCommitAndPushOrThrow)
- [x] **log-conversation-tool** — Implement the `log_conversation` MCP tool (R1): `mode:full` appends the reconstructed transcript to today's journal; `mode:summary` appends one bullet and, when `kb_worthy`, writes to `knowledge/raw/conversations/` and enqueues to the KB. Reuses journal/git/queue/`saveConversationSource` primitives; takes `content` and `kb_worthy` as inputs (no server-side summarization). Returns journal path and KB queue id. (log-conversation.test.ts 9/9 green; wired into TOOL_REGISTRY; saveConversationSource relocated to vault/journal.ts)
- [x] **read-tools-trio** — Implement the three read tools: `vault_search` (over journals/pages/projects), `crm_lookup` (`pages/crm.json`), and `get_priorities` (parse `#priorities` mirroring `/priorities`). All conform to the standard MCP text-content return shape. (read-tools.test.ts 14/14 green; wired into TOOL_REGISTRY; parseTag extracted config-free to vault/journal-parse.ts; searchVault containment-guarded)

## Phase 2 — Remote transport + auth

> Depends on: Phase 1.

### Tests (write first)

- [x] Write the test suite for **streamable-http-transport** — test-plan.md §6. (src/server/mcp-transport.test.ts: 6 red tests — six-tools-only via real SDK client, session persistence, 403 host-gate, route coexistence, opt-in 404, closed-bearer-gate 401)
- [x] Write the test suite for **mcp-oauth-single-user** — test-plan.md §7. (src/server/mcp-oauth.test.ts: 11 red tests — DCR, consent-form POST gate with secret NEVER in a URL, PKCE S256-only, single-use codes, redirect_uri binding, expiry, user binding, RFC 8414 metadata)
- [x] Confirm red before implementation. (Verified 2026-06-10: mcp-transport 6R + mcp-oauth 11R — all 17 are clean "implementation pending" assertions, zero import crashes)

### Implementation

- [x] **streamable-http-transport** — Mount `StreamableHTTPServerTransport` at a new `/mcp` route on the existing daemon HTTP server (`src/server/http.ts`), backed by the shared `createJarvisMcpServer` instance exposing only the six App-surface tools. Handle session/stream setup and conform to existing host-allowlisting. (src/server/mcp-transport.ts; mcp-transport.test.ts 6/6 green; fail-closed bearer default, idle eviction + closeAll teardown)
- [x] **mcp-oauth-single-user** — Implement single-user OAuth 2.1 for the `/mcp` endpoint using the SDK auth helpers (DCR + authorization-code flow), gating authorization on `JARVIS_HTTP_SECRET` and binding issued access tokens to the one known user id. Validate the bearer token on every `/mcp` request before the transport handles it. (src/server/mcp-oauth.ts hand-rolls the minimal flow — the SDK helpers are Express-bound; mcp-oauth.test.ts 11/11 green; daemon mounts /mcp + OAuth when JARVIS_HTTP_SECRET set; consent form shows redirect destination, DCR capped + scheme-validated per security review)
- [x] **remote-tunnel-exposure** (docs/config only) — Stand up a named tunnel exposing only the daemon `/mcp` route at a stable HTTPS hostname, with no inbound ports on the host. Document the tunnel config, secret handling, and recovery/runbook. (DONE 2026-06-10, **Tailscale Funnel** per revised decision: [tunnel-runbook.md](tunnel-runbook.md) with Cloudflare appendix as fallback. Live at `https://jarvis.tail6b86b9.ts.net` — three path mounts only; verified: issuer pinned via MCP_ISSUER_URL ✓, POST /mcp without token → 401 ✓, /api/state + /health → 404 at tailscaled ✓.)

## Phase 3 — App wiring + prompt port

> Depends on: Phase 2.

### Tests (write first)

- [x] _No code-test-required tasks — see per-task strategy in test-plan.md (docs/config only)._

### Implementation

- [x] **app-connector-config** (docs/config only) — Register the remote MCP server as a Claude App custom connector, complete the OAuth handshake, and verify exactly the six tools are discoverable and callable from a thread against the live vault/KB.
- [x] **port-summarization-prompt** (docs/config only) — Port the `summarizeSession` prompt and kb-worthy heuristic verbatim into the Claude App project instructions so the App produces equivalent summary text and a `kb_worthy` boolean, then passes them to `log_conversation`. Document that the session lifecycle drops for the App path (server is stateless to the App). (Copy-paste deliverable: [app-project-instructions.md](app-project-instructions.md) — verbatim prompt + heuristic, mapped to `mode:summary`+`kb_worthy` as the funnel-preserving default with `mode:full` for verbatim capture; documents the stateless/no-session-lifecycle split and the equivalent-not-identical journal-shape tradeoff. Operator pastes it into the App project instructions.)

## Phase 4 — E2E validation

> Depends on: Phase 3.

### Tests (write first)

- [x] _The deliverable itself is a documented, repeatable acceptance test (tests-as-deliverable)._ ([e2e-acceptance-test.md](e2e-acceptance-test.md))

### Implementation

- [x] **e2e-funnel-validation** — End-to-end validation (DoD #5): from a Claude App thread, run read tools against the live vault, capture an idea routed to the correct product target, then `log_conversation` (summary + kb_worthy) and confirm the journal/KB raw-source write lands in the same git history and is picked up by the next nightly KB distillation with no new pipeline stage. Deliver as a documented, repeatable acceptance test. (DONE 2026-06-11: deliverable is [e2e-acceptance-test.md](e2e-acceptance-test.md); connector validated live — read tools (incl. a CRM query) ran against the live vault from a Claude App thread over the Funnel, auth persisted across a restart. The 5-step procedure stands as the repeatable acceptance test for future regression runs.)
