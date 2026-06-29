# Subsystem Deep-Dives

Architecture mechanics that don't change what Claude does in a typical session but matter when working *in* a given subsystem. `CLAUDE.md` carries a one-line summary of each; the detail lives here. Per-file annotations are in `module-reference.md`.

---

## In-flight op tracking

Every `execClaude()` spawn registers an `InFlightOp` (`src/transport/in-flight.ts`) and emits `BusOpEvent` frames (start/progress/end). TG shows a tracker message ("🤔 agent · 12s · /cancel") that edits every ~10s and deletes on end; the webview shows a cancellable pill. `cancelOp(id)` SIGTERMs the child. `/cancel [opId-prefix]` kills the user's most recent op (or by id). Classifier ops are filtered from senders to avoid resolver spam.

## Mutation pipeline

`src/transport/mutations.ts` is the central registry for autonomous codebase operations (`MutationDescriptor`, applier registry, `createMutation`/`cancelMutation`). The appliers, all registered in `src/index.ts`:

1. **`workRunApplier`** (`src/jobs/work-runner.ts`) — spawns Claude CLI with `spec.md + tasks.md + /work --auto` for a project slug.
2. **`genEvalLoopApplier`** (`src/jobs/gen-eval-loop-runner.ts`, `autoApprove: false`) — validates the `gen-eval-loop` payload and drives `runGenEvalLoop()` (per-round: createWorktree → /work --auto → /review → recordRound → evaluateLoop → destroyWorktree).
3. **`orchestratedWorkApplier`** (`src/jobs/orchestrated-work-runner.ts`, `autoApprove: true`, kind `orchestrated-work`) — creates a sandboxed worktree, drives `runProjectOrchestration` over real fs/git effects with `createProductionTaskWorkflowRunner` as the live per-task role-spawn binding (Phase 8), maps the terminal `OrchestrationResult` to a single `MutationEvent` (finalized→completed, held→completed-flagged-held, blocked→failed).
4. **`workRunReleaseApplier`** (`src/jobs/work-run-release.ts`, `autoApprove: true`, kind `work-run-release`, `supervised: false`) — drives a cold finalize-or-discard of a parked run.

The cockpit Start action dispatches to either the orchestrated or legacy applier via the `src/jobs/work-dispatch.ts` seam — `resolveWorkDispatch` maps the `resolveDispatchMode` decision to a concrete mutation kind; `handleApiMutationsCreate` substitutes `kind:'orchestrated-work'` when orchestrated mode is selected, stamps `dispatchMode`+`fallbackReason` onto the payload, and always records which applier ran. Both `orchestrated-work` and `work-run` share the same deterministic per-project worktree path and the same per-project + global concurrency caps, so the two never run the same project concurrently.

Mutations are logged append-only to `logs/mutations.jsonl`; orphaned `running` entries are flipped to `failed` at startup via `reconcileOrphans()`.

### Supervision coupling

Every mutation state transition drives `src/jobs/supervision-store.ts`: `createMutation` seeds a `SupervisedRun` (`running` for autoApprove, `blocked-on-human` for pending-approval); `startApply` flips to `running`; `output` events refresh `lastHeartbeatAt` and advance `lastOutputAt` (both throttled to once per 30s — `lastOutputAt` is the LLM-output signal the quiet-run nudge keys on, distinct from `lastChildAliveAt`); non-output writes thread the current `lastOutputAt` through so it is never reset to undefined; `completed`/`failed` and applier-crash paths flip terminal status. All supervision writes are wrapped in a safe try/catch — a disk failure logs a warning but does not interrupt the mutation flow (the audit source-of-truth remains `mutations.jsonl`).

## Supervision & stall-check

