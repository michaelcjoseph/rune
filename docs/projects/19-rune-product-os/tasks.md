# Rune Product-OS — Tasks

Not started. See [spec.md](spec.md) for the workstreams and [test-plan.md](test-plan.md) for verification.

> **Test-first by default.** Every phase below opens with a **Tests (write first)** block.
> Those tests mirror the matching [test-plan.md](test-plan.md) sections and must fail (red)
> before any implementation task in the phase begins. A phase's implementation is done when
> its test-plan sections pass.
>
> Granularity here is the meaningful deliverable — not a granular sub-task. Per-task file
> layout, schemas, and signatures are settled in `/work`'s Plan phase, against the spec.
>
> Phases are ordered by dependency (see spec.md "Build Sequence"). Phase 7 (W3) is
> parallelizable and may run alongside any phase.

## Phase 1 — MCP standalone service (W1)

> Depends on: nothing.

### Tests (write first)

- [ ] Write the suite for **mcp-standalone-lifecycle** — test-plan.md §1: the MCP runs as a process independent of the cockpit; a cockpit restart does not tear down the MCP or its OAuth session; the MCP has its own startup, `/health` status endpoint, and graceful teardown.
- [ ] Write the suite for **mcp-daemon-config** — test-plan.md §1: `RUNE_MCP_SECRET`, `RUNE_MCP_ISSUER_URL`, `RUNE_MCP_OAUTH_STORE_FILE`, `RUNE_MCP_HOST`, and `RUNE_MCP_PORT` are read separately from the web server's `RUNE_HTTP_SECRET` / `MCP_ISSUER_URL`; defaults are `127.0.0.1`, `3848`, and `logs/rune-mcp-oauth-store.json`.
- [ ] Write the suite for **web-starts-with-mcp-degraded** — test-plan.md §1: Rune web startup succeeds when the MCP daemon is unreachable and cockpit state marks MCP monitoring degraded.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **mcp-daemon-entrypoint** — Add a standalone MCP daemon entrypoint (`src/mcp/daemon.ts`) and package script (`npm run mcp:start`) that starts only the MCP service on `RUNE_MCP_HOST:RUNE_MCP_PORT` with Streamable HTTP MCP at `/mcp` and daemon status at `/health`. No Telegram bot, cockpit web routes, scheduler, Whoop OAuth, or Rune webview boot in this process.
- [ ] **mcp-daemon-config** — Add typed config getters/env docs for `RUNE_MCP_SECRET`, `RUNE_MCP_ISSUER_URL`, `RUNE_MCP_OAUTH_STORE_FILE`, `RUNE_MCP_HOST`, and `RUNE_MCP_PORT`; keep web auth on `RUNE_HTTP_SECRET` unchanged.
- [ ] **mcp-oauth-store-split** — Wire the MCP daemon's OAuth consent gate and bearer verification to `RUNE_MCP_SECRET`, issuer metadata to `RUNE_MCP_ISSUER_URL`, and persisted tokens to `RUNE_MCP_OAUTH_STORE_FILE`. Acceptance: deleting `logs/rune-mcp-oauth-store.json` revokes MCP tokens without touching web auth cookies.
- [ ] **remove-web-mcp-mount** — Stop mounting `/mcp` from the Rune web server. The web server no longer owns MCP sessions or OAuth state; Claude App connects directly to `127.0.0.1:3848` via Tailscale Funnel.
- [ ] **mcp-health-status-endpoint** — Add `GET /health` to the MCP daemon for process/service status only: daemon up, OAuth configured, active sessions count, warm-index status, last index rebuild result, uptime, and bounded recent-log tail or log pointers. Do not expose pkms content or product functions through this endpoint.
- [ ] **web-starts-with-mcp-degraded** — Add a small MCP availability reader for cockpit state using the MCP daemon `/health` endpoint. Use a short connect timeout (non-blocking; a hung daemon must not slow web boot) and treat any error/timeout as "degraded." If MCP is down or unauthenticated, Rune web startup still succeeds and monitoring surfaces a degraded MCP state instead of failing boot.
- [ ] **launchd-plist-and-install** — Produce the second launchd job (`com.jarvis.rune-mcp`) plist with working directory, command (`npm run mcp:start`), env expectations, and stdout/stderr log paths, plus an install script (`launchctl bootstrap`/`kickstart`/`bootout`). The plist + script are agent-deliverable and lint-checkable; the actual `bootstrap` of a live service and confirming it survives a cockpit restart is a **manual/live gate** (see spec "Manual Acceptance Gates").
- [ ] **launchd-runbook** — Document the launchd job: working directory, command, env expectations, logs, bootstrap/kickstart commands, and the Tailscale Funnel mapping to `127.0.0.1:3848`. Note that the final Funnel hostname is a human prerequisite supplied to `RUNE_MCP_ISSUER_URL`.
- [ ] **reauth-store-ownership** *(assertable)* — Ensure the MCP OAuth session/token store is owned solely by the standalone service (`RUNE_MCP_OAUTH_STORE_FILE`), not the web server. Assertable acceptance: a cockpit (web) restart performs no read/write/delete of the MCP OAuth store file, and the daemon's in-memory session set is untouched by web lifecycle. Document the expected one-time cutover reauth (old web store tokens are not migrated).
- [ ] **user-reachability-check** *(assertable half)* — Stop the MCP daemon and confirm the cockpit still loads with a degraded monitoring state; restart only Rune web and confirm the MCP daemon process and its OAuth store file are unaffected. The live half — authenticating a real Claude App against the Tailscale hostname and confirming the session survives a web restart with no reauth — is a **manual/live gate**, not an automatable task.

