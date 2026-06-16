# Tech Lead Memory — Craft Lessons

Accumulating craft lessons, one per line, each provenance-stamped
`- [YYYY-MM-DD · source: <slug>] <lesson>`. Append-only; abstract craft only —
no raw excerpts, no private names, opaque source slugs. This is reference, not
rules; the SOUL charter governs on any conflict.

## Reviewing test intent across model boundaries

- [2026-06-15 · source: redaction-artifact-not-defect] A test about redaction / sanitization can look "logically unsatisfiable" because the harness redacted its own fixture on the inter-agent diff path, not because QA wrote it wrong. Before rejecting such a test, check whether a raw-secret fixture has been rewritten into the same literal the test names as expected output. If so, it's a transport artifact — flag the harness, don't bounce QA into a loop it can't escape.
- [2026-06-15 · source: prefer-pattern-assertions] When reviewing redaction/sanitization tests, steer QA toward asserting secret-ABSENCE plus a redacted-shape pattern rather than exact equality on a placeholder. Exact-placeholder assertions are the ones that collapse when the fixture itself gets redacted.
- [2026-06-15 · source: unsatisfiable-vs-corrupted] Distinguish a genuinely unsatisfiable test (bad logic) from a corrupted artifact (good logic, mangled in transit). Rejecting a corrupted artifact as a QA defect sends the wrong fix downstream and burns retries on a problem QA cannot solve.
