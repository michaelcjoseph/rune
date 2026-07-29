# Project Lifecycle: `/plan` → merged

The full path a project travels from a `/plan` conversation to a branch merged onto `main` by an orchestrated `/work` run. `CLAUDE.md` carries a one-line pointer; the per-stage detail lives here. Companion docs: `subsystems.md` (mutation pipeline, supervision, gated-merge finalizer mechanics), `reviews-kb-vault.md` (planning-session routing).

Read this when you need to know **who owns a stage, who signs off on it, and what condition advances it** — e.g. debugging why a run stalled, blocked, or refused to merge.

## Models at a glance

Role→model bindings are policy-declared in `policies/model-policy.json` (`roleDefaults`); a missing policy falls back to `def.model ?? config.AGENT_MODEL`.

| Role | Model / provider | How it runs |
|---|---|---|
| pm, tech-lead, reviewer, designer | Opus 4.8 / anthropic | judgment calls (fenced-verdict round-trips) |
| qa, coder | GPT-5.5 / openai (Codex) | artifact producers (`runExecutionAgent`) |
| neutral critique | Claude Opus **then** Codex | cross-model hardening, sequential (Codex critiques Claude's output) |

Charters load via `composeRoleContext(role, instruction)` (`src/roles/loader.ts`): `agents/<role>/SOUL.md` → system channel (authority), `agents/<role>/memory.md` + exemplars → a low-authority fenced reference in the first user turn. SOUL wins on conflict.

Three structural facts to hold onto:

- **Validation is fail-closed by task policy** — every planned task carries `validationPolicy`. Missing/legacy metadata means `required`; only the explicit, planning-reviewed `reviewed-no-validation` value exempts a task. Required tasks must pass admission before QA/coder dispatch, then the distinct pre-closeout mechanical gate (C3), while the final merge gate (D3) still runs the complete product command list.
- **Reviewers see the complete Git surface** — self-review is itself a worktree-editing coder pass, so after it Rune stages tracked and untracked changes and derives the scrubbed canonical `git diff HEAD` from the worktree. That Git-derived diff is the only implementation surface QA, reviewer, tech lead, and designer receive; no model-returned text is ever a candidate diff. Its hash is rechecked after mechanical validation.
- **Exactly one human gate** in the whole lifecycle: `/approve` (A5). Everything downstream of it is automated and adds zero approval points (project-20 invariant, asserted in tests). The manual live-release gate some project `tasks.md` files carry is a Definition-of-Done note, not a pipeline gate.

---

# Phase A — Planning (`/plan` → scaffolded project)

One interactive session, split around the `/approve` gate. Pre-approval is a live PM interview; post-approval is the automated `runDownstreamPlan` pipeline. Failures after A5 leave the session `approved` so `/approve` can retry without losing the spec.

| # | Stage | Primary | Reviewing gate | Advance when | Anchor |
|---|---|---|---|---|---|
| A1 | `/plan <product>` entry | user + code | registry validation (slug must exist in `products.json`) | canonical slug matches → session created, status `scoping` | `bot/commands/plan.ts` |
| A2 | PM Socratic interview | **pm** | none per turn; a spec-shaped reply missing the `pm-spec` fence throws | PM has enough context OR detects proceed-intent, emits a `pm-spec` artifact | `reviews/planning-handler.ts` `defaultScopingTurn` |
| A3 | PM spec parse + validate | code | schema — `{version:2, kind:'pm-spec', product, title, spec}` | valid `PmSpecArtifact` parses | `planning-handler.ts` `validatePmSpecArtifact` |
| A4 | PM fix-it self-review (cold) | **pm** | the self-review; one strict-format re-prompt then fail | parseable corrected/confirmed spec → status `spec-proposed`, presented to user | `planning-handler.ts` `reviewPmSpecArtifact`; `intent/self-review.ts` `runSelfReview` |
| **A5** | **★ `/approve` — the single human gate ★** | **user** | state-machine guards; a legacy artifact (no `version:2`) hard-fails with a restart message, never silent-scaffolds | user approves `spec-proposed` → status `approved`, `approvedSpec` persisted (durable resume point) | `bot/commands/approve.ts` `handleApprove`; `reviews/planning.ts` `approveActivePlanningSession` |
| A6 | Tech-lead breakdown | **tech-lead** | parser is fail-**hard** — an empty/zero-task breakdown throws | `{techSpec, tasks≥1}` parses | `intent/planning-roles.ts` `runDownstreamPlan` |
| A7 | Tech-lead fix-it self-review (cold) | **tech-lead** | the self-review; one re-prompt then fail | parseable corrected/confirmed result | `planning-roles.ts`; `self-review.ts` |
| A8 | PM review-match | **pm** | this IS the gate; fail-**closed** (unparseable → `match:false`) | `match===true` OR PM supplied an in-band repair; **no-repair mismatch is terminal, non-retryable** | `planning-roles.ts` `pmReviewMatch` |
| A9 | Claude critique (pass 1) | **Claude Opus** (neutral) | self-contained fail-closed — unparseable keeps the pre-critique plan | always (revise-or-keep); only a thrown CLI error is terminal | `intent/planning-critique.ts` `runPlanningCritique` |
| A10 | Codex critique (pass 2) | **Codex GPT-5.5** (read-only) | gated by Codex availability | always — revise, or degrade to Claude-alone with a **non-terminal warning** | `planning-critique.ts` |
| A11 | Context seed (`context.md`) | **code** (roles never author `context.md` — invariant) | validation in `seedProjectContext` | context produced → full `SpecArtifact` assembled + persisted as `downstreamArtifact` | `intent/project-context.ts` `seedProjectContext` |
| A12 | Scaffold | **project-setup-writer** agent | deterministic backstop — repo resolves under `$WORKSPACE_ROOT`; `crossCheckScaffold` verifies the slug; **all three of `spec.md`/`tasks.md`/`test-plan.md` must exist on disk** | verified slug + three files present → session deleted. Project is now workable | `jobs/scaffold-approval.ts` `runScaffoldApproval`; `.claude/agents/project-setup-writer.md` |

Downstream order (A6→A12) is fixed: breakdown → tech-lead self-review → `pmReviewMatch` → Claude critique → Codex critique → context seed → scaffold. The critique reads forward into both the seed and the human-visible surface. The agent writes `spec.md`/`tasks.md`/`test-plan.md`/`index.md`; `tech-spec.md`, `context.md`, and `examples/<role>.md` are written deterministically by `writeRoleArtifacts`, not the agent.

The tech-lead breakdown, PM repair, both critique passes, and deterministic `tasks.md` rendering preserve each task's `validationPolicy`. Critique parsing reconciles policy by stable task ID: an existing task keeps its already-reviewed policy even if a critic tries to change it, while every critic-added task is forced to `required`. Other parsers default omitted or malformed legacy values to `required`; `tasks.md` records the policy immediately under its task checkbox so `selectNextTask` can carry it into runtime admission.

---

# Phase B — Dispatch & sandbox (orchestrated `/work` begins)

| # | Stage | Primary | Reviewing gate | Advance when | Anchor |
|---|---|---|---|---|---|
| B1 | Dispatch / validate / register | `orchestratedWorkApplier` (auto-approve) | `validate()` — slug valid, project dir has `spec.md`, under per-project + global concurrency caps | `{ok:true}` + not cancelled → `SupervisedRun` seeded `running` | `jobs/orchestrated-work-runner.ts`; `transport/mutations.ts` |
| B2 | Worktree from `baseSha` | `createWorktree` | preconditions (target path free, repo has HEAD); resume rebase-reconciles against `baseBranch`; project directory plus managed `spec.md`/`tasks.md`/existing `context.md` must be non-symlinks whose realpaths stay inside the worktree | `SandboxSpec` returned, project dir found, baseline tasks snapshotted | `jobs/sandbox-runtime.ts` `createWorktree`; `verifyWorktreeProvisioning` |
| B3 | Build deps + start loop | `buildOrchestrationDeps` | none (setup) | loop begins. Per-task round cap = `ORCHESTRATED_ROUND_CAP` = 3 (hard-clamped ≤4) | `orchestrated-work-runner.ts` |

The branch is `rune-work/<slug>` cut at the repo HEAD `baseSha`. Dependency provisioning keeps the fast external `node_modules` symlink for ordinary products, but direct Next.js projects receive a local copy instead so Turbopack resolves every dependency within the worktree — the copy is staged (async, via a sibling dir renamed into place) so it never blocks the event loop or leaves a half-copied tree. `orchestrated-work` and legacy `work-run` share the deterministic per-project worktree path and concurrency caps, so the same project never runs twice concurrently.

---

# Phase C — Per-task loop (repeats until no `- [ ]` remains)

`selectNextTask` returns the first unchecked `- [ ]` line in document order; id = slug of the task text (stable across line moves). Every unchecked line is a real task that enters the per-task role workflow; test-first behavior is handled inside C2b, where QA authors required tests before coder work.

## C1 — Task selection
`src/intent/orch-task-select.ts` `selectNextTask`, driven by the loop in `project-orchestrator.ts` `runProjectOrchestration`. Selection reads the task's adjacent `Validation policy` metadata and defaults older tasks to `required`. The loop is bounded by `taskCount+1` so a closeout that fails to tick can't spin. Cancellation is checked before each selection and before the finalizer.

## C2 — Per-task role workflow (`src/intent/team-task-workflow.ts` `runGated`)

Before model-policy resolution, executor preflight, dependency construction, or any QA/coder call, the production runner admits the task's validation contract. A required task must have at least one parseable shell-free command, a worktree-contained real `validationCwd` (repository root by default), and every referenced executable available on the launchd-safe toolchain path. Missing commands, malformed commands, missing executables, invalid/missing directories, and symlink escapes return blocked `TaskValidationFailure` evidence and append a scrubbed `task-validation-failures.jsonl` record. Only explicit `reviewed-no-validation` tasks bypass this admission; `runValidationCommands([])` retains its legacy pass behavior outside this orchestrated boundary.

After admission, the production runner resolves all role models and executes the run-scoped executor preflight before dependency construction or the first role call: executable CLIs, persisted subscription authentication from the effective product executor state, and one bounded built-in-tools-disabled live call per unique exact model binding. Claude and Codex probes stay behind their centralized AI spawn boundaries; Codex additionally uses a private auth/runtime, official execution-feature disabling, and a macOS Seatbelt sensitive-host-read denial. When artifact MCP is configured, each distinct QA/coder format is built in a temporary scratch worktree, authenticated through its generated profile/runtime, and must complete a live relay/broker MCP `initialize` + exact `tools/list` handshake before cleanup. A success is transcripted once and cached for later tasks/closeout retries in the same run. A failure is a bounded, scrubbed, typed `blocked` terminal with no raw probe output, no invoked roles, and unchanged tracked, staged, and untracked product-worktree state; failed checks are retried rather than cached. Manual/live release-gate tasks bypass this automated-executor gate.

After preflight, each role call first persists a durable execution checkpoint naming task, role, provider, CLI format, exact model, and workflow stage. A failed checkpoint write blocks before spawn; successful task closeout clears the current checkpoint, and old cursors without the optional field remain readable. Executor or unexpected role-boundary failures carry a typed `ExecutionFailure` through `TaskEvidence.executionFailure` (with `failureReason` retained as a compatibility summary). This structure—not diagnostic wording—selects the operational route; policy/preflight blocks, findings, ordinary gate rejection, and cancellation remain distinct.

Artifact-role execution gets at most two total fresh-process attempts. Spawn, timeout, retryable provider, and generic nonzero-exit failures may retry once after a jittered 1–2 second cancellation-aware backoff; Codex supplies a structured process failure kind rather than relying on diagnostic wording. Retry requires identical `git add -A` + `git write-tree` OIDs before and after the failed attempt. The snapshot covers tracked and non-ignored untracked content only—ignored files, Git metadata, and external side effects are outside this guard. A Git-visible mutation yields `worktree-changed`, preserves the partial work, and stops. Artifact-MCP/environment/config/auth/sandbox, preflight, validation, Git, cancellation, and semantic/gate failures do not retry. Eligible QA/coder retries rebuild and stop a fresh isolated artifact-MCP environment; all retries use a new model child and emit bounded attempt/retry transcript activity. If the child and MCP cleanup both fail, the child failure remains primary and the cleanup problem is retained as secondary attempt evidence; no retry follows an uncertain cleanup. Exhaustion retains both failed attempts with scrubbed diagnostics.

After preflight, a single task runs through these ordered sub-gates. Verdicts emit `role-verdict` events; rejections emit `gate-rejection`. Gate identifiers are the exact strings in code.

| Sub | Stage | Primary | Gate | PASS criteria / FAIL handling |
|---|---|---|---|---|
| a | reviewer-independence pre-gate | orchestrator | (implicit) | a reviewer provider distinct from the coder's exists → pass; null → terminal `block` (fail-closed, no rounds) |
| b | QA writes tests | qa | — | tests authored pinning the task contract (or a `no-code-test-rationale`) |
| c | tech-lead test-intent | tech-lead | **`test-intent`** | verdict `approved===true`; FAIL → tech-lead **repair** first (once per task, unless `repairable:false`), then loop back to QA (≤ cap) then `block` |
| d | coder implements | coder | — | diff produced to satisfy the QA tests AND drive the product `validationCommands` green in the worktree (coder self-gate, prompt-enforced); typed executor failure → operational `held` |
| e | coder self-review | coder | — | a fresh-context worktree-editing coder pass (`coder-self-review` stage, coder model binding) after **every** round's implementation, free to edit the same files and re-run validation. Returns an outcome-only `coder-self-review` fence (`confirmed`/`revised` + bounded notes) — never a diff. Rune snapshots `git write-tree` before and after and fails closed when the claimed outcome disagrees with the tree (`confirmed`=unchanged, `revised`=changed), on a malformed fence, or on any executor failure — the post snapshot runs even then, so edits from a failed pass can't be quietly reviewed. `revised` notes join the coder handoff notes reaching the reviewer and tech lead. Unexpected boundary failure → checkpoint-attributed operational `held` |
| f | canonical review capture | Rune | — | `captureCanonicalReviewState` after the self-review: `git add -A` includes tracked + untracked work, and the scrubbed canonical `git diff HEAD` + hash + changed paths become the sole downstream review surface. There is no per-round candidate-vs-canonical comparison — the worktree *is* the artifact. The approved hash is rechecked once after mechanical validation at closeout (`ReviewSurfaceFailure`, `orchestrated-work-runner`) to catch post-approval drift |
| g | QA re-validate | qa | `implementation-diff` | QA always receives the canonical diff; `approved===true` else terminal `block` |
| h | reviewer review | reviewer (cross-provider) | **`reviewer-verdict`** | reviewer receives the canonical diff; max finding severity ≤ low (`low`→pass-with-warnings; `medium/high/critical`→fail→objection loop); malformed verdict → terminal `failed` |
| i | tech-lead diff review | tech-lead | **`implementation-diff`** | tech lead receives the canonical diff; pass/pass-with-warnings; runs **every** round regardless of reviewer outcome; fail → objection loop |
| j | designer review (conditional) | designer | **`design-review`** | designer receives the canonical diff only if `task.designerNeeded` — production `toSizedTask` hardcodes this **false**, so the stage is inert in the orchestrated path today |
| — | round-exit decision | orchestrator | — | all gates pass + all prior ledger findings verified + open severity ≤ low → `ready-for-closeout` |

**Test-intent repair (gate c FAIL path):** on the FIRST rejection the tech-lead patches the tests itself instead of bouncing an unfixable state back to the same QA agent (`deps.techLeadRepairTests`, production: an `execute('tech-lead')` worktree session). Mechanics are fail-safe: the repair delta is computed against a pre-repair `git write-tree` snapshot; any path outside `*.test.ts(x)` is reverted on disk (the allowlist is deliberately NOT widened to QA's diff paths — a QA stray into product source must not license a tech-lead edit of the same source); then **confirm-red** runs the product `validationCommands` — a green or timed-out run rolls the patch back (`not-repaired` → QA bounce), a red run threads its output tail into the re-review as `Confirm-red evidence` so the tech-lead judges red-for-the-right-reason. A `repairable:false` verdict (structural rework / spec ambiguity) skips the repair entirely; every internal failure degrades to the QA bounce, never a task-fatal throw. Evidence lands as `TaskEvidence.testIntentRepair`; the attempt emits a `test-repair` activity event.

**Test-deletion guardrail:** gates g and h fail a diff that deletes or weakens a test unless the coder's handoff notes (threaded into both bodies as `## Coder handoff notes`) justify it — a sandbox-impossible external/live dependency or a demonstrated flake, recorded as `TEST-REMOVED: <path> — <reason>`; a test that is red because the implementation fails it may never be removed.

**Objection loop:** findings above `low` thread back as `rejectionFeedback` (+ a severity-sorted findings ledger) into the next coder round, up to 3 rounds (`ORCHESTRATED_ROUND_CAP`; hard budget 4). Terminals: `all-low` or stagnation (severity flat ≥3 rounds, no non-reversible high/critical) → closeout; a non-reversible high/critical residue at cap → **held**; unresolved reversible feedback at cap → **block**. Every rejection also drafts a best-effort gate-learning lesson into the counterpart role's `agents/<role>/memory.md` (never blocks the retry). There is no per-task human park and no PM-wrapup call from `runGated` — per-task terminals are machine-owned `ready-for-closeout` / `block` / `failed`.

## C3 — Pre-closeout mechanical validation (`runCloseoutChecks`, Rune-owned)

This gate runs after a task reaches `ready-for-closeout` but before `performCloseout`, context transformation, checkbox mutation, or a closeout commit. Explicit `reviewed-no-validation` tasks pass without commands. Required tasks are re-admitted against the current worktree, then run the product's `closeoutValidationStrategy`, bounded by `WORK_RUN_CLOSEOUT_COMMAND_TIMEOUT_MS` (default 120s):

- `product-commands` (the default when absent) runs the configured `validationCommands` from validated `validationCwd`.
- `vitest-related` collects tracked changed paths against `HEAD` plus untracked files, excludes deletions, normalizes/deduplicates them, rebases them from the worktree root to `validationCwd`, then argv-spawns `npx vitest related --run --passWithNoTests <paths>` there. Rune and Rune-MCP opt into this strategy; deletion or global-config changes fall back to the complete command list.
- After commands pass, Rune stages again and requires the canonical review-diff hash to equal the hash approved by QA/reviewer/tech lead/designer. A post-review or validation-time mutation fails closed with durable `ReviewSurfaceFailure` hashes and changed paths; raw diff content is never persisted.

Admission or command failures append bounded, scrubbed `TaskValidationFailure` evidence with the exact command/prerequisite, exit status or timeout, and diagnostics. A red gate feeds its scrubbed output tail back to the coder as `GateRejectionFeedback` for up to `CLOSEOUT_REPAIR_CAP` (2) whole-workflow repair re-runs. A timeout first requests Node diagnostic reports with `SIGUSR2`, sanitizes them, and stores them with a command/head/tail artifact under `<run>/validation-diagnostics/` before process-group reap. Exhaustion best-effort WIP-commits and parks `blocked-on-human`; no context write, task tick, or closeout commit has occurred.

## C4 — Mutation closeout (`project-orchestrator.ts` `performCloseout`, Rune-owned)

Only a task that passed C3 enters this ordered sequence:

1. Normalize and compute **both** the context update and checkbox tick (`markSelectedTaskComplete`, exact task text+section, stale match refused) before writing either.
2. Persist context, then the tick.
3. `commitCloseout` — `git add -A` + commit `rune(<product>): closeout — <task>`.
4. `verifyCleanWorktree` — `git status --porcelain` empty.

The context normalization is a deterministic migration/upsert: the exact legacy `## Canonical Interfaces` heading becomes `## Interfaces & Contracts` in place with its body preserved, and absent canonical sections are appended with `_None yet._`. The resulting document must contain each of the five canonical headings exactly once. Duplicate canonical headings, duplicate legacy headings, a legacy/canonical collision, or an update body containing a managed heading is ambiguous and fails with a structured reason, canonical/conflicting headings where relevant, and a bounded proposed repair; conflict evidence retains an exact total while displaying at most ten headings. Rune never guesses how to merge competing bodies. Authoritative spec/tasks/context access shares one managed-worktree adapter: it validates the real parent/file, opens with `O_NOFOLLOW`, verifies the descriptor still matches the current contained pathname, rejects hard links, and truncates only after verification. Node does not expose `openat(2)`, so a hostile surviving process could still race an ancestor rename after verification; closeout's serialized, post-child-reap lifecycle explicitly excludes that actor.

Advance → build a `TaskRunRecord`, append `task-records.jsonl`, write resumable `cursor.json` without the now-completed role checkpoint. A context-transform refusal writes neither `context.md` nor `tasks.md` and creates no closeout commit. Rune first attempts the labeled `WIP — closeout blocked` checkpoint, then emits failed terminal truth with a **preserved** operational-hold disposition—not a `blocked-on-human` finding park. The durable run summary and Cockpit surfaces carry the resolved worktree-relative context filename, heading/repair evidence, checkpoint diagnostic or WIP SHA, and preserved disposition; host paths are scrubbed. Stale-tick or a dirty post-commit worktree remains an operational **hold**.

## C5 — Advance / loop
Re-read `tasks.md`; ticked task skipped, next selected. No `- [ ]` remaining = **branch-complete** → Phase D.

---

# Phase D — Finalize & merge (`jobs/work-run-finalizer.ts` `runGatedMerge`)

| # | Stage | Primary | Gate / criteria | Advance when | Anchor |
|---|---|---|---|---|---|
| D1 | Finalizer handoff | `runFinalizerHandoff` → `finalize` adapter (gated-merge mode) | an unavailable adapter returns `held` — never self-merges | adapter returns `{finalized, outcome}` | `jobs/finalizer-handoff.ts` |
| D2 | Classify + transcript flush | `runGatedMerge` | re-runs `classify()` (diff vs `baseSha` → outcome, sets `tasksRemaining`); a hold-signal terminal → operational hold, no merge | `outcome === 'branch-complete'` | `work-run-finalizer.ts` |
| D3 | **Hard merge gate** | `runGate` (under per-product base-branch lock) | first-failure-wins: validation-present → no concurrent run → **clean dry-merge** → **zero tasks remaining** → clean tree → validated `validationCwd` → complete product `validationCommands` green there, each bounded by `WORK_RUN_GATE_COMMAND_TIMEOUT_MS` (default 10 min). Unchanged by the C3 closeout strategy. | `{ok:true}` | `jobs/work-run-gate-runtime.ts` `runGate`; `work-run-gate.ts` `evaluateGate`; `work-run-merge-lock.ts` `withBaseBranchLock` |
| D4 | Merge → mark done → push → delete | `runGatedMerge` | merge-conflict on the real merge → abort + operational hold | `git merge --no-ff` → `markProjectDone` flips the project Done in `index.md` → write summary/index → **push before delete** → remove worktree → `git branch -d` | `work-run-finalizer.ts` |
| D5 | Terminal trigger + teardown disposition | applier | captures immutable success/failure/cancellation trigger, resolves removed/preserved/parked cleanup, appends terminal facts through the still-open transcript, then writes summary + terminal mutation/supervision state | trigger truth and cleanup disposition are both durable before publication | `orchestrated-work-runner.ts` |

D3 runs entirely in a **throwaway detached integration worktree** at `baseBranch` — the real `main` is byte-for-byte unchanged until the gate is green. Gate refusal stops the run at branch-complete with a `gateHeldReason` and never merges (awaiting-human). Crash mid-finalize resumes off a durable `PHASE_ORDER` (exactly-once merge/push/index).

---

# Terminal states

| State | Meaning | Trigger |
|---|---|---|
| **completed / finalized** | successful trigger; merged to `main`, project marked Done | D3 green + merge/push landed |
| **held** | branch + worktree preserved, no merge; a later Start auto-reclaims a **clean** preserved worktree (`createWorktree` removes + re-adds it), while a **dirty** one refuses with commit-or-discard guidance — uncommitted work is never auto-destroyed | non-reversible high/critical finding or merge-gate refusal; typed operational failures—including structured context-transform refusal after its WIP checkpoint attempt—keep a failure trigger |
| **parked** | cleanup disposition preserves the worktree and waits for **explicit human release** (never auto-releases); it does not replace the terminal trigger | dirty/uncertain terminal cleanup; finalizer/mapping park flags; closeout repair exhaustion (WIP-committed); `PARKED_RUN_NUDGE_AFTER_MS` fires a one-time staleness nudge |
| **blocked → failed** | durable stop, task not skipped | task didn't reach closeout, or loop non-convergence |
| **failed** | hard failure | worktree-create error, orchestration throw, user cancel |

Every orchestrated terminal now stores an immutable `trigger` (`success | failure | cancellation`, with execution-failure/cancellation source where applicable) separately from its worktree `disposition` (`removed | preserved | parked`, optional WIP SHA). The runner resolves disposition before persisting terminal mutation/supervision state; the finalizer's transcript checkpoint stays open so the resolved `terminal-facts` row lands before final close and the disposition-aware summary rewrite. Summary outcome, exit facts, descriptor error, event kind, and notifications derive from the trigger; disposition affects preservation and supervision only. Executor/orchestration failure uses `exitCode:1` + `execution-failure` and remains failed after dirty-WIP parking. User cancellation uses `exitCode:1` + `user-cancel` and remains failed. System/shutdown/recovery cancellation uses `exitCode:null` + `system-cancel`, retaining work-product classification without being mistaken for an executor failure. Cleanup uncertainty after genuine success does not invent a failure, and late work-product classification cannot upgrade a failure trigger to completion. A summary carrying structured `contextFailure` is accepted only with failed outcome, a failure trigger, execution-failure exit facts, preserved disposition, and exact agreement—including absence—between the checkpoint SHA and disposition SHA. The transcript, run summary, authenticated detail/Cockpit projection, and Telegram parked message expose the same scrubbed cause plus disposition; legacy top-level reason/parked fields and readers without the optional records remain supported.

Cross-cutting supervision (`jobs/stall-check-runner.ts`, 30s tick): `checkStalledRuns` kills child-dead runs (5min); `planQuietNudges` then `planQuietCancel` handle alive-but-silent runs (keyed on `lastOutputAt`); `planMaxRuntimeKills` enforces `WORK_RUN_MAX_RUNTIME_MS` regardless of liveness (fail-toward-kill). Cancellation carries both terminal classification (`user | system`) and actuator source. User, shutdown, recovery, and unspecified system requests are irrevocable. Quiet/max-runtime requests are provisional at the post-workflow boundary only: non-ready evidence still stops, while `ready-for-closeout` atomically supersedes the active watchdog request, emits `system-cancel-superseded`, resets the quiet cycle (and max-runtime epoch when applicable), then performs normal closeout and continues. → `subsystems.md` for the supervision-store activity-reset mechanics.
