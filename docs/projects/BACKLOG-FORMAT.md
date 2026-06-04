# Backlog format (`bugs.md` / `ideas.md`)

Canonical reference for the per-product backlog files the cockpit reads (project
[09-expand-cockpit](09-expand-cockpit/spec.md)). A product repo keeps two backlog files under
`docs/projects/`:

- `docs/projects/bugs.md` — open/closed bugs
- `docs/projects/ideas.md` — user-authored ideas (and loop-filed observations)

The parser (`src/intent/backlog-parser.ts`) is **strict**: it accepts only the forms below.
Anything else is **skipped with a warning** — either a file-level warning (rendered as a banner in
the drawer) or an item-level warning (a `⚠` chip on the row). A malformed line never crashes the
drawer; it is simply not actionable. A product repo may carry its own copy of this file, but the
parser does not require one to exist.

## `bugs.md`

One bug per line:

```markdown
- [ ] Cockpit shows the wrong run status
- [x] Whoop date mismatch on the morning card
- [x] Drawer scroll jumps on open → 04-whoop-fix
```

- `- [ ] <text>` — an **open** bug.
- `- [x] <text>` or `- [X] <text>` — a **done** bug.
- Either form may end with a promotion marker ` → NN-slug` (see **Promotion marker** below).

## `ideas.md`

Section headings, top-level bullets, and optional two-space sub-bullets:

```markdown
## User-authored

- Expand the cockpit with a backlog drawer
  - count line per product
  - one-click Plan
- Cross-product backlog view → 12-cross-backlog

## Loop-filed

<!-- loop-filed:auto -->
- Recurring friction: morning prep is slow
```

- `## User-authored` / `## Loop-filed` — section headings.
- `- <text>` — a **top-level idea** bullet (optionally ending with ` → NN-slug`).
- `  - <text>` — a **sub-bullet** (exactly **two** leading spaces) that attaches as `body` to the
  most recent top-level idea. A blank line between a bullet and a `  - ` line breaks the attachment.
- The Loop-filed sentinel HTML comment is preserved verbatim.
- Top-level bullets appearing **before any recognized heading** default to the `user-authored`
  section.

Loop-filed ideas can be `open`, but their **Plan** action is disabled (`disabledReason:
'loop-filed'`) — only user-authored ideas are plan-able in v1.

## Promotion marker

When a bug or idea is promoted into a project (via the cockpit **Plan** button), its top-level line
gains a suffix:

```
 → NN-slug
```

- Strict pattern: ` → ` followed by `\d{2}-[a-z0-9-]+` at the **end of the line** (e.g.
  ` → 09-expand-cockpit`).
- The strict anchor prevents real text that merely ends in `→ something` from being misread as a
  promotion. A line ending in ` → <non-matching-slug>` stays an item, is **not** treated as
  promoted, and receives an item warning `bad-promotion-marker`.
- For bugs, promotion also flips the checkbox to `[x]`. For ideas, the suffix alone marks promotion.

## Always rejected (warned + skipped)

- Tab-indented bullets
- `*` bullets (use `-`)
- Numbered lists (`1.`, `2.`, …)
- Blockquotes (`> …`)
- Code fences inside the backlog
- Indentation deeper than two spaces

## Copyable template

Drop these two files into a product repo's `docs/projects/` to make its backlog cockpit-readable:

`docs/projects/bugs.md`:

```markdown
# Bugs

- [ ] First open bug
```

`docs/projects/ideas.md`:

```markdown
# Ideas

## User-authored

- First idea
  - optional supporting detail

## Loop-filed

<!-- loop-filed:auto -->
```
