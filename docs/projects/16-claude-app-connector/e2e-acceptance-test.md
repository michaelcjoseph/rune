# E2E acceptance test — funnel intact end-to-end (DoD #5)

Project 16 Phase 4, task **e2e-funnel-validation**. This IS the deliverable:
a documented, repeatable acceptance test proving a conversation logged from
the Claude App reaches the next nightly KB distillation through the existing
vault → pipeline → KB funnel, with **no new pipeline stage**.

Run it from a real Claude App thread with the Rune connector enabled and
the project instructions ([app-project-instructions.md](app-project-instructions.md))
pasted in. Re-run it any time the connector or funnel changes.

## Preconditions

- `tailscale funnel status` shows the three `/mcp` + `.well-known` mounts on
  `https://rune.tail6b86b9.ts.net` (Funnel on).
- The daemon is running (`curl -s -o /dev/null -w '%{http_code}'
  http://127.0.0.1:3847/health` → `200`) with `RUNE_HTTP_SECRET`,
  `MCP_ISSUER_URL`, and the ts.net hostname in `RUNE_ALLOWED_HOSTS`.
- The App connector is registered and shows exactly six tools.

## Test procedure (from a Claude App thread)

### 1. Read tools run against the live vault

Ask the thread three things that force each read tool, and confirm the
answers reflect *current* vault content (not the model's prior knowledge):

- "What are my priorities today?" → calls `get_priorities`; the answer must
  match today's (or yesterday's) `#priorities` block.
- "Look up <a name in your CRM> in my CRM." → calls `crm_lookup`; returns the
  real record from `pages/crm.json`.
- "Search my vault for <a recent topic>." → calls `vault_search`; returns
  `file:line — snippet` hits from journals/pages/projects.

**Pass:** each tool returns live vault data in the standard text shape.

### 2. Capture a routed idea

In the thread, say something like: "Capture an idea for **aura**: <a short
friction>." → calls `log_idea` with `product: "aura"`.

**Pass:** the tool reply names the filed bullet and the resolved product
(`aura`). Verify on the host:

```bash
git -C ~/workspace/aura log --oneline -1        # a "log_idea: ..." commit
tail -n 5 ~/workspace/aura/docs/projects/ideas.md   # the bullet, "→ aura"
```

(Use any registered product, or omit the product to confirm the `→ inbox`
fallback instead.)

### 3. Log the conversation (summary + kb_worthy)

End the thread: "Log this conversation." The App produces the
Topic/Prompt/Discussion/Conclusion + KB-worthy judgment, then calls
`log_conversation` with `mode:"summary"` and `kb_worthy:true` (make the
thread genuinely insight-bearing so the heuristic returns yes).

**Pass:** the tool reply gives a journal path AND a KB queue id.

### 4. The write landed in the SAME git history the pipeline reads

On the host (the vault is the live working tree):

```bash
cd "$VAULT_DIR"
git log --oneline -1                              # "log_conversation: ..." commit
git show --stat HEAD | grep -E 'journals/|knowledge/raw/conversations/'
#   → today's journal AND a knowledge/raw/conversations/conversation-*.md
cat logs/../$(ls -t knowledge/raw/conversations/*.md | head -1)  # the summary text
```

Confirm the conversation source file exists under
`knowledge/raw/conversations/` and the KB ingestion queue holds it
(`cat logs/kb-ingest-queue.json` or the queue file referenced by
`src/kb/queue.ts`).

### 5. The next nightly distillation ingests it — no new stage

The nightly job's existing **KB queue** step (`stepKBQueue` in
`src/jobs/nightly.ts` → `processIngestionQueue`) drains the queue and routes
anything path-matching `conversation` to `knowledge/raw/conversations/`
(`src/kb/ingest.ts`), compiling it into the wiki. Nothing in this project
added a pipeline stage — the journal and the conversation source were always
ingestion inputs.

Either wait for the nightly run, or trigger ingestion on demand to prove the
path without waiting:

```bash
# On-demand: process the KB queue now (same code the nightly step calls).
cd ~/workspace/rune && npm run seed    # or the KB-ingest entry the queue uses
```

**Pass:** the queued conversation source is ingested and a wiki page is
created/updated citing it — and the diff to make that happen was **zero new
pipeline code**.

## Definition of done (spec Success Metrics)

| Metric | Target | This test |
| --- | --- | --- |
| App connector tools live | exactly 6 discoverable + callable | step 1–3 |
| Funnel intact end-to-end | App thread appears in next nightly KB distillation | step 4–5 |
| Routing correctness | 0 silently-dropped / mis-attributed captures | step 2 (`→ aura` / `→ inbox`) |
| Surface portability | general/dev chat no longer requires Telegram | the thread itself |

## Result log

Record each run here (date, pass/fail per step, notes):

- _2026-06-10: pending operator run — connector live, six tools confirmed;
  steps 1–5 to be executed from a Claude App thread._
