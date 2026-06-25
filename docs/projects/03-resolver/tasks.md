# Resolver & Self-Evolution — Tasks

Not started. See [spec.md](spec.md) for details.

## Phase A — Independent foundation

> Parallel-safe with Project 02. None of these touch code paths that Project 02 modifies.

### Skill evals MVP (#7)

- [x] Create `evals/` directory with `README.md` documenting the YAML schema (agent, fixtures with input + assertions; assertion types: substring, citation_present, max_length_chars, json_shape, regex)
- [x] Add `scripts/run-evals.ts` that loads YAML, invokes agent via `runAgent()`, runs assertions, prints per-fixture pass/fail breakdown, exits non-zero on any fail
- [x] Add `npm run evals` entry to `package.json`; support `npm run evals -- <agent-name>` for single-agent runs and `npm run evals -- --dry-run` to validate YAML without API calls
- [x] Write 2–3 sample evals (`evals/wiki-compiler.yaml`, `evals/kb-query.yaml`, `evals/content-triager.yaml`) — each with at least one fixture
- [x] Add eval-pass requirement to `/work` skill done checklist (lightweight reference, no CI gate yet)

### `/learn` (#8)

- [x] Add `src/bot/commands/learn.ts` (`/learn <text>` appends `{ts, text}` JSON line to `vault/learnings.jsonl`; empty text → usage hint)
- [x] Add `src/bot/commands/learn-list.ts` (echo current prepended learnings, capped at the same N as runtime)
- [x] Register both commands in `src/bot/handlers/text.ts`
- [x] Extend `src/ai/claude.ts:runAgent` to read tail of `vault/learnings.jsonl` and prepend to agent prompt under `## Learnings` heading; cap at N most recent (default 20) by token budget
- [x] Tests: append happy path, file-missing case, prepend ordering, token-budget cap

### Skill-frontmatter cron (#6)

