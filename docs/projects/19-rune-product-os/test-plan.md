# Rune Product-OS Test Plan

Verification checklist for the Rune Product-OS project: MCP re-architecture, cockpit product-OS reframe, knowledge freshness, and the writing & brand migration.

This project is **test-first**: each numbered section below is written by a phase's
**Tests (write first)** task in [tasks.md](tasks.md), and those tests must fail (red)
before that phase's implementation tasks begin. A phase's implementation is done when its
test-plan sections pass.

> See also: [Cross-cutting test plan](../../tech/test-plan.md) for shared guidelines, monitoring, and security checks.

## Priority Levels

- 🔴 **Critical**: Blocks user progress, requires immediate attention
- 🟡 **High**: Degrades experience significantly, should be handled gracefully
- 🟢 **Low**: Non-blocking, can fail silently with logging

## 1. MCP Standalone Service (W1 Phase 1)

- [ ] 🔴 The MCP runs as a process independent of the cockpit, with its own startup, `/health` service-status endpoint, and graceful teardown.
- [ ] 🔴 *(assertable)* A cockpit (web) restart performs no read/write/delete of the MCP OAuth store file and does not touch the daemon's in-memory session set — the MCP OAuth session is structurally owned by the standalone service. A one-time cutover reauth (old web-store tokens are not migrated to `RUNE_MCP_OAUTH_STORE_FILE`) is expected and documented.
- [ ] 🔴 **(manual/live gate)** With a real Claude App authenticated against the Tailscale hostname, restarting only the Rune web job leaves the Claude App session authenticated with no reauthentication. (Spec "Manual Acceptance Gates" — not an automated assertion.)
- [ ] 🟡 The cockpit talks to the MCP as a separate service; it no longer hosts the MCP in-process.
- [ ] 🟢 MCP service startup/shutdown is logged and observable.
- [ ] 🔴 MCP daemon binds to `127.0.0.1:3848` by default and reads `RUNE_MCP_SECRET`, `RUNE_MCP_ISSUER_URL`, `RUNE_MCP_OAUTH_STORE_FILE`, `RUNE_MCP_HOST`, and `RUNE_MCP_PORT` separately from web auth config.
- [ ] 🔴 `GET /health` returns service status only (daemon up, OAuth configured, active sessions count, warm-index status, last rebuild result, uptime, bounded recent-log tail or log pointers), never pkms content or product functionality.
- [ ] 🔴 Rune web startup succeeds when the MCP daemon is down; cockpit monitoring marks MCP as degraded instead of blocking boot.
- [ ] 🔴 **(manual/live gate)** Integration verification: authenticate Claude App against the MCP Tailscale Funnel hostname, call a MCP tool, restart only the Rune web launchd job, and call the MCP tool again without OAuth reauthentication. Requires the real Claude App + provisioned Funnel hostname (spec "Manual Acceptance Gates"). The assertable proxy — cockpit restart does not touch the MCP OAuth store, and the cockpit loads with degraded monitoring when MCP is stopped — is covered by the automatable rows above.

## 2. Warm Retrieval Core (W1 Phase 2 — `src/kb/vault-index.ts`, cutover)

### Coverage

- [ ] 🔴 Build over a fixture vault indexes every `*.md` under every folder, including `knowledge/` and a peripheral folder (`world-view/`, `career/`); a folder is in scope by existing, with no allow/deny list.
- [ ] 🔴 A new folder or repopulated empty folder is covered on the next build with no code or config change.
- [ ] 🟢 An empty folder is a no-op and stays in scope.

### Read tolerance

- [ ] 🟡 An unreadable markdown file is skipped with a logged reason and the build completes, never aborts.
- [ ] 🟢 Non-markdown files and `.git/` are skipped, preserving the existing deep-search corpus boundary.

### Index integrity & query

- [ ] 🔴 `refreshVaultIndex()` swaps the index atomically; an in-flight query never sees a half-built corpus.
- [ ] 🔴 `queryVaultIndex` returns the `{file,line,content}[]` shape matching `kb/search.ts` `searchVault`.
- [ ] 🟡 Matcher is case-insensitive regex-like per line, with literal-substring fallback on invalid/unsupported patterns.
- [ ] 🟡 `directory` narrows results by top-level folder path prefix; `maxResults` caps the result set.
- [ ] 🟢 Build logs `{files,lines,bytes,heapUsed,buildMs}` on every build.

