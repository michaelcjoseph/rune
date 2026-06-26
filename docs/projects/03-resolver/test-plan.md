# Resolver & Self-Evolution Test Plan

Error handling checklist for the Resolver, Ask-Twice telemetry, skill-frontmatter cron, eval framework, `/learn`, entity auto-linking, compilation checkpoints, and hybrid search.

> See also: existing tests in `src/bot/handlers/text.test.ts`, `src/jobs/scheduler.test.ts`, `src/kb/*.test.ts`.

## Priority Levels

- 🔴 **Critical**: Blocks the loop — Telegram becomes unresponsive, agent runs crash, KB ingest breaks.
- 🟡 **High**: Degrades the workflow — wrong skill routed, missed proposals, eval false-pass.
- 🟢 **Low**: Cosmetic or rare — log formatting, edge-case routing.

## 1. Resolver (Phase B)

### Routing decisions

- [ ] 🔴 KB-shaped messages from the carried-forward matrix (e.g. "What did Fred Wilson say about glp-1?") classify as `kb_query` with confidence ≥ threshold
- [ ] 🔴 Non-KB messages from the matrix (e.g. "What time is sunset?", "Add this to my journal") do NOT classify as `kb_query`
- [ ] 🔴 Slash commands skip the resolver entirely (no extra Haiku latency on `/weekly`, `/kb`, etc.)
- [ ] 🔴 Active review-session messages skip the resolver (session takes priority)
- [ ] 🔴 Messages < 5 words skip the resolver
- [ ] 🟡 Confidence < threshold falls through to existing freeform conversation handler (no behavior change)
- [ ] 🟡 Routed-skill failure logs `outcome: 'failed'` and replies via freeform fallback (user is never silent-failed)
- [ ] 🟡 Ambiguous top-2 within 0.05 confidence falls through with note "Couldn't tell if you meant /X or /Y"
- [ ] 🟢 Resolver latency stays under 1s on Haiku for typical messages

### Registry

- [ ] 🔴 New agent file with `triggers:` frontmatter is included in registry on next startup (no code change)
- [ ] 🟡 Registry entries cover slash commands with their description metadata
- [ ] 🟡 `kb_query` intent is present using the carried-forward matrix as few-shot examples
- [ ] 🟢 Duplicate skill names (Rune + vault override) resolved per existing `loadAgentDef` precedence

### Intent log

- [ ] 🔴 Every resolver call appends one JSON line to `logs/intent-log.jsonl` regardless of outcome
- [ ] 🔴 Concurrent writes from multiple TG messages don't truncate or interleave malformed JSON
- [ ] 🟡 Log entry includes `{ts, intent, args, confidence, outcome, skill_invoked}`
- [ ] 🟢 Log file rotation behaves correctly (or no rotation needed at expected volume — document the choice)

## 2. Ask-Twice telemetry (Phase B part 2)

### Scan job

- [ ] 🔴 Empty intent log returns no proposals, no error
- [ ] 🔴 Scan reads exactly the last 30 days of intent log
- [ ] 🟡 Repeated intents (≥ 3 occurrences in window) surface as proposals
- [ ] 🟡 Proposals capped at 3 per scan
- [ ] 🟡 Existing skills (already in registry) are deduped — no proposal for something we already have
- [ ] 🟡 Cron expressions in proposals are syntactically valid before write
- [ ] 🟢 High-volume chatter (user just chats a lot) does not generate proposals — proposer prompt distinguishes "asked for the same kind of thing" from "chatted a lot"

### Review integration

- [ ] 🔴 Pending proposals appear in dynamic-review prep context alongside playbook drafts
- [ ] 🔴 When user approves a proposal, the post-review agent creates the skill file or registers the cron
- [ ] 🟡 When user rejects, proposal status updates and it doesn't re-surface
- [ ] 🟡 No proposals → no empty section in prep
- [ ] 🟢 Approved proposals' resulting skill files include reasonable defaults (description, triggers, body skeleton)

## 3. Skill-frontmatter cron (Phase A)

### Frontmatter parsing

- [ ] 🔴 Agent file with valid `cron:` field registers a job at startup
- [ ] 🔴 Invalid cron expression logs error and skips registration (does NOT crash scheduler)
- [ ] 🟡 `cron_args` is passed to `runAgent`
- [ ] 🟡 `cron_chat: true` posts output to TG; absent or false → log only
- [ ] 🟡 Two agents with same name (Rune + vault) — cron registers using whichever wins per `loadAgentDef` precedence
- [ ] 🟢 Removed agent file → cron unregistered on next restart (no hot reload needed)

### Execution

- [ ] 🔴 Scheduled invocation calls `runAgent(name, cron_args)` correctly
- [ ] 🔴 Failed agent run logs error but doesn't crash scheduler
- [ ] 🟡 `cron_chat: true` with no TG bot wired → log warning, fall back to log-only

## 4. Skill evals MVP (Phase A)

- [ ] 🔴 `npm run evals` invokes each agent against fixtures and reports pass/fail
- [ ] 🔴 Any failed assertion → script exits non-zero
- [ ] 🟡 `npm run evals -- <agent-name>` runs only that agent's evals
- [ ] 🟡 `npm run evals -- --dry-run` validates YAML and counts calls without invoking agents (cost control)
- [ ] 🟡 Malformed eval YAML is skipped with clear error; other evals continue
- [ ] 🟡 Agent invocation timeout marks eval failed with timeout reason; continues to next eval
- [ ] 🟢 Per-fixture breakdown is readable in terminal output
- [ ] 🟢 Each assertion type works: substring, citation_present, max_length_chars, json_shape, regex

