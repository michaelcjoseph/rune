import { copyFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import config from '../config.js';
import { runAgent } from '../ai/claude.js';
import { readVaultFile, writeVaultFile, vaultFileExists, getVaultPath, listVaultFiles, getFileModTime } from '../vault/files.js';
import { dequeue } from './queue.js';
import { initKB } from './init.js';
import { linkEntities, loadAliasMap } from './entity-extract.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('kb-ingest');

export interface IngestCounts {
  readonly created: number;
  readonly updated: number;
}

export interface IngestResult {
  success: boolean;
  output: string;
  counts: IngestCounts;
}

/**
 * Ingest a source file into the knowledge base.
 * Copies the source to raw/, then runs the wiki-compiler agent.
 */
export async function ingestSource(
  sourcePath: string,
  options?: { guidance?: string },
): Promise<IngestResult> {
  log.info('Starting ingestion', { source: sourcePath });

  // Ensure the source exists in the vault
  const content = readVaultFile(sourcePath);
  if (!content) {
    return { success: false, output: `Source file not found: ${sourcePath}`, counts: { created: 0, updated: 0 } };
  }

  // If the source is not already in knowledge/raw/, copy it there
  if (!sourcePath.startsWith('knowledge/raw/')) {
    const destDir = determineRawDir(sourcePath);
    const destPath = join(destDir, basename(sourcePath));
    const fullDest = getVaultPath(destPath);
    mkdirSync(join(config.VAULT_DIR, destDir), { recursive: true });

    // Mutable sources (world-view, playbook, projects) are overwritten on every
    // re-ingest so the wiki sees fresh content. Immutable sources (Readwise
    // articles, captured conversations) are copied once and then left alone.
    const isMutable = isMutableSource(sourcePath);
    if (!vaultFileExists(destPath) || isMutable) {
      copyFileSync(getVaultPath(sourcePath), fullDest);
      log.info('Copied source to raw/', { from: sourcePath, to: destPath, overwrite: isMutable });
    }
  }

  // Ensure knowledge base structure exists
  initKB();

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

  // Snapshot log.md before agent runs to verify it wrote something
  const logBefore = readVaultFile('knowledge/log.md') || '';

  // Snapshot mtimes before and after the agent runs so we can (a) detect any
  // boundary violation in projects/, and (b) surface created/updated counts in
  // knowledge/wiki/ for the nightly TG summary.
  const projectsBefore = snapshotProjectsMtimes();
  const wikiBefore = snapshotWikiMtimes();

  const result = await runAgent('wiki-compiler', prompt, config.CLAUDE_INGEST_TIMEOUT_MS);

  const projectsAfter = snapshotProjectsMtimes();
  const wikiAfter = snapshotWikiMtimes();
  const counts = diffWikiCounts(wikiBefore, wikiAfter);

  // Check the boundary guard before the error return so writes during a failed
  // agent run are still surfaced.
  const violations = diffMtimes(projectsBefore, projectsAfter);
  if (violations.length > 0) {
    log.error('wiki-compiler wrote to projects/*.md (boundary violation)', { source: sourcePath, violations });
    return {
      success: false,
      output: `wiki-compiler boundary violation: modified projects/*.md — ${violations.join(', ')}`,
      counts,
    };
  }

  if (result.error) {
    log.error('Ingestion failed', { source: sourcePath, error: result.error });
    return { success: false, output: result.error, counts };
  }

  // Verify the agent actually wrote to the log — if not, it ran but did nothing
  const logAfter = readVaultFile('knowledge/log.md') || '';
  if (logAfter === logBefore) {
    log.error('Agent completed but wrote nothing to log.md', { source: sourcePath });
    return { success: false, output: 'Agent completed but produced no output — wiki-compiler may not have found the knowledge base.', counts };
  }

  // Entity auto-link pass: for each wiki page the compiler just touched,
  // scan for mentions of known entities (CRM, books, places, family) and
  // append canonical slugs to the page's `related:` frontmatter. Reference
  // sections also get bare mentions rewritten to wikilinks. Failures here
  // must not fail the ingest — the page itself is already written.
  try {
    applyEntityLinks(wikiBefore, wikiAfter);
  } catch (err) {
    log.warn('Entity auto-link pass failed; leaving pages un-linked', {
      error: (err as Error).message,
    });
  }

  // Remove from queue if it was queued
  dequeue(sourcePath);

  log.info('Ingestion complete', { source: sourcePath, created: counts.created, updated: counts.updated });
  return { success: true, output: result.text || 'Ingestion complete.', counts };
}

/** After a wiki-compiler run, walk the set of created/updated pages and
 *  apply the entity-linker. Per-page failures are isolated: one malformed
 *  page must not block the rest. `loadAliasMap()` is hoisted so the JSON
 *  data stores are read once per ingest, not once per touched page. */
function applyEntityLinks(before: Map<string, number>, after: Map<string, number>): void {
  const touched: string[] = [];
  for (const [path, mtime] of after) {
    const prev = before.get(path);
    if (prev === undefined || prev !== mtime) touched.push(path);
  }
  if (touched.length === 0) return;
  const aliasMap = loadAliasMap();
  for (const rel of touched) {
    try {
      const content = readVaultFile(rel);
      if (content === null) continue;
      const result = linkEntities(rel, content, aliasMap);
      if (result.updatedContent === content) continue;
      writeVaultFile(rel, result.updatedContent);
      log.info('Entity-linker updated wiki page', { rel, related: result.related });
    } catch (err) {
      log.warn('Entity-linker failed on page, skipping', {
        rel,
        error: (err as Error).message,
      });
    }
  }
}

/** Determine which raw/ subdirectory a source belongs in based on its path. */
export function determineRawDir(sourcePath: string): string {
  if (sourcePath.startsWith('Readwise/')) return 'knowledge/raw/articles';
  if (sourcePath.startsWith('journals/')) return 'knowledge/raw/journals';
  if (sourcePath.includes('conversation')) return 'knowledge/raw/conversations';
  if (sourcePath.startsWith('world-view/')) return 'knowledge/raw/world-view';
  if (sourcePath === 'pages/playbook.md') return 'knowledge/raw/playbook';
  if (sourcePath.startsWith('projects/') && !sourcePath.startsWith('projects/archive/')) {
    return 'knowledge/raw/projects';
  }
  return 'knowledge/raw/notes';
}

/** Returns true if the source path represents content that changes over time
 *  and should be re-copied into knowledge/raw/ on every ingest. */
export function isMutableSource(sourcePath: string): boolean {
  return sourcePath.startsWith('world-view/')
    || sourcePath === 'pages/playbook.md'
    || sourcePath.startsWith('journals/')
    || (sourcePath.startsWith('projects/') && !sourcePath.startsWith('projects/archive/'));
}

/** Snapshot mtime of every projects/**\/*.md file (excluding projects/archive/).
 *  Used as a boundary guard around wiki-compiler runs — the compiler's scope is
 *  knowledge/ only; any modification to projects/ is a violation. */
export function snapshotProjectsMtimes(): Map<string, number> {
  const out = new Map<string, number>();
  for (const rel of listVaultFiles('projects')) {
    if (rel.startsWith('projects/archive/')) continue;
    const mtime = getFileModTime(rel);
    if (mtime !== null) out.set(rel, mtime.getTime());
  }
  return out;
}

/** Return list of paths whose mtime changed (or that were added) between two snapshots. */
function diffMtimes(before: Map<string, number>, after: Map<string, number>): string[] {
  const changed: string[] = [];
  for (const [path, mtime] of after) {
    const prev = before.get(path);
    if (prev === undefined || prev !== mtime) changed.push(path);
  }
  return changed;
}

/** Snapshot mtime of every knowledge/wiki/**\/*.md file. Used by `ingestSource`
 *  to report created/updated counts for the nightly summary. */
export function snapshotWikiMtimes(): Map<string, number> {
  const out = new Map<string, number>();
  for (const rel of listVaultFiles('knowledge/wiki')) {
    const mtime = getFileModTime(rel);
    if (mtime !== null) out.set(rel, mtime.getTime());
  }
  return out;
}

/** Classify wiki-page mtime diffs: new paths are created; existing paths with
 *  changed mtime are updated. Paths present in `before` but missing from `after`
 *  (deletions) are not counted.
 *
 *  Caveat: mtime resolution depends on the filesystem (APFS has nanosecond
 *  precision; HFS+ has 1s). Two writes to the same file inside one second on
 *  an HFS+ volume would be invisible to this diff. Not a concern on the
 *  target APFS vault. */
export function diffWikiCounts(before: Map<string, number>, after: Map<string, number>): IngestCounts {
  let created = 0;
  let updated = 0;
  for (const [path, mtime] of after) {
    const prev = before.get(path);
    if (prev === undefined) created++;
    else if (prev !== mtime) updated++;
  }
  return { created, updated };
}