### Parity & scale (tests as deliverable)

- [ ] 🔴 `ripgrep-parity-harness`: over a committed fixture vault, the real warm index result set is a superset of or equal to real `rg -i --glob '*.md'` at file+line granularity across `knowledge/`, peripheral folders, mixed case, regex metacharacters, and invalid-regex fallback. No stub replaces the index. (See examples/qa.md.)
- [ ] 🟡 `realscale-index-budget-validation`: build over the real vault or a ~72MB markdown fixture completes within the provisional committed budget (default: build < 10s, resident heap < 512MB — falsifiable defaults, tightened to a sane margin above the first measurement), queries use the resident index without per-query walking, and measured numbers are recorded in a checked-in acceptance note.

### Cutover

- [ ] 🔴 A default `vault_search` with no `types` returns hits from `knowledge/` and at least one peripheral folder via the warm index.
- [ ] 🔴 `ALL_SEARCH_TYPES` no longer acts as the default coverage gate; no closed `journals/pages/projects` default remains; no folder include/exclude config exists.
- [ ] 🟡 `types` narrows by top-level folder-name prefix; an unknown value is ignored or returns no matches consistently, never a hidden exclusion.
- [ ] 🟢 The `vault_search` schema is broadened off the closed 3-value enum and the tool description advertises whole-vault markdown search.
- [ ] 🔴 Production `vault_search` is bound to `queryVaultIndex` (`read-tools-deps.ts`); result shape and `maxResults` preserved.
- [ ] 🔴 The resolved `kb_query`/admin-stdio boundary is enforced: a per-session local admin stdio spawn does **not** build or hold the warm index (assert no warm-index build is triggered across the stdio entry/factory/admin `kb_query` load graph) and stays on cold ripgrep; only the long-lived daemon routes daemon-internal broad `kb_query` through `queryVaultIndex` after readiness. Automated pin: `src/mcp/admin-stdio-boundary.test.ts`.
- [ ] 🔴 Startup begins building the index without blocking tools; during initial warmup, daemon `vault_search` and daemon-internal broad `kb_query` fall back to cold ripgrep; after readiness, both use the warm index.
- [ ] 🔴 The background rebuild interval schedules at the configured 15-minute cadence, is unref'd, and tears down cleanly; a failed refresh logs and retains the prior complete index; rebuild cadence default is documented.
- [ ] 🟡 The warm index follows symlinks under the vault root and indexes large markdown files fully.
- [ ] 🟡 A symlink cycle (a symlink pointing at an ancestor directory) is handled by the visited real-path/inode guard — the build terminates and does not index the same file unboundedly.
- [ ] 🟢 The `refresh_vault_index` MCP tool triggers a rebuild and returns readiness/build stats.
- [ ] 🔴 Integration verification: start the MCP daemon against a fixture vault, query before readiness and observe cold fallback, wait for readiness, query again and observe warm-index path, then edit a fixture file and confirm the 15-minute/manual refresh path exposes it.

## 3. Expanded MCP Functions + Metrics (W1 Phase 3)

- [ ] 🔴 `journal_range` returns the journal entries for a given date range from warm state.
- [ ] 🟡 `follow_wikilinks` resolves `[[wikilinks]]` to their target content.
- [ ] 🟡 `tag_date_query` filters the corpus correctly by tag/date.
- [ ] 🔴 The MCP metrics snapshot tool reports total calls, calls by tool, errors by tool, timeouts by tool, p50/p95/p99 latency, active sessions, warm-index readiness, index age, and last rebuild result with a stable, queryable shape.
- [ ] 🟡 A **timeout** is counted when a call exceeds `RUNE_MCP_TOOL_TIMEOUT_MS` (default 30000) and is reflected in both the error and timeout counters for that tool; an **error** is any throwing/tool-error call.
- [ ] 🟡 Latency percentiles are computed over a bounded per-tool ring buffer/reservoir; resident memory does not grow with call volume (no unbounded sample array).
- [ ] 🔴 Metrics reset on MCP process restart.
- [ ] 🟢 New functions are served warm (no per-call cold spawn or full vault walk).
- [ ] 🔴 Integration verification: call the new content tools through a real MCP client, then call `mcp_metrics_snapshot` and verify the tool counters/latency fields reflect those calls.

