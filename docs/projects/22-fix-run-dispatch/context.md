# Project Context: startFixRun — cockpit Fix dispatches a real, verified fix run instead of dead-ending at the handoff

> Orchestration state for the `rune` project "startFixRun — cockpit Fix dispatches a real, verified fix run instead of dead-ending at the handoff".
> Owned by Rune's context curator — roles read a bounded slice and emit handoff
> notes; they do not author this file directly.

## Current State

The Fix button should turn an approved, single-product bug scope into a real orchestrated-work run that either lands a reviewed, finalizer-gated merge on main or reaches a readable terminal state in the cockpit. The operator should be able to distinguish success, policy decline, parked human intervention, and machinery failure without reading raw CLI output.

## Key Decisions

- Decision #1 locked to approach (a): scaffold a minimal one-task fix project and dispatch orchestrated-work, reusing team-task + the project-15 finalizer. Gen-eval-loop (b) rejected because its runs currently park blocked-on-human and don't finish cleanly.
- "Verified" includes code review of the fix, not just a green suite. The intent is that the merged fix was reviewed. If the team-task / orchestrated-work path already runs a review stage, reuse it; if not, adding one is in scope for meeting requirement #3. Reject this assumption if a green-suite-only bar is what you actually want.
- Single-product means the bug's product repo is the same repo the run mutates (rune fixing rune).
- Existing execution infra (orchestrated-work mutations, team-task workflow, project-15 finalizer, work-run observability from projects 11/13/14/15) is reused, not rebuilt.
- The gate and scoping decision are unchanged; startFixRun is only invoked on a proceed decision.

## Interfaces & Contracts

# Tech Spec — Fix Button Dispatches a Real, Verified, Merged Fix Run

## Summary

`startFixRun` currently throws, causing every approved Fix attempt to end as `handoff-failed`. This project replaces the stub with a real handoff: guard single-product eligibility, scaffold and commit a one-task fix project, dispatch orchestrated-work, and reconcile the run outcome back to the fix-attempt terminal shown in the cockpit.

The implementation reuses existing machinery:
- `createMutation('orchestrated-work', { projectSlug, product }, 'webview')` creates the run descriptor; descriptor id is the `runId`.
- Team-task workflow supplies the code-review gate.
- Orchestrated-work invokes the project-15 gated merge finalizer.
- Existing work-run transcript and run APIs provide the cockpit transcript link.

## Contracts

`startFixRun(input: StartFixRunInput): Promise<StartFixRunResult>`

`StartFixRunInput = { product: string; bugId: string; scope: { bug: BacklogItem; facts: BugScopingFacts } }`

`StartFixRunResult = { accepted: true; runId: string } | { accepted: false; reason: string; detail?: string }`

Expected `accepted:false` reasons:
- `unknown-product`
- `not-repo-backed`
- `not-single-product`
- `scaffold-failed`
- `commit-failed`
- `dispatch-rejected`

Webview mapping:
- `accepted:true` records/keeps `proceeding` with `runId`.
- `accepted:false` + `not-single-product` records `declined` with reason/detail.
- Other `accepted:false` reasons and throws record `handoff-failed`.
- No branch may clobber an already-recorded terminal.

`FixAttemptState` adds post-dispatch terminals:
- `fixed`
- `failed`
- `parked-on-human`

`declined` remains pre-dispatch policy/gate decline, not a reconciler output.

## Data Flow

1. Gate returns `proceeding`.
2. `startFixRun` resolves product config.
3. Single-product guard:
   - unknown product => `unknown-product`
   - empty `repoPath` => `not-repo-backed`
   - deliverable repo differs from product repo => `not-single-product`
4. Scaffold helper derives deterministic slug and writes:
   - `docs/projects/<slug>/spec.md`
   - `docs/projects/<slug>/tasks.md`
