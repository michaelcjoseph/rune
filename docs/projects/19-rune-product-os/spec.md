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

- **Rune MCP:** the operations/runs container is the more important one and gets more room; no projects/bugs in the usual sense.
- **writing:** no projects or bugs — just ideas. Operations/runs hold draft/publish runs. Chat discusses upcoming content.
- **brand:** the standard three containers over the existing single-page app.
- **monitoring (new):** a fourth surface, scoped to **internal products only** (see W2).

### The internal/external line

The cockpit gains a top-level internal/external distinction so the roster reads as two classes, not one flat list. Monitoring exists as a real tab on internal products and a stubbed/empty container on external products so the shape stays consistent and external monitoring can land later without a structural change.

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
- **No macОS/account changes, no launchd label changes** (rebrand project 18 owns runtime identity; this project assumes it done).
- **No vector/semantic retrieval respec** beyond the in-memory index and the new functions named above.

---

## Workstreams

The project is four workstreams. W1 is the backend unblocker (two of the surfaces depend on it); W2 is the organizing model; W4 depends on W1 being standalone; W3 is a separable curation workstream. The linearized build order is in [Build Sequence](#build-sequence).

### W1 — MCP re-architecture

Split the MCP server out of the cockpit process into a standalone, long-lived service.

- **Independent lifecycle (Phase 1).** The MCP service runs as its own process. The cockpit can restart freely without dropping the MCP's OAuth session, so the Claude App never re-authenticates on a cockpit restart. This makes goal #1 structurally impossible to regress: it is no longer the same process.
- **Warm retrieval core (Phase 2).** The service holds the full markdown vault and an in-memory index resident, and answers deep `vault_search` from warm state — no cold per-query vault walk, no per-call process spawn. This is the existing warm-index work, dropped in as a phase. Diagnosis: the timeouts are architectural (cold spawns, inline 30-file reads, no warm state), not algorithmic — a long-lived process with an in-memory index is a 10–100x latency drop with zero vector infrastructure. The index exploits existing tags, frontmatter, and `[[ ]]` links.
- **Expanded functions + metrics (Phase 3).** New functions: journal-range pulls, link-following, tag/date queries. The service exposes a live metrics endpoint (call volume, timeouts, latency) for the cockpit to read.

**Key decisions:** standalone always-on service; cockpit reads metrics via a **live MCP endpoint** (not a shared store) so monitoring is real-time; no vector DB; `knowledge/` is the semantic layer.

### W2 — Cockpit product-OS reframe

Make the existing three containers product-aware, draw the internal/external line, and add monitoring.

- **Product-aware containers.** Each product's three containers fill from that product's context. Rune MCP weights the operations/runs container heavier; writing drops projects/bugs and keeps ideas.
- **Internal/external distinction.** Top-level in the UI. Internal products: Rune, Rune MCP. External: aura, assay, relay, writing, brand.
- **Monitoring (new).** A fourth surface. Internal-only, fed by telemetry the system generates: MCP call metrics (from the W1 live endpoint) and Rune orchestration-run metrics. Stubbed/empty on external products so the shape is consistent and external monitoring lands later without a structural change.

**Key decisions:** monitoring is internal-only with external stubs; cockpit reads MCP metrics from the live endpoint.

### W3 — Knowledge freshness / reconciliation

A separable curation-pipeline workstream. When a new journal entry contradicts a fact curated a month ago, the nightly KB processing must detect the supersession instead of letting the stale fact survive in the curated page. Fast, accurate retrieval of wrong data is worse than slow retrieval, so this is load-bearing for the "rely on the KB for specs" goal.

- The fix lives in the **Rune nightly curation step**, not in the MCP service, cockpit, or writing migration.
- Add a reconciliation/invalidation pass that flags or supersedes curated facts contradicted by newer journal entries.
- The in-flight Jarvis→Rune rename is the canonical instance: recent commits renamed it across the project page and KB, but stale references survive (e.g. CLAUDE.md still points at `jarvis/CLAUDE.md` and "Jarvis-spawned sub-agents"). The system contradicts itself mid-rename and nothing reconciled it. W3 should fix that drift and prove the mechanism on it.

### W4 — Writing & Brand (`michaelcjoseph.com`)

Writing becomes a product Rune orchestrates, publishing to the personal site. This is **only viable because of W1**: writing leans hard on the KB (journals, worldview, playbook, Lenny, PG), and once the MCP is a standalone service reachable from any repo, writing content can live in `michaelcjoseph.com` while Rune still reaches back into pkms for source material.

- **Two-product repo.** `michaelcjoseph.com` expands to host two products: **Brand** (the existing root single-page Next.js app, active today) and **Writing** (a new `/rune` subtree where each content piece is a page at `/rune/{topic}`).
- **Rune orchestrates writing as true work runs** — drafting and publishing a `/rune/{topic}` page is a work run, the same way Rune executes on aura or relay.
- **Migration boundary:**
  - Historical content (existing blog posts in pkms) does **not** move — it is historical, stays in pkms.
  - Forward-looking **ideas** (topics) migrate into the writing product.
  - The writing **workflow commands** (`/blog`, `/writing-critique`, `/voice`, `/topics`) are recreated/duplicated in the writing product so the writing agent can use them while working in `michaelcjoseph.com`.
  - Writing **leaves pkms entirely** and consumes pkms only through the MCP.

**Key decisions:** historical content stays; ideas migrate; commands recreated in the writing product; writing consumes pkms via MCP only; brand is an active product, not a stub.

---

## Build Sequence

Phases are ordered by dependency. W1's standalone split is the unblocker for monitoring (telemetry source) and writing (cross-repo KB access), so it leads.

| Phase | Workstream | Deliverable | Depends on |
|---|---|---|---|
| 1 | W1 | MCP standalone service with independent lifecycle (reauth fix) | — |
| 2 | W1 | Warm full-vault retrieval core (the existing warm-index work) | 1 |
| 3 | W1 | Expanded MCP functions + live metrics endpoint | 2 |
| 4 | W2 | Cockpit product-aware containers + internal/external line | 1 |
| 5 | W2 | Monitoring tab (internal-only, live MCP endpoint + Rune run metrics; external stubs) | 3, 4 |
| 6 | W4 | Writing & Brand surfaces + writing migration into `michaelcjoseph.com` | 3, 4 |
| 7 | W3 | Knowledge-freshness reconciliation in Rune nightly | — (parallelizable) |

The per-phase task breakdown lives in [tasks.md](tasks.md) and the verification checklist in [test-plan.md](test-plan.md). The project is built **test-first** — every phase opens with a **Tests (write first)** block whose tests fail (red) before implementation, and a phase is done when its test-plan sections pass.

---

## Success Metrics

| Metric | Target | How measured |
|---|---|---|
| Cockpit restart → MCP reauth | Zero reauths on cockpit restart | Restart cockpit, confirm Claude App session survives |
| Deep `vault_search` latency | No timeouts; warm-state answers | W1 Phase 2 budget validation + acceptance |
| Markdown folder coverage | 100% of `*.md` under vault root | Ripgrep-parity harness (Phase 2) |
| MCP metrics visible | Call volume, timeouts, latency live in cockpit | Monitoring acceptance (Phase 5) |
| Writing publishes | A `/rune/{topic}` page produced by a Rune work run | W4 acceptance |
| Stale-fact supersession | A superseded fact is flagged/replaced in nightly | W3 acceptance (Jarvis→Rune drift case) |

---

## Open Questions

- [ ] MCP service deployment shape: separate launchd service vs. a second process under the same supervisor; restart/health story.
- [ ] Exact metrics-endpoint contract (shape, auth) the cockpit consumes live.
- [ ] Where the writing product's recreated workflow commands live and how they're kept in sync with the pkms originals (or whether pkms originals are retired).
- [ ] W3 supersession heuristic: how the nightly decides a journal entry invalidates a curated fact (explicit contradiction vs. recency vs. flagged-for-review).
- [ ] Final background rebuild cadence default and env-var name for the warm index (carried from the warm-index slice).
- [ ] `kb_query`/admin-stdio boundary: keep cold ripgrep vs. route daemon-internal search through the warm index (carried from the warm-index slice).
