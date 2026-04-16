import { basename } from 'node:path';
import { listVaultFiles, vaultFileExists } from '../vault/files.js';
import { enqueue, getQueue } from './queue.js';
import { determineRawDir } from './ingest.js';
import { processIngestionQueue } from './engine.js';
import { initKB } from './init.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('kb-seed');

interface SeedSource {
  path: string;
  guidance?: string;
}

interface SeedResult {
  discovered: number;
  skippedAlreadyIngested: number;
  enqueued: number;
}

const SEED_SOURCES: SeedSource[] = [
  {
    path: 'pages/playbook.md',
    guidance:
      'This is the user\'s personal playbook — extract principles, mental models, and decision frameworks as concept pages.',
  },
  {
    path: 'world-view',
    guidance:
      'These are worldview essays — extract beliefs, values, and philosophical positions as concept and topic pages.',
  },
  {
    path: 'Readwise',
    guidance:
      'This is a Readwise article/highlight export — extract key ideas, author positions, and notable quotes.',
  },
];

function discoverFiles(sources: SeedSource[]): Array<{ file: string; guidance?: string }> {
  const files: Array<{ file: string; guidance?: string }> = [];

  for (const source of sources) {
    if (source.path.endsWith('.md')) {
      if (vaultFileExists(source.path)) {
        files.push({ file: source.path, guidance: source.guidance });
      } else {
        log.warn('Source file not found', { path: source.path });
      }
    } else {
      const dirFiles = listVaultFiles(source.path);
      for (const f of dirFiles) {
        files.push({ file: f, guidance: source.guidance });
      }
    }
  }

  return files;
}

function isAlreadyIngested(filePath: string): boolean {
  const rawDir = determineRawDir(filePath);
  const rawPath = `${rawDir}/${basename(filePath)}`;
  if (!vaultFileExists(rawPath)) return false;
  // File is in raw/ but still in the queue — ingestion was attempted but failed
  const queue = getQueue();
  if (queue.some((e) => e.source === filePath)) return false;
  return true;
}

export async function seedKB(
  sources?: SeedSource[],
  onProgress?: (msg: string) => void,
  options?: { force?: boolean },
): Promise<SeedResult> {
  initKB();
  const { force = false } = options ?? {};
  const effectiveSources = sources ?? SEED_SOURCES;
  const allFiles = discoverFiles(effectiveSources);
  const report = onProgress ?? (() => {});

  let skipped = 0;
  let enqueued = 0;

  for (const { file, guidance } of allFiles) {
    if (!force && isAlreadyIngested(file)) {
      skipped++;
      continue;
    }
    enqueue(file, guidance);
    enqueued++;
  }

  report(
    `Seed discovery: ${allFiles.length} files found, ${skipped} already ingested, ${enqueued} enqueued`,
  );

  return {
    discovered: allFiles.length,
    skippedAlreadyIngested: skipped,
    enqueued,
  };
}

export async function seedAndProcess(
  sources?: SeedSource[],
  onProgress?: (msg: string) => void,
  options?: { dryRun?: boolean; processAfter?: boolean; force?: boolean },
): Promise<{ seed: SeedResult; processed: number; errors: number }> {
  const report = onProgress ?? (() => {});
  const { dryRun = false, processAfter = true, force = false } = options ?? {};

  initKB();
  const effectiveSources = sources ?? SEED_SOURCES;
  const allFiles = discoverFiles(effectiveSources);

  if (dryRun) {
    let skipped = 0;
    for (const { file } of allFiles) {
      if (!force && isAlreadyIngested(file)) skipped++;
    }
    const wouldEnqueue = allFiles.length - skipped;
    report(`Dry run: ${allFiles.length} files found, ${skipped} already ingested, ${wouldEnqueue} would be enqueued`);

    for (const source of effectiveSources) {
      const sourceFiles = allFiles.filter((f) => f.guidance === source.guidance);
      report(`  ${source.path}: ${sourceFiles.length} files`);
    }

    return {
      seed: { discovered: allFiles.length, skippedAlreadyIngested: skipped, enqueued: 0 },
      processed: 0,
      errors: 0,
    };
  }

  const seed = await seedKB(sources, onProgress, { force });

  if (!processAfter) {
    return { seed, processed: 0, errors: 0 };
  }

  const queue = getQueue();
  report(`Processing ${queue.length} queued source(s)...`);

  const { processed, errors } = await processIngestionQueue();
  report(`Processing complete: ${processed} succeeded, ${errors} failed`);

  return { seed, processed, errors };
}