`SupervisedRun[]` state persists to `logs/supervised-runs.json` (`supervision-store.ts`). `upsertRun` **field-merges** by id so a keep-alive heartbeat can't clear `quietNudgedAt`. The stall-check runner (`stall-check-runner.ts`, 30s tick) runs on a single snapshot:
- `checkStalledRuns` → newly-nudged-id set (child-dead stall, 5min threshold).
- `planQuietNudges` over the non-stalled remainder (quiet-but-alive, keyed on `lastOutputAt`, 5min threshold) → publishes `formatQuietNudge`, persists `quietNudgedAt`.
- **Escalation (project 15 P2.7):** `planQuietCancel` (quiet past `WORK_RUN_QUIET_CANCEL_AFTER_MS` since nudge → `cancelMutation`), `planMaxRuntimeKills` (running past `WORK_RUN_MAX_RUNTIME_MS` regardless of liveness → `cancelMutation`, fail-toward-kill on corrupt timestamp).
- `planParkedNudges` over `blocked-on-human` runs (one-time staleness nudge after `PARKED_RUN_NUDGE_AFTER_MS`, never auto-releases).

Per-run send/persist/cancel/kill errors are individually caught so a failure on one run can't skip the rest; tick exceptions caught so a failure can't crash the server.

## Work-run lifecycle

`workRunApplier` spawns Claude CLI with `--output-format stream-json --verbose` and converts each stdout envelope into human-readable `output` `MutationEvent`s via the stream-json→display adapter (`work-run-transcript.ts`). The terminal sequence:

- Tees raw envelopes to a per-run durable transcript sink (`<id>/transcript.jsonl`).
- Classifies on work product via `computeWorkProduct` + `finalizeWorkRun` (`work-run-classify.ts`) — outcome ∈ branch-complete / partial / noop / dirty-uncommitted / failed.
- Flushes transcript (awaits finish), writes `summary.json` atomically, appends a `WorkRunIndexRow` to `logs/work-runs/index.jsonl` (best-effort).
- Augments the terminal event with `projectSlug`+`product` so the cockpit and `formatWorkRunTerminal` can name the run.

**Start event (project 13 Phase 1a):** once `createWorktree` succeeds, yields a one-shot `start` `MutationEvent` carrying `operatorWorktreePath` (un-scrubbed) + `runId`/`projectSlug`/`product`. **The path is LOCAL-OPERATOR-ONLY and is never copied onto the descriptor**, so it never reaches `mutations.jsonl`/summary/index/transcript/forensics. The createWorktree-failure branch returns before this point so a run with no worktree emits no `start`.

**Parked state (project 13 Phase 1b):** when the stream contains a valid `RUNE_WORK_RUN_SENTINEL` (parsed via `parseWorkRunSentinel`) and the run was NOT user-cancelled, work-runner writes a durable `blocked-on-human` supervision record FIRST, SKIPS `runFinalizer` (leaves the worktree live), and yields a terminal event carrying `parked:true` + un-scrubbed `operatorWorktreePath` + `pendingCheck`/`command`/`reason` from the sentinel. Scoped to the legacy `work-run` applier only. The parked terminal message renders a one-tap "🔓 Release" inline button (callback `work-run-release:<id>`).

