#!/usr/bin/env tsx
import type { MessageSender } from '../src/transport/sender.js';

const COMMANDS: Record<string, string> = {
  query: 'Query the knowledge base',
  ingest: 'Trigger ingestion of a source file',
  seed: 'Bulk-seed KB from vault content (playbook, worldview, Readwise)',
  lint: 'Run wiki health check',
  status: 'Show KB stats and system state',
  search: 'Search vault and wiki',
  workout: 'Generate today\'s workout. Args: [home|gym] [mobility|endurance|strength|speed|power]',
  'done-workout': 'Log the most recently generated workout to today\'s journal',
  study: 'Run a spaced-repetition session. Args: [N] for N questions (1-10), or "status"',
  nightly: 'Run the full nightly pipeline (commits + pushes). Default: today. Use `--date YYYY-MM-DD` to backfill. Add `--force` to re-run a date already marked processed.',
  help: 'Show this help text',
};

function printHelp(): void {
  console.log('Jarvis CLI — Knowledge base operations from the terminal\n');
  console.log('Usage: jarvis <command> [args]\n');
  console.log('Commands:');
  for (const [name, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(10)} ${desc}`);
  }
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      flags[arg.slice(2)] = args[i + 1] ?? '';
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help') {
    printHelp();
    return;
  }

  if (!(command in COMMANDS)) {
    console.error(`Unknown command: ${command}\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (args.includes('--help')) {
    printHelp();
    return;
  }

  const { initKB, queryKB, ingestSource, lintKB, getKBStats } = await import(
    '../src/kb/engine.js'
  );
  initKB();

  switch (command) {
    case 'query':
      await cmdQuery(args, queryKB);
      break;
    case 'ingest':
      await cmdIngest(args, ingestSource);
      break;
    case 'seed':
      await cmdSeed(args);
      break;
    case 'lint':
      await cmdLint(lintKB);
      break;
    case 'status':
      cmdStatus(getKBStats);
      break;
    case 'search':
      await cmdSearch(args);
      break;
    case 'workout':
      await cmdWorkout(args);
      break;
    case 'done-workout':
      await cmdDoneWorkout();
      break;
    case 'study':
      await cmdStudy(args);
      break;
    case 'nightly':
      await cmdNightly(args);
      break;
  }
}

async function cmdQuery(
  args: string[],
  queryKB: (q: string) => Promise<{ success: boolean; answer: string }>,
): Promise<void> {
  const question = args.join(' ');
  if (!question) {
    console.error('Usage: jarvis query <question>');
    process.exitCode = 1;
    return;
  }
  const result = await queryKB(question);
  if (!result.success) {
    console.error('Query failed:', result.answer);
    process.exitCode = 1;
    return;
  }
  console.log(result.answer);
}

async function cmdIngest(
  args: string[],
  ingestSource: (
    path: string,
    opts?: { guidance?: string },
  ) => Promise<{ success: boolean; output: string }>,
): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const sourcePath = positional[0];

  if (!sourcePath) {
    const { processIngestionQueue } = await import('../src/kb/engine.js');
    const { getQueue } = await import('../src/kb/queue.js');
    const queue = getQueue();
    if (queue.length === 0) {
      console.log('Ingestion queue is empty. Usage: jarvis ingest <vault-relative-path> [--guidance "..."]');
      return;
    }
    console.log(`Processing ${queue.length} queued source(s)...`);
    const { processed, errors } = await processIngestionQueue();
    console.log(`Done. Processed: ${processed}, Errors: ${errors}`);
    return;
  }

  const guidance = flags['guidance'] || undefined;

  const result = await ingestSource(sourcePath, { guidance });
  if (!result.success) {
    console.error('Ingestion failed:', result.output);
    process.exitCode = 1;
    return;
  }
  console.log(result.output);
}

async function cmdLint(
  lintKB: () => Promise<{ success: boolean; report: string }>,
): Promise<void> {
  const result = await lintKB();
  if (!result.success) {
    console.error('Lint failed:', result.report);
    process.exitCode = 1;
    return;
  }
  console.log(result.report);
}

function cmdStatus(
  getKBStats: () => {
    totalPages: number;
    entities: number;
    concepts: number;
    topics: number;
    comparisons: number;
    recentLog: string[];
  },
): void {
  const stats = getKBStats();
  console.log('Knowledge Base Status\n');
  console.log(`  Pages:  ${stats.totalPages} total`);
  console.log(`          ${stats.entities} entities, ${stats.concepts} concepts, ${stats.topics} topics, ${stats.comparisons} comparisons`);
  console.log(`\nRecent Activity:`);
  if (stats.recentLog.length === 0) {
    console.log('  (no recent activity)');
  } else {
    for (const entry of stats.recentLog) {
      console.log(`  ${entry}`);
    }
  }
}

async function cmdSeed(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const dryRun = 'dry-run' in flags;
  const enqueueOnly = 'enqueue-only' in flags;
  const force = 'force' in flags;

  const { seedAndProcess } = await import('../src/kb/seed.js');
  const result = await seedAndProcess(
    undefined,
    (msg) => console.log(msg),
    { dryRun, processAfter: !dryRun && !enqueueOnly, force },
  );

  console.log(`\nDiscovered: ${result.seed.discovered}`);
  console.log(`Already ingested: ${result.seed.skippedAlreadyIngested}`);
  console.log(`Enqueued: ${result.seed.enqueued}`);
  if (!dryRun && !enqueueOnly) {
    console.log(`Processed: ${result.processed}`);
    console.log(`Errors: ${result.errors}`);
  }
}

async function cmdSearch(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const query = positional.join(' ');
  if (!query) {
    console.error('Usage: jarvis search <term> [--type entity|concept|topic|comparison]');
    process.exitCode = 1;
    return;
  }
  const type = flags['type'] || undefined;

  const { searchWithFilter } = await import('../src/kb/search.js');
  const results = searchWithFilter(query, { type }, { maxResults: 20 });
  if (results.length === 0) {
    console.log('No results found.');
    return;
  }
  for (const r of results) {
    console.log(`${r.file}:${r.line}  ${r.content.trim()}`);
  }
}

/** Stub a MessageSender that prints to stdout. Lets the CLI reuse handler
 *  functions without a real TG connection. */
function makeStdoutSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: async (_userId: number, text: string) => { console.log(text); },
    startTyping: (_userId: number) => {},
    stopTyping: (_userId: number) => {},
  };
}

async function cmdWorkout(args: string[]): Promise<void> {
  const { handleWorkout } = await import('../src/bot/commands/workout.js');
  await handleWorkout(makeStdoutSender(), 0, args.join(' '));
}

async function cmdDoneWorkout(): Promise<void> {
  const { handleDoneWorkout } = await import('../src/bot/commands/done-workout.js');
  await handleDoneWorkout(makeStdoutSender(), 0);
}

/** Run a spaced-repetition session in the terminal. `handleStudy` starts the
 *  session (or prints `status`); the session is event-driven, so the loop reads
 *  each answer from stdin and feeds it to `handleSRMessage` until the session
 *  ends. The loop serialises calls with await — no re-entrant session-map access. */
async function cmdStudy(args: string[]): Promise<void> {
  const arg = args.join(' ').trim();

  // A real session needs an interactive terminal for the answer loop; the
  // `status` query just prints one line, so it is exempt.
  if (arg.toLowerCase() !== 'status' && !process.stdin.isTTY) {
    console.error(
      '`jarvis study` needs an interactive terminal — use `jarvis study status` for a non-interactive summary.',
    );
    process.exitCode = 1;
    return;
  }

  const { handleStudy } = await import('../src/bot/commands/study.js');
  const { hasActiveSRSession, handleSRMessage } = await import('../src/study/sr-session.js');
  const sender = makeStdoutSender();
  const userId = 0;

  await handleStudy(sender, userId, arg);
  // `status`, an empty pool, or nothing due → no session was created.
  if (!hasActiveSRSession(userId)) return;

  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (hasActiveSRSession(userId)) {
      const answer = await new Promise<string | null>((resolve) => {
        const onClose = (): void => resolve(null);
        rl.once('close', onClose);
        rl.question('\nYour answer: ', (a) => {
          rl.removeListener('close', onClose);
          resolve(a);
        });
      });
      if (answer === null) {
        console.log('\n(session abandoned)');
        break;
      }
      await handleSRMessage(userId, answer, sender);
    }
  } finally {
    rl.close();
  }
}

async function cmdNightly(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const rawDate = flags['date'];
  let targetDate: string | undefined;
  if (rawDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      console.error(`--date must be ISO YYYY-MM-DD (got "${rawDate}")`);
      process.exitCode = 1;
      return;
    }
    targetDate = rawDate;
  }
  const force = 'force' in flags;

  const { executeNightly, formatSummary } = await import('../src/jobs/nightly.js');
  const label = targetDate ? `for ${targetDate}` : '(today)';
  const forceSuffix = force ? ' [--force]' : '';
  console.log(`Running nightly pipeline ${label}${forceSuffix} (this may take 5-15 minutes)...\n`);
  const result = await executeNightly(targetDate, { force });
  console.log(formatSummary(result));
  // Exit non-zero if any step errored, so wrappers can detect failures
  if (result.steps.some((s) => s.status === 'error')) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
