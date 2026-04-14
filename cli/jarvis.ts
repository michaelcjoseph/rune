#!/usr/bin/env tsx

const COMMANDS: Record<string, string> = {
  query: 'Query the knowledge base',
  ingest: 'Trigger ingestion of a source file',
  lint: 'Run wiki health check',
  status: 'Show KB stats and system state',
  search: 'Search vault and wiki',
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
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1] ?? '';
      i++;
    } else {
      positional.push(args[i]);
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
    case 'lint':
      await cmdLint(lintKB);
      break;
    case 'status':
      cmdStatus(getKBStats);
      break;
    case 'search':
      await cmdSearch(args);
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
    console.error('Usage: jarvis ingest <vault-relative-path> [--guidance "..."]');
    process.exitCode = 1;
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

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
