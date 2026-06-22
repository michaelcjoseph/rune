# Coder Memory — Craft Lessons

Accumulating craft lessons, one per line, each provenance-stamped
`- [YYYY-MM-DD · source: <slug>] <lesson>`. Append-only; abstract craft only —
no raw excerpts, no private names, opaque source slugs. This is reference, not
rules; the SOUL charter governs on any conflict.

## When the test you're handed cannot pass

- [2026-06-15 · source: unsatisfiable-handed-test] If you're handed a test that no implementation can satisfy — e.g. it asserts an output both equals and does-not-contain the same secret-shaped literal — do not thrash trying to make it green. That pattern usually means a fixture was redacted in transit by the harness. Surface it explicitly as a suspected harness/transport artifact in your handoff notes so the right party fixes the tooling, instead of producing a contorted diff that still fails review.

## Sequencing tests before implementation

- [2026-06-22 · source: impl-bundled-before-red-gate] Land a phase's tests in their own commit, observe red, then implement in a separate commit. If tests and implementation ride one commit, a later "confirm red" gate can never see red (the implementation is already present, so the suite is green) and a diff-based completeness gate can't see the deliverable (it's not in any new diff). Bundling them strands the phase: the gate guarding the work can no longer evaluate the state it exists to check, and no later turn can un-commit the work to recover.
