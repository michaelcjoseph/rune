# Tech Lead Memory — Craft Lessons

Accumulating craft lessons, one per line, each provenance-stamped
`- [YYYY-MM-DD · source: <slug>] <lesson>`. Append-only; abstract craft only —
no raw excerpts, no private names, opaque source slugs. This is reference, not
rules; the SOUL charter governs on any conflict.

## Reviewing test intent across model boundaries

- [2026-06-15 · source: redaction-artifact-not-defect] A test about redaction / sanitization can look "logically unsatisfiable" because the harness redacted its own fixture on the inter-agent diff path, not because QA wrote it wrong. Before rejecting such a test, check whether a raw-secret fixture has been rewritten into the same literal the test names as expected output. If so, it's a transport artifact — flag the harness, don't bounce QA into a loop it can't escape.
- [2026-06-15 · source: prefer-pattern-assertions] When reviewing redaction/sanitization tests, steer QA toward asserting secret-ABSENCE plus a redacted-shape pattern rather than exact equality on a placeholder. Exact-placeholder assertions are the ones that collapse when the fixture itself gets redacted.
- [2026-06-15 · source: unsatisfiable-vs-corrupted] Distinguish a genuinely unsatisfiable test (bad logic) from a corrupted artifact (good logic, mangled in transit). Rejecting a corrupted artifact as a QA defect sends the wrong fix downstream and burns retries on a problem QA cannot solve.

## Protected local service ownership

- [2026-06-29 · source: agent-protected-service-invariant] Never kill, stop, interrupt, or reuse protected listeners without explicit human approval: Rune web / cockpit at `127.0.0.1:3847` (`com.jarvis.daemon`) and Rune MCP daemon at `127.0.0.1:3848` (`com.jarvis.rune-mcp`). If a test collides, require a dynamic/task-local port, and before killing any process verify the PID was spawned by the current task/worktree/test command.
- [2026-06-30 · source: env-var-deployment-coverage] When a project adds or changes environment variables, require an explicit task that updates `src/config.ts`, configuration docs, `.env.example`, and the live `.env.local` deployment step as appropriate. Tracked files get placeholders only; real secrets stay out of git.

## Logging & observability in the plan

- [2026-07-02 · source: silent-failure-live-run] Every new code path the plan introduces — model calls, gates, pipeline stages, and the failure/catch branches that guard them — must specify its logging in the tech spec and carry a task for it: log the stage start, the terminal outcome, and on failure the underlying cause (enough of the model/provider and the real error to tell an environmental failure from a logic one), at the point the failure is caught rather than only as a user-facing message. Ask of every breakdown: "if this fails in a live run, is it diagnosable from the logs alone?" A path that answers no is under-specified; treat missing logging as a review objection, not a nice-to-have.
- [2026-07-02 · source: which-model-actually-ran] When a step delegates to a model call, the plan must ensure the resolved model/provider that actually executed is logged. A role's helper can silently route to a different model than the role's configured one; without a log line naming the model that ran, that divergence is invisible until someone reads raw CLI args after a failure.

## Scoping a task so it can actually compile

- [2026-07-10 · source: 22-fix-run-dispatch-union-exhaustive-consumers] Extending a union / discriminated-union type is never "type-layer only." Under strict typecheck, every exhaustive `switch` (or mapper with no `default`) that consumes the type must handle the new members or the build fails, so the task implicitly owns those consumer sites. When shaping such a task or reviewing its test intent, require the SAME task to make each exhaustive consumer total — with a test pinning safe, non-throwing handling of the new members — or re-scope. A task worded "add to the union, no downstream changes" is self-contradictory; catch it at test-intent, not when the coder hits a red typecheck mid-implementation and improvises an out-of-scope patch to compile.
