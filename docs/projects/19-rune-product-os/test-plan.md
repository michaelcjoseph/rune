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

- [ ] 🔴 The MCP runs as a process independent of the cockpit, with its own startup, health, and graceful teardown.
- [ ] 🔴 A cockpit restart does not tear down the MCP service or its OAuth session; the Claude App stays authenticated with no reauthentication.
- [ ] 🟡 The cockpit talks to the MCP as a separate service; it no longer hosts the MCP in-process.
- [ ] 🟢 MCP service startup/shutdown is logged and observable.

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
- [ ] 🟡 `realscale-index-budget-validation`: build over the real vault or a ~72MB markdown fixture completes within the documented budget, queries use the resident index without per-query walking, resident heap stays under the documented ceiling, and measured numbers are recorded.

### Cutover

- [ ] 🔴 A default `vault_search` with no `types` returns hits from `knowledge/` and at least one peripheral folder via the warm index.
- [ ] 🔴 `ALL_SEARCH_TYPES` no longer acts as the default coverage gate; no closed `journals/pages/projects` default remains; no folder include/exclude config exists.
- [ ] 🟡 `types` narrows by top-level folder-name prefix; an unknown value is ignored or returns no matches consistently, never a hidden exclusion.
- [ ] 🟢 The `vault_search` schema is broadened off the closed 3-value enum and the tool description advertises whole-vault markdown search.
- [ ] 🔴 Production `vault_search` is bound to `queryVaultIndex` (`read-tools-deps.ts`); result shape and `maxResults` preserved.
- [ ] 🟡 The `kb_query`/admin-stdio boundary is enforced and documented (cold ripgrep documented as service-only, or daemon-internal routed through `queryVaultIndex` without per-spawn warm-index cost).
- [ ] 🔴 Startup builds the index before `vault_search` accepts queries; the background rebuild interval schedules at the configured cadence, is unref'd, and tears down cleanly; a failed refresh logs and retains the prior complete index; rebuild cadence default is documented.

## 3. Expanded MCP Functions + Metrics (W1 Phase 3)

- [ ] 🔴 A journal-range pull returns the journal entries for a given date range from warm state.
- [ ] 🟡 Link-following resolves `[[wikilinks]]` to their target content.
- [ ] 🟡 Tag/date queries filter the corpus correctly.
- [ ] 🔴 The live metrics endpoint reports call volume, timeouts, and per-call latency with a stable, queryable shape.
- [ ] 🟢 New functions are served warm (no per-call cold spawn or full vault walk).

## 4. Cockpit Product-OS Reframe (W2 Phase 4)

- [ ] 🔴 Each product renders the three containers (projects/ideas/bugs; operations/runs; chat) with product-aware contents.
- [ ] 🟡 Rune MCP weights the operations/runs container heavier; writing shows ideas only (no projects/bugs).
- [ ] 🔴 The roster renders as two classes; internal = Rune, Rune MCP; external = aura, assay, relay, writing, brand.
- [ ] 🟢 Adding a future external product needs no structural change to the container spine.

## 5. Monitoring (W2 Phase 5)

- [ ] 🔴 Internal products (Rune, Rune MCP) show a real monitoring tab fed by live data: MCP call metrics (from the live endpoint) and Rune orchestration-run metrics.
- [ ] 🔴 The cockpit reads MCP metrics from the live MCP endpoint (not a shared store).
- [ ] 🟡 External products show a stubbed/empty monitoring container; the shape is consistent for later external monitoring.
- [ ] 🟢 Monitoring degrades gracefully when the MCP endpoint is briefly unavailable.

## 6. Writing & Brand (W4 Phase 6)

- [ ] 🔴 Rune produces a `/rune/{topic}` page in `michaelcjoseph.com` as a work run (drafting/publishing shows in the operations/runs container).
- [ ] 🔴 `michaelcjoseph.com` hosts two products: Brand (root single-page app, identity unchanged) and Writing (`/rune` subtree).
- [ ] 🟡 The writing surface shows ideas, draft/publish runs, and scoped chat; no projects/bugs.
- [ ] 🔴 Forward-looking ideas migrate to the writing product; historical content stays in pkms.
- [ ] 🟡 The writing workflow commands (`/blog`, `/writing-critique`, `/voice`, `/topics`) exist in the writing product.
- [ ] 🔴 Writing reads pkms source material only through the MCP (no direct pkms file access from `michaelcjoseph.com`).

## 7. Knowledge-Freshness Reconciliation (W3 Phase 7)

- [ ] 🔴 A newer journal entry that contradicts a previously curated fact triggers the nightly to flag or supersede the stale fact.
- [ ] 🔴 Valid curated facts are not invalidated by the reconciliation pass (conservative heuristic).
- [ ] 🟡 The Jarvis→Rune rename drift is reconciled (surviving stale references corrected) as the canonical proof case.
- [ ] 🟢 The reconciliation pass logs what it flagged/superseded for review.
