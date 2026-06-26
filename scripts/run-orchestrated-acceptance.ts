#!/usr/bin/env tsx
// Headless driver for a REAL orchestrated work run (project 14, Phase 8 live
// acceptance — and a general operator tool for dispatching one orchestrated
// run without the cockpit).
//
// Drives the production `orchestratedWorkApplier` in-process — the same
// applier the cockpit Start action dispatches to — so the run exercises the
// real path: sandboxed worktree (resume if `rune-work/<slug>` already
// exists), `runProjectOrchestration`, live role spawns via
// `createProductionTaskWorkflowRunner` (QA/coder → codex, judgment roles →
// claude), Rune-owned closeout commits, and the deliberate finalizer hold.
//
// The mutation pipeline glue (createMutation/supervision/bus fan-out) is NOT
// exercised here — it is fixture-proven elsewhere; this driver is about the
// live execution binding. Paths (PROJECT_ROOT, logs/, policies/) derive from
// the checkout this script runs in, so a worktree run stays isolated from the
// production daemon's logs.
//
// Usage:
//   npx tsx --env-file-if-exists=.env.local scripts/run-orchestrated-acceptance.ts \
//     --project <slug> [--product <product>]
//
// Exits 0 on a `completed` terminal (including the held/branch-complete case),
// 1 on `failed` or a dispatch error. Every MutationEvent is printed as one
// JSON line so the run is observable and the terminal event is recoverable
// from the output.
import { randomUUID } from 'node:crypto';
import { orchestratedWorkApplier } from '../src/jobs/orchestrated-work-runner.js';
import { NotificationBus } from '../src/transport/notification-bus.js';
import type { ApplyContext, MutationDescriptor } from '../src/transport/mutations.js';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const projectSlug = argValue('--project');
  const product = argValue('--product') ?? 'rune';
  if (!projectSlug) {
    console.error(
      'Usage: run-orchestrated-acceptance.ts --project <slug> [--product <product>]',
    );
    process.exit(1);
  }

  const payload = { projectSlug, product };
  const verdict = orchestratedWorkApplier.validate(payload);
  if (!verdict.ok) {
    console.error(`validate failed: ${verdict.reason}`);
    process.exit(1);
  }

  const descriptor: MutationDescriptor<typeof payload> = {
    id: randomUUID(),
    kind: 'orchestrated-work',
    source: 'cli',
    target: { type: 'orchestrated-work', ref: projectSlug },
    preview: { summary: `orchestrated-work on ${projectSlug} (headless acceptance)` },
    payload,
    createdAt: new Date().toISOString(),
    status: 'running',
  };
  console.log(`run id: ${descriptor.id}`);

  // SIGTERM/SIGINT flips the cancel flag the applier polls before starting
  // work; once role spawns are in flight the registered active processes are
  // reaped by the executors' own lifecycle handling.
  let cancelled = false;
  process.on('SIGINT', () => {
    cancelled = true;
  });
  process.on('SIGTERM', () => {
    cancelled = true;
  });

  const ctx: ApplyContext = {
    bus: new NotificationBus(),
    cancel: () => cancelled,
  };

  let terminal: 'completed' | 'failed' | null = null;
  for await (const event of orchestratedWorkApplier.apply(descriptor, ctx)) {
    console.log(JSON.stringify(event));
    if (event.kind === 'completed' || event.kind === 'failed') {
      terminal = event.kind;
    }
  }

  if (terminal === null) {
    console.error('applier ended without a terminal event');
    process.exit(1);
  }
  process.exit(terminal === 'completed' ? 0 : 1);
}

main().catch((err) => {
  console.error('orchestrated acceptance crashed:', err);
  process.exit(1);
});
