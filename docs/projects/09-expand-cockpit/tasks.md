# Expand Cockpit — Tasks

Not started. See [spec.md](spec.md) for details.

Test commit lands before any implementation code per phase.

## Phase 1 — Reader + parser

**Tests (write first)**

- [x] `backlog-parser.test.ts` — all accepted forms; all rejected forms produce typed warnings; CRLF and no-final-newline files; Unicode in bullet text; the strict slug suffix regex; ideas sub-bullet attachment across blank line (does NOT attach); sectioning before any heading defaults `user-authored`. (Test-first deliverable: suite is red against the not-yet-built `backlog-parser.ts` — `Cannot find module './backlog-parser.js'` — which is the success condition until the Phase 1 build task lands.)
- [x] `backlog-id.test.ts` — same line at same position → same id; line edit → different id; same line at different position → different id. (Test-first deliverable: red against the not-yet-built `backlog-id.ts`; pins the exact sha1-slice formula and product-locality.)
- [x] `backlog-reader.test.ts` — registry roll-up; ids are product-local; non-repo-backed → `not-repo-backed` flag; missing file → empty + no error; unreadable file → empty + file warning surfaces; symlink/path-escape rejection. (Test-first deliverable: red against the not-yet-built `backlog-reader.ts`; real-tmpdir product repos exercise the symlink-escape and repoPath-outside-workspace security checks.)

**Build**

- [x] `src/intent/backlog-parser.ts` — `parseBugs`, `parseIdeas`, returning `{ items, fileWarnings }`. (`backlog-parser.test.ts` green — 31 cases.)
- [x] `src/intent/backlog-id.ts` — deterministic id helper. (Implemented alongside the parser as its hard dependency; `backlog-id.test.ts` green — 22 cases.)
- [x] `src/intent/backlog-reader.ts` — `readBacklogs(registry, productsConfig)` with security checks. (`backlog-reader.test.ts` green — 9 cases; realpath+containment, symlink-escape, fd-based size-capped reads, fail-closed workspace root.)
- [x] Extend `CockpitProduct` with optional `backlogCounts`. (Added `BacklogCounts` type + product-name-keyed 5th `buildCockpitView` param + `computeBacklogCounts` helper; repo-backed-only guard; `cockpit.test.ts` + `backlog-reader.test.ts` green.)

## Phase 2 — Drawer + sidebar count line

> Depends on: Phase 1

**Tests (write first)**

- [x] `cockpit-backlog-counts.test.ts` — sidebar one-liner reflects counts and warning count; clicking opens drawer; non-repo-backed product → drawer shows `not repo-backed`. (Test-first deliverable: HTTP suite over `GET /api/cockpit` asserting `backlogCounts` per repo-backed product + none for non-repo-backed; the count assertions stay red until the Phase 2 build wires `readBacklogs`/`computeBacklogCounts` into `handleApiCockpit`. DOM-side sidebar/drawer behavior is the integration check, per the cockpit-ux precedent.)
- [x] `backlog-drawer.test.ts` — `GET /api/backlog/:product` returns parsed items + warnings; drawer renders Bugs/Ideas tabs; tab persists; disabled actions show tooltip with `disabledReason`; ideas body renders as nested list; source-file link constructed correctly. (Test-first deliverable: HTTP suite pinning the endpoint contract — parsed bugs/ideas/fileWarnings, server-computed `plan` action with disabledReason precedence planning-active > already-promoted > bug-done > loop-filed > parse-warning, 404 unknown-product / 409 not-repo-backed envelopes. Red until the Phase 2 build adds the route; DOM rendering is the integration check.)

**Build**

