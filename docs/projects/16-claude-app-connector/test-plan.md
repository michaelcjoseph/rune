# Jarvis Conversation Surface on the Claude App Test Plan

Error handling checklist for the six-tool MCP connector, its remote transport/auth,
and the vault → pipeline → KB funnel that must stay intact.

This project is **test-first**: each numbered section below is written by a phase's
**Tests (write first)** task in [tasks.md](tasks.md), and those tests must fail (red)
before that phase's implementation tasks begin. A phase's implementation is done when its
test-plan sections pass.

> See also: [Cross-cutting test plan](../../tech/test-plan.md) for shared guidelines, monitoring, and security checks.

## Priority Levels

- 🔴 **Critical**: Blocks user progress, requires immediate attention
- 🟡 **High**: Degrades experience significantly, should be handled gracefully
- 🟢 **Low**: Non-blocking, can fail silently with logging

## 1. MCP server shared factory

### Factory refactor

- [ ] 🔴 `createJarvisMcpServer(opts)` registers exactly the requested tool set on one `McpServer` instance; the App-surface opts yield the six App tools, the admin opts yield the `kb_*` set.
- [ ] 🔴 The stdio entry (`mcp/index.ts`) keeps working with no behavior change to existing tools — a no-behavior-change test pins the admin tool list and outputs.
- [ ] 🟡 Requesting an unknown tool name in `opts` fails loudly at construction rather than silently registering nothing.

## 2. Product routing function

### resolveProductTarget

- [ ] 🔴 An explicit `product` target that matches `policies/products.json` files the item under that product.
- [ ] 🔴 An explicit `product` target that is unknown is rejected and the item falls back to the explicit inbox/unrouted target — never filed under a non-existent product, never dropped.
- [ ] 🔴 An omitted/unresolved candidate files to the inbox/unrouted target (never guesses a product).
- [ ] 🟡 `ProjectIdea` and the `ideas.md` bullet writer carry a `product` field so loop-filed and App-filed ideas share one attribution schema.
- [ ] 🟢 Products-config read failure degrades to the inbox fallback rather than throwing into the tool call.

## 3. log_idea tool

### Capture + dedupe

- [ ] 🔴 `log_idea` files an idea (and a bug via `kind`) to the resolved product target and returns the filed bullet + resolved target.
- [ ] 🔴 A git commit/push failure surfaces a clear error rather than reporting a phantom filed bullet.
- [ ] 🟡 `deriveIdeaId` dedupe prevents a duplicate bullet when the same content is captured twice.
- [ ] 🟢 A malformed `kind` is rejected with a clear MCP error, no partial write.

## 4. log_conversation tool

### Journal + KB write

- [ ] 🔴 `mode:full` appends the reconstructed transcript to today's journal and returns the journal path.
- [ ] 🔴 `mode:summary` appends a single bullet; with `kb_worthy:true` it also writes to `knowledge/raw/conversations/`, enqueues to the KB, and returns the KB queue id.
- [ ] 🔴 Today's journal file not existing yet is handled — the file is initialized before the append, the write never fails on a missing file.
- [ ] 🔴 An unwritable vault tree or a git commit failure surfaces a clear error; the tool never reports a phantom success.
- [ ] 🟡 A KB enqueue failure after a successful journal write is surfaced distinctly so a partial write is never read as a full success.
- [ ] 🟡 A malformed `mode` or missing `content` is rejected before any vault write.
- [ ] 🟢 The tool performs only the vault-write half (no server-side summarization) — a test asserts no summarization call is made.

## 5. Read tools trio

### vault_search / crm_lookup / get_priorities

- [ ] 🔴 `vault_search` returns matches across journals/pages/projects in the standard MCP text-content shape.
- [ ] 🔴 `crm_lookup` resolves a person/company from `pages/crm.json`.
- [ ] 🔴 `get_priorities` parses `#priorities` and returns today's/this-week's priorities mirroring `/priorities`.
- [ ] 🟡 A missing/empty source file (no `crm.json`, no `#priorities`) returns an empty result gracefully, not an error.
- [ ] 🟢 All three conform to the standard MCP text-content return shape (shared-shape assertion).

## 6. Streamable HTTP transport

### /mcp route

- [ ] 🔴 `StreamableHTTPServerTransport` mounts at `/mcp` on the daemon HTTP server and exposes only the six App-surface tools (the `kb_*` admin tools are not reachable remotely).
- [ ] 🔴 Session/stream setup conforms to the existing host-allowlisting.
- [ ] 🟡 A disallowed host is rejected at the `/mcp` boundary.
- [ ] 🟢 The route coexists with existing daemon HTTP routes without regressing them.

## 7. MCP single-user OAuth

### Auth gate

- [ ] 🔴 A request without a valid bearer token is rejected before the transport handles it.
- [ ] 🔴 An access token bound to a non-Michael user id is rejected; tokens bind to the one known user id.
- [ ] 🔴 Authorization is gated on `JARVIS_HTTP_SECRET` (DCR + authorization-code flow).
- [ ] 🟡 An expired/replayed token is rejected.
- [ ] 🟢 A clear auth-failure response is returned (no tool exposure to an unauthenticated caller).

## 8. E2E funnel validation

### Funnel intact end-to-end (DoD #5)

- [ ] 🔴 From a Claude App thread: read tools run against the live vault, an idea is captured and routed to the correct product target, and `log_conversation` (summary + `kb_worthy`) writes to the journal and KB raw-source queue.
- [ ] 🔴 The journal/KB write lands in the same git history the nightly pipeline reads and is picked up by the next nightly KB distillation with no new pipeline stage.
- [ ] 🟡 The acceptance test is documented and repeatable.
- [ ] 🟢 `/diet`, `/workout`, and Jarvis-pushed updates remain on Telegram and are not exposed to the App.
