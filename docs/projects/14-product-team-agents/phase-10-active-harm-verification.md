# Phase 10 Active-Harm Verification

**Recorded:** 2026-06-17
**Result:** confirmed. A working orchestrated run can be treated as quiet today if it emits no
`output` or `activity` events during the quiet window.

## Finding

The focused probe in `src/jobs/orchestrated-work-runner.test.ts` starts a real
`orchestrated-work` mutation through `createMutation`, lets the injected orchestration remain
in flight, and inspects the supervision record while the applier is still running.

The observed run state has:

- `status: "running"`
- matching project slug
- no `lastOutputAt`
- only the create/start supervision upserts

At `startedAt + 5 minutes + 1ms`, `planQuietNudges` selects the run. After the nudge marker is
applied, `planQuietCancel` selects the same run at `quietAt + 20 minutes + 1ms`.

That confirms the active-harm hypothesis from Phase 10 work item 1: the quiet-nudge /
quiet-cancel backstop can target a genuinely working orchestrated run when the orchestration
path stays silent.

## Verification

```sh
TELEGRAM_BOT_TOKEN=test-token TELEGRAM_USER_ID=12345 VAULT_DIR=/tmp/vault RUNE_HTTP_SECRET=test-secret OBSIDIAN_VAULT_NAME=TestVault WORKSPACE_DIR=/tmp/workspace npm test -- --configLoader runner src/jobs/orchestrated-work-runner.test.ts -t "active-harm probe" --reporter=verbose
```

Result: `1 passed | 21 skipped`.

## Implication

Phase 10 should keep the streaming work high priority. Once orchestrated role activity flows
as `output` or `activity`, the mutation supervision path can advance `lastOutputAt` mid-run
and this harm path should stop firing on healthy work.
