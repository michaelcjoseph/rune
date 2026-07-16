# Reviewer Memory — Craft Lessons

Accumulating craft lessons, one per line, each provenance-stamped
`- [YYYY-MM-DD · source: <slug>] <lesson>`. Append-only; abstract craft only —
no raw excerpts, no private names, opaque source slugs. This is reference, not
rules; the SOUL charter governs on any conflict.

## Objections: signal vs. artifact

- [2026-06-15 · source: self-contradiction-is-a-tell] A diff that contains a logically impossible assertion — an expectation that an output both equals and does-not-contain the same string around a secret or placeholder — is usually a sign the artifact was corrupted upstream (the harness redacted a fixture in transit), not a real defect. Treat self-contradiction as a suspected transport artifact first, and say so, rather than reaching for a hard objection.
- [2026-06-15 · source: objections-are-one-shot] Your objection-class findings are a one-shot hard gate: they short-circuit retries and can discard the whole run, and the coder never gets your feedback as a fixable round. Reserve objections for genuine defects in the named classes (security, data-integrity, concurrency, irreversibility, cost/perf, privacy). For anything that looks like a harness artifact or a fixable miss, withhold the pass with notes instead of objecting — that path is retryable.
- [2026-06-15 · source: review-the-real-tree-when-unsure] When a finding hinges on an exact literal that could have been rewritten by redaction (anything secret-shaped), flag the uncertainty rather than asserting the code is broken. The diff you were handed may not be the tree on disk.

## Completeness: judge the tree, not only the diff

- [2026-06-22 · source: deliverable-already-on-tree] When judging whether a task's deliverable is complete, check the branch tree, not only the diff you were handed. If an earlier commit bundled the deliverable in out of sequence, it won't appear in this task's diff and will read as "missing" — failing a task whose work is already present on the branch. A deliverable that already exists on the tree counts as satisfied; absence-from-this-diff is not absence-from-the-branch.

## Protected local service ownership

- [2026-06-29 · source: agent-protected-service-invariant] Never kill, stop, interrupt, or reuse protected listeners without explicit human approval: Rune web / cockpit at `127.0.0.1:3847` (`com.jarvis.daemon`) and Rune MCP daemon at `127.0.0.1:3848` (`com.jarvis.rune-mcp`). If a test collides, require a dynamic/task-local port, and before killing any process verify the PID was spawned by the current task/worktree/test command.

## Planning-artifact review

- [2026-07-16 · source: execution-profiles-planning-review] Review a plan's dispatchability as well as its prose: every named role, review flag, dependency, manual gate, and acceptance artifact must be represented in the structured task model and reach the runtime workflow. A marker in `tasks.md` is not evidence that the orchestrator can enforce it.
- [2026-07-16 · source: execution-profiles-planning-review] For security-sensitive plans, verify that an existing security policy is reconciled rather than duplicated, that the named security reviewer actually exists and blocks on findings, and that platform-enforcement claims have a fail-closed capability test.
