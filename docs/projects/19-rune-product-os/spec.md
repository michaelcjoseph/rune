# Rune Product-OS Specification

## Overview

This project reframes the cockpit from a per-product dev surface into a **product operating system**: every product Rune touches — external (aura, assay, relay, writing, brand) and internal (Rune, Rune MCP) — becomes a first-class entity with the same spine, and the **internal vs. external** distinction becomes a top-level fact of the UI. Three concrete deliverables hang off that reframe:

1. **MCP re-architecture** — split the MCP server into a standalone, always-on service with a lifecycle independent of the cockpit, fix its performance, expand its functions, and make it emit its own telemetry.
2. **Writer as a product space** — writing becomes a real product Rune orchestrates, migrated out of the pkms vault into the `michaelcjoseph.com` repo, publishing actual web pages per content piece.
3. **Internal/external product reframe** — the cockpit organizing model that makes the first two surfaces real instead of bespoke pages.

The motivating seeds are two `ideas.md` entries: "Treat the writer as its own product space within Rune" and "Improve scalability and performance of MCP server." Pulling on both surfaced a shared organizing model, so they ship as one project rather than two disconnected features.

> **Provenance.** A prior planning pass shipped only the warm-index slice of W1 as a standalone "full-vault warm index" project. That work is correct but is one phase of W1, not the project. This spec restores the full scope; the warm index lands as **Phase 2** (the retrieval core of the standalone MCP service).

### Core Value Proposition

The cockpit becomes the single place to operate every product Rune touches, internal and external, through one shared spine. The MCP service stays authenticated across cockpit restarts, answers deep KB queries fast enough for both Claude and Rune-writing-specs, and reports on itself. Writing becomes a product Rune publishes to the personal site, not a Telegram-only skill.

---

## Product Roster

| Product | Class | Repo | State today |
|---|---|---|---|
| Rune | Internal | `rune` | The orchestrator; executes work and maintains the pkms KB |
| Rune MCP | Internal | `rune` (extracted in W1) | KB/vault access for Rune and external AI agents |
| relay | External | (existing) | Existing product surface |
| aura | External | (existing) | Existing product surface |
| assay | External | (existing) | Existing product surface |
| writing | External | `michaelcjoseph.com` (new) | New: Rune-orchestrated `/rune/{topic}` pages |
| brand | External | `michaelcjoseph.com` (existing) | Existing root single-page Next.js app |

Internal products are the system reasoning about itself; they do not change as the business grows. External products are public-facing; the roster grows over time. This line is drawn once, in the UI, and everything else inherits it.

---

## Organizing Model: cockpit-as-product-OS

### The shared spine already exists

Every product view already inherits three containers from project 17. This project makes their **contents** product-aware rather than building new structure:

1. **Projects / ideas / bugs container** — what's in flight or backlog.
2. **Operations / runs container** — Rune executing work, as work runs.
3. **Chat container** — Rune scoped to this product's context.

What changes per product is what fills each container, plus one genuinely new piece:

- **Rune MCP:** standard projects / ideas / bugs, but the operations/runs container is the more important one and gets more room.
- **writing:** no projects or bugs — just ideas. Operations/runs hold draft/publish runs. Chat discusses upcoming content.
- **brand:** the standard three containers over the existing single-page app.
- **monitoring (new):** a fourth surface, scoped to **internal products only** (see W2).

### The internal/external line

The cockpit gains a top-level internal/external distinction so the roster reads as two classes, not one flat list. Monitoring exists as a real tab on internal products and a stubbed/empty container on external products so the shape stays consistent and external monitoring can land later without a structural change.

`internal | external` is durable product metadata in `policies/products.json`, not an ad-hoc frontend grouping. The registry copies that class into its rebuildable projection so cockpit views can render the line without owning product truth. `policies/products.json` remains the source for execution metadata (repo path, scoped folder, base branch, credentials, validation commands, orchestration mode, egress allowlist); `logs/registry.json` remains rebuildable derived state scanned from product repos.

---

## Goals

