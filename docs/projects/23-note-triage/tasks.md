# Note Triage — Tasks

Built in a single operator-supervised session (2026-07-08) from the approved plan; each task
landed green before the next (test-first within each module). The decomposition below follows
the planning-checklist triple (pure core / runtime adapter / user surface) and the two queued
lessons that apply: nightly-wiring is a multi-file change (snapshot + positional indexes +
narrow-mock suites), and LLM-over-untrusted-input needs trust-boundary rows up front (see
test-plan.md).

## Phase 1 — Write guards

- [x] Extract the ancestor-realpath containment check shared by `assertBacklogWriteAllowed`
      into `assertResolvesInsideRepo`; add `ALLOWED_TOPIC_FILES` +
      `assertScopedTopicWriteAllowed(repoPath, scopePath, absPath)`
      (`src/intent/backlog-write-lock.ts`). Deliberately NOT a widening of
      `ALLOWED_BACKLOG_FILES` — that would legalize `docs/rune/*` in every repo for every
      existing call site.
- [x] Security tests: accept/reject matrix incl. traversal, symlinked scope dir, non-relative
      scopePath, not-yet-existing target (`src/intent/backlog-security.test.ts`).

## Phase 2 — Pure core

- [x] `src/intent/note-triage.ts`: item types + `parseNoteTriageOutput` (fence-strip,
      malformed-item drop, 20-item cap, single-line discipline), `routeNoteItems` with
      `resolveProductTarget` re-validation (unknown → vault; writing-product idea → writing
      topic; unroutable bug → vault with `[Bug — unrouted]` marker; ideas-disabled → vault),
      `extractProjectPageHints`, `normalizeNoteTitle`/`containsNoteTitle`,
      `appendVaultIdeaBlocks` (inserts before `## Supersession audit`), `appendTopicLines`
      (seeds header, cockpit-parseable bullets).
- [x] Pure tests incl. `parseIdeas` round-trip pinning cockpit visibility
      (`src/intent/note-triage.test.ts`).

## Phase 3 — Agent + runtime adapter

- [x] `.claude/agents/note-triage.md`: tool-less (`tools: []`) sonnet extractor; strict JSON
      contract; fail-closed rules (unsure product → null, unsure item → omit, synthesized
      phrasing, skip `#playbook`/`#meeting`/`#diet` passages).
- [x] `src/jobs/note-triage.ts` `runNoteTriage`: config-first fail-closed, hints + delimited
      journal prompt, one retry, per-target-file writes (lock → guard → title-dedupe →
      atomic write → audit log; no product-repo commits), path-scrubbed failure detail.
- [x] I/O tests over tmpdir repos + vault fixtures (`src/jobs/note-triage.test.ts`).

## Phase 4 — Nightly wiring + supersession

- [x] `stepNoteTriage` registered at position 7 (after Registry rebuild → fresh product set;
      after Journal-intent producer; before Journal ingest), consuming the once-read journal.
- [x] Daily-tags narrowed to nutrition-only (`KNOWN_MARKDOWN_FILES`, `#idea`/Writing-topics
      prompt rules retired, `mentionsMarkdown` → `/\bnutrition\.md\b/`).
- [x] Nightly test updates: 17→18 snapshot + ordered names, shifted positional indexes,
      nutrition fixture for the daily-content-updater abort test, narrowing pin, note-triage
      module mock in `nightly.test.ts` + `nightly.nosleep.test.ts` (sandbox-runtime `execFile`
      edge) + `nightly-knowledge-reachability.test.ts`.
- [x] `.claude/agents/daily-content-updater.md` narrowed to nutrition only.

## Phase 5 — Docs + closeout

- [x] This scaffold + `docs/projects/index.md` row + promotion marker on the source idea in
      `docs/projects/ideas.md`.
- [x] CLAUDE.md: 18-step orchestrator, note-triage in the runtime agents list;
      `docs/architecture/module-reference.md` via docs-sync.
- [x] **Live operator gate (user-reachability):** run live 2026-07-08 against the real journal
      (plus one synthetic pass for the two item kinds the day's journal didn't contain).
      Observed: 12 relay ideas + 1 rune bug + 2 research topics filed from real content
      (relay's `ideas.md` created fresh; `docs/rune/` created in michaelcjoseph.com); a vault
      new-product `###` block inserted above `## Supersession audit`; `writing-ideas.md`
      seeded; all filed items surfaced through the cockpit `readBacklogs` path as open
      user-authored items; audit rows in `logs/backlog-mutations.jsonl` with correct
      product/file/branch; product repos left dirty-uncommitted; git only ever read.
      **Dedupe finding:** a forced identical re-run re-filed near-duplicates under different
      LLM titles — fixed during the gate by injecting the already-filed titles for the date
      into the prompt as a do-not-re-emit list (`collectFiledTitles`); a third live run then
      filed only genuinely-new journal content (one semantic-split near-dupe slipped, removed
      by hand — the accepted residual for forced re-runs; production runs once per journal
      via the daily-processed marker).

**User-reachability check:** the capability triggers from the nightly cron (and a forced
`executeNightly(date, {force:true})` for on-demand runs); outcomes are observable in the
nightly summary detail, the cockpit backlog drawer, and the filed files themselves.