- [x] `GET /api/backlog/:product` in `src/server/webview.ts`. (`handleApiBacklog` + `sendErrorEnvelope`; new pure `src/server/backlog-actions.ts` computes the per-item `plan` action with disabledReason precedence; planning-active gate excludes terminal approved/abandoned sessions; `backlog-drawer.test.ts` green — 12 cases.)
- [x] New drawer HTML/JS/CSS in `index.html` / `app.js` / `app.css` (modeled on existing `mutation-drawer`). (`#backlog-drawer` + `openBacklogDrawer`/`renderBacklogItem`; Bugs/Ideas tabs w/ localStorage persistence, disabled-action tooltips, nested ideas body, obsidian source link, warnings banner; opened via a `[data-backlog-open]` trigger in `handleCockpitClick`. Pure frontend — DOM verified by the integration check per the cockpit-ux precedent; Plan POST wiring is Phase 4.)
- [x] Sidebar one-liner replaces the placeholder sub-section. (`handleApiCockpit` computes per-product `backlogCounts` fail-soft and feeds them as `buildCockpitView`'s 5th arg → `cockpit-backlog-counts.test.ts` green; `renderCockpit` emits a `.cockpit-backlog` count line `Bugs N · Ideas N · ⚠ N · open ↗` per product carrying `data-backlog-open` to open the drawer.)

## Phase 3 — Add

> Depends on: Phase 2

**Tests (write first)**

- [x] `backlog-append.test.ts` — pure: bugs append `\n- [ ] <text>` at EOF (ensures trailing newline); ideas insert above Loop-filed sentinel inside User-authored, with sentinel-missing and section-missing fallbacks; empty/multiline rejected with typed errors. (Test-first deliverable: exact-string assertions pin the insertion algorithm — new idea lands directly after the last User-authored bullet, loop-filed section preserved verbatim. Red until the Phase 3 build lands `backlog-append.ts`.)
- [x] `backlog-append-api.test.ts` — endpoint happy + each typed error; per-file mutex serializes concurrent appends; temp-then-rename verified via mocked fs. (Test-first deliverable: HTTP suite over `POST /api/backlog/:product/:kind` (happy → `{item}` with computed actions; 400 empty-text/multiline-text; 404 unknown-product/unknown-kind) + `backlog-write-lock` mutex (structural overlap proofs) + temp-then-rename via a path-gated `node:fs` override. Red until the Phase 3 build lands `backlog-write-lock.ts` + the POST route.)
- [x] `backlog-security.test.ts` — write paths outside the two allowed files → 500; symlink target outside repoPath → 500; write logged to `logs/backlog-mutations.jsonl`. (Test-first deliverable: real-tmpdir tests for `assertBacklogWriteAllowed` (two allowed files; third-file / outside-docs / traversal / symlink-file-escape / symlink-dir-escape all reject) + `appendBacklogMutationLog` (append-only JSONL with product/file/branch/dirty/before/after, repo-relative file). Red until the Phase 3 build lands `backlog-write-lock.ts`.)

**Build**

- [x] `src/intent/backlog-append.ts` (pure). (`appendBug`/`appendIdea` → `{ok,content}|{ok:false,error}`; CRLF→LF normalization; sentinel-first stays above the loop-filed section; `backlog-append.test.ts` green — 16 cases.)
- [x] `src/intent/backlog-write-lock.ts` (per-file mutex). (`withFileLock` async mutex + `writeFileAtomic` temp-then-rename + `assertBacklogWriteAllowed` (allowed-files + symlink-escape guard) + `appendBacklogMutationLog`; `backlog-security.test.ts` green (9), `backlog-append-api.test.ts` mutex tests green.)
- [x] `POST /api/backlog/:product/:kind`; integration with security checks + audit log. (`handleApiBacklogAppend`: per-file-mutex critical section (guard → read → append → capture pre-write git → atomic write), 400 empty-text/multiline-text, 404 unknown-product/unknown-kind, best-effort audit to `config.BACKLOG_MUTATIONS_FILE`; returns the appended item found by line number (ideas insert above the sentinel, so not the last item). `backlog-append-api.test.ts` green — 11.)
- [ ] Drawer `+` chip with pending-state input.

## Phase 4 — Plan + promotion job + scaffold contract

> Depends on: Phase 3

**Tests (write first)**

- [ ] `scaffold-result-parser.test.ts` — extract `{ slug, filesCreated }` from agent message; malformed → undefined; cross-check against repo diff; mismatch → distinct error; all `filesCreated` paths must be repo-relative.
- [ ] `product-scaffold-target.test.ts` — approval resolves the target product's `repoPath` from `policies/products.json`, rejects non-repo-backed/unknown products, and passes the canonical target repo path to the setup writer with real write access (target `cwd`/allowed directory), not just prompt text; Jarvis remains the `jarvis` product, not a hard-coded default for every product.
- [ ] `promotion-job.test.ts` — state transitions; restart-replay resumes a `scaffolded` promotion to `marked-source`; explicit retry endpoint resumes `mark-source-error` with backoff and capped attempts; terminal states are not re-entered; linked planning abandonment advances `planning-started` to `planning-abandoned`.
- [ ] `planning-collision.test.ts` — second Plan click while a planning session is active → `409 active-planning-session`; cockpit's resume/abandon dialog wired.
- [ ] `backlog-mark-done.test.ts` — match by snapshot, not line; `[x]` already-done is rewritten with suffix idempotently; ideas append suffix only once; ambiguous match → `mark-source-error`; surrounding bytes preserved (including sub-bullets).
- [ ] `plan-button-api.test.ts` — `POST /api/backlog/:product/items/:id/plan` returns `{ planningSessionId, promotionId }`; stale id → `409 stale-item`; product-local ids do not collide across products; loop-filed → `422 item-not-eligible`.
- [ ] `plan-e2e.test.ts` (integration) — append idea → plan → approve → scaffold captured → bullet marked promoted → promotion `marked-source`. A duplicate mark-source attempt is a byte-equal no-op on the source file.

**Build**

- [ ] Generalize `runAgent`, `project-setup-writer`, and `buildSetupWriterBrief` so the approved session carries an explicit target product repo path from `policies/products.json`; the agent is spawned with that repo writable, writes to that target repo's `docs/projects/`, emits `scaffold-result` JSON, and keeps all returned paths repo-relative.
- [ ] `src/intent/scaffold-result.ts` parser + repo-diff cross-check (the directory-diff verification from `approve.ts` commit `a5018e5` is the existing fallback; this phase formalizes the JSON block as the primary signal).
- [ ] `src/intent/promotions.ts` — durable job log at `config.PROMOTIONS_FILE` (`logs/promotions.jsonl` by default) + restart replay + explicit retry helper.
- [ ] `src/intent/backlog-mark-done.ts` — pure rewriter returning `{ newText, matched }`.
- [ ] Extend `StoredPlanningSession` with optional `promotionId`.
- [ ] Extend approval path in `src/bot/commands/approve.ts` and webview approve route to drive the promotion job.
- [ ] Wire `/clear`, `/fresh`, webview abandon, and planning expiry to mark linked `planning-started` promotions as `planning-abandoned`.
- [ ] `POST /api/backlog/:product/items/:id/plan`, `GET /api/promotions/:id`, and `POST /api/promotions/:id/retry` in `webview.ts`.
- [ ] Drawer Plan button wiring + planning panel hand-off + collision dialog.

## Phase 5 — Polish

> Depends on: Phase 4

- [ ] Add an automated HTTP/module smoke test using tmpdir product repos: read drawer data, add bug, add idea, plan an idea end-to-end with a stubbed setup writer, assert promotion `marked-source`, and assert no real product repo outside the tmpdir is touched.
- [ ] Add `docs/projects/BACKLOG-FORMAT.md` to the Jarvis repo as the canonical format reference and include a copyable template section for product repos; do not require this project to edit every registered product repo.
- [ ] Update `docs/projects/08-intent-layer/spec.md` cockpit section with a one-paragraph reference.
- [ ] Add an automated docs check that `docs/projects/ideas.md` contains a promoted `Expand cockpit → 09-expand-cockpit` line, then update the line if the check fails.
- [ ] Create the follow-on project stub `docs/projects/ideas.md` entry for `expand-cockpit-fix-autorun` with a one-sentence scope and a backlink from this spec; no separate `/plan` conversation required for v1 completion.