## Phase 2 — Warm retrieval core (W1)

> Depends on: Phase 1. (Carried forward from the prior warm-index project; see examples/qa.md for parity/acceptance intent.)

### Tests (write first)

- [ ] Write the unit suite for **warm-vault-index-core** — test-plan.md §2: all-folder markdown coverage including `knowledge/` and a peripheral folder, empty-folder no-op, unreadable-file tolerance, atomic swap during refresh, regex/literal matching, path-prefix filtering, `maxResults`, and the `{file,line,content}` shape.
- [ ] Write the suite for **vault-search-fullcoverage-cutover** — test-plan.md §2: default query returns hits from `knowledge/` and a peripheral folder; `types` narrows; unknown types do not act as hidden exclusions; no include/exclude config exists; the tool description advertises whole-vault markdown coverage.
- [ ] Write the tests/docs for **kb-query-path-decision** — test-plan.md §2, asserting the **resolved** admin-stdio boundary (spec "Resolved `kb_query`/admin-stdio boundary"): per-session local admin stdio stays on cold ripgrep and does not build the warm index; only the long-lived daemon holds warm state. Assert no warm-index build is triggered by an admin-stdio spawn.
- [ ] Write the suite for **warm-index-fallback-and-cadence** — test-plan.md §2: startup builds in background; `vault_search` and daemon-internal broad `kb_query` fall back to cold ripgrep until ready; refresh runs every 15 minutes; symlinks are followed and a symlink cycle terminates via the visited real-path guard; large markdown files are indexed fully; `refresh_vault_index` reports readiness/build stats.
- [ ] Confirm every suite above fails (red) before implementation.

### Implementation

