# Real-Scale Warm-Index Budget Acceptance

Acceptance harness:

```bash
npx tsx --env-file-if-exists=.env.local src/kb/__acceptance__/vault-index-realscale.acceptance.ts
```

The default harness creates a generated markdown vault of at least 72 MiB, with
most bytes under `knowledge/` and a smaller peripheral-folder slice. It then
builds the real warm index, verifies the build log/status stats, removes the
generated fixture, and queries again to prove subsequent searches use resident
index state rather than per-query filesystem walking.

First measured on 2026-06-29 against the generated fixture. Thresholds keep a
bounded margin above the measured run while remaining below the provisional
10s / 512 MiB defaults from the spec.

```json
{
  "fixture": "generated-72mb",
  "fixtureBytes": 77416138,
  "thresholds": {
    "buildMs": 1000,
    "heapUsedBytes": 394264576
  },
  "measured": {
    "files": 72,
    "lines": 1032264,
    "bytes": 77416138,
    "heapUsed": 198276320,
    "buildMs": 84
  }
}
```
