# Journal-KB Integration Test Plan

Error handling checklist for the journal → KB ingestion pipeline, KB-activity scanner, KB-aware project updates, meeting notes structure, KB-aware default chat, and lint extensions.

> See also: existing tests in `src/kb/ingest.test.ts`, `src/jobs/nightly.test.ts`, `src/reviews/weekly.test.ts`.

## Priority Levels

- 🔴 **Critical**: Blocks the loop — daily ingestion broken, reviews can't run, KB corruption.
- 🟡 **High**: Degrades the workflow significantly — wrong content extracted, missed updates, slow chat.
- 🟢 **Low**: Cosmetic or rare — log formatting, edge-case routing.

## 1. Daily journal ingestion (Phase 1)

### Routing & mutability
- [ ] 🔴 `journals/2026_04_22.md` → `knowledge/raw/journals/2026_04_22.md` (verify `determineRawDir` + `isMutableSource`)
- [ ] 🔴 Re-ingesting the same journal after the user edits it overwrites the raw copy (no stale content read by wiki-compiler on second pass)
- [ ] 🟡 `journals/archive/old.md` (if any archive convention) doesn't get re-ingested
- [ ] 🟢 Empty journal (whitespace only) is skipped without erroring

### Nightly step ordering
- [ ] 🔴 `stepJournalIngest` runs before `stepKBQueue` so today's journal is included in the nightly compile pass (or a second KB queue pass runs after)
- [ ] 🔴 If `stepJournalIngest` throws, subsequent steps still run (error isolation matches existing pattern)
- [ ] 🟡 Nightly TG summary includes the journal-ingest result line

### wiki-compiler journal handling
- [ ] 🟡 Interstitial timestamps (`10:15 - did X`) are not extracted as entities or events
- [ ] 🟡 Casual asides ("had a great ramen at Tatsu-ya #place") still go through `#place` tag pipeline; the journal-ingest run doesn't double-process them as KB entities
- [ ] 🟡 People mentioned in meeting notes (`[[alice]]`) get an entity page created/updated with a `journal_ref` to the source date
- [ ] 🟡 Project thoughts in journals update the relevant project's wiki page (not the `projects/<slug>.md` markdown file — that's a separate write, owned by `project-updater`)
- [ ] 🟢 Reading insights tagged with `#book` or wikilinked to `[[book-title]]` get processed correctly

### Boundary enforcement
- [ ] 🔴 `wiki-compiler` does not write to `projects/*.md` during journal ingest (existing scope rule, verify under journal-shaped input)
- [ ] 🔴 `wiki-compiler` does not write to `world-view/`, `pages/playbook.md`, or other human-owned dirs
- [ ] 🟡 If `wiki-compiler` decides a journal mention warrants a project-page edit, it cites via `[[wikilink]]` rather than writing the file

## 2. KB-activity scanner (Phase 2)

### Log parsing
- [ ] 🔴 Empty log (no entries in window) returns empty digest cleanly (not an error)
- [ ] 🔴 Malformed log lines are skipped, not crashed on
- [ ] 🔴 `Skipped (duplicate)` and `Skipped (image-only)` entries are excluded from the digest body (collapsed into a count line)
- [ ] 🟡 Entries with non-empty `Pages touched` are included in the digest body
- [ ] 🟡 Entries are correctly grouped by category (entity / concept / topic / comparison) via file-path inspection of the wikilink targets
- [ ] 🟡 Entries are correctly classified as created vs. updated (heuristic: page existed in `knowledge/index.md` before vs. after the entry)
- [ ] 🟡 Date-window filter is inclusive at both ends (start and end dates count)
- [ ] 🟡 Date attribution: a re-ingest of an old journal counts in the *log entry's* week, not the original journal's week (documented edge case from spec)
- [ ] 🟢 Citation counts back to source raw files are accurate

### Integration with reviews
- [ ] 🔴 `extraPrepContext` (or equivalent) appends KB digest to prep context for `dynamic` post-agent reviews
- [ ] 🟡 When digest is empty, no section is added (no empty headers)
- [ ] 🟡 Monthly/quarterly/yearly windows pull the right log slices
- [ ] 🟢 Digest in prep context displays cleanly when surfaced in the interview

## 3. Project-updater KB-aware (Phase 2)

- [ ] 🔴 `project-updater` actually queries `kb_query` (or equivalent) when drafting weekly summaries — not just claims to
- [ ] 🟡 Returned KB pages are cited as `[[wikilinks]]` in the project summary
- [ ] 🟡 If KB query fails or returns nothing, project-updater still produces a summary (no hard dependency)
- [ ] 🟡 Updater doesn't query KB for projects not discussed in the review (no waste)
- [ ] 🟢 Summary length stays proportional — KB context informs but doesn't bloat the summary

## 4. Meeting notes structure (Phase 3)

> Action items are out of scope for v1 — Phase 3 covers attendees → CRM and decisions → Decisions Log only.

### Detection & extraction
- [ ] 🔴 Journal block with `#meeting` tag is detected and processed
- [ ] 🔴 Attendees extracted as `[[wikilink]]` references map to `pages/crm.json` entries
- [ ] 🟡 Decision lines (e.g., "Decision: ship X") are recognized and routed
- [ ] 🟡 Block boundaries are correctly identified — block ends at next major heading, large time gap, next `#meeting`, or end of journal
- [ ] 🟡 Empty `#meeting` blocks (no attendees, no decisions — just a reference) are skipped (no CRM/decisions writes); count surfaced in nightly TG summary

### Routing
- [ ] 🔴 CRM update appends source journal to attendee's `journal_refs` (no duplicates if same-date already present)
- [ ] 🔴 Decision lines get appended to the correct `projects/<slug>.md` Decisions Log when a project is tagged
- [ ] 🟡 Multiple meetings in one journal are handled independently — each iterated, attendees/decisions dispatched separately
- [ ] 🟡 Two meetings discussing the same project: decisions append in journal order
- [ ] 🟢 If no project tag is present, decisions are dropped with a log warning (not silently lost — surface in nightly TG summary)

## ~~5. KB-aware default chat (Phase 4)~~

> **Deferred to [Project 03 (Resolver & Self-Evolution)](../03-resolver/test-plan.md).** Section 1 of Project 03's test plan covers the resolver's routing decisions, including KB-shaped-message tests using the same matrix that originated here.

## 6. KB volume + decay (Phase 5)

- [ ] 🔴 `wiki-linter` flags pages with `valid-until` < today
- [ ] 🟡 `wiki-linter` flags orphaned pages (zero inbound `[[wikilinks]]`)
- [ ] 🟡 Lint report stays under TG message limit (chunking handled by existing `sendLongMessage`)
- [ ] 🟡 KB-activity digest summarization triggers above threshold (e.g., >50 entries)
- [ ] 🟢 Summarization preserves category structure (doesn't collapse into one paragraph)

## 7. Cross-phase regression

- [ ] 🔴 Existing reviews still pass all current tests (627 baseline)
- [ ] 🔴 Existing nightly pipeline still passes all current tests
- [ ] 🟡 KB ingestion of non-journal sources (Readwise, manual `/ingest`) still routes correctly after `determineRawDir()` changes
- [ ] 🟡 Worldview-drift detection still works after KB-activity scanner is added (no shared-state collision)
