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

- [ ] Write the suite for **mcp-standalone-lifecycle** — test-plan.md §1: the MCP runs as a process independent of the cockpit; a cockpit restart does not tear down the MCP or its OAuth session; the MCP has its own startup/health/teardown.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **mcp-standalone-service** — Extract the MCP server out of the cockpit process into a standalone, long-lived service with its own lifecycle (startup, health, graceful teardown). The cockpit no longer hosts the MCP; it talks to the separate service.
- [ ] **reauth-survives-cockpit-restart** — Ensure the MCP OAuth session is owned by the standalone service so a cockpit restart leaves the Claude App authenticated. Acceptance: restart the cockpit, confirm the Claude App MCP session survives with no reauthentication.

## Phase 2 — Warm retrieval core (W1)

> Depends on: Phase 1. (Carried forward from the prior warm-index project; see examples/qa.md for parity/acceptance intent.)

### Tests (write first)

- [ ] Write the unit suite for **warm-vault-index-core** — test-plan.md §2: all-folder markdown coverage including `knowledge/` and a peripheral folder, empty-folder no-op, unreadable-file tolerance, atomic swap during refresh, regex/literal matching, path-prefix filtering, `maxResults`, and the `{file,line,content}` shape.
- [ ] Write the suite for **vault-search-fullcoverage-cutover** — test-plan.md §2: default query returns hits from `knowledge/` and a peripheral folder; `types` narrows; unknown types do not act as hidden exclusions; no include/exclude config exists; the tool description advertises whole-vault markdown coverage.
- [ ] Write the tests/docs for **kb-query-path-decision** — test-plan.md §2, matching the chosen admin-stdio boundary.
- [ ] Confirm every suite above fails (red) before implementation.

### Implementation

- [ ] **warm-vault-index-core** — Build the resident warm-index module (`src/kb/vault-index.ts`): walk the entire vault root for every `*.md` under every folder with NO folder allow/deny list (a folder is in scope by existing); skip `.git/` and non-markdown files; read best-effort (skip unreadable files with a logged reason, never abort); hold the corpus resident as a flat line index built once and swapped atomically; intern/share the vault-relative path across all lines of a file; expose `buildVaultIndex()`/`refreshVaultIndex()` and `queryVaultIndex(query, {directory?, maxResults?})` returning the `{file,line,content}[]` shape of `kb/search.ts` `searchVault`; use case-insensitive regex-like per-line matching with literal-substring fallback; log `{files,lines,bytes,heapUsed,buildMs}` at each build.
- [ ] **ripgrep-parity-harness** — Deliver the non-regression harness over a committed fixture vault (`knowledge/`, `journals/`, and at least two peripheral folders): run real ripgrep (`rg -i --glob '*.md'` over the vault root) and the real warm index for a representative query set, then assert the index result set is a superset of or equal to ripgrep's at file+line granularity after normalizing paths and line numbers. Cover `knowledge/`, peripheral folders, mixed case, regex metacharacters, and invalid/unsupported regex fallback. Build a real index and shell real ripgrep; no stub may replace the index.
- [ ] **realscale-index-budget-validation** — Validate the warm index at real-vault scale (real vault when available, or a generated ~72MB markdown fixture dominated by a `knowledge/`-scale folder): assert full build completes within a documented budget, subsequent queries use the resident index without per-query walking, resident heap stays under a sane ceiling, and the build log reports actual `{files,lines,bytes,heapUsed,buildMs}`. Record measured numbers in test output or a checked-in acceptance note.
- [ ] **vault-search-fullcoverage-cutover** — Withdraw the carve-out and back the standalone service's deep search with the warm index. `read-tools.ts`: remove `ALL_SEARCH_TYPES` as the default coverage gate; default no-types search queries the entire warm index; keep `types` only as optional narrowing by top-level folder-name prefixes, unknown values ignored consistently. `mcp/server.ts`: broaden the `types` schema off the closed 3-value enum and update the tool description/parameter docs. `read-tools-deps.ts`: bind production `vault_search` to `queryVaultIndex`. Preserve result shape and `maxResults`.
- [ ] **kb-query-path-decision** — Make an explicit decision for `kb_query`/admin stdio search: either keep `kb_query` on cold ripgrep and document warm indexing as service-only, or route daemon-internal broad KB search through `queryVaultIndex` without imposing warm-index startup cost on per-session stdio `ADMIN_TOOLS`. Add tests or docs matching the chosen boundary.
- [ ] **daemon-warm-index-lifecycle** — Wire the warm index into the standalone service next to `initKB()` so it builds before `vault_search` accepts queries. Add a background full-rebuild interval with configurable cadence and a sane default; unref the timer; on rebuild failure log and retain the prior complete index; expose teardown to stop the timer cleanly during shutdown/tests. No per-folder exclusion mechanism.

## Phase 3 — Expanded MCP functions + metrics endpoint (W1)