## 4. Cockpit Product-OS Reframe (W2 Phase 4)

- [ ] 🔴 Each product renders the three containers (projects/ideas/bugs; operations/runs; chat) with product-aware contents.
- [ ] 🟡 Rune MCP weights the operations/runs container heavier; writing shows ideas only (no projects/bugs).
- [ ] 🔴 The roster renders as two classes; internal = Rune, Rune MCP; external = aura, assay, relay, writing, brand.
- [ ] 🟢 Adding a future external product needs no structural change to the container spine.
- [ ] 🔴 `policies/products.json` is the source for `class: internal | external`; registry/cockpit projections copy it without the frontend hardcoding the grouping.
- [ ] 🔴 `rune-mcp`, `writing`, and `brand` are executable products with work-run support; `writing` and `brand` share a repo path while `writing` carries a scoped folder path.
- [ ] 🟡 Product-scoped chat works for shared-repo products and includes the scoped folder when present.
- [ ] 🔴 Integration verification: load cockpit, see internal/external groups, open `rune-mcp`, `writing`, and `brand`, and verify their containers, scoped chat payloads, and empty states.

## 5. Monitoring (W2 Phase 5)

- [ ] 🔴 Internal products (Rune, Rune MCP) show a real monitoring tab fed by live data: MCP call metrics (from the metrics snapshot tool) and Rune orchestration-run metrics.
- [ ] 🔴 The cockpit reads MCP metrics by polling the MCP `mcp_metrics_snapshot` tool, not a shared store or direct log read.
- [ ] 🟡 External products show a stubbed/empty monitoring container; the shape is consistent for later external monitoring.
- [ ] 🟢 Monitoring degrades gracefully when the MCP endpoint is briefly unavailable.
- [ ] 🟡 Polling runs once per second only while the monitoring view is visible and stops when hidden/unmounted.
- [ ] 🔴 Integration verification: open `rune-mcp` monitoring, call a MCP tool, see counters update within roughly one second, stop the MCP daemon, and verify cockpit remains usable with degraded monitoring.

## 5A. Protected Localhost Services (W2 Safety Hardening)

- [ ] 🔴 A single shared contract/module defines the protected services: Rune web at `127.0.0.1:3847` with launchd label `com.jarvis.daemon`, and Rune MCP at `127.0.0.1:3848` with launchd label `com.jarvis.rune-mcp`.
- [ ] 🔴 Coder, QA, tech-lead, and reviewer role instructions/memories include the protected-service invariant: never kill, stop, interrupt, or reuse either protected listener without explicit human approval.
- [ ] 🔴 Runtime product-team prompts include the same protected-service invariant for both Claude and Codex executors, independent of static role-file content.
- [ ] 🔴 Automated tests and test helpers do not bind listeners on `3847` or `3848`; they use port `0` or injected task-local ports. Production-port references are allowed only in config/default assertions, docs, or manual/live acceptance text.
- [ ] 🔴 Rune-owned cleanup helpers refuse to kill a process that owns `3847` or `3848`, or that matches the protected launchd service identity, unless an explicit human approval path is present.
- [ ] 🔴 Regression for the exact outage shape: when a stuck test or cleanup path reports `127.0.0.1:3847` occupied, the system classifies it as protected Rune web and refuses to kill it without approval.
- [ ] 🔴 Equivalent MCP regression: when `127.0.0.1:3848` is occupied, the system classifies it as protected Rune MCP and refuses to kill it without approval.
- [ ] 🟡 Before killing any non-protected process, cleanup logic verifies that the PID was spawned by the current task/worktree/test command; "something is listening on the port" is not enough evidence.
- [ ] 🟡 If Rune web or Rune MCP is down after a work run or monitoring check, cockpit/run telemetry surfaces a degraded/outage state rather than silently killing, reusing, or restarting the service.
- [ ] 🟢 The protected-service warning text is generated from the shared contract so docs, prompts, and guard error messages do not drift.

