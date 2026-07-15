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

Two structural facts to hold onto:

- **Validation runs at three layers** — the coder self-gate in-loop runs the product's complete `validationCommands` and iterates fix → re-run until green; per-task closeout (C3) runs the product's configured `closeoutValidationStrategy`; the final merge gate (D3) runs the complete `validationCommands` again. Rune and Rune-MCP use task-scoped Vitest related tests at C3, while products without an explicit strategy preserve the full product-command closeout. C3 and D3 remain mechanical gates; the final full-suite gate is unchanged.
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

---

# Phase B — Dispatch & sandbox (orchestrated `/work` begins)

| # | Stage | Primary | Reviewing gate | Advance when | Anchor |
|---|---|---|---|---|---|
| B1 | Dispatch / validate / register | `orchestratedWorkApplier` (auto-approve) | `validate()` — slug valid, project dir has `spec.md`, under per-project + global concurrency caps | `{ok:true}` + not cancelled → `SupervisedRun` seeded `running` | `jobs/orchestrated-work-runner.ts`; `transport/mutations.ts` |
| B2 | Worktree from `baseSha` | `createWorktree` | preconditions (target path free, repo has HEAD); resume rebase-reconciles against `baseBranch` | `SandboxSpec` returned, project dir found, baseline tasks snapshotted | `jobs/sandbox-runtime.ts` `createWorktree` |
| B3 | Build deps + start loop | `buildOrchestrationDeps` | none (setup) | loop begins. Per-task round cap = `ORCHESTRATED_ROUND_CAP` = 3 (hard-clamped ≤4) | `orchestrated-work-runner.ts` |

The branch is `rune-work/<slug>` cut at the repo HEAD `baseSha`. Dependency provisioning keeps the fast external `node_modules` symlink for ordinary products, but direct Next.js projects receive a local copy instead so Turbopack resolves every dependency within the worktree — the copy is staged (async, via a sibling dir renamed into place) so it never blocks the event loop or leaves a half-copied tree. `orchestrated-work` and legacy `work-run` share the deterministic per-project worktree path and concurrency caps, so the same project never runs twice concurrently.

---

# Phase C — Per-task loop (repeats until no `- [ ]` remains)

`selectNextTask` returns the first unchecked `- [ ]` line in document order; id = slug of the task text (stable across line moves). Every unchecked line is a real task that enters the per-task role workflow; test-first behavior is handled inside C2b, where QA authors required tests before coder work.

## C1 — Task selection
`src/intent/orch-task-select.ts` `selectNextTask`, driven by the loop in `project-orchestrator.ts` `runProjectOrchestration`. Loop is bounded by `taskCount+1` so a closeout that fails to tick can't spin. Cancellation is checked before each selection and before the finalizer.

## C2 — Per-task role workflow (`src/intent/team-task-workflow.ts` `runGated`)

A single task runs through these ordered sub-gates. Verdicts emit `role-verdict` events; rejections emit `gate-rejection`. Gate identifiers are the exact strings in code.

| Sub | Stage | Primary | Gate | PASS criteria / FAIL handling |
|---|---|---|---|---|
| a | reviewer-independence pre-gate | orchestrator | (implicit) | a reviewer provider distinct from the coder's exists → pass; null → terminal `block` (fail-closed, no rounds) |
| b | QA writes tests | qa | — | tests authored pinning the task contract (or a `no-code-test-rationale`) |
| c | tech-lead test-intent | tech-lead | **`test-intent`** | verdict `approved===true`; FAIL → tech-lead **repair** first (once per task, unless `repairable:false`), then loop back to QA (≤ cap) then `block` |
| d | coder implements | coder | — | diff produced to satisfy the QA tests AND drive the product `validationCommands` green in the worktree (coder self-gate, prompt-enforced); executor throw → `failed` |
| e | coder self-review | coder | — | **exactly one** fix-it pass over its own diff (`runSelfReview`); throw → `failed` |
| f | QA re-validate (conditional) | qa | `implementation-diff` | only if self-review changed diff behavior; `approved===true` else terminal `block` |
| g | reviewer review | reviewer (cross-provider) | **`reviewer-verdict`** | max finding severity ≤ low (`low`→pass-with-warnings; `medium/high/critical`→fail→objection loop); malformed verdict → terminal `failed` |
| h | tech-lead diff review | tech-lead | **`implementation-diff`** | pass/pass-with-warnings; runs **every** round regardless of reviewer outcome; fail → objection loop |
| i | designer review (conditional) | designer | **`design-review`** | only if `task.designerNeeded` — production `toSizedTask` hardcodes this **false**, so the stage is inert in the orchestrated path today |
| — | round-exit decision | orchestrator | — | all gates pass + all prior ledger findings verified + open severity ≤ low → `ready-for-closeout` |

