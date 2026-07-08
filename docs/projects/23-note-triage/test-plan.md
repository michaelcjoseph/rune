# Note Triage — Test Plan

Trust-boundary rows are listed first, per the planning-checklist queued lesson (LLM over
untrusted input committing to tracked files).

## Trust boundary / scale

- [x] **Input length cap** — journal truncated at 50 000 chars before the prompt
      (`runNoteTriage`; same constant as Daily-tags).
- [x] **Output cap** — at most 20 items accepted per pass (`MAX_ITEMS_PER_PASS`), malformed
      elements dropped without failing the pass (`parseNoteTriageOutput` unit tests).
- [x] **Prompt-injection containment** — tool-less agent (`tools: []`), delimited journal with
      ignore-embedded-instructions rule (prompt-content test), single-line discipline
      (whitespace-collapse tests), and deterministic re-validation: an LLM-claimed
      unregistered product degrades to the vault path (routing test); write targets are
      allowlist-guarded (security tests: traversal, symlinked scope dir, wrong basename,
      non-relative scopePath).
- [x] **Exactly-once / idempotency** — nightly `daily-processed` marker gates the pass;
      per-target normalized-title dedupe + in-batch seen-set make a forced identical re-run a
      no-op everywhere (I/O test: second run appends nothing, no new audit rows).
- [x] **Per-item fault isolation** — a failing target file (e.g. missing repo) is counted and
      reported while every other target still lands; step error never aborts the nightly
      (I/O test + nightly error-isolation test).
- [x] **Path scrubbing** — failure detail is scrubbed via `scrubAbsolutePaths` before it
      reaches the step summary (I/O test asserts no tmpdir root leaks).

## Pure core (`src/intent/note-triage.test.ts` — 28 tests)

- [x] Parse: bare/fenced JSON, non-array rejection, malformed-element drop, whitespace
      collapse, blank product → null, oversized-field drop, batch cap.
- [x] Routing: registered idea → product plan; case-insensitive match; null/unknown → vault;
      writing idea → writing topic coercion; bug → bugs.md; unroutable bug → vault marker;
      topics → scoped files; no-writing-product skip; ideas-disabled → vault.
- [x] Hints: registered page → product, non-product page → null, alias/heading wikilink forms,
      case-insensitivity, dedupe, no plain-text false hits.
- [x] Appends: vault blocks insert before `## Supersession audit`, heading creation, on-disk +
      in-batch dedupe, unchanged-content no-op; topic lines seed header, dedupe, and
      round-trip through `parseIdeas` as open user-authored ideas (cockpit visibility pin).

## Runtime adapter (`src/jobs/note-triage.test.ts` — 11 tests)

- [x] Happy path: all five item kinds land in their five targets; 4 audit rows with
      branch/dirty; git only ever read (rev-parse/status) — never commit.
- [x] `docs/rune/` + topic files created on first write with headers.
- [x] Fail-closed: empty journal skips before config/LLM; unreadable products config errors
      before the agent call; agent error/invalid JSON retried once then zero writes; empty
      array → skipped.
- [x] Prompt content: product table, hint lines (registered + non-product), journal delimiters.

## Nightly integration (`nightly.test.ts` / `nosleep` / `knowledge-reachability`)

- [x] 18-step snapshot with 'Note triage' at position 7; positional index shifts.
- [x] Step result propagation; error isolation (pipeline continues to Mark processed).
- [x] Note triage runs after Registry rebuild (`invocationCallOrder`).
- [x] Daily-tags narrowing: nutrition still routes to daily-content-updater; an ideas/topics
      analysis no longer routes (skipped, zero updater calls); abort-path fixture moved to
      `#diet`.
- [x] Narrow-mock suites: note-triage module mocked in nosleep (execFile edge) and
      knowledge-reachability (no PRODUCTS_CONFIG_FILE in its config mock).

## Integration verification (live operator gate)

> With real journal lines (a product idea for a known product, a bug for a known product, a
> new-product idea, a writing topic, a research topic), a forced nightly run files each to its
> target: the product idea/bug appear in that repo's `docs/projects/{ideas,bugs}.md` AND in
> the cockpit backlog drawer; `docs/rune/writing-ideas.md` + `research-topics.md` exist in
> michaelcjoseph.com with synthesized bullets; the vault `projects/ideas.md` gains the
> new-product `###` block above `## Supersession audit`; `logs/backlog-mutations.jsonl` has
> one row per repo write; `git status` in the product repos shows dirty-not-committed; a
> second forced run appends nothing. Tracked as the unchecked live gate in tasks.md.
