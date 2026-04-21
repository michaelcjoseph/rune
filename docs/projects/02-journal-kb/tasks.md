# Journal-KB Integration — Tasks

Not started. See [spec.md](spec.md) for details.

## Phase 1 — Daily journal ingestion

- [ ] Extend `determineRawDir()` in `src/kb/ingest.ts` to route `journals/*.md` → `knowledge/raw/journals/`
- [ ] Extend `isMutableSource()` to include `journals/` (so re-ingestion of edited journals overwrites the raw copy)
- [ ] Add `stepJournalIngest` to `src/jobs/nightly.ts` (enqueues today's journal; runs before the KB queue step so the journal is ingested in the same nightly pass)
- [ ] Reorder nightly steps so KB queue runs after journal ingest (or add a second KB queue pass at the end)
- [ ] Update `.claude/agents/wiki-compiler.md` with a "Journal-shaped sources" subsection: skip timestamps and casual asides, focus on people/decisions/concepts, update existing pages additively
- [ ] Verify `wiki-compiler` does not write to `projects/*.md` (boundary check — already enforced but confirm under journal-ingest path)
- [ ] Surface ingest counts in nightly TG summary
- [ ] Tests: routing, mutable behavior, nightly ordering, scope-boundary enforcement
- [ ] End-to-end smoke test: write meeting + reading + project thought into a journal, trigger nightly, confirm KB pages updated and `projects/*.md` untouched by `wiki-compiler`

## Phase 2 — KB-activity scanner + project-updater KB-aware

- [ ] Create `src/reviews/kb-activity.ts` with `scanKBActivity(startDate, endDate)` and a `formatKBActivity()` markdown formatter
- [ ] Parse `knowledge/log.md` entries via the regex documented in spec (`^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] \[INGEST\]`); capture status + `Pages touched` line
- [ ] Distinguish "ingested with new content" (Pages touched non-empty) from "Skipped (...)"; surface only the former in the digest body, collapse skips into a count line
- [ ] Resolve wikilinks in `Pages touched` to category (entities / concepts / topics / comparisons) by file-path inspection
- [ ] Group digest by category and direction (created vs. updated)
- [ ] Wire digest into `src/reviews/interview.ts` via `extraPrepContext` hook (per-review-type) or in `start()` for all dynamic reviews; suppress the section if empty
- [ ] Update `.claude/agents/project-updater.md` to require `kb_query` for project-related entities/concepts before drafting summaries, and to cite results with `[[wikilinks]]`
- [ ] Tests: log parsing (well-formed, malformed, skipped, empty window), skipped-vs-touched discrimination, digest formatting, integration with weekly prep
- [ ] End-to-end smoke test: run `/weekly` after a week of ingestion; confirm KB activity is surfaced in the interview and project summaries cite wiki pages

## Phase 3 — Meeting notes structure

**Scope:** attendees → CRM, decisions → Decisions Log. Action items are out of scope for v1.

- [ ] Create `src/jobs/meeting-extract.ts` with `extractMeetings(content, date)` using `askClaudeOneShot` + structured-output prompt
- [ ] Define `Meeting` type: `{attendees: string[], project: string | null, decisions: string[]}`
- [ ] Extractor must handle multiple meetings per journal — returns an array
- [ ] Extractor must identify meeting block boundaries holistically (LLM-based, not regex) — start at `#meeting`, end at next major heading / large time gap / next `#meeting` / end of journal
- [ ] Extractor must skip `#meeting` blocks that are empty (no attendees, no decisions — likely a reference, not a transcription)
- [ ] Add `stepMeetingExtract` to `src/jobs/nightly.ts` after `stepJournalIngest`, iterating over all meetings returned
- [ ] Wire attendees → `json-updater` for CRM updates; dedup `journal_refs` so same-day add doesn't duplicate
- [ ] Wire decisions → project Decisions Log append (lightweight helper or via `project-updater` invocation for the tagged project)
- [ ] Tests: meeting detection, attendee extraction with wikilinks, decision routing to correct project, multiple meetings per journal, block boundary detection, empty-block skip
- [ ] End-to-end smoke test: write `#meeting` block with attendees + decisions, trigger nightly, confirm CRM dedup + project decision append

## ~~Phase 4 — KB-aware default chat~~

> **Deferred to [Project 03 (Resolver & Self-Evolution)](../03-resolver/tasks.md).** Phase 4's design assets are carried into Project 03's Resolver. No deliverables in this project.

## Phase 5 — KB volume + decay

- [ ] Extend `.claude/agents/wiki-linter.md` to flag pages with expired `valid-until`
- [ ] Extend `wiki-linter` to flag orphaned pages (no inbound `[[wikilinks]]`)
- [ ] Add summarization layer to `src/reviews/kb-activity.ts` — when digest exceeds threshold, run a one-shot summarizer instead of raw output
- [ ] Tests: lint detects expired and orphaned pages; summarizer triggered above threshold
- [ ] End-to-end smoke test: backdate a `valid-until` on a wiki page; run lint; confirm flag appears in report