- [ ] **warm-vault-index-core** — Build the resident warm-index module (`src/kb/vault-index.ts`): walk the entire vault root for every `*.md` under every folder with NO folder allow/deny list (a folder is in scope by existing); skip `.git/` and non-markdown files; read best-effort (skip unreadable files with a logged reason, never abort); hold the corpus resident as a flat line index built once and swapped atomically; intern/share the vault-relative path across all lines of a file; expose `buildVaultIndex()`/`refreshVaultIndex()` and `queryVaultIndex(query, {directory?, maxResults?})` returning the `{file,line,content}[]` shape of `kb/search.ts` `searchVault`; use case-insensitive regex-like per-line matching with literal-substring fallback; log `{files,lines,bytes,heapUsed,buildMs}` at each build.
- [ ] **ripgrep-parity-harness** — Deliver the non-regression harness over a committed fixture vault (`knowledge/`, `journals/`, and at least two peripheral folders): run real ripgrep (`rg -i --glob '*.md'` over the vault root) and the real warm index for a representative query set, then assert the index result set is a superset of or equal to ripgrep's at file+line granularity after normalizing paths and line numbers. Cover `knowledge/`, peripheral folders, mixed case, regex metacharacters, and invalid/unsupported regex fallback. Build a real index and shell real ripgrep; no stub may replace the index.
- [ ] **realscale-index-budget-validation** — Validate the warm index at real-vault scale (real vault when available, or a generated ~72MB markdown fixture dominated by a `knowledge/`-scale folder): assert full build completes within a **provisional documented budget** (start with: build < 10s for ~72MB, resident heap < 512MB; these are falsifiable defaults to be tightened against the first measured numbers, not "whatever we measure"), subsequent queries use the resident index without per-query walking, and the build log reports actual `{files,lines,bytes,heapUsed,buildMs}`. Record measured numbers in a checked-in acceptance note and adjust the committed thresholds to a sane margin above the measurement.
- [ ] **vault-search-fullcoverage-cutover** — Withdraw the carve-out and back the standalone service's deep search with the warm index. `read-tools.ts`: remove `ALL_SEARCH_TYPES` as the default coverage gate; default no-types search queries the entire warm index; keep `types` only as optional narrowing by top-level folder-name prefixes, unknown values ignored consistently. `mcp/server.ts`: broaden the `types` schema off the closed 3-value enum and update the tool description/parameter docs. `read-tools-deps.ts`: bind production `vault_search` to `queryVaultIndex`. Preserve result shape and `maxResults`.
- [ ] **kb-query-warm-daemon-route** — Route daemon-internal broad `kb_query` retrieval through `queryVaultIndex` after readiness, with cold ripgrep fallback until the first index is ready. Per the resolved boundary, the per-session local admin stdio server stays on cold ripgrep and never builds the warm index; only the long-lived daemon holds warm state.
- [ ] **daemon-warm-index-lifecycle** — Wire the warm index into the standalone service next to `initKB()`: build on startup without blocking tool availability; schedule a 15-minute full-rebuild interval; unref the timer; follow symlinks **with a visited real-path/inode guard so symlink cycles cannot cause a non-terminating or unbounded walk**; index large markdown files fully; on rebuild failure log and retain the prior complete index; expose teardown to stop the timer cleanly during shutdown/tests. No per-folder exclusion mechanism.
- [ ] **refresh-vault-index-tool** — Add the admin-only MCP tool `refresh_vault_index` to request a warm-index refresh and report readiness/build stats, so writing workflows can force freshness after large source updates without waiting 15 minutes.

## Phase 3 — Expanded MCP functions + metrics snapshot (W1)

> Depends on: Phase 2.

### Tests (write first)

- [ ] Write the suite for **mcp-content-functions** — test-plan.md §3: journal-range pulls return entries for a date range; link-following resolves `[[wikilinks]]`; tag/date queries filter correctly.
- [ ] Write the suite for **mcp-metrics-snapshot-tool** — test-plan.md §3: the MCP metrics snapshot tool reports total calls, calls/errors/timeouts by tool, p50/p95/p99 latency, active sessions, warm-index readiness/age, and last rebuild result; shape is stable and queryable; counters reset on process restart.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **mcp-journal-range-tool** — Add the MCP tool `journal_range` that returns journal entries for an inclusive date range from warm state when ready, with cold fallback only while warming. Define input schema, output shape, max range/default cap, missing-day behavior, and sanitized errors.
- [ ] **mcp-wikilink-follow-tool** — Add the MCP tool `follow_wikilinks` that resolves `[[wikilinks]]` from a source file or text snippet to target vault content, bounded by depth/result limits and served from the warm corpus.
- [ ] **mcp-tag-date-query-tool** — Add the MCP tool `tag_date_query` that filters markdown content by tag and/or date range using warm index metadata, with stable result shape and caps.
- [ ] **mcp-metrics-instrumentation** — Wrap all MCP tool calls in metrics collection for total calls, calls/errors/timeouts by tool, latency samples, and active sessions. Define a **timeout** as a call exceeding the configured per-call ceiling (`RUNE_MCP_TOOL_TIMEOUT_MS`, default 30000), counted as both an error and a timeout for that tool; an **error** is any call that throws or returns a tool-error result. Latency percentiles (p50/p95/p99) are computed over a **bounded per-tool ring buffer / reservoir** (fixed sample window), never an unbounded array, so resident memory cannot grow with call volume in the long-lived process. Metrics live in memory and reset on MCP restart.
- [ ] **mcp-metrics-snapshot-tool** — Add the MCP tool `mcp_metrics_snapshot` returning live metrics plus warm-index readiness/age/last rebuild result. No vault reads, no LLM calls, no separate metrics HTTP endpoint.
- [ ] **docs-tool-contracts** — Document all new MCP tool names, schemas, caps, and error behavior in architecture/config docs.

