import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';
import { writeVaultFile, vaultFileExists } from '../vault/files.js';
import { DEFAULT_SCHEMA } from './schema.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('kb-init');

const KB_DIRS = [
  'knowledge/raw/articles',
  'knowledge/raw/conversations',
  'knowledge/raw/journals',
  'knowledge/raw/notes',
  'knowledge/raw/media',
  'knowledge/raw/reviews',
  'knowledge/raw/lenny',
  'knowledge/wiki/entities',
  'knowledge/wiki/concepts',
  'knowledge/wiki/topics',
  'knowledge/wiki/comparisons',
];

/** Ensure the knowledge base directory structure and seed files exist. Idempotent. */
export function initKB(): void {
  for (const dir of KB_DIRS) {
    mkdirSync(join(config.VAULT_DIR, dir), { recursive: true });
  }

  if (!vaultFileExists('knowledge/schema.md')) {
    writeVaultFile('knowledge/schema.md', DEFAULT_SCHEMA);
    log.info('Seeded knowledge/schema.md');
  }

  if (!vaultFileExists('knowledge/index.md')) {
    writeVaultFile(
      'knowledge/index.md',
      '# Knowledge Base Index\n\n## Entities\n\n## Concepts\n\n## Topics\n\n## Comparisons\n',
    );
    log.info('Seeded knowledge/index.md');
  }

  if (!vaultFileExists('knowledge/log.md')) {
    writeVaultFile('knowledge/log.md', '# Knowledge Base Log\n\n');
    log.info('Seeded knowledge/log.md');
  }
}
