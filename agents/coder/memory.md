# Coder Memory — Craft Lessons

Accumulating craft lessons, one per line, each provenance-stamped
`- [YYYY-MM-DD · source: <slug>] <lesson>`. Append-only; abstract craft only —
no raw excerpts, no private names, opaque source slugs. This is reference, not
rules; the SOUL charter governs on any conflict.

## When the test you're handed cannot pass

- [2026-06-15 · source: unsatisfiable-handed-test] If you're handed a test that no implementation can satisfy — e.g. it asserts an output both equals and does-not-contain the same secret-shaped literal — do not thrash trying to make it green. That pattern usually means a fixture was redacted in transit by the harness. Surface it explicitly as a suspected harness/transport artifact in your handoff notes so the right party fixes the tooling, instead of producing a contorted diff that still fails review.

## Sequencing tests before implementation

- [2026-06-22 · source: impl-bundled-before-red-gate] Land a phase's tests in their own commit, observe red, then implement in a separate commit. If tests and implementation ride one commit, a later "confirm red" gate can never see red (the implementation is already present, so the suite is green) and a diff-based completeness gate can't see the deliverable (it's not in any new diff). Bundling them strands the phase: the gate guarding the work can no longer evaluate the state it exists to check, and no later turn can un-commit the work to recover.

## Protected local service ownership

- [2026-06-29 · source: agent-protected-service-invariant] Never kill, stop, interrupt, or reuse protected listeners without explicit human approval: Rune web / cockpit at `127.0.0.1:3847` (`com.jarvis.daemon`) and Rune MCP daemon at `127.0.0.1:3848` (`com.jarvis.rune-mcp`). If a test collides, use a dynamic/task-local port, and before killing any process verify the PID was spawned by the current task/worktree/test command.
- [2026-07-08 · source: 21-parallel-product-chats-gate-implementation-diff] Keep an implementation diff scoped to exactly the behavior the approved tests pin; when you notice an adjacent change that seems worthwhile, split it into its own separately specified and tested task rather than bundling unpinned behavior changes into the current fix.

## When the type-checker forces a consumer change

- [2026-07-10 · source: 22-fix-run-dispatch-union-exhaustive-consumers] Making the build green is not a license to invent behavior. When adding a member to a matched type (union / discriminated union) forces you to touch an exhaustive `switch` or mapper to compile, that consumer change IS part of the deliverable — handle the new cases explicitly with a safe, test-pinned mapping. Never silence the exhaustiveness error with a bare `default: throw` or an unpinned fail-closed branch just to get past `tsc`: it converts a compile error into a runtime crash the tests never exercised, and a diff gate will reject the unscoped, untested control flow. If handling the consumer sites genuinely exceeds the task's stated scope, stop and surface the scope conflict in your handoff notes rather than shipping the throw. Also read the task literally against the type system before you start: "extend the union, no downstream changes" is impossible when total consumers exist, so raise it up front instead of discovering it at red typecheck.
- [2026-07-13 · source: 22-fix-run-dispatch-gate-implementation-diff] Implement only what the agreed task scope covers; if you believe downstream behavior must be wired in now, stop and secure explicit, agreed test intent for its user-visible contract before writing the code — untested speculative wiring is scope creep, not progress.