## Phase 4 — Cockpit product-aware containers + internal/external line (W2)

> Depends on: Phase 1.

### Tests (write first)

- [ ] Write the suite for **product-os-containers** — test-plan.md §4: each product renders the three containers with product-aware contents; Rune MCP weights operations/runs heavier; writing shows ideas only (no projects/bugs).
- [ ] Write the suite for **internal-external-distinction** — test-plan.md §4: the roster renders as two classes; Rune and Rune MCP are internal; aura/assay/relay/writing/brand are external.
- [ ] Write the suite for **product-policy-schema** — test-plan.md §4: `policies/products.json` accepts `class`, optional `scopePath`, and executable entries for `rune-mcp`, `writing`, and `brand`; registry copies product class into cockpit projections.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **product-policy-schema** — Extend `policies/products.json` parsing/types with `class: "internal" | "external"` and optional `scopePath` for products sharing a repo. In **this phase**, add the **class/scope/projection metadata only** for `rune-mcp`, `writing`, and `brand` (enough for the cockpit to render the roster and containers). The **execution metadata** for `writing`/`brand` (repoPath, baseBranch, credentialsFile, egressAllowlist, validation commands, work-run support) is added in Phase 6 `michaelcjoseph-product-config` — the two tasks are complementary edits to the same entries, not a redo. `writing` and `brand` share the `michaelcjoseph.com` repo path, with `writing.scopePath` pointing at the writing subtree.
- [ ] **registry-product-class** — Extend registry source scanning and `buildRegistry` so product class and optional scope path are copied from policy config into `logs/registry.json`; keep registry rebuildable and tolerant of products with zero projects.
- [ ] **product-os-api-projection** — Extend cockpit/product-deep-view API payloads with product class and container capabilities so the frontend does not infer behavior from hardcoded product names except for intentional layout weighting.
- [ ] **internal-external-distinction** — Add the top-level internal/external distinction to the cockpit and register the full product roster (internal: `rune`, `rune-mcp`; external: `aura`, `assay`, `relay`, `writing`, `brand`).
- [ ] **product-os-containers** — Make the existing three containers fill from each product's context. `rune-mcp` shows projects/ideas/bugs but emphasizes operations/runs; `writing` reads ideas from `docs/rune/writing-ideas.md` and does not render bugs as a primary workflow; `brand` uses the standard containers over the site root.
- [ ] **product-scoped-chat** — Ensure cockpit chat scope works for `rune-mcp`, `writing`, and `brand`, including shared-repo products where `scopePath` constrains repo context.
- [ ] **frontend-empty-states** — Add explicit empty/degraded states for products with no projects, no ideas, unavailable repo, or unavailable MCP service; no blank panels.
- [ ] **user-reachability-check** — Open cockpit, see Internal and External groups, open each new product, verify the expected containers and scoped chat payload.

## Phase 5 — Monitoring (W2)

> Depends on: Phase 3 (metrics snapshot tool), Phase 4 (product surfaces).

### Tests (write first)

- [ ] Write the suite for **monitoring-internal-only** — test-plan.md §5: internal products show a real monitoring tab fed by live data; external products show a stubbed/empty monitoring container; the cockpit reads MCP metrics from the MCP metrics snapshot tool.
- [ ] Write the suite for **monitoring-polling-lifecycle** — test-plan.md §5: cockpit polls `mcp_metrics_snapshot` once per second only while the monitoring view is visible; polling stops on hidden/unmounted views; unavailable MCP renders degraded state.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **monitoring-api-adapter** — Add a Rune web adapter that calls the MCP daemon's `mcp_metrics_snapshot` tool and maps failures to a degraded monitoring state. Do not read a shared metrics store.
- [ ] **rune-run-metrics-adapter** — Define and implement Rune orchestration-run metrics from existing work-run/supervision stores (for example running count, parked count, terminal outcomes, recent failures, p95 runtime where available).
- [ ] **monitoring-tab** — Add the monitoring surface. Internal products render MCP call metrics and Rune orchestration-run metrics. External products render a stubbed/empty monitoring container with consistent shape.
- [ ] **monitoring-polling-lifecycle** — Poll once per second while the monitoring view is visible; stop polling when hidden/unmounted; show last-updated time and degraded state when MCP is unreachable.
- [ ] **user-reachability-check** — With MCP running, open `rune-mcp` monitoring and watch counters change after an MCP tool call; stop MCP and verify cockpit remains usable with degraded monitoring.