> Depends on: Phase 2.

### Tests (write first)

- [ ] Write the suite for **mcp-content-functions** — test-plan.md §3: journal-range pulls return entries for a date range; link-following resolves `[[wikilinks]]`; tag/date queries filter correctly.
- [ ] Write the suite for **mcp-metrics-endpoint** — test-plan.md §3: the live endpoint reports call volume, timeouts, and latency; shape is stable and queryable.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **mcp-content-functions** — Add functions to pull content from journal entries by range, follow `[[wikilinks]]`, and query by tag/date, served warm from the resident index/corpus.
- [ ] **mcp-metrics-endpoint** — Expose a live metrics endpoint on the standalone service reporting call volume, timeouts, and per-call latency, designed for the cockpit to poll/subscribe in real time.

## Phase 4 — Cockpit product-aware containers + internal/external line (W2)

> Depends on: Phase 1.

### Tests (write first)

- [ ] Write the suite for **product-os-containers** — test-plan.md §4: each product renders the three containers with product-aware contents; Rune MCP weights operations/runs heavier; writing shows ideas only (no projects/bugs).
- [ ] Write the suite for **internal-external-distinction** — test-plan.md §4: the roster renders as two classes; Rune and Rune MCP are internal; aura/assay/relay/writing/brand are external.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **product-os-containers** — Make the existing three containers (projects/ideas/bugs; operations/runs; chat) fill from each product's context. Rune MCP gives operations/runs more room; writing drops projects/bugs and keeps ideas.
- [ ] **internal-external-distinction** — Add the top-level internal/external distinction to the cockpit and register the full product roster (internal: Rune, Rune MCP; external: aura, assay, relay, writing, brand).

## Phase 5 — Monitoring (W2)

> Depends on: Phase 3 (metrics endpoint), Phase 4 (product surfaces).

### Tests (write first)

- [ ] Write the suite for **monitoring-internal-only** — test-plan.md §5: internal products show a real monitoring tab fed by live data; external products show a stubbed/empty monitoring container; the cockpit reads MCP metrics from the live endpoint.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **monitoring-tab** — Add the monitoring surface. Internal products: render MCP call metrics (from the W1 live endpoint) and Rune orchestration-run metrics. External products: a stubbed/empty container so the shape stays consistent for later external monitoring.

## Phase 6 — Writing & Brand surfaces + migration (W4)

> Depends on: Phase 3 (standalone MCP reachable cross-repo), Phase 4 (product surfaces).

### Tests (write first)

- [ ] Write the suite/checks for **writing-product-orchestration** — test-plan.md §6: Rune produces a `/rune/{topic}` page in `michaelcjoseph.com` as a work run; the writing surface shows ideas, draft/publish runs, and scoped chat.
- [ ] Write the checks for **writing-migration-boundary** — test-plan.md §6: ideas migrate; historical content stays in pkms; workflow commands exist in the writing product; writing reads pkms only via the MCP.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **michaelcjoseph-two-product-repo** — Expand `michaelcjoseph.com` to host Brand (existing root single-page app, unchanged identity) and Writing (a new `/rune` subtree with `/rune/{topic}` pages, one per content piece).
- [ ] **writing-orchestration** — Make Rune orchestrate writing as work runs: kick off a topic, draft, and publish a `/rune/{topic}` page, pulling KB source material from pkms via the MCP.
- [ ] **writing-migration** — Migrate forward-looking ideas (topics) into the writing product; recreate the writing workflow commands (`/blog`, `/writing-critique`, `/voice`, `/topics`) in the writing product; leave historical content in pkms; ensure writing consumes pkms only through the MCP.
- [ ] **writing-brand-surfaces** — Wire both products into the cockpit product-OS: writing's ideas/runs/chat containers; brand's standard three containers over the existing single-page app.

## Phase 7 — Knowledge-freshness reconciliation (W3)

> Depends on: nothing (parallelizable). Lives in the Rune nightly curation step, not in MCP/cockpit/writing.

### Tests (write first)

- [ ] Write the suite for **knowledge-supersession** — test-plan.md §7: a newer journal entry that contradicts a curated fact triggers the nightly to flag/supersede the stale fact; valid facts are not invalidated; the Jarvis→Rune drift case is reconciled.
- [ ] Confirm red before implementation.

### Implementation

- [ ] **nightly-reconciliation-pass** — Add a reconciliation/invalidation step to the Rune nightly curation that detects when a newer journal entry supersedes a previously curated fact and flags or replaces it, with a conservative heuristic to avoid deleting valid facts.
- [ ] **jarvis-rune-drift-reconcile** — Use the in-flight Jarvis→Rune rename as the canonical instance: reconcile the surviving stale references (e.g. CLAUDE.md pointing at `jarvis/CLAUDE.md`, "Jarvis-spawned sub-agents") and prove the mechanism on it.