**Test-intent repair (gate c FAIL path):** on the FIRST rejection the tech-lead patches the tests itself instead of bouncing an unfixable state back to the same QA agent (`deps.techLeadRepairTests`, production: an `execute('tech-lead')` worktree session). Mechanics are fail-safe: the repair delta is computed against a pre-repair `git write-tree` snapshot; any path outside `*.test.ts(x)` is reverted on disk (the allowlist is deliberately NOT widened to QA's diff paths — a QA stray into product source must not license a tech-lead edit of the same source); then **confirm-red** runs the product `validationCommands` — a green or timed-out run rolls the patch back (`not-repaired` → QA bounce), a red run threads its output tail into the re-review as `Confirm-red evidence` so the tech-lead judges red-for-the-right-reason. A `repairable:false` verdict (structural rework / spec ambiguity) skips the repair entirely; every internal failure degrades to the QA bounce, never a task-fatal throw. Evidence lands as `TaskEvidence.testIntentRepair`; the attempt emits a `test-repair` activity event.

**Test-deletion guardrail:** gates g and h fail a diff that deletes or weakens a test unless the coder's handoff notes (threaded into both bodies as `## Coder handoff notes`) justify it — a sandbox-impossible external/live dependency or a demonstrated flake, recorded as `TEST-REMOVED: <path> — <reason>`; a test that is red because the implementation fails it may never be removed.

**Objection loop:** findings above `low` thread back as `rejectionFeedback` (+ a severity-sorted findings ledger) into the next coder round, up to 3 rounds (`ORCHESTRATED_ROUND_CAP`; hard budget 4). Terminals: `all-low` or stagnation (severity flat ≥3 rounds, no non-reversible high/critical) → closeout; a non-reversible high/critical residue at cap → **held**; unresolved reversible feedback at cap → **block**. Every rejection also drafts a best-effort gate-learning lesson into the counterpart role's `agents/<role>/memory.md` (never blocks the retry). There is no per-task human park and no PM-wrapup call from `runGated` — per-task terminals are machine-owned `ready-for-closeout` / `block` / `failed`.

## C3 — Per-task closeout (`project-orchestrator.ts` `performCloseout`, Rune-owned)

Ordered so every commit is finalizer-ready:

1. Compute **both** the context update and the checkbox tick (`markSelectedTaskComplete`, ticks exactly the selected task by text+section, refuses a stale match) **before** writing either.
2. **`runCloseoutChecks`** — run the product's `closeoutValidationStrategy`, bounded by `WORK_RUN_CLOSEOUT_COMMAND_TIMEOUT_MS` (default 120s). `product-commands` (the default when absent) runs the configured `validationCommands`. `vitest-related` collects tracked changed paths against `HEAD` plus untracked files, excludes deletions, normalizes/deduplicates them, then argv-spawns `npx vitest related --run --passWithNoTests <paths>` in the worktree; Rune and Rune-MCP opt into this strategy. On failure the run dir gets `closeout-validation-failure.txt` with bounded output head + tail while the scrubbed tail feeds back to the coder as `GateRejectionFeedback` (qa→coder, `implementation-diff`) for up to `CLOSEOUT_REPAIR_CAP` (2) whole-workflow repair re-runs. A timeout first requests Node diagnostic reports with `SIGUSR2`, sanitizes them, and stores them with a command/head/tail artifact under `<run>/validation-diagnostics/` before the normal process-group reap.
3. Persist context, then the tick.
4. `commitCloseout` — `git add -A` + commit `rune(<product>): closeout — <task>`.
5. `verifyCleanWorktree` — `git status --porcelain` empty.

Advance → build a `TaskRunRecord`, append `task-records.jsonl`, write resumable `cursor.json`. Failure dispositions: context-rejected/stale-tick → operational **hold**; **`closeout checks failed` → bounded coder repair loop** (2 re-runs with the failing output tail as gate feedback), still red after 3 attempts → best-effort WIP commit (`rune(<product>): WIP — closeout blocked — <task>`) + **parked** (`blocked-on-human`; branch + worktree preserved, releasable via the standard release path — release cold-finalizes and removes the worktree so a later Start can re-dispatch); worktree not clean → **hold**.

## C4 — Advance / loop
Re-read `tasks.md`; ticked task skipped, next selected. No `- [ ]` remaining = **branch-complete** → Phase D.

---

# Phase D — Finalize & merge (`jobs/work-run-finalizer.ts` `runGatedMerge`)

| # | Stage | Primary | Gate / criteria | Advance when | Anchor |
|---|---|---|---|---|---|
| D1 | Finalizer handoff | `runFinalizerHandoff` → `finalize` adapter (gated-merge mode) | an unavailable adapter returns `held` — never self-merges | adapter returns `{finalized, outcome}` | `jobs/finalizer-handoff.ts` |
| D2 | Classify + transcript flush | `runGatedMerge` | re-runs `classify()` (diff vs `baseSha` → outcome, sets `tasksRemaining`); a hold-signal terminal → operational hold, no merge | `outcome === 'branch-complete'` | `work-run-finalizer.ts` |
| D3 | **Hard merge gate** | `runGate` (under per-product base-branch lock) | first-failure-wins: validation-present → no concurrent run → **clean dry-merge** → **zero tasks remaining** → clean tree → complete product `validationCommands` green, each bounded by `WORK_RUN_GATE_COMMAND_TIMEOUT_MS` (default 10 min). Unchanged by the C3 closeout strategy. | `{ok:true}` | `jobs/work-run-gate-runtime.ts` `runGate`; `work-run-gate.ts` `evaluateGate`; `work-run-merge-lock.ts` `withBaseBranchLock` |
| D4 | Merge → mark done → push → delete | `runGatedMerge` | merge-conflict on the real merge → abort + operational hold | `git merge --no-ff` → `markProjectDone` flips the project Done in `index.md` → write summary/index → **push before delete** → remove worktree → `git branch -d` | `work-run-finalizer.ts` |
| D5 | Terminal event + teardown | applier | maps finalizer result to the terminal `MutationEvent`, writes `mutations.jsonl` + terminal `SupervisedRun` | run `completed`, `merged:true`, `branchDeleted:true` | `orchestrated-work-runner.ts` |

D3 runs entirely in a **throwaway detached integration worktree** at `baseBranch` — the real `main` is byte-for-byte unchanged until the gate is green. Gate refusal stops the run at branch-complete with a `gateHeldReason` and never merges (awaiting-human). Crash mid-finalize resumes off a durable `PHASE_ORDER` (exactly-once merge/push/index).

---

# Terminal states

| State | Meaning | Trigger |
|---|---|---|
| **completed / finalized** | merged to `main`, project marked Done | D3 green + merge/push landed |
| **held** | branch-complete, branch + worktree preserved, no merge; a later Start auto-reclaims a **clean** preserved worktree (`createWorktree` removes + re-adds it), while a **dirty** one refuses with commit-or-discard guidance — uncommitted work is never auto-destroyed | non-reversible high/critical finding, operational failure, or merge-gate refusal |
| **parked** | preserved, waits for **explicit human release** (never auto-releases) | finalizer/mapping park flags; closeout repair exhaustion (WIP-committed); `PARKED_RUN_NUDGE_AFTER_MS` fires a one-time staleness nudge |
| **blocked → failed** | durable stop, task not skipped | task didn't reach closeout, or loop non-convergence |
| **failed** | hard failure | worktree-create error, orchestration throw, user cancel |

Cross-cutting supervision (`jobs/stall-check-runner.ts`, 30s tick): `checkStalledRuns` kills child-dead runs (5min); `planQuietNudges` then `planQuietCancel` handle alive-but-silent runs (keyed on `lastOutputAt`); `planMaxRuntimeKills` enforces `WORK_RUN_MAX_RUNTIME_MS` regardless of liveness (fail-toward-kill). A system cancel is honored at the next task boundary. → `subsystems.md` for the supervision-store field-merge invariants.