5. Scaffold commit lands only those paths on the product `baseBranch`.
6. `createMutation('orchestrated-work', { projectSlug, product }, 'webview')` dispatches the run.
7. Reconciler maps run terminal outcome to fix-attempt terminal.
8. Cockpit renders terminal, reason/detail, and run transcript link.

## Scaffold and Git Safety

The fix project must be present on baseBranch before dispatch because orchestrated-work resolves the project in a fresh worktree.

Implementation must:
- Use a deterministic slug keyed by bug id.
- Be idempotent for retries.
- Commit only scaffold paths.
- Preserve unrelated dirty files and staged files.
- Fail with typed reason if scaffold paths conflict with unrelated work.
- Verify/checkout baseBranch safely or use a task-local worktree.
- Leave no half-written project on failure.
- Log slug and commit SHA.

Tests use temp git repos only.

## Reconciler

The reconciler reads existing mutation/supervision records by `runId`.

Mapping:
- completed with merged/finalizer-merged discriminator => `fixed`
- failed => `failed`
- parked, blocked-on-human, held, noop, partial, or completed without merge => `parked-on-human`

It is wired two ways:
- Event-driven if mutation terminal events are available.
- Startup catch-up sweep over `proceeding` attempts.

Correctness must not depend only on event delivery. The reconciler is idempotent and never overwrites an existing terminal.

## Logging

Required logs:
- Guard accept/reject with reason.
- Scaffold slug and commit SHA.
- Dispatch start with runId and dispatch kind.
- Dispatch/scaffold/commit failures with cause.
- Reconciler runId -> terminal mapping with underlying run outcome.
- Webview distinction between policy decline and handoff failure.

User-visible messages and HTTP/cockpit surfaces must not expose unsanitized host paths.

## Cockpit Surface

Update state mapping and rendering for:
- `fixed`
- `failed`
- `parked-on-human`
- `declined` with reason/detail
- existing `handoff-failed`

The existing runId link to `/api/work-runs/<runId>` remains the transcript path.

## Test Strategy

Code tests:
- FixAttemptState parse/round-trip.
- Guard pass and all reject branches.
- Scaffold commit in temp git repo, including idempotent retry and dirty unrelated work preservation.
- startFixRun dispatch assembly and failure branches.
- Webview accepted:false mapping.
- Reconciler mappings for merged, failed, parked/blocked/noop/partial.
- Cockpit rendering and run link retention.
- Log-capture assertions for required paths.

Tests-as-deliverable:
- Stub-free acceptance path using temp repo, real guard, real scaffold-and-commit, and real `createMutation('orchestrated-work')`.
- Recorded terminal outcomes drive reconciler to `fixed`, `failed`, and `parked-on-human`.
- Divergent deliverable repo records `declined`, not `handoff-failed`.

Manual live gate:
- Operator clicks Fix on a real bug.
- Run dispatches and is visible.
- Reviewer gate actually runs.
- Finalizer gates merge.
- Main receives the merge or attempt reaches readable terminal.
- Transcript and logs are readable.
- Guard reject reads as `declined`.
- Protected listeners 127.0.0.1:3847 and :3848 are not killed or reused.

## Protected-Service Invariant

No test may kill, reuse, or bind the protected listener ports. Any spawned process cleanup must verify the PID belongs to the test. Tests operate on temp repos, not the real vault or protected service worktree.

## Out of Scope

Cross-repo/cross-product autorun, bug gate changes, gen-eval-loop seeding, bug sweeps, and new review/finalizer/status systems.

## Known Risks

_None yet._

## Next Task Handoff

Start with: Extend FixAttemptState in src/jobs/fix-attempt-store.ts with the post-dispatch terminals 'fixed' | 'failed' | 'parked-on-human' (the pre-dispatch 'declined' already exists and is reused for guard policy-declines): add them to the FixAttemptState union, the STATES set, and parseFixAttempt validation (a terminal with runId stays valid; keep torn-line tolerance; do not require runId on the guard-decline path). No transition wiring yet. Update fix-attempt-store.test.ts for parse/round-trip of the new states.