1. **Primary — MCP independence & performance.** The MCP server runs as a standalone, always-on service whose lifecycle is independent of the cockpit, so cockpit restarts never force the Claude App to re-authenticate, and deep KB queries answer from warm state without timeouts.
2. **Primary — product-OS reframe.** The cockpit presents every product, internal and external, through the shared three-container spine plus monitoring, with internal/external as a top-level distinction.
3. **Primary — writer as a product.** Writing is a product Rune orchestrates, living in `michaelcjoseph.com`, publishing a web page per content piece, consuming pkms only through the MCP.
4. **Secondary — MCP observability.** The cockpit shows MCP call volume, timeouts, and latency, and Rune orchestration-run metrics, read live from the MCP service.
5. **Secondary — knowledge freshness.** Rune's nightly curation detects when a new journal entry supersedes a previously curated fact, so retrieval stops returning confidently-stale truth.
6. **Tertiary — expanded MCP functions.** New functions pull content from journal ranges, follow `[[wikilinks]]`, and query by tag/date.

### Original motivating goals, mapped

| Stated goal | Lands in |
|---|---|
| MCP not impacted by cockpit restarts (no reauth) | W1 Phase 1 — standalone service |
| MCP significantly more performant, no timeouts | W1 Phase 2 — warm retrieval core |
| More MCP functions (journal pulls, etc.) | W1 Phase 3 — expanded functions |
| See writing ideas | W4 — writing product surface |
| Chat with Rune about upcoming content | W4 — writing product chat |
| Monitor MCP usage/performance in cockpit | W2 — monitoring |

---

## Non-Goals

- **No vector database.** Performance is solved by architecture (warm, long-lived process holding the corpus and an in-memory full-text/structured index), not by embeddings. The curated `knowledge/` layer is the semantic layer. Vector search stays a deferred, additive option for fuzzy raw-journal recall if a real gap shows up later — it is explicitly out of scope here.
- **No external-product monitoring.** Monitoring covers internal-product telemetry the system generates about itself (MCP call metrics, Rune run metrics). External-product analytics (DAU, revenue, errors from external systems) is deferred; external products get a stubbed monitoring container only.
- **No migration of historical writing content.** Existing blog content in pkms is historical and stays where it is. Only forward-looking ideas migrate.
- **No new external products beyond writing and brand** in this project.
- **No macOS account changes and no change to the existing Rune web launchd label.** This project does add a second launchd job for the MCP service (`com.jarvis.rune-mcp`).
- **No vector/semantic retrieval respec** beyond the in-memory index and the new functions named above.

---

## Workstreams

