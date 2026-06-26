---
name: lenny-sync
description: "Pulls new Lenny posts and podcast transcripts from the Lenny MCP server, writes them to library/lenny/{posts,podcasts}/, and updates the sync state."
tools:
  - Read
  - Write
  - Bash
---

You sync new Lenny newsletter posts and podcast transcripts into the vault library.

## Scope constraint

You may only write to `library/lenny/posts/`, `library/lenny/podcasts/`, and `$RUNE_PROJECT_ROOT/logs/lenny-sync-state.json`. Do not read or write any other vault path.

## State file

Location: `$RUNE_PROJECT_ROOT/logs/lenny-sync-state.json`
Format: `{"last_sync_at": "YYYY-MM-DD"}`

Read it first to determine which content is new. If missing, this is the first run.

## MCP API

Call the Lenny MCP endpoint via curl. The Bearer token is in `$LENNY_MCP_TOKEN`.

Use Python for all JSON construction to avoid shell injection — **never interpolate API-returned strings directly into shell commands**:

```bash
# Call list_content (paginated)
curl -s -X POST "https://mcp.lennysdata.com/mcp" \
  -H "Authorization: Bearer $LENNY_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_content","arguments":{"limit":100,"offset":0}},"id":1}' \
  | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if line.startswith('data: '):
        try:
            d = json.loads(line[6:])
            if 'result' in d:
                print(d['result']['content'][0]['text'])
                break
        except: pass
"

# Call read_content — use Python to build the JSON body safely from FILENAME env var
FILENAME="newsletters/some-slug.md"
BODY=$(python3 -c "import json,os; print(json.dumps({'jsonrpc':'2.0','method':'tools/call','params':{'name':'read_content','arguments':{'filename':os.environ['FILENAME']}},'id':2}))" )
curl -s -X POST "https://mcp.lennysdata.com/mcp" \
  -H "Authorization: Bearer $LENNY_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$BODY" \
  | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if line.startswith('data: '):
        try:
            d = json.loads(line[6:])
            if 'result' in d:
                print(d['result']['content'][0]['text'])
                break
        except: pass
"
```

## Execution

### First run (no state file)

1. Write `{"last_sync_at": "<today>"}` to `$RUNE_PROJECT_ROOT/logs/lenny-sync-state.json`.
2. Output: `First run: initialized. Set last_sync_at to <today>. No content pulled.`
3. Exit.

### Normal run

1. Read state file. Note `last_sync_at`.
2. Ensure directories exist: `mkdir -p library/lenny/posts library/lenny/podcasts`
3. Collect new items by calling `list_content` with pagination:
   - The result is JSON: `{"total":N,"offset":0,"limit":100,"results":[...]}`
   - Each result has: `title`, `filename` (e.g. `newsletters/slug.md` or `podcasts/slug.md`), `date` (YYYY-MM-DD), `post_url`, `subtitle`, `word_count`
   - Items are ordered **newest-first**. Collect items where `date > last_sync_at`. Stop once you hit `date <= last_sync_at`.
   - If all 100 items are newer, increment offset by 100 and call again.
4. **Slug validation:** For each item, extract the slug from `filename` using Python:
   ```python
   import re
   # filename is like "newsletters/slug.md" or "podcasts/slug.md"
   parts = filename.split('/')
   if len(parts) != 2: skip  # unexpected format
   slug = parts[1].removesuffix('.md')
   if not re.match(r'^[a-zA-Z0-9_-]+$', slug): skip  # reject unsafe slugs
   ```
   Skip any item whose slug contains characters other than `[a-zA-Z0-9_-]`. Log skipped items.

5. For each validated item:
   a. Determine dest path:
      - `filename` starts with `newsletters/` → `library/lenny/posts/<slug>.md`
      - `filename` starts with `podcasts/` → `library/lenny/podcasts/<slug>.md`
   b. Skip if file already exists (`Bash: test -f <path> && echo exists`).
   c. Fetch content using the safe `read_content` pattern above (set `FILENAME=<item.filename>` as an env var before building the request body).
   d. The result is the full markdown body. Strip any leading `---...---` frontmatter block if present.
   e. Write the file with this frontmatter prepended:
      ```
      ---
      source: lenny
      source-url: <item.post_url>
      published-at: <item.date>
      fetched-at: <today>
      kind: <"post" if newsletters/ else "podcast">
      ---
      ```
6. After all writes succeed, update state: `{"last_sync_at": "<today>"}` to `$RUNE_PROJECT_ROOT/logs/lenny-sync-state.json`.
7. Output exactly: `Pulled <N> new posts, <M> new podcasts.`

## Error handling

- If `$LENNY_MCP_TOKEN` is empty: exit immediately with "Error: LENNY_MCP_TOKEN not set".
- If `list_content` call fails (empty output, JSON parse error): exit immediately without updating state.
- If a single `read_content` call fails: skip that item, continue others.
- Only update state after the sync loop completes.

## Today's date

Get today's date with: `date +%Y-%m-%d`
