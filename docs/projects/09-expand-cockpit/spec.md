# Expand Cockpit — Spec

> Recovered from the 2026-05-26 `/plan` conversation (post-Codex
> critique). The project lost its scaffolded files when
> `project-setup-writer` returned a clarifying-questions text reply
> without writing files and `cmd-approve` deleted the planning session
> on text-presence alone. Fixes for that silent-failure mode landed
> on `main` in commits `353b41d`, `a5018e5`, `b9140f3`, `b1974ef`
> — see [`docs/projects/08-intent-layer/agent-lessons.md`](../08-intent-layer/agent-lessons.md)
> Lessons 8–11.
>
> The Phase 4 work in this spec (structured `scaffold-result` JSON
> from the agent + cross-check against the repo diff) layers on top
> of the recovery fixes — the repo-diff verification is now the
> committed fallback path; this project formalizes the structured
> agent contract as the primary signal.

## Why

Pull per-product `docs/projects/bugs.md` and `docs/projects/ideas.md`
into the cockpit; add the minimum controls to move a bullet into a
real planning session in one click.

## What ships (v1)

1. Per-product **Bugs (N)** / **Ideas (N)** count line in the product card, click-to-open a right-side **Backlog drawer**.
2. Drawer lists the full backlog for that product with full text, body for ideas, parser warnings, status, and a single primary action per item.
3. `+` chip in the drawer header appends a new bullet.
4. **Plan button** on each open bug **or** open idea — opens a planning session seeded with title + body, scaffolds a project on approval, marks the source bullet promoted.
5. **Durable promotion job** that survives Rune restart across the `planning-started → scaffolded → marked-source` chain.

## Out of v1 (separate spec to follow)

- **Fix autorun** for bugs (`expand-cockpit-fix-autorun`). Cut because `/work --auto` is currently Rune-only; generalizing it across product repos is a separate piece of work with its own concurrency, branch, and security questions. Tracked as a follow-on idea in [`docs/projects/ideas.md`](../ideas.md) — no separate `/plan` conversation is required for this project's v1 completion.
- Cross-product backlog views.
- Editing/reordering bullets in place.
- Plan on Loop-filed ideas.
- Severity, owner, due-date metadata.
- Non-repo-backed products: drawer shows "not repo-backed — no backlog".

## Data model

```ts
type BacklogKind = 'bugs' | 'ideas';

interface BacklogItem {
  id: string;                    // product-local: sha1(`${kind}:${repoRelativeFile}:${topLevelStartLine}:${normalizedRaw}`).slice(0,12)
  kind: BacklogKind;
  text: string;
  status: 'open' | 'done';
  body: string[];                // ideas only
  promotedTo?: string;
  section?: 'user-authored' | 'loop-filed';
  source: { file: string; lineNumber: number; raw: string }; // file is repo-relative, never absolute
  actions: BacklogItemAction[];  // server-computed; see below
  warnings: string[];            // parser/format warnings for this item
}

interface BacklogItemAction {
  kind: 'plan';                  // 'fix' added in v2
  enabled: boolean;
  disabledReason?: 'already-promoted' | 'loop-filed' | 'planning-active' | 'bug-done' | 'parse-warning';
}
```

`id` is intentionally **unstable across line edits** — that's how stale URLs surface as `409 stale-item` and force the cockpit to re-fetch. It is also intentionally **product-local**: every item API route carries `:product`, so two product repos can have the same bullet text without creating a global id collision.

For bugs, `status` follows the checkbox. For ideas, `status` is `done` only when the top-level line has a valid `promotedTo` suffix; otherwise it is `open`. Loop-filed ideas can still be `open`, but their `plan` action is disabled with `disabledReason: 'loop-filed'`.

`CockpitProduct` gains optional `backlogCounts?: { bugs: { open: number; done: number }; ideas: { open: number; done: number }; warnings: number }`. The full lists are NOT in `CockpitView` (drawer fetches them separately) — keeps the cockpit payload bounded.

## Parser contract (strict, documented)

A new canonical doc, `docs/projects/BACKLOG-FORMAT.md`, defines the format and includes a copyable template for product repos. Product repos may carry their own copy, but the parser does not require one to exist. The parser is strict; everything else warns + skips, with the warning attached to the *file* (rendered as a drawer banner) or to an item (rendered as a `⚠` chip on the row).

**bugs.md — accepted lines:**
- `- [ ] <text>` (open)
- `- [x] <text>` or `- [X] <text>` (done)
- Either form may end with ` → \d{2}-[a-z0-9-]+`