## 5. `/learn` (Phase A)

### Command

- [ ] 🔴 `/learn <text>` appends `{ts, text}` JSON line to `vault/learnings.jsonl`
- [ ] 🟡 Empty `/learn` with no args replies with usage hint, does not append
- [ ] 🟡 `/learn-list` echoes the current prepended learnings (the same N applied at runtime)
- [ ] 🟢 Confirmation reply on success

### Runtime prepend

- [ ] 🔴 Every `runAgent()` invocation prepends the most recent N learnings under `## Learnings` heading
- [ ] 🔴 Missing learnings file → no prepend, no error
- [ ] 🟡 Token budget cap enforced — oldest learnings dropped from prepend; full file remains intact
- [ ] 🟡 Conflicting learnings (two contradictory entries) — no auto-resolution; both passed through (user's responsibility)
- [ ] 🟢 Prepend ordering: most recent last (so it has the most weight in the prompt)

## 6. Entity auto-linking (Phase C)

### Matching

- [ ] 🔴 Known entity name in compiled wiki content gets added to `related:` frontmatter (deduped)
- [ ] 🔴 Unknown name (not in alias map) is ignored
- [ ] 🟡 Word-boundary matching prevents "Stripe" → "stripes" false positives
- [ ] 🟡 Capitalized first letter required for personal names (no false-match on lowercase common words)
- [ ] 🟡 Multiple aliases for same entity ("Patrick", "Patrick Collison") matched longest-first
- [ ] 🟡 References / See-also fenced section gets bare mentions converted to `[[wikilinks]]`
- [ ] 🟡 Prose mentions are NOT auto-rewritten (voice intact)
- [ ] 🟢 No-match case is a no-op (page unchanged)
- [ ] 🟢 Entity has no canonical wiki page yet → skipped (creating new pages is `wiki-compiler`'s job)

### Integration

- [ ] 🔴 Hook runs only after `wiki-compiler` returns successfully
- [ ] 🔴 Frontmatter merge preserves existing `related:` entries
- [ ] 🟡 Compatible with journal-derived pages (post-Project-02): same hook works regardless of source path

## 7. Compilation checkpoints + source hierarchy (Phase C)

### Priority

- [ ] 🔴 Queue processed in priority order: `world-view` and `journals/*` (top tier) before `pages/playbook.md`, `projects/*`, Readwise, conversations, notes
- [ ] 🟡 Legacy queue entries without `priority` field default to lowest priority
- [ ] 🟢 Priority field surfaced in queue inspection (for debugging)

### Checkpoints

- [ ] 🔴 Every 15 ingestions, `wiki-linter` is invoked
- [ ] 🔴 Linter failure does NOT block the queue (non-blocking checkpoint)
- [ ] 🟡 Checkpoint summary appended to `knowledge/log.md` with stable `[CHECKPOINT]` marker
- [ ] 🟡 Project 02's KB-activity scanner skips `[CHECKPOINT]` entries gracefully (backward-compat parser tweak verified)
- [ ] 🟢 Empty queue at scheduled time skipped silently

## 8. Hybrid search (Phase C)

### Embedding ingest

- [ ] 🔴 Each compiled wiki page is embedded and persisted to `logs/kb-vectors.sqlite`
- [ ] 🔴 Embedding API failure → page is committed without embedding; backfill on next ingest cycle
- [ ] 🟡 sqlite-vec extension fails to load → fall back to ripgrep-only with startup warning (don't crash)
- [ ] 🟢 Re-ingest of mutable source updates the embedding (no orphan vectors)

### Search

- [ ] 🔴 `--hybrid` flag (or feature flag) routes through `search-hybrid.ts`; default off initially behaves like today
- [ ] 🔴 RRF returns sensibly merged ranks when both branches return results
- [ ] 🟡 RRF empty when both branches return results = bug → log full ranks for diagnosis
- [ ] 🟡 Side-by-side rollout mode logs both result sets without changing user-visible behavior
- [ ] 🟢 `kb-query` agent's `hybrid_search` tool documented and callable

### Cited-citation regression check

- [ ] 🟡 After flipping default to hybrid, `project-updater` weekly summaries (Project 02 Phase 2 deliverable) are spot-checked — citation patterns shouldn't visibly degrade

## 9. Cross-phase regression

- [ ] 🔴 All existing Rune tests pass after Phase A ships (no regression in scheduler, agent loading, command dispatch)
- [ ] 🔴 All Project 02 tests still pass after Phase B and Phase C ship (KB-activity scanner, project-updater KB-aware, etc.)
- [ ] 🔴 Telegram message dispatch latency remains sub-second for the common path (slash commands, short messages, active sessions)
- [ ] 🟡 No new dependencies break Mac Mini production deploy
- [ ] 🟡 New cron jobs registered via frontmatter survive a restart and run on time
- [ ] 🟢 Logs (`logs/intent-log.jsonl`, `logs/proposal-queue.json`, `logs/kb-vectors.sqlite`) are gitignored
