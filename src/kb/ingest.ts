import { copyFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import config from '../config.js';
import { runAgent } from '../ai/claude.js';
import { readVaultFile, writeVaultFile, vaultFileExists, getVaultPath } from '../vault/files.js';
import { dequeue } from './queue.js';
import { createLogger } from '../utils/logger.js';
import { getLocalDate, getTimestamp } from '../utils/time.js';

const log = createLogger('kb-ingest');

/**
 * Ingest a source file into the knowledge base.
 * Copies the source to raw/, then runs the wiki-compiler agent.
 */
export async function ingestSource(
  sourcePath: string,
  options?: { guidance?: string },
): Promise<{ success: boolean; output: string }> {
  log.info('Starting ingestion', { source: sourcePath });

  // Ensure the source exists in the vault
  const content = readVaultFile(sourcePath);
  if (!content) {
    return { success: false, output: `Source file not found: ${sourcePath}` };
  }

  // If the source is not already in knowledge/raw/, copy it there
  if (!sourcePath.startsWith('knowledge/raw/')) {
    const destDir = determineRawDir(sourcePath);
    const destPath = join(destDir, basename(sourcePath));
    const fullDest = getVaultPath(destPath);
    mkdirSync(join(config.VAULT_DIR, destDir), { recursive: true });

    if (!vaultFileExists(destPath)) {
      copyFileSync(getVaultPath(sourcePath), fullDest);
      log.info('Copied source to raw/', { from: sourcePath, to: destPath });
    }
  }

  // Ensure knowledge base structure exists
  ensureKBStructure();

  // Build the ingestion prompt
  const guidanceNote = options?.guidance
    ? `\n\nUser guidance: ${options.guidance}`
    : '';

  const prompt = `Ingest the following source into the knowledge base.

Source file: ${sourcePath}

Read the source file, then follow the ingestion workflow defined in knowledge/schema.md:
1. Read the source material
2. Read knowledge/index.md to understand existing wiki pages
3. Identify key entities, concepts, and topics
4. Create or update relevant wiki pages in knowledge/wiki/
5. Update knowledge/index.md with new/changed entries
6. Append an entry to knowledge/log.md${guidanceNote}`;

  const result = await runAgent('wiki-compiler', prompt);

  if (result.error) {
    log.error('Ingestion failed', { source: sourcePath, error: result.error });
    return { success: false, output: result.error };
  }

  // Remove from queue if it was queued
  dequeue(sourcePath);

  log.info('Ingestion complete', { source: sourcePath });
  return { success: true, output: result.text || 'Ingestion complete.' };
}

/** Determine which raw/ subdirectory a source belongs in based on its path. */
function determineRawDir(sourcePath: string): string {
  if (sourcePath.startsWith('Readwise/')) return 'knowledge/raw/articles';
  if (sourcePath.includes('conversation')) return 'knowledge/raw/conversations';
  return 'knowledge/raw/notes';
}

/** Ensure the knowledge base directory structure exists. */
function ensureKBStructure(): void {
  const dirs = [
    'knowledge/raw/articles',
    'knowledge/raw/conversations',
    'knowledge/raw/notes',
    'knowledge/wiki/entities',
    'knowledge/wiki/concepts',
    'knowledge/wiki/topics',
    'knowledge/wiki/comparisons',
  ];

  for (const dir of dirs) {
    mkdirSync(join(config.VAULT_DIR, dir), { recursive: true });
  }

  // Create index.md if it doesn't exist
  if (!vaultFileExists('knowledge/index.md')) {
    writeVaultFile(
      'knowledge/index.md',
      '# Knowledge Base Index\n\n## Entities\n\n## Concepts\n\n## Topics\n\n## Comparisons\n',
    );
  }

  // Create log.md if it doesn't exist
  if (!vaultFileExists('knowledge/log.md')) {
    writeVaultFile('knowledge/log.md', '# Knowledge Base Log\n\n');
  }
}