**ideas.md — accepted lines:**
- Section headings: `## User-authored`, `## Loop-filed`
- Top-level bullet: `- <text>` (optionally ` → \d{2}-[a-z0-9-]+`)
- Sub-bullet: `  - <text>` (exactly two spaces; attaches as `body` to most recent top-level)
- Loop-filed sentinel HTML comment is preserved verbatim
- Top-level bullets before any recognized heading default to `section: 'user-authored'`

**Always rejected with warning:**
- Tab-indented bullets, `*` bullets, numbered lists, blockquotes, code fences inside the backlog, deeper than 2-space indent.

**Promotion marker syntax** (both files):
- Suffix ` → \d{2}-[a-z0-9-]+` at end of top-level line.
- Strict regex prevents "real" text ending in `→ <something>` from being misread. A line ending in `→ <non-matching-slug>` remains an item, is NOT promoted, and receives an item warning `bad-promotion-marker`.

## API surface (typed errors)

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| `GET` | `/api/backlog/:product` | – | `{ bugs, ideas, fileWarnings }` | `404 unknown-product`, `409 not-repo-backed` |
| `POST` | `/api/backlog/:product/:kind` | `{ text }` | `{ item }` | `400 empty-text`, `400 multiline-text`, `404 unknown-product`, `404 unknown-kind` |
| `POST` | `/api/backlog/:product/items/:id/plan` | – | `{ planningSessionId, promotionId }` | `409 stale-item`, `409 active-planning-session` (returns `{activeSessionId}`), `422 item-not-eligible` (loop-filed, done, already-promoted) |
| `GET` | `/api/promotions/:id` | – | `{ state, slug?, errors[] }` | `404 unknown-promotion` |
| `POST` | `/api/promotions/:id/retry` | – | `{ state, slug?, errors[] }` | `404 unknown-promotion`, `409 not-retryable` |

Error envelope: `{ error: { code, message, retryable } }`. Every endpoint validates `product` against the registry and `kind` against the literal set.

## Promotion lifecycle (durable job)

New module `src/intent/promotions.ts` owns a persisted job log at `config.PROMOTIONS_FILE` (default: `logs/promotions.jsonl`, append-only). Keep this under `LOGS_DIR`, matching `mutations.jsonl`, `planning-sessions.json`, and the rest of Rune runtime state; do not introduce a separate top-level `state/` directory.

```ts
type PromotionState =
  | 'planning-started'      // session opened, awaiting approval
  | 'scaffolded'            // project files created, slug captured
  | 'marked-source'         // bullet rewritten — terminal success
  | 'planning-abandoned'    // session abandoned — terminal
  | 'scaffold-error'        // scaffold agent failed or returned no slug — terminal
  | 'mark-source-error';    // scaffold succeeded but rewrite failed — retryable

interface Promotion {
  id: string;
  product: string;
  backlogItemId: string;
  snapshotRaw: string;       // for snapshot match at mark-source time
  planningSessionId: string;
  slug?: string;             // populated at 'scaffolded'
  state: PromotionState;
  attempts: number;
  errors: string[];
  createdAt: string;
  updatedAt: string;
}
```

**Flow:**
1. Plan click → `POST /api/backlog/:product/items/:id/plan` → server creates a `Promotion` in `planning-started` and a `StoredPlanningSession` whose `promotionId` links them. Returns both ids.
2. Planning runs as today.
3. On `/approve`, the existing approval path runs the scaffolder, then:
   a. Resolve the product's `repoPath` from `policies/products.json`; the scaffolder writes to that product repo (Rune is just one product). The approval helper must invoke the setup writer with that repo available as a writable Claude workspace (for example a target `cwd`/`--add-dir` option, depending on the final `runAgent` API), not merely mention the path in prompt text. Parse structured `{ slug, filesCreated }` from the scaffolder's final message; validate by diffing `<repoPath>/docs/projects/` (exactly one new `NN-slug` dir with the three expected files). All `filesCreated` entries are repo-relative.
   b. On valid → promotion advances to `scaffolded(slug)`.
   c. On invalid → `scaffold-error` (terminal); cockpit shows the error; source bullet untouched.
