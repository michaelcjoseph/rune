# Note Triage Specification

## Overview

Nightly processing reads today's journal and files forward-looking items where they belong:
ideas for an existing registered product into that product repo's `docs/projects/ideas.md`,
bugs into that repo's `docs/projects/bugs.md`, ideas for products that don't exist yet into
the vault's `projects/ideas.md`, and writing/research topics into the writing product's
scoped docs in michaelcjoseph.com (`docs/rune/writing-ideas.md`, `docs/rune/research-topics.md`).

Before this project, the Daily-tags step filed ideas and writing topics only into vault-global
files (`projects/ideas.md`, `writing/topics.md`) with no product routing, and no bug lane
existed at all. Items rotted in a single undifferentiated list instead of landing on the
product backlog the cockpit already reads.

### Core Value Proposition

Write a thought in the journal once; the right backlog has it by morning — already visible in
the cockpit backlog drawer for repo-backed products, with no manual sorting.

### Decisions (operator-confirmed)

- **Input:** today's journal only, passed in by `executeNightly` (journal read exactly once).
- **Write mode:** direct filing, no approval queue — the cockpit backlog drawer is the review
  surface before anything is planned or executed.
- **Topics:** two files, `writing-ideas.md` (writing/blog material) and `research-topics.md`
  ("look into X" material), both under the writing product's `scopePath` (`docs/rune`).
- **Supersession:** writing topics no longer flow to vault `writing/topics.md`; vault
  `projects/ideas.md` remains the home only for new-product ideas. Daily-tags keeps only
  `health/nutrition.md` on the markdown side.
- **Product identification:** vault `projects/<name>.md` pages map 1:1 to products of the same
  name where one exists. A deterministic journal wikilink scan produces prompt hints (pages
  with a registered product labeled as routing hints; pages without one explicitly labeled
  non-products). The LLM may also infer a product contextually, but every claimed product is
  re-validated against `policies/products.json` via `resolveProductTarget` — an invented name
  degrades to the vault new-product path.
- **Unroutable bugs** (null/unknown product, or `bugs: false` like writing) fail closed to the
  vault ideas file with a `[Bug — unrouted]` marker — durable and review-surfaced, not an
  ephemeral step-detail note.
- **No git commits to product repos** — machine filings leave working trees dirty for operator
  review (matches `fileTerminalBugsToBacklog`). Vault writes ride nightly's final commit.

### Trust boundary

The journal is untrusted input to an LLM whose output drives writes to tracked files. The
extraction agent is **tool-less** (`tools: []`), the journal is delimited with an
ignore-embedded-instructions rule, output is capped at 20 items/pass with single-line
discipline enforced by the parser, and write targets are constrained by two allowlist guards
(`assertBacklogWriteAllowed` for `docs/projects/{ideas,bugs}.md`; the new
`assertScopedTopicWriteAllowed` for the two topic basenames under the writing product's
scopePath). Topics are synthesized one-liners, never verbatim journal copies (the writing
product's privacy boundary).

### Non-Goals

- Sweeping vault notes beyond the day's journal (a modified-file tracker is out of scope).
- Cockpit surfacing for `research-topics.md` (writing-ideas.md surfaces automatically via the
  existing `WRITING_IDEAS_REL` reader; research topics are file-only for now).
- Any change to the observation loop's Loop-filed idea path or the `log_idea` MCP tool.

## Architecture

- **Pure core** — `src/intent/note-triage.ts`: agent-output validation
  (`parseNoteTriageOutput`), routing (`routeNoteItems`), wikilink hints
  (`extractProjectPageHints`), append/dedupe helpers (`appendVaultIdeaBlocks`,
  `appendTopicLines`, `containsNoteTitle`).
- **Runtime adapter** — `src/jobs/note-triage.ts` (`runNoteTriage`): products config first
  (fail closed), prompt composition, one retry on agent error/invalid JSON, per-target-file
  guarded writes with fault isolation, audit rows to `logs/backlog-mutations.jsonl`.
- **Agent** — `.claude/agents/note-triage.md`: tool-less sonnet extractor, strict JSON array.
- **User surface** — trigger: the nightly cron (step 7, "Note triage", after Registry
  rebuild); discovery/observation: the nightly summary step detail (per-target counts) and
  the cockpit backlog drawer where filed items appear.
