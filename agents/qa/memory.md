# QA Memory — Craft Lessons

Accumulating craft lessons, one per line, each provenance-stamped
`- [YYYY-MM-DD · source: <slug>] <lesson>`. Append-only; abstract craft only —
no raw excerpts, no private names, opaque source slugs. This is reference, not
rules; the SOUL charter governs on any conflict.

## Writing tests that survive the cross-model path

- [2026-06-15 · source: redaction-fixture-collision] When the behavior under test IS redaction / sanitization / secret-scrubbing, remember your test source crosses the inter-agent path, where the harness runs its own secret redaction over the diff before a reviewer sees it. A realistic raw-secret fixture (e.g. an `sk-…` literal) gets redacted in transit. If your "expected redacted output" is the same literal the harness produces, your raw fixture and your expected string collapse to one value and the test reads as self-contradictory to the reviewer.
- [2026-06-15 · source: assert-absence-not-placeholder] For redaction tests, assert the raw secret is ABSENT and that the output MATCHES a redacted-shape pattern (a regex), not exact equality against a fixed placeholder literal. Pattern assertions stay satisfiable even if the placeholder format changes or carries a per-secret tag.
- [2026-06-15 · source: distinct-fixture-and-expected] Keep a test's raw fixture and its expected post-transform form structurally distinct, so no single rewrite of the source can make one equal the other. A fixture that can become its own expected output is a latent unsatisfiable test.

## Protected local service ownership

- [2026-06-29 · source: agent-protected-service-invariant] Never kill, stop, interrupt, or reuse protected listeners without explicit human approval: Rune web / cockpit at `127.0.0.1:3847` (`com.jarvis.daemon`) and Rune MCP daemon at `127.0.0.1:3848` (`com.jarvis.rune-mcp`). If a test collides, use a dynamic/task-local port, and before killing any process verify the PID was spawned by the current task/worktree/test command.