## Phase 6 — Writing & Brand surfaces + migration (W4) — EXTRACTED

> **Extracted 2026-06-29 to its own project:** `michaelcjoseph.com`
> `docs/projects/01-rune-writing-product`. Phase 6's deliverables live in the
> `michaelcjoseph.com` repo, which a `rune`-scoped orchestrated run cannot write to
> (single-repo worktree). The original run silently false-completed this phase by
> committing assertion tests against the empty target; see `docs/projects/bugs.md`.
> The writing product is planned and tracked in that repo's project now, including the
> rune-side engine work (writer pipeline, `/blog` + `/writing-critique`, products.json,
> cockpit surfaces) as its Phase A dependency. Do not re-run Phase 6 from this project.

## Phase 7 — Knowledge-freshness reconciliation (W3)

> Depends on: nothing (parallelizable). Lives in the Rune nightly curation step, not in MCP/cockpit/writing.

### Tests (write first)

- [ ] Write the suite for **knowledge-supersession** — test-plan.md §7: a newer journal entry that contradicts a curated fact triggers the nightly to flag/supersede the stale fact; the Jarvis→Rune drift case is reconciled; and a **near-miss negative case** (a still-valid curated fact that superficially resembles a supersession candidate — e.g., a legitimate historical reference to the prior identity) is left unchanged.
- [ ] Write the suite for **nightly-reconciliation-wiring** — test-plan.md §7: reconciliation runs **immediately after the `KB queue` step** (step index right after KB queue, currently step 11, ahead of the unrelated Whoop/observation/learning steps and before `KB lint`); nightly step count and ordered step-name snapshots are updated for the new fixed position; narrow child-process mocks still import the module.
- [ ] Write the suite for **supersession-audit** — test-plan.md §7: each auto-edit writes an inline changelog entry and appends a `knowledge/supersessions.jsonl` record; ambiguous candidates are logged but not edited; raw journals are never modified.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **supersession-candidate-finder** — Build the deterministic candidate finder for the **rename / identity-drift class** (v1 scope per spec): identify curated facts that name a superseded identity via token/alias matching against a known supersession term (canonical case: "Jarvis" → "Rune"). General free-prose semantic contradiction is explicitly out of v1 scope. It must ignore raw journals as edit targets.
- [ ] **supersession-llm-adjudicator** — Add conservative LLM adjudication that confirms a candidate **already surfaced by the deterministic finder** is a current-state fact and clearly superseded (it does not discover contradictions on its own). Only clear supersessions auto-edit; ambiguous cases are logged and left unchanged. Must pass an over-invalidation near-miss: a curated fact that superficially resembles a candidate but is still valid (e.g., a legitimate historical reference naming the prior identity) is left unchanged.
- [ ] **supersession-auto-editor** — Apply accepted supersessions to curated pages, append a concise inline changelog entry, and append a machine-readable record to `knowledge/supersessions.jsonl`.
- [ ] **nightly-reconciliation-pass** — Wire the reconciliation step after `KB queue` and before `KB lint`; update `nightly.test.ts` step-count + ordered step-name snapshot and check `nightly.nosleep.test.ts`'s narrow `node:child_process` mock.
- [ ] **pkms-instructions-rename** — Update pkms `CLAUDE.md` and `AGENTS.md` from Jarvis to Rune in the current instruction sections. Do not rewrite raw journals.
- [ ] **jarvis-rune-drift-reconcile** — Use remaining curated-page Jarvis→Rune drift as the canonical fixture for the reconciliation mechanism; psychology pages are eligible only when adjudicated as current-state facts, not historical references.
- [ ] **user-reachability-check** — Run nightly with a fixture contradiction and observe the summary step, edited curated page, inline changelog, and `knowledge/supersessions.jsonl` audit record.
