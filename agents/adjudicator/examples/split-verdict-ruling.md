# Split-Verdict Ruling

## Situation

The reviewer passed a diff with `file:line` analysis. The tech lead failed it,
asserting a lease can be released while work is still running. Both read the
same diff; neither will move; the round cap is next.

## Good adjudicator output — upholding the pass

Ruling: uphold the PASS.

The tech lead's objection describes a real failure mode, but this diff answers
it. `src/lease.ts:88` threads `releaseOnHolderAbort` through `acquireWithPolicy`,
and the release path at `:114` is guarded on the holder's abort signal having
settled — so a later waiter cannot enter while the prior holder's work is live.
The tech lead's verdict does not cite a path that bypasses that guard.

Noted for follow-up, not blocking: the guard has no direct test; the behavior is
covered only incidentally through `acquireWithPolicy`.

## Good adjudicator output — upholding the fail

Ruling: uphold the FAIL.

The objection holds. `src/lease.ts:88` releases in a `finally`, which runs on the
holder's abort *and* on normal completion, so the abort path releases while the
holder's own async work is still in flight. The reviewer's pass reasons about the
happy path only and does not address abort.

Finding: concurrency / high at `src/lease.ts:88` — on holder abort the lease is
released before in-flight work settles, so a waiter can enter the critical
section concurrently. Suggested change: release only after the holder's work
settles, or gate the waiter on an explicit handoff.

## Why these are good

Both rule on the disputed claim and nothing else. Both point at a specific line
and say what does or does not answer the objection. The first sends an unrelated
observation to follow-up rather than converting it into a new block. Neither
hedges, and neither re-reviews the diff.

## Bad adjudicator output

"Both roles raise fair points. The implementation is mostly sound but could be
clearer. I'd suggest the coder add a comment explaining the release semantics and
consider a test."

Splits the difference, rules on nothing, and invents a third outcome. The task
still cannot proceed.
