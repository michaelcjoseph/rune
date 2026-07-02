## Reconciler test intent (fix-attempt-terminal-reconciler)

Pin the mapping to the RUN's own recorded outcome — the mutations descriptor / supervision-store is the single source of truth; do not invent a status the run didn't emit.

```ts
it('moves proceeding → fixed only when the run completed AND merged', () => {
  seedFixAttempt(FILE, { state: 'proceeding', runId: 'r1' });
  const runRecord = recordedRun('r1', { status: 'completed', outcome: 'branch-complete', merged: true });
  reconcileProceedingFixAttempts(FILE, { readRun: () => runRecord });
  expect(latest(FILE, 'r1').state).toBe('fixed');
});

it('maps completed-but-not-merged (blocked-on-human / parked) → parked-on-human', () => { /* status:'blocked-on-human' ⇒ 'parked-on-human' */ });
it('maps failed run → failed with the run failure reason in detail', () => { /* status:'failed' ⇒ 'failed', detail carries cause */ });
it('is idempotent: a second pass over an already-terminal attempt writes nothing new', () => { /* no duplicate/overwrite */ });
it('logs runId → terminal + underlying outcome for each transition', () => { /* diagnosable from logs alone */ });
```

Assert on BEHAVIOR (the terminal that lands + the log line), not on internal call order. Feed recorded run records, never a live agent run.