#!/usr/bin/env tsx
// CLI entry for the Ask-Twice intent scan. Invoked by:
//   - The `intent-scan` agent via Bash (dogfood cron path)
//   - Manual runs: `npm run intent-scan`
// Prints the summary the scan would otherwise post to Telegram, so the cron
// agent's cron_chat output is the same content the user sees either way.
import { runIntentScan } from '../src/jobs/intent-scan.js';

async function main(): Promise<void> {
  const result = await runIntentScan();
  if (result.status === 'error') {
    console.error(result.detail);
    process.exit(1);
  }
  if (result.status === 'skipped') {
    console.log(`Skipped: ${result.detail}`);
    return;
  }
  const lines = [
    `Ask-Twice scan drafted ${result.queued.length} proposal(s):`,
    ...result.queued.map(p => `• ${p.title} — ${p.rationale}`),
    '',
    'Review in your next /weekly.',
  ];
  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error('Intent-scan CLI crashed:', err);
  process.exit(1);
});