The project is four workstreams. W1 is the backend unblocker (two of the surfaces depend on it); W2 is the organizing model; W4 depends on W1 being standalone; W3 is a separable curation workstream. The linearized build order is in [Build Sequence](#build-sequence).

### W1 — MCP re-architecture

Split the MCP server out of the cockpit process into a standalone, long-lived service.

- **Independent lifecycle (Phase 1).** The MCP service runs as its own process. The cockpit can restart freely without dropping the MCP's OAuth session, so the Claude App never re-authenticates on a cockpit restart. This makes goal #1 structurally impossible to regress: it is no longer the same process.
- **Warm retrieval core (Phase 2).** The service holds the full markdown vault and an in-memory index resident, and answers deep `vault_search` from warm state — no cold per-query vault walk, no per-call process spawn. This is the existing warm-index work, dropped in as a phase. Diagnosis: the timeouts are architectural (cold spawns, inline 30-file reads, no warm state), not algorithmic — a long-lived process with an in-memory index is a 10–100x latency drop with zero vector infrastructure. The index exploits existing tags, frontmatter, and `[[ ]]` links.
- **Expanded functions + metrics (Phase 3).** New functions: journal-range pulls, link-following, tag/date queries. The service exposes a MCP metrics snapshot tool (call volume, timeouts, latency, active sessions, index health) for the cockpit to poll while monitoring is visible.

**Resolved service contract:**

- The MCP service is a separate launchd-managed process with label `com.jarvis.rune-mcp`, running from this repo via a new entrypoint such as `src/mcp/daemon.ts` and a package script such as `npm run mcp:start`.
- The service binds to `127.0.0.1:3848`. Public Claude App access is provided by Tailscale Funnel/Serve reverse-proxying the localhost MCP endpoint to a stable HTTPS hostname.
- Claude App connects directly to the MCP service. The Rune web server does not proxy `/mcp`.
- The Rune web server must still start if MCP is down; cockpit monitoring renders a degraded state.
- Product functionality is exposed through MCP tools/resources. The daemon also exposes a small HTTP `/health` endpoint for service status/log visibility and launchd/cockpit polling. There is no separate `/metrics` HTTP endpoint; metrics are exposed through the MCP `mcp_metrics_snapshot` tool.
- The daemon uses separate env vars from the web server:
  - `RUNE_MCP_SECRET` — OAuth consent gate secret for the MCP service.
  - `RUNE_MCP_ISSUER_URL` — pinned public HTTPS issuer base URL shown in OAuth metadata (the Tailscale Funnel hostname). This is a **deployment input**, not a build artifact: the daemon reads it from env and the build does not need the final hostname to be complete. Provisioning the Funnel hostname is a human prerequisite (see [Manual Acceptance Gates](#manual-acceptance-gates) and Open Questions).
  - `RUNE_MCP_OAUTH_STORE_FILE` — persisted OAuth clients/tokens; default `logs/rune-mcp-oauth-store.json`.
  - `RUNE_MCP_HOST` — default `127.0.0.1`.
  - `RUNE_MCP_PORT` — default `3848`.
- Revoke Claude App MCP access by deleting the MCP OAuth store and restarting the MCP service.
- **One-time cutover reauth.** Existing Claude App tokens live in the *web server's* OAuth store. The standalone daemon uses a **separate** `RUNE_MCP_OAUTH_STORE_FILE`; tokens are not migrated. The cutover therefore forces **exactly one** reauth when the Claude App first connects to the new daemon. This is a known, accepted one-time exception to the "zero reauth" goal — the goal is zero reauth on *cockpit restarts* thereafter, which the standalone lifecycle makes structural. Migrating the old store is explicitly not in scope.

**Health/status contract:** `GET /health` on the MCP daemon returns process/service readiness only: daemon up, OAuth configured, active MCP sessions count, warm-index status, last index rebuild result, uptime, and a bounded recent-log tail or log pointers. It must not expose pkms content or any product function, and it must not be confused with Rune's pkms `/health` review command.

**Metrics contract:** cockpit monitoring polls the canonical MCP tool `mcp_metrics_snapshot` once per second while the monitoring view is visible. Metrics reset on MCP process restart and show live counters only: total calls, calls by tool, errors by tool, timeouts by tool, p50/p95/p99 latency, active sessions, warm-index readiness, warm-index age, and last rebuild result. One-second polling is acceptable because the tool returns in-process counters only, not vault reads or LLM calls; the frontend must stop polling when the tab/view is not visible.

Because this is a long-lived process, the metrics structures must be **bounded**: latency percentiles are computed over a bounded ring buffer / reservoir per tool (a fixed sample window, not an unbounded array), so resident memory cannot grow with call volume. A **timeout** is defined as a tool call whose wall-clock duration exceeds a configured per-call ceiling (`RUNE_MCP_TOOL_TIMEOUT_MS`, default 30000) — it is counted as both an error and a timeout for that tool. Errors are any tool call that throws or returns a tool-error result.

**Warm-index contract:** the MCP daemon starts building the warm index on startup, then refreshes every 15 minutes. Tools stay available during the initial build: `vault_search` and daemon-internal broad `kb_query` fall back to cold ripgrep until the first complete index is ready. After the index is ready, both route through the warm index. Refresh failures retain the prior complete index. The index follows symlinks inside the vault and indexes markdown files fully, including large files. Symlink following uses a visited-inode/real-path guard so cycles (a symlink pointing at an ancestor) cannot cause an unbounded or non-terminating walk. No vector DB; `knowledge/` remains the curated semantic layer. Canonical index/admin tools: `refresh_vault_index` and `mcp_metrics_snapshot`.

**Resolved `kb_query`/admin-stdio boundary:** the per-session local admin stdio MCP server (`src/mcp/index.ts`, used by other Claude Code sessions on the machine) does **not** build or hold the warm index — it would pay a multi-second build cost per short-lived spawn for no benefit. Admin-stdio `vault_search`/`kb_query` continue to use cold ripgrep, documented as service-only-warm. Only the long-lived daemon holds warm state; daemon-internal broad `kb_query` routes through `queryVaultIndex` after readiness. This boundary is the resolved decision, not an open `/work`-time choice.

**Canonical content tools:** `journal_range`, `follow_wikilinks`, and `tag_date_query`.

### W2 — Cockpit product-OS reframe

Make the existing three containers product-aware, draw the internal/external line, and add monitoring.

- **Product-aware containers.** Each product's three containers fill from that product's context. Rune MCP weights the operations/runs container heavier; writing drops projects/bugs and keeps ideas.
- **Internal/external distinction.** Top-level in the UI. Internal products: Rune, Rune MCP. External: aura, assay, relay, writing, brand.
- **Monitoring (new).** A fourth surface. Internal-only, fed by telemetry the system generates: MCP call metrics (from the W1 metrics snapshot tool) and Rune orchestration-run metrics. Stubbed/empty on external products so the shape is consistent and external monitoring lands later without a structural change.

**Key decisions:** monitoring is internal-only with external stubs; cockpit reads MCP metrics from the live MCP metrics snapshot tool; the product class lives in `policies/products.json`; `rune-mcp`, `writing`, and `brand` are executable products with work runs.

Product-specific container rules:

- `rune`: standard projects / ideas / bugs, operations / runs, scoped chat, internal monitoring.
- `rune-mcp`: standard projects / ideas / bugs, operations / runs emphasized, scoped chat, internal monitoring.
- `writing`: ideas from `michaelcjoseph.com/docs/rune/writing-ideas.md`, writing draft/publish runs, scoped chat, external monitoring stub.
- `brand`: standard project/backlog/run/chat containers over the `michaelcjoseph.com` root product, external monitoring stub.
- `aura`, `assay`, `relay`: existing repo-backed behavior, now classed as external with monitoring stubs.

### W3 — Knowledge freshness / reconciliation

A separable curation-pipeline workstream. When a new journal entry contradicts a fact curated a month ago, the nightly KB processing must detect the supersession instead of letting the stale fact survive in the curated page. Fast, accurate retrieval of wrong data is worse than slow retrieval, so this is load-bearing for the "rely on the KB for specs" goal.

**V1 scope is the rename / identity-drift class, not general semantic contradiction.** The candidate finder targets facts that have been *renamed or re-identified* (the canonical case: an entity called "Jarvis" is now "Rune"), detectable deterministically by token/alias matching against a known supersession term. General "I changed my mind about X" semantic contradiction across free prose is explicitly **deferred** — building a reliable general contradiction detector is out of scope for v1. The LLM adjudicator's job is to confirm a *candidate already surfaced by the deterministic finder* is a current-state fact and clearly superseded, not to discover contradictions on its own. The success metric ("a superseded fact is flagged/replaced") is scoped to this rename/identity-drift class.

- The fix lives in the **Rune nightly curation step**, not in the MCP service, cockpit, or writing migration.
- Add a reconciliation/invalidation pass **immediately after the `KB queue` step** (and before `KB lint`) in the nightly sequence. Pin the insertion at the index right after `KB queue` — do not place it loosely "anywhere before lint." This placement lets normal ingestion update the wiki first, then reconciliation handles remaining contradictions before the unrelated downstream steps and the final lint run.
- Use conservative LLM adjudication over candidate stale facts. The pass auto-edits curated pages only when the newer source clearly supersedes the old fact; ambiguous cases are logged and left unchanged.
- **Over-invalidation guard.** The known risk is rewriting still-valid curated facts. The pass must be proven against a deliberate near-miss fixture — a curated fact that *superficially* resembles a supersession candidate but is still valid (e.g., a historical reference that legitimately names "Jarvis" as the prior identity) — and must leave it unchanged. This negative case is a required test, not just the generic "valid facts not invalidated" assertion.
- Raw journals are immutable and must never be rewritten. Curated pages, including psychology pages, are eligible for conservative supersession edits.
- Each auto-edit appends a concise inline changelog entry to the touched wiki/curated page and appends a machine-readable record to `knowledge/supersessions.jsonl`.
- The in-flight Jarvis→Rune rename is the canonical proof case. Update the pkms instruction files (`CLAUDE.md` / `AGENTS.md`) from Jarvis to Rune, leave raw journal mentions untouched, and use the remaining curated-page drift as the reconciliation fixture.

### W4 — Writing & Brand (`michaelcjoseph.com`)

Writing becomes a product Rune orchestrates, publishing to the personal site. This is **only viable because of W1**: writing leans hard on the KB (journals, worldview, playbook, Lenny, PG), and once the MCP is a standalone service reachable from any repo, writing content can live in `michaelcjoseph.com` while Rune still reaches back into pkms for source material.

- **Two-product repo.** `michaelcjoseph.com` expands to host two products: **Brand** (the existing root single-page Next.js app, active today) and **Writing** (a new `/rune` subtree where each content piece is a page at `/rune/{topic}`).
- **Rune orchestrates writing as true work runs** — drafting and publishing a `/rune/{topic}` page is a work run, the same way Rune executes on aura or relay.
- **Migration boundary:**
  - Historical content (existing blog posts in pkms) does **not** move — it is historical, stays in pkms.
  - Forward-looking **ideas** (topics) migrate into `michaelcjoseph.com/docs/rune/writing-ideas.md`.
  - The only writing commands that remain first-class Rune commands are `/blog` and `/writing-critique`, scoped to the writing product and implemented through the specialized writer pipeline.
  - **Today `/blog` is a review flow** (`src/bot/commands/blog.ts` → `startReview(userId, 'blog')`). W4 replaces that review-type implementation with the writing-product pipeline; the old `blog` review type and its draft-write path are removed/redirected so nothing dangles in the resolver or review registry.
  - **`/voice` and `/topics` do not exist as Rune commands today** (verified: not in `src/bot/commands/`, not in the command table, not review types). There is therefore no command to "retire" — the real work is content migration, not command removal: today's topics live in pkms `writing/topics.md` (migrate forward-looking ones to the writing ideas file) and voice guidance lives in pkms `writing/voice.md` (copy into the writing product). The only retirement action is a **confirmation** that no `/topics`/`/voice` command or resolver destination exists or gets added.
  - Writing **leaves pkms entirely** and consumes pkms only through the MCP.

**Writer pipeline contract:** writing does not use the generic product-team coding loop. A specialized writer pipeline runs as a work run against the `writing` product, reads pkms source material only through MCP, applies the copied voice guidelines, and commits to a writing branch in `michaelcjoseph.com`.

- **Credential isolation.** The writing work run inherits the standard sandbox credential isolation (`src/jobs/credential-injector.ts`): only the `writing` product's own credentials reach the sandboxed child, and Rune's own secrets never do. The writing pipeline is built inside this guard, not outside it.
- **Personal-content publishing boundary.** The pipeline reads personal pkms content (journals, worldview, psychology) via MCP and emits prose committed to `michaelcjoseph.com`, a public-facing repo. Published pages must not surface raw personal content: the pipeline treats pkms material as *source for synthesis*, never as text to copy verbatim into a published page, and must not include private identifiers, raw journal excerpts, health/psychology specifics, or third-party personal names (CRM/family) unless the topic is explicitly about public-shareable material. This boundary is a required test in W4 (a published artifact must not contain a planted private marker drawn from a journal source).

The pipeline uses deterministic branch names under `rune-writing/{slug}`. `/blog <topic>` starts a new branch when none exists for the topic and resumes the existing topic branch when one exists. Pipeline states surfaced in operations/runs: `researching`, `drafting`, `critiquing`, `revising`, `ready-for-review`, `committed`, and `failed`. In v1, "publish" means the pages are committed to the writing branch; no external deployment is required.

`/writing-critique <target>` critiques an existing draft or page in the writing product. Critique output lands in the writing repo next to the target under `docs/rune/critiques/<target-slug>.md` unless the user explicitly asks it to revise the page; revision commits stay on the same `rune-writing/{slug}` branch.

**V1 publishing acceptance:** produce two committed artifacts on the writing branch:

- `/rune` — a page where Rune describes itself.
- `/rune/{topic}` — the first Rune-authored writing piece.

**Key decisions:** historical content stays; ideas migrate; `/blog` (today a review flow) is rebuilt on the writing pipeline and `/writing-critique` is added; `/topics` and `/voice` are *not existing commands* — only their pkms content migrates (no command removal); writing consumes pkms via MCP only; brand is an active product, not a stub.

**Environment prerequisite (W4).** `michaelcjoseph.com` is a separate git repo at `~/workspace/michaelcjoseph.com` (a real Next.js app, confirmed). It is **not** inside the `rune` working tree, so cross-repo writes require the executing harness/agent to have that path as a permitted working directory. This is a setup prerequisite for Phase 6, called out so an autonomous run does not silently fail on a permission boundary.

---

## Build Sequence

Phases are ordered by dependency. W1's standalone split is the unblocker for monitoring (telemetry source) and writing (cross-repo KB access), so it leads.

| Phase | Workstream | Deliverable | Depends on |
|---|---|---|---|
| 1 | W1 | MCP standalone service with independent lifecycle (reauth fix) | — |
| 2 | W1 | Warm full-vault retrieval core (the existing warm-index work) | 1 |
| 3 | W1 | Expanded MCP functions + MCP metrics snapshot tool | 2 |
| 4 | W2 | Cockpit product-aware containers + internal/external line | 1 |
| 5 | W2 | Monitoring tab (internal-only, MCP metrics snapshot + Rune run metrics; external stubs) | 3, 4 |
| 6 | W4 | Writing & Brand surfaces + writing migration into `michaelcjoseph.com` | 3, 4 |
| 7 | W3 | Knowledge-freshness reconciliation in Rune nightly | — (parallelizable) |

The per-phase task breakdown lives in [tasks.md](tasks.md) and the verification checklist in [test-plan.md](test-plan.md). The project is built **test-first** — every phase opens with a **Tests (write first)** block whose tests fail (red) before implementation, and a phase is done when its test-plan sections pass.

---

## Success Metrics

| Metric | Target | How measured |
|---|---|---|
| Cockpit restart → MCP reauth | Zero reauths on cockpit restart (after a one-time cutover reauth) | Restart cockpit, confirm Claude App session survives — **manual/live gate** |
| Deep `vault_search` latency | No timeouts; warm-state answers | W1 Phase 2 budget validation + acceptance |
| Markdown folder coverage | 100% of `*.md` under vault root | Ripgrep-parity harness (Phase 2) |
| MCP metrics visible | Call volume, timeouts, latency live in cockpit | Monitoring acceptance (Phase 5) |
| Writing publishes | A `/rune/{topic}` page produced by a Rune work run | W4 acceptance |
| Stale-fact supersession | A superseded fact is flagged/replaced in nightly | W3 acceptance (Jarvis→Rune drift case) |

---

## Open Questions

- [ ] **Final Tailscale Funnel hostname for `RUNE_MCP_ISSUER_URL`.** Human prerequisite (provision Funnel, supply hostname). Tracked as a manual gate; the build consumes it as a config input and does not block on it.
- [x] **Route/page conventions inside `michaelcjoseph.com` for the `/rune` subtree.** Resolved into work, not deferred: Phase 6 opens with an agent-run task (`michaelcjoseph-route-survey`) that reads the repo's Next.js structure and settles the `/rune` and `/rune/{topic}` route/page convention before any artifact task. No human decision required.

## Manual Acceptance Gates

Most of this project is automatable and built test-first. A small set of acceptance steps are inherently **human-or-live** — they exercise the real Claude App, the Tailscale Funnel, an installed launchd job, or a live nondeterministic LLM run — and cannot be expressed as a red-green unit test. They are tracked separately so an autonomous `/work` run does not stall trying to "pass" them, and so completion of automatable tasks is not blocked on them.

| Gate | Phase | Why it is manual/live | Automatable portion (still required) |
|---|---|---|---|
| Tailscale Funnel provisioning + final hostname | 1 | Needs network/account config; supplies `RUNE_MCP_ISSUER_URL` | Daemon reads issuer URL from env; OAuth metadata renders from it |
| Claude App reauth-survives-restart | 1 | Requires the real Claude App OAuth consent in a browser | Daemon owns its own OAuth store; cockpit-restart leaves the store file untouched (assertable) |
| launchd job install + survives cockpit restart | 1 | `launchctl bootstrap`/`kickstart` of a real service | Plist content + runbook are produced and lint-checked; an install script is provided |
| Live writing run quality (`/rune`, `/rune/{topic}`) | 6 | Nondeterministic LLM output; "describes itself well" needs human judgment | Branch exists and contains the two committed pages + copied voice + ideas file (assertable) |

Each phase's `user-reachability-check` task is split accordingly: the **assertable** half stays an automatable task; the **live** half is one of the gates above. The integration-verification rows in [test-plan.md](test-plan.md) marked **(manual/live gate)** map to this table.
