# Reviews, KB Routing & Vault Memory

Detailed mechanics for the review→post-agent flow, the worldview/playbook write rules, KB raw-source routing, and the writer/product-team memory loops. `CLAUDE.md` carries the Vault Content Model table (the load-bearing conceptual model); the extensions and procedural detail live here.

---

## How Reviews Work

All reviews run through Rune (Telegram bot). They are **interview-based conversations**, not Claude generating summaries:

1. **Prep** — `journal-scanner` and `system-scanner` agents read silently in parallel; for `/weekly`, a worldview-drift check flags any active project whose thesis cites a recently-shifted world-view topic; pending playbook drafts (queued nightly from `#playbook` tags) are surfaced.
2. **Interview** — Conversation in Telegram covering memories, work, learning, reflection. Claude surfaces journal quotes, asks follow-ups, challenges narratives, surfaces pending drafts and worldview deltas for approval.
3. **Outline** — Claude presents a structured outline for approval. The outline is the approval surface for *all* downstream writes, including proposed worldview diffs and playbook drafts.
4. **Write-up + post-agents** — After approval, `review-writer` appends to today's journal, then specialist post-agents run in parallel: `project-updater` (writes `projects/*.md`), `playbook-updater` (appends approved drafts to `pages/playbook.md`), `worldview-updater` (applies approved diffs to `world-view/*.md` with changelog), `psychology-updater` (scoped updates to `pages/psychology.md`), `json-updater` (data stores). Files touched by the updaters are auto-enqueued for KB ingestion the same night.

### Review → post-agent flow

`src/reviews/interview.ts` drives review sessions. At outline-approval points the interview emits a structured approval signal via `sender.send(userId, text, { approval: { prompt, options } })`. On the webview this renders as clickable button rows; on Telegram the text is the fallback. After the user approves the outline:

1. `review-writer` appends the formatted review to today's journal.
2. Dynamic analysis (one-shot LLM call in `runWriteupAndUpdates`) decides which post-agents to run by producing `{projects, psychology, json_updates, worldview, playbook}` booleans.
3. Each post-agent runs in parallel. Failures and missing-agent errors are surfaced in the TG summary (not silent) — see `AGENT_NOT_FOUND_PREFIX` in `src/ai/claude.ts`.
4. Files touched by `project-updater` / `worldview-updater` / `playbook-updater` are auto-enqueued via `enqueueKB()` so the next nightly KB ingestion refreshes wiki citations.

### Worldview preservation — propose-only

`worldview-updater` only applies diffs that appeared in the user-approved outline. The interview surfaces proposed worldview changes inline for approval before the updater runs. This preserves first-person voice and prevents silent rewrites of convictions. The agent must edit additively and always append a `### [[YYYY_MM_DD]]` changelog entry.

### Nightly playbook extraction

`src/jobs/playbook-extract.ts` (wired into `src/jobs/nightly.ts` between `Daily tags` and `Whoop activity`) scans today's journal for `#playbook` tags. On hit, it calls the `playbook-proposer` agent to draft formatted entries and appends them to `logs/playbook-queue.json` with `status: 'pending'`. Pending drafts auto-surface in the prep context of the next dynamic review, where the user approves/rejects them.

### Worldview-drift flag

`src/reviews/worldview-drift.ts`: during weekly prep (`extraPrepContext` hook in `weekly.ts`), scans `world-view/*.md` changelog entries in the review window. For each recently-shifted topic, greps `projects/*.md` (excluding `archive/`) for citations and flags any project whose thesis references the shifted topic. Flagged projects are raised in the interview so the user can decide whether to re-examine the thesis.

---

## KB raw-source routing

`src/kb/ingest.ts` `determineRawDir()`:
- `Readwise/*` → `knowledge/raw/articles/`
- `journals/*` → `knowledge/raw/journals/`
- `world-view/*` → `knowledge/raw/world-view/`
- `pages/playbook.md` → `knowledge/raw/playbook/`
- `projects/*` (excluding `projects/archive/`) → `knowledge/raw/projects/`
- `library/lenny/*` → `knowledge/raw/lenny/` (mutable — Lenny posts can be re-published upstream)
- `library/lennys-podcast/*` → `knowledge/raw/lenny/` (legacy folder; immutable — one-time backfill)
- `library/graham-essays/*` → `knowledge/raw/articles/` (immutable — one-time backfill)
- anything with `conversation` in the path → `knowledge/raw/conversations/`
- fallback → `knowledge/raw/notes/`

Mutable sources (world-view, playbook, active projects, journals, library/lenny) **overwrite** the `raw/` copy on every re-ingest (see `isMutableSource()`) so wiki citations reflect current content. Immutable sources (Readwise, conversations, library/lennys-podcast, library/graham-essays) are copied once.

---

## Writing voice

`writing/voice.md` is the user-authored source of truth for Rune's writing voice. `src/vault/voice.ts` exposes `buildVoicePromptSection()`, which re-reads the file on every call (no cache) so edits take effect without a restart; content is truncated at `VOICE_PROMPT_CHAR_BUDGET` (8000 chars). The four Claude entry points in `src/ai/claude.ts` — `askClaude`, `askClaudeOneShot`, `runAgent`, and `askClaudeWithContext` (options-bag form: `{ voice: true }`) — each accept an optional `voice` flag (default `false`). When `true`, the block is appended to the system prompt (`--append-system-prompt`).

**Opted in** (prose the user reads): `handleConversation` (TG/webview chat), `/ask`, `summarizeSession` (/fresh + nightly capture), `morning-prep`, the blog/health/interview/new-project review sessions, the `review-writer` agent, `kb-query`, and the prose-writing post-agents `project-updater`, `worldview-updater`, and `psychology-updater`.