## 6. Writing & Brand (W4 Phase 6)

- [ ] 🔴 Rune produces both `/rune` and `/rune/{topic}` pages in `michaelcjoseph.com` as a writing-product work run (drafting/publishing shows in the operations/runs container).
- [ ] 🔴 `michaelcjoseph.com` hosts two products: Brand (root single-page app, identity unchanged) and Writing (`/rune` subtree).
- [ ] 🟡 The writing surface shows ideas, draft/publish runs, and scoped chat; no projects/bugs.
- [ ] 🔴 Forward-looking ideas migrate to `michaelcjoseph.com/docs/rune/writing-ideas.md`; historical content stays in pkms.
- [ ] 🔴 `/blog` and `/writing-critique` are Rune commands backed by the specialized writing pipeline.
- [ ] 🟡 `/topics` and `/voice` are confirmed to not exist as Rune commands/resolver destinations (they never did — this is a confirmation, not a removal); topics content comes from the migrated writing-ideas file, and voice guidance is copied into the writing product/pipeline from pkms `writing/voice.md`.
- [ ] 🔴 Writing reads pkms source material only through the MCP (no direct pkms file access from `michaelcjoseph.com`).
- [ ] 🔴 Published-content privacy boundary: a planted private marker placed in a journal source does **not** appear in the committed published artifact; pkms material is synthesized, never copied verbatim.
- [ ] 🔴 Writing branches use `rune-writing/{slug}`; `/blog <topic>` resumes an existing topic branch when present and starts one otherwise.
- [ ] 🔴 Writing operations/runs surface `researching`, `drafting`, `critiquing`, `revising`, `ready-for-review`, `committed`, and `failed`.
- [ ] 🟡 `/writing-critique <target>` writes critique output to `docs/rune/critiques/<target-slug>.md` by default; revisions require explicit user request and stay on the same writing branch.
- [ ] 🔴 V1 publish means committed to the writing branch; no external deployment is required.
- [ ] 🔴 *(assertable)* Integration verification: trigger `/blog`, observe a writing work run reach a terminal state, and verify the resulting `rune-writing/{slug}` branch in `michaelcjoseph.com` contains the `/rune` page, first `/rune/{topic}` page, copied voice guidance, and writing ideas file.
- [ ] 🟡 **(manual/live gate)** The generated prose quality ("Rune describes itself well") is judged manually; it is not an automated assertion. Requires the cross-repo working-directory prerequisite (`~/workspace/michaelcjoseph.com` writable by the agent).

## 7. Knowledge-Freshness Reconciliation (W3 Phase 7)

- [ ] 🔴 A newer source naming a superseded identity (v1 scope: rename / identity-drift class, e.g. Jarvis→Rune) triggers the nightly to flag or supersede the stale curated fact. General free-prose semantic contradiction is out of v1 scope.
- [ ] 🔴 Valid curated facts are not invalidated by the reconciliation pass (conservative heuristic).
- [ ] 🔴 Over-invalidation near-miss: a still-valid curated fact that superficially resembles a supersession candidate (e.g., a legitimate historical reference to the prior identity) is left unchanged.
- [ ] 🟡 The Jarvis→Rune rename drift is reconciled (surviving stale references corrected) as the canonical proof case.
- [ ] 🟢 The reconciliation pass logs what it flagged/superseded for review.
- [ ] 🔴 Reconciliation runs **immediately after the `KB queue` step** (fixed index right after KB queue, ahead of the unrelated Whoop/observation/learning steps and before `KB lint`); `nightly.test.ts` step count and ordered step-name snapshot are updated for the new fixed position.
- [ ] 🔴 Raw journals are never modified; curated pages, including psychology pages, are eligible only when the LLM adjudicator classifies the fact as current-state and clearly superseded.
- [ ] 🔴 Accepted supersessions auto-edit curated pages, append concise inline changelog entries, and append records to `knowledge/supersessions.jsonl`; ambiguous candidates are logged and left unchanged.
- [ ] 🔴 Integration verification: run nightly against a fixture containing a stale curated Jarvis→Rune fact plus raw historical Jarvis journal mentions; verify the curated page changes, raw journal stays byte-identical, the audit log records the edit, and the nightly summary reports the reconciliation step.
