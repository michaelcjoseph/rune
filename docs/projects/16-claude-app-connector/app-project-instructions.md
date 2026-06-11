# Claude App project instructions — Jarvis connector

Project 16 Phase 3, task **port-summarization-prompt**. This is the
copy-paste source for the Claude App **project instructions** (Projects →
your Jarvis project → Instructions) that drive the connector. It ports the
server's `summarizeSession` prompt and kb-worthy heuristic verbatim so an
App thread produces summary text and a `kb_worthy` judgment equivalent to
the Telegram `/fresh` flow, then writes them back through `log_conversation`.

## Why the prompt moves to the App

On the Telegram/webview path the server owns the session: `summarizeSession`
(`src/ai/claude.ts`) runs the prompt against the live session id, and
`closeConversation` (`src/bot/commands/fresh.ts`) parses the result, writes
the journal entry, and enqueues the KB source. **The App path is stateless
to the server** — there is no session id to summarize and no
`getSession`/`deleteSession` lifecycle. So the summarization judgment has to
happen in the App (it has the live thread), and the server's
`log_conversation` tool performs ONLY the vault-write half. This is the
intended split (spec R1 req 5, R5 req 18): no server-side summarization on
the App path.

## The mode that preserves the funnel

The project's whole thesis is *the capture-and-compound funnel is the asset.*
Of the two `log_conversation` modes, only **`mode:summary` + `kb_worthy:true`**
reaches the KB raw-source queue (spec R1 req 3) — that is the path that keeps
the funnel intact, so it is the default for anything worth keeping. The
server's `/fresh` writes a single journal bullet and, when kb-worthy, saves
the same text to `knowledge/raw/conversations/` and enqueues it; the App
reproduces that with `mode:summary`. `mode:full` exists for verbatim thread
capture (maps to `/fresh-full`) and is journal-only — it does NOT hit the KB.
`mode:full` is a faithful reconstruction, not a byte-exact transcript (no
transcript file exists for the tool to read — accepted tradeoff, spec
Non-Goals).

---

## Paste the following into the App project instructions

> You have a Jarvis connector with six tools: `kb_query`, `vault_search`,
> `log_idea`, `crm_lookup`, `get_priorities`, and `log_conversation`. Use the
> read tools freely mid-thread to answer from the live vault/KB. Capture
> ideas and bugs with `log_idea` as they come up (pass the `product` when the
> thread makes the target clear; omit it otherwise — it routes to an inbox).
>
> **When I end a thread (I say "log this", "/fresh", "wrap up", or similar),
> first judge the conversation using this exact format and heuristic:**
>
> ```
> Topic: <brief topic in 5-10 words>
> Prompt: <my original question/request>
> Discussion: <2-4 sentence summary of what was discussed>
> Conclusion: <what was decided, learned, or resolved>
> KB-worthy: <yes or no>
> ```
>
> **KB-worthy** means this conversation produced insights worth ingesting
> into the knowledge base. Answer **yes** if it produced a new insight,
> framework, mental model, factual information worth preserving, or explored
> a topic in depth. Answer **no** if it was purely operational, casual chat,
> or covered topics already well-documented.
>
> Then call `log_conversation` with **`mode: "summary"`**:
> - `content`: one compact line capturing Topic + Conclusion (and the key
>   point of the Discussion if it fits) — this becomes a single journal
>   bullet, so keep it to one line.
> - `kb_worthy`: `true` or `false`, straight from the KB-worthy line above.
>   When `true`, the tool also writes the summary to the KB raw-source queue,
>   so the next nightly distillation picks it up — this is the funnel.
>
> Report back the journal path the tool returns, and the KB queue id when it
> enqueued one.
>
> **Only if I explicitly ask to "log the full conversation" / "/fresh-full",**
> call `log_conversation` with `mode: "full"` and put a faithful
> reconstruction of the whole thread in `content`. Full mode is journal-only
> (it does not touch the KB).

---

## Notes for whoever maintains this

- **Keep the prompt in sync.** The format block and the KB-worthy heuristic
  above are verbatim from `summarizeSession` in `src/ai/claude.ts`. If that
  prompt changes, update this doc and re-paste into the App so the two
  surfaces stay equivalent.
- **Equivalent, not identical.** The server's `/fresh` renders
  Topic/Prompt/Discussion/Conclusion as indented sub-bullets in the journal;
  the App's `mode:summary` lands a single condensed bullet (summary mode
  collapses newlines). Both flag kb-worthiness the same way and both feed the
  KB on a yes. The journal *shape* differs; the funnel behavior matches —
  that is the accepted "equivalent" bar (spec Success Metrics).
- **No session lifecycle.** The App never calls anything that maps to
  `getSession`/`deleteSession`. Each `log_conversation` call is a one-shot
  vault write; the server holds no per-thread state for the App.
- **Phase 4 e2e** exercises exactly the `mode:summary` + `kb_worthy:true`
  path end to end: read tools → routed `log_idea` → `log_conversation`
  summary, then confirm the journal/KB write lands in git and the next
  nightly KB distillation ingests it with no new pipeline stage.