**Deliberately not opted in** (structured / classifier output): resolver Haiku, content-triager, photo-classifier, meeting/book extract, the review-routing one-shot JSON extract, wiki-compiler, wiki-linter, `json-updater`, `playbook-updater`, `proposal-updater`, and prep agents (journal-scanner, project-scanner, system-scanner). These stay deterministic.

## Writer-role memory (project 12)

The `/blog` flow layers a writer-role identity on top of the voice prompt. `src/reviews/blog.ts` calls `composeWriterContext(buildBaseInstructions(topic))` (from `src/writer/memory.ts`) before the first Claude turn. The SOUL charter (`agents/writer/SOUL.md`) is prepended to the base blog instructions on the system channel (`--append-system-prompt`). The accumulating craft lessons (`agents/writer/memory.md`) ride the first user turn inside a `<writer-memory>` fence — never the system channel — so they carry reference weight rather than rule weight; on any SOUL ↔ memory conflict, SOUL governs. Only `systemInstructions` (SOUL + base, no memory text) is persisted as `prepContext`. Cold start (missing files) degrades gracefully to voice-only behavior.

**Closure + capture loop (Phase 2):** the writer ends a finished piece with a fenced `writer-memory-candidates` block then the `[[WRITER_MEMORY_COMPLETE]]` sentinel on its own final line. `blogHandler.handleMessage` runs `detectCompletionSentinel` (`src/writer/sentinel.ts`) on every assistant turn; on a final-line sentinel it strips it from the reply, then runs `captureLessons` (`src/writer/capture.ts`) — fault-isolated and 20s-timeout-bounded. `captureLessons` (serialized against itself per-process) gates on `feedbackSeen`, privacy-filters, dedupes, provenance-stamps, appends to `memory.md`, and commits via `commitWriterMemory` (`src/writer/commit.ts`, on-`main`-only, memory.md-only, no push). Capture auto-commits with no approval gate. The loop closes: a lesson captured on piece N loads into piece N+1's `referenceContext`.

## Product-team roles (project 14)

`src/roles/loader.ts` generalizes the writer-role loader pattern to six product-team roles (pm, tech-lead, qa, coder, reviewer, designer). Each role has a SOUL charter and a `memory.md` under `agents/<role>/`. The same two-channel authority boundary applies: SOUL.md → system-prompt, memory.md → low-authority reference fence.

**Learning loop (Phase 6):** the nightly `stepLearningLoop` in `src/jobs/nightly.ts` closes the build loop with a feedback-to-memory cycle. Feedback records are submitted as machine-readable JSONL to `logs/feedback.jsonl` (validated by `src/intent/feedback-record.ts`; required fields: projectSlug/source/createdAt/issueSummary/evidence). Each night the step reads unprocessed records (content-hash dedup via `logs/feedback-processed.json` — exactly-once, per-pass cap of 20, 60s per-record timeout). For each valid record `runPostMortem` (`src/intent/postmortem.ts`) makes a neutral `askClaudeOneShot` call and parses a fenced `postmortem` JSON block: `{kind:'lesson', stage, role, lesson}` or `{kind:'no-lesson', rationale}`. Role and stage are validated against the closed `ROLE_NAMES`/`ROLE_STAGES` rosters — an invalid/unparseable result fails safe to no-lesson, never a fabricated lesson. A `lesson` attribution is handed to `writeRoleLesson` (`src/roles/memory-writer.ts`): privacy-filtered, dedup'd, appended as `- [YYYY-MM-DD · source: <slug>] <lesson>`, committed in one atomic `commitRoleMemory` call (pathspec-scoped, on-main guard, no push). The pure `runLearningLoop` composer (`src/intent/learning-loop.ts`) orchestrates over injected `{readFeedback, attribute, writeLesson}` seams. These commits are independent of the vault final commit and are never self-merged.

---

## Vault Content Model — full reference

The vault has four LLM-mutable content layers with **different write semantics**. They stay distinct on purpose — each has its own cadence, tone, and audit trail. Collapsing them would force one schema to handle conflicting temporal models (wiki pages decay; convictions evolve with audit trail; playbook is append-only; projects are living logs).

| Layer | Write semantics | Updater agent | Trigger |
|---|---|---|---|
| `knowledge/` | Wiki with `last-verified` + `valid-until` — pages decay | `wiki-compiler` | KB ingestion queue (nightly + on-demand) |
| `world-view/*.md` | First-person essays with `### [[YYYY_MM_DD]]` changelog — beliefs evolve with audit trail | `worldview-updater` | Review outline approval (propose-only, never auto-writes) |
| `pages/playbook.md` | Append-only tactical entries with stable `<slug>-<YYYY-MM-DD>` anchors | `playbook-proposer` + `playbook-updater` | `#playbook` journal tag → nightly queue → next review approval |
| `projects/*.md` | Living logs: status + dated thesis + decisions log + weekly summaries | `project-updater` | Review outline approval (authoritative) |

Plus `pages/psychology.md` (living profile, updated by `psychology-updater` with scope gradient: `observation` / `pattern_check` / `reassessment` / `full_rewrite`) and JSON data stores (`pages/{books,crm,places}.json`, `health/workouts.json`, `career/applications.json`, `investments/investments.json`, `study/progress.json`) updated by `json-updater`.

**Relationship:** `knowledge/` is the neutral reference layer and *cites* the other three as raw sources (via `knowledge/raw/{world-view,playbook,projects}/`). The flow is one-way — human-authored layers feed the KB as sources; the KB does not own them.
