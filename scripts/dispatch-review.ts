#!/usr/bin/env tsx
/**
 * CLI wrapper around `dispatchToExecutor` for the `/review --cross-model`
 * skill (project 08 Phase 6 A8.2). The skill is markdown instructions that
 * Claude reads and follows — to actually invoke `dispatchToExecutor` from
 * those instructions the agent runs this script via Bash.
 *
 * Usage:
 *   npx tsx scripts/dispatch-review.ts <agent-name> <objective-and-context-file>
 *
 * - `agent-name`: a reviewer agent (e.g., `code-reviewer`,
 *   `security-auditor`). Must be a NeutralAgentDef-parseable file under
 *   `.claude/agents/<name>.md` (the script's default `loadNeutralAgent`).
 * - `objective-and-context-file`: path to a file containing the full
 *   handoff prompt the reviewer should see (the file lists, diff or
 *   diff-fetch instruction, project rules pointer). The script reads it
 *   as the handoff `context`; the `objective` is derived from the agent
 *   name. Passing via a file keeps shell-argv length out of the loop —
 *   diffs can be 100s of KB.
 *
 * Output:
 * - On success: prints the executor's stdout (the reviewer's verdict +
 *   findings, in the reviewer's native vocabulary) and exits 0.
 * - On dispatcher/probe failure: prints a `DISPATCH-FAILED: <reason>`
 *   line to stderr and exits 1 so the caller can mark the agent
 *   `UNAVAILABLE` and proceed with the rest of the panel (matches the
 *   skill's existing missing-agent fallback).
 *
 * The Codex provider-availability probe runs inside `dispatchToExecutor`;
 * an unavailable Codex (binary missing or not logged in) surfaces as a
 * structured failure here, not a crash.
 */

import { readFileSync } from 'node:fs';
import { dispatchToExecutor } from '../src/jobs/dispatch-runtime.js';
import { buildHandoff } from '../src/intent/dispatch.js';

async function main(): Promise<void> {
  const [, , agent, contextFile] = process.argv;
  if (!agent || !contextFile) {
    console.error(
      'Usage: dispatch-review.ts <agent-name> <objective-and-context-file>',
    );
    process.exit(2);
  }
  let context: string;
  try {
    context = readFileSync(contextFile, 'utf8');
  } catch (err) {
    console.error(
      `DISPATCH-FAILED: could not read context file '${contextFile}': ${(err as Error).message}`,
    );
    process.exit(1);
  }

  // The handoff carries a product/project pair — for the manual /review
  // skill these are descriptive labels (the review isn't bound to a
  // specific product workflow). Using `rune` / `review-cross-model` so
  // the dispatch log entry is self-describing.
  const handoff = buildHandoff({
    target: 'codex',
    agent,
    product: 'rune',
    project: 'review-cross-model',
    objective: `Run the ${agent} review panel against the changes described in the context.`,
    context,
  });

  const outcome = await dispatchToExecutor(handoff);
  if (outcome.result.status === 'failed') {
    console.error(`DISPATCH-FAILED: ${outcome.result.failureReason}`);
    process.exit(1);
  }
  if (outcome.text !== null) {
    process.stdout.write(outcome.text);
  }
}

main().catch((err) => {
  console.error('dispatch-review CLI crashed:', err);
  process.exit(1);
});