- [x] Extend `src/ai/claude.ts:loadAgentDef` frontmatter parser to read optional `cron`, `cron_args`, `cron_chat`, `triggers` fields
- [x] In `src/jobs/scheduler.ts:startScheduler`, scan all agent files (Rune + vault) and register a generic `runAgent(name, cron_args ?? '')` job per agent with a `cron:` field
- [x] On invocation: if `cron_chat: true`, post output to TG; otherwise log only
- [x] Validate cron expression at registration; bad expression → log error and skip (don't crash)
- [x] Tests: cron parsing, registration, invocation routing (chat vs log), bad-expression handling

### Ask-Twice telemetry harness (#2 part 1)

- [x] Add `src/utils/intent-log.ts` exporting `appendIntent(entry: IntentLogEntry): void` (JSONL append to `logs/intent-log.jsonl`)
- [x] Define `IntentLogEntry` type: `{ts, intent, args, confidence, outcome, skill_invoked}`
- [x] Tests: append, file rotation safety (don't truncate on concurrent writes)

## Phase B — Resolver

> Depends on: Phase A (intent-log harness in place; eval framework ready for resolver fixtures)

### Skill registry

- [x] Create `src/bot/skill-registry.ts` exporting `getSkillRegistry(): SkillEntry[]`
- [x] Pull entries from: agent files with `triggers:` frontmatter, slash commands (with one-line description metadata), and the carried-forward `kb_query` intent (KB-shaped matrix as few-shot examples)
- [x] Cache the registry at startup; expose `reloadSkillRegistry()` for future hot-reload

### Resolver

- [x] Create `src/bot/resolver.ts` exporting `classifyIntent(message, registry): { skill, args, confidence }`
- [x] Implement single Haiku call with the message + compact registry; structured-output prompt returns JSON
- [x] Default confidence threshold: 0.7 (configurable via env)
- [x] Add `classifyIntent` thin wrapper in `src/ai/claude.ts`
- [x] Wire into `src/bot/handlers/text.ts`: insert between active-session check and freeform fallback. Skip for slash commands, active sessions, messages < 5 words
- [x] On every resolver call: append to intent log via `appendIntent()` regardless of routing outcome
- [x] On confidence < threshold: fall through to freeform handler
- [x] On routed-skill failure: log to intent-log with `outcome: 'failed'`; reply via existing freeform fallback
- [x] On ambiguous top-2 within 0.05 confidence: fall through with note "Couldn't tell if you meant /X or /Y"

### Resolver evals

- [x] Create `evals/resolver.yaml` with the carried-forward KB-shaped/non-KB matrix as direct fixtures (8 entries)
- [x] Add additional fixtures covering routing to other skills (journal append, /family, /weekly, etc.)
- [x] Assert: classified skill matches expected, confidence ≥ threshold for clear cases

### Ask-Twice scan job (#2 part 2)

- [x] Create `src/jobs/intent-scan.ts` exporting `runIntentScan(bot)` — reads last 30 days of intent log, groups by intent shape via Haiku, emits proposals to `logs/proposal-queue.json` (`{type: 'skill_or_cron', title, rationale, suggested_skill, suggested_cron, status: 'pending'}`)
- [x] Cap proposals at 3 per scan; dedupe against existing skill registry; validate any cron expression in proposals
- [x] Register the job via skill-frontmatter cron (eat the dogfood) — add a thin `intent-scan` agent file with `cron: "0 15 * * 6"` (Saturday 3pm)
- [x] Extend `src/reviews/interview.ts` prep context to include pending proposals (analogous to playbook queue)
- [x] Extend post-review agent flow: when a proposal is approved, the relevant updater creates the skill file or registers the cron via frontmatter edit
- [x] Tests: scan over a synthetic intent log, dedupe behavior, proposal validation, prep-context integration

## Phase C — KB optimizations

> Depends on: Project 02 Phases 1–3 + 5 fully shipped. Do not start until journals are being ingested nightly and KB-activity scanner is in production.

### Entity auto-linking (#3)

- [x] Create `src/kb/entity-extract.ts` exporting `linkEntities(pagePath, content): { related: string[], updatedContent: string }`
- [x] Build alias map from `pages/crm.json`, `pages/books.json`, `pages/places.json`, `FAMILY_NAMES` env var; longest-first ordering for matching
- [x] Word-boundary, case-aware regex matching (capitalized first letter required for personal names to avoid "Stripe" → "stripes")
- [x] Append matched canonical paths to page's `related:` frontmatter (deduped)
- [x] Replace bare mentions inside fenced "References" / "See also" sections only (do NOT mangle prose)
- [x] Hook into `src/kb/ingest.ts` after `wiki-compiler` returns; merge frontmatter, write page back
- [x] Tests: alias precedence, word-boundary edge cases, References-only replacement, no-match no-op, missing-canonical-page skip

### Source hierarchy + checkpoints (#4)

- [x] Extend `src/kb/queue.ts` with `priority` field and `getPriority(sourcePath): number` derivation: `world-view` and `journals/*` (top tier) > `pages/playbook.md` > `projects/*` > Readwise > conversations > notes
- [x] Modify `src/kb/engine.ts:processIngestionQueue` to process in priority order; track ingestion count
- [x] Every 15 ingestions: invoke `wiki-linter`, append checkpoint summary to `knowledge/log.md` with a stable shape (e.g. `[YYYY-MM-DD HH:MM] [CHECKPOINT] ...`)
- [x] Backward-compat tweak in Project 02's `src/reviews/kb-activity.ts` parser to skip `[CHECKPOINT]` entries
- [x] Tests: priority ordering, checkpoint trigger at boundary, log format, scanner skip-checkpoint compatibility

### ~~Hybrid search (#5)~~

Deferred to `docs/projects/ideas.md`. Revisit when the KB has 100+ pages
across varied domains and synonym/paraphrase misses become a felt
problem. Pulling in `better-sqlite3` + `sqlite-vec` native deps (and
likely an external embedding model) isn't justified at current vault
scale.

## Cross-phase

- [x] Update CLAUDE.md `Agents` section if any new runtime agents are added (resolver-classifier, intent-scan, etc.)
- [x] Update CLAUDE.md `Project Structure` section as new files land
- [x] Update `docs/projects/index.md` status for this project as phases ship
