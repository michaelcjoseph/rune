import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../utils/logger.js';
import { parseTaskProgress, type PhaseProgress } from '../utils/task-progress.js';

const log = createLogger('projects-snapshot');

// Resolve PROJECT_ROOT relative to this file (src/server/ → project root → ../../)
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECTS_DIR = join(PROJECT_ROOT, 'docs', 'projects');
const INDEX_FILE = join(PROJECTS_DIR, 'index.md');

export type { PhaseProgress };

export interface ProjectSummary {
  slug: string;
  status: string;
  progress: { done: number; total: number; perPhase: PhaseProgress[] };
  specPath: string;
  lastModified: string | null;
}

/** Parse project status and description from the index.md table. Returns a Map<slug, status>. */
function parseIndex(): Map<string, string> {
  const result = new Map<string, string>();
  let raw: string;
  try {
    raw = readFileSync(INDEX_FILE, 'utf8');
  } catch {
    return result;
  }
  for (const line of raw.split('\n')) {
    // Match table rows: | [slug](path) | Status | Description |
    const m = line.match(/^\|\s*\[([^\]]+)\]\([^)]+\)\s*\|\s*([^|]+?)\s*\|/);
    if (m) {
      const slug = m[1]!.trim();
      const status = m[2]!.trim();
      result.set(slug, status);
    }
  }
  return result;
}

/** Read a tasks.md file and count done/total items, grouped by Phase headers.
 *  Pure tally logic lives in `parseTaskProgress`; this wrapper handles the read
 *  (a missing/unreadable file is an empty tally, not an error). */
function parseTasksProgress(tasksPath: string): { done: number; total: number; perPhase: PhaseProgress[] } {
  let raw: string;
  try {
    raw = readFileSync(tasksPath, 'utf8');
  } catch {
    return { done: 0, total: 0, perPhase: [] };
  }
  return parseTaskProgress(raw);
}

/** Read mtime from a file, return ISO string or null. */
function getLastModified(path: string): string | null {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

export function getProjectSummaries(): ProjectSummary[] {
  const indexStatuses = parseIndex();
  const summaries: ProjectSummary[] = [];

  let names: string[];
  try {
    names = readdirSync(PROJECTS_DIR) as string[];
  } catch {
    log.warn('Could not read projects dir');
    return [];
  }

  // Sort entries by directory name for consistent ordering
  names.sort((a, b) => a.localeCompare(b));

  for (const name of names) {
    try {
      if (!statSync(join(PROJECTS_DIR, name)).isDirectory()) continue;
    } catch {
      continue;
    }
    const slug = name;
    const dir = join(PROJECTS_DIR, slug);
    const specPath = join(dir, 'spec.md');
    const tasksPath = join(dir, 'tasks.md');

    if (!existsSync(specPath)) continue;

    const status = indexStatuses.get(slug) ?? 'Unknown';
    const progress = existsSync(tasksPath)
      ? parseTasksProgress(tasksPath)
      : { done: 0, total: 0, perPhase: [] };

    const lastModified = getLastModified(existsSync(tasksPath) ? tasksPath : specPath);

    summaries.push({
      slug,
      status,
      progress,
      specPath: join('docs', 'projects', slug, 'spec.md'),
      lastModified,
    });
  }

  return summaries;
}