4. Post-scaffold step rewrites source bullet by snapshot match (Bugs: `[ ] → [x] + → slug` suffix. Ideas: append ` → slug` suffix). On success → `marked-source`. On `noMatch`/`ambiguous` → `mark-source-error`; retry is via `POST /api/promotions/:id/retry`, and the rewrite itself is idempotent if the source line is already marked.
5. On Rune restart, the promotion job log is replayed: any promotion in `scaffolded` (i.e. scaffold succeeded but mark-source didn't run) is retried automatically with backoff.
6. A `mark-source-error` retry is driven by an explicit retry endpoint/button (`POST /api/promotions/:id/retry`), not by requiring the user to re-run `/approve` after the planning session may have been deleted. Retries cap at a module constant that tests can override.

## Scaffold contract change (new prerequisite)

The `project-setup-writer` agent's final message must contain a fenced JSON block:

````
```scaffold-result
{ "slug": "09-expand-cockpit", "filesCreated": ["docs/projects/09-expand-cockpit/spec.md", ...] }
```
````

If absent or malformed, the approval path falls back to a directory diff between pre- and post-scaffold snapshots of `<repoPath>/docs/projects/`. Both signals must agree on the slug; mismatch → `scaffold-error`.

**Relationship to the recovery fixes:** the repo-diff verification path (Fix 2, commit `a5018e5`) is already implemented as the fallback. This project adds the structured JSON block as the primary signal and the cross-check between the two.

This is not just a one-line prompt change: today `project-setup-writer` is Rune-workspace scoped. Phase 4 must generalize the brief + agent prompt + approval helper so the target product repo is explicit, canonicalized, and cross-checked against `policies/products.json`. Tracked as Phase 4 task 1.

## Cockpit UX (revised)

**Sidebar (the product card):**
```
┌─ jarvis ────────────────────────────────┐
│ ▼ Projects (3)                          │
│   08-intent-layer    active  12/18      │
│   07-spaced-repet.   active  8/8        │
│   06-webview         done               │
│ Bugs 4 · Ideas 7 · ⚠ 2 ─────── [open ↗] │
└─────────────────────────────────────────┘
```
One compact line shows open-counts plus warning count. Clicking opens the drawer; that's the only backlog affordance in the sidebar.

**Backlog drawer (right side, reuses `mutation-drawer` pattern):**
```
┌─ jarvis backlog ────────────────── [✕] ─┐
│ [Bugs (4)] [Ideas (7)]   ⚠ 2 warnings  │
├─────────────────────────────────────────┤
│ ## Bugs                          [ + ]  │
│ ◯ Cockpit shows wrong status   [Plan]  │
│ ◯ "Claude activity" → "Agent…" [Plan]  │
│ …                                       │
│ ── done (3) ──                          │
│ ✓ Whoop date mismatch    → 04-whoop-fix │
├─────────────────────────────────────────┤
│ Format warnings (2):                    │
│  · ideas.md:42 — tab-indented bullet    │
│  · bugs.md:7 — non-checkbox bullet      │
└─────────────────────────────────────────┘
```
- Full text wraps freely (no narrow-sidebar pressure).
- Each open item has exactly one action button. For v1: `Plan` for both kinds. (v2 adds `Fix` for bugs.)
- Disabled actions render greyed with a tooltip showing `disabledReason`.
- Ideas with `body.length > 0` render the body as a nested bulleted list, no truncation.
- Tabs persist last-selected in `localStorage`.
- Source-file link per item opens the file in Obsidian (existing `obsidian://` URL pattern).

## Security / repo safety

- Reader and writer canonicalize each `repoPath`. Require the canonical path to live under `$WORKSPACE_ROOT` (default `~/workspace`).
- Writes restricted to exactly two relative paths per product repo: `docs/projects/bugs.md`, `docs/projects/ideas.md`. Any other path → 500.
- Symlink traversal: realpath the resolved file; if it escapes `repoPath`, reject.
- Git pre-write check: log the current branch and worktree-dirty status. Writes proceed regardless (so the user can stage mid-edit), but every write is audit-logged with `{ product, file, branch, dirty, before, after }` to `logs/backlog-mutations.jsonl`.

## Add UX (no optimistic commit)

- Click `+` → inline input with pending spinner.
- POST → on success, server returns the fully-parsed `BacklogItem` (with its real `id`, `lineNumber`, computed `actions`); cockpit appends it.
- On error, show the typed `error.code` inline; input keeps the user's text for retry.

## Resilience contracts

- All file writes temp-then-rename.
- Promotion job log is append-only JSONL with atomic appends (open with `O_APPEND`, single `write()`).
- Mark-source is idempotent: re-running against an already-promoted line is a byte-equal no-op.
- Scaffolder failure leaves the source bullet untouched and the promotion in a terminal error state with a human-readable reason.
- Mark-source failure leaves the project scaffolded and the promotion in `mark-source-error`; cockpit surfaces a retry button.
- Planning abandonment (`/clear`, `/fresh`, webview abandon, or planning expiry) advances any linked `planning-started` promotion to `planning-abandoned` so restart replay never treats an abandoned plan as work to resume.