**Commit-poll ticker (project 11 Phase 4):** `streamProcess` runs a parent-side commit-poll ticker (10s, unref'd, re-entrancy-guarded) — each tick calls `git log baseSha..branch`, reads `tasks.md` tally via `parseTasks`, passes both to `planCommitProgress`, and enqueues a scrubbed throttled `progress` `MutationEvent` when a new commit lands. Enabled only when `sandbox.baseSha` is present.

**Forensics (project 11 Phase 3):** `exportForensics` writes a reconstructable evidence bundle to `logs/work-runs/<id>/` BEFORE the worktree is destroyed; best-effort by contract.

**Retention GC:** `gcWorkRuns` prunes `logs/work-runs/` artifacts oldest-first to satisfy `WORK_RUN_RETENTION_MAX_RUNS` + `WORK_RUN_RETENTION_MAX_BYTES`; protected set = activeRuns + non-terminal run-store + worktree-checked-out branches. Runs at startup and on each run completion (fire-and-forget).

## Gated-merge finalizer (project 15)

`runFinalizer(input, effects)` (`work-run-finalizer.ts`) is the shared idempotent phase-recorded finalizer, records a durable phase per step (`logs/work-runs/<id>/phase`) for crash-resume.

- **`hold` mode** (P0.4a): classify → flush transcript → write summary/index → resolve worktree (best-effort removal, branch left intact) → terminal supervision write. NEVER merges/pushes/deletes; never leaves the run `running`.
- **`gated-merge` mode** (P1.5 + Phase 3.5, live via `runGatedMerge`): classify → flush → summary → index → gate → merge → push → delete → terminal, recording `merged-not-pushed` then `pushed-not-deleted` (**push-before-delete: origin is the durable backup**); consults `readLastPhase()` for crash-resume (skips an already-committed merge/push/index-append — exactly-once); a failed gate STOPS at branch-complete and alerts (never merges); a non-branch-complete run never consults the gate.

The pure gate DECISION (`evaluateGate`), gate RUNTIME (`runGate` — runs validationCommands in an integration worktree so a red check never mutates `main`), and per-product/per-base-branch merge lock (`withBaseBranchLock`) are all wired as effects from `work-runner.ts`. `resolveWorktreeAndFinalize` runs `onBranchDelete` AFTER `removeWorktree` and BEFORE `git branch -d` (git refuses to delete a checked-out branch).

Live consumers: the live work-runner `apply()` terminal path (gated-merge mode) and the startup recovery path (`recovery-finalize-runner.ts` — hold mode by default, gated-merge to RESUME a crashed-mid-merge run off its durable phase, never to initiate one).

## Orchestrated work & product-team agents (project 14)

The orchestrated path is OFF by default (`ORCHESTRATED_WORK_ENABLED=false`); a per-product `orchestratedMode: true/false` in `policies/products.json` overrides it. When on, the cockpit Start action routes to `orchestratedWorkApplier`.

**The six product-team roles** (`src/roles/loader.ts`): `pm`, `tech-lead`, `qa`, `coder`, `reviewer`, `designer`. Each has a SOUL charter and a `memory.md` under `agents/<role>/` (mirroring `agents/writer/`). Two-channel authority boundary: SOUL.md → system-prompt, memory.md → low-authority reference fence. Judgment roles (pm, tech-lead, reviewer, designer) → fable; artifact roles (qa, coder) → gpt-5.5. Reviewer/coder provider distinctness is enforced fail-closed at resolution time in `team-task-deps.ts`.

**Flow:** `runProjectOrchestration` (`project-orchestrator.ts`) drives tasks to completion: while an unchecked task remains: `selectNextTask` → `assembleTaskContext` → `runTaskWithRetries` (`decideAttemptOutcome` per attempt; objection short-circuits) → on ready-for-closeout: `performCloseout` (curate+`applyContextUpdate` → `markSelectedTaskComplete` → runCloseoutChecks → commitCloseout → verifyCleanWorktree; any failure blocks durably) → advance. When no unchecked task remains: `buildFinalizerHandoff` → `runFinalizerHandoff`. **Never self-merges** — a completed orchestrated run holds branch-complete for operator merge (spec req 17). `context.md` is Rune-owned orchestration state; `context-curator.ts` is its only writer.

**Single task workflow** (`team-task-workflow.ts`): one task through role gates in order — reviewer-independence check (fail-closed) → QA-first (tests or no-code-test rationale) → tech-lead test review → bounded coder→reviewer round loop → objection-class hard gate → tech-lead diff review → designer IFF `task.designerNeeded` → PM wrap-up → `TaskEvidence`.

**Planning critique (Phase 9):** `runPlanningCritique` is the Rune-owned NEUTRAL cross-model hardening step (NOT a 7th role) that runs after the PM/tech-lead self-review and before the human approval gate. SEQUENTIAL: Claude (Opus) critiques+revises first, then Codex (GPT-5.5) critiques+revises Claude's output. Degrades to the Claude pass alone when Codex is unavailable; fail-closed.

**Live acceptance:** `npm run acceptance:orchestrated` (`__acceptance__/orchestrated-live.acceptance.ts`) — stub-free proof: (1) provider preflight (fail-loud if `claude --model opus` or Codex unavailable); (2) ephemeral fixture repo + temp orchestrated product; (3) drive the production `orchestratedWorkApplier.apply()` over the real path; (4) self-verify (branch diff non-empty + QA-authored test PASSES against the coder's diff + reached `completed`+`held:true`); (5) write a scrubbed proof artifact. Exit 0 = pass.

## Multi-model dispatch (Layer 5)

`dispatchToExecutor(handoff, opts)` (`dispatch-runtime.ts`) branches by target: `claude` → `runAgent`; `codex` → `probeCodexProvider()` guard then `compileToCodex` + `runCodex`. Probe failure short-circuits with a failed `DispatchResult` and still appends the log entry. Maps result to `DispatchResult`, calls `recordDispatch`, appends to `logs/dispatch-log.jsonl`. VALID_SLUG-guards the agent name. Enforces "text is null iff failed". **Invariant:** handoff `context` must never carry vault personal content when target is `codex`.

## Observation loop (§16)

Nightly composer `runNightlyObservation(deps)` (`observation-nightly.ts`) wires sensors → synthesis → loop → triage/dispatch/format:
- `readSensors` fans three sources in stable order (vault → telemetry → interactions); **invariant:** interaction-log `detail` carries only structured metadata, never raw user content.
- `synthesizeDigest(signals, diarize)` short-circuits on empty input.
- `runObservationLoop(signals, existingIdeas, triage)` — in-order triage walk with in-batch + cross-batch dedupe; `LoopOutcome` ∈ filed/discarded/duplicate/quiet.
- `formatIdeasMarkdown(outcomes)` → bullets for `docs/projects/ideas.md`; `planEngineDispatch` routes proceed→dispatch / escalate→await-approval.

## MCP — local stdio + remote OAuth connector (project 16)

**Local (`rune-kb`):** the KB is exposed as a stdio MCP server registered in `.claude/settings.json` so any Claude Code session on the machine can use `kb_query`, `kb_search`, `kb_ingest`, `kb_stats`, `kb_lint`. Standalone entry: `npx tsx --env-file-if-exists=.env.local src/mcp/index.ts`.

**Remote (`/mcp` Claude App connector):** `src/mcp/daemon.ts` runs the standalone MCP daemon (`npm run mcp:start`) on `RUNE_MCP_HOST:RUNE_MCP_PORT`, serving daemon `/health`, OAuth routes, and Streamable HTTP MCP at `/mcp` without booting Telegram, the cockpit/webview, scheduler, or Whoop OAuth. `mountMcpRoute` (`mcp-transport.ts`) handles the `/mcp` endpoint gated by single-user OAuth 2.1 (`mcp-oauth.ts`). Gate order: host-allowlist 403 → FAIL-CLOSED bearer 401 → SDK transport. Per-session `McpServer` instances default to `createRuneMcpServer(APP_SURFACE_TOOLS)` (the six App-surface tools — kb_* admin tools are never remotely reachable). OAuth: DCR (http/https redirect_uris, MAX_CLIENTS=20), consent-form gate (POST with `RUNE_MCP_SECRET` in the BODY), PKCE S256-only, codes single-use, tokens userId-bound + expiry-checked. Production wires `tokenTtlMs:null` (never-expire) + `RUNE_MCP_OAUTH_STORE_FILE` (default `logs/rune-mcp-oauth-store.json`, 0600, atomic) so the App authenticates once to the daemon and survives cockpit restarts. Serves RFC 8414 AS metadata + RFC 9728 protected-resource metadata (issuer pinned via `RUNE_MCP_ISSUER_URL`). Revoke all = delete the daemon store file + restart the MCP daemon.

**One-time cutover reauth:** old web store tokens are not migrated. The standalone daemon owns only `RUNE_MCP_OAUTH_STORE_FILE`, so the Claude App must authenticate once when switching from the legacy web-process store; after that, cockpit restarts do not read, write, delete, or invalidate the daemon store or live daemon sessions.

**MCP daemon launchd runbook:** the committed LaunchAgent is `launchd/com.jarvis.rune-mcp.plist`, installed as `~/Library/LaunchAgents/com.jarvis.rune-mcp.plist` by `scripts/install-rune-mcp-launchd.sh`. It runs with `Label=com.jarvis.rune-mcp`, `WorkingDirectory=/Users/jarvis/workspace/rune`, and `ProgramArguments=/usr/bin/env npm run mcp:start`; the package script expands to `NODE_ENV=production tsx --env-file-if-exists=.env.local src/mcp/daemon.ts`, so daemon env comes from that working directory's `.env.local` when present. Required live-use expectation: set `RUNE_MCP_SECRET`; set `RUNE_MCP_ISSUER_URL` to the final public Funnel HTTPS origin; optionally override `RUNE_MCP_OAUTH_STORE_FILE`, `RUNE_MCP_HOST`, and `RUNE_MCP_PORT` (defaults: `logs/rune-mcp-oauth-store.json`, `127.0.0.1`, `3848`). The plist sets only `PATH`; it does not inline secrets. Stdout/stderr go to `~/Library/Logs/rune/rune-mcp.out.log` and `~/Library/Logs/rune/rune-mcp.err.log`; the daemon `/health` response also points at the in-repo process log.

```bash
scripts/install-rune-mcp-launchd.sh lint
scripts/install-rune-mcp-launchd.sh install
scripts/install-rune-mcp-launchd.sh restart
scripts/install-rune-mcp-launchd.sh uninstall

launchctl print gui/$(id -u)/com.jarvis.rune-mcp
launchctl kickstart -k gui/$(id -u)/com.jarvis.rune-mcp
launchctl bootout gui/$(id -u)/com.jarvis.rune-mcp
```

The install script creates `~/Library/LaunchAgents` and `~/Library/Logs/rune`, lints the source and installed plist, bootouts any existing `com.jarvis.rune-mcp` job, bootstraps the installed plist into `gui/$(id -u)`, then kickstarts it. `restart` is a kickstart only; `uninstall` bootouts the job and removes the installed plist.

Tailscale Funnel is the public Claude App ingress. Keep the daemon bound to loopback and map the Funnel HTTPS listener to the daemon:

```bash
tailscale funnel --bg --https=443 http://127.0.0.1:3848
tailscale funnel status
```

The resulting `https://<machine>.<tailnet>.ts.net` hostname is a human provisioning prerequisite, not a build artifact. Put that exact origin, with no trailing path, in `RUNE_MCP_ISSUER_URL`; Claude App then reaches `https://<machine>.<tailnet>.ts.net/mcp` while the daemon still listens locally on `127.0.0.1:3848`.

## Cockpit view

`buildCockpitView(registry, runStatus, taskProgress?, workRuns?, backlogCounts?, dispatchModes?)` (`src/intent/cockpit.ts`) is a pure projection. `CockpitProject` carries `lifecycleStatus`, `runStatus`, `actions`, and optional `progress` (gen-eval-loop block), `taskProgress` (done/total), `workRun` (id, outcome, reason, last-N output, startedAt, transcriptUrl), `dispatchMode`+`fallbackReason`. `CockpitProduct` carries optional `backlogCounts` (product-name-keyed, repo-backed only). The cockpit filters out lifecycle-`done` projects per product (keeping every product header). `handleApiCockpit` (`webview.ts`) feeds live `RunStatusByProject` from `readCockpitRunStatus(SUPERVISED_RUNS_FILE)` + `readWorkRunProjections` (passing the supervision store's running/blocked-on-human runs as the 4th `activeRuns` arg so a live run's card renders immediately).

**Webview UX:** the cockpit sidebar polls `GET /api/cockpit` and renders products/projects with lifecycle status, run-status, per-project action buttons (start / continue / enter-planning-mode), the in-flight gen-eval-loop progress block, a static task-progress bar, and a per-project work-run block (`renderWorkRun` — active run shows elapsed + last-N output inline; terminated run shows typed outcome + reason + transcript link). The backlog drawer (`#backlog-drawer`) opens from a product's count line, fetches `GET /api/backlog/:product`, renders Bugs/Ideas tabs each with a Plan button + a `+` add chip. The Pending Approvals panel polls `GET /api/approvals`. A production-only "↻ Restart server" button posts to `POST /api/server/restart`.
