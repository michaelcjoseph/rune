import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../utils/logger.js';

const log = createLogger('projects-snapshot');

// Resolve PROJECT_ROOT relative to this file (src/server/ → project root → ../../)
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECTS_DIR = join(PROJECT_ROOT, 'docs', 'projects');
const INDEX_FILE = join(PROJECTS_DIR, 'index.md');

export interface PhaseProgress {
  phase: string;
  done: number;
  total: number;
}

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

/** Parse a tasks.md file and count done/total items, grouped by Phase headers. */
function parseTasksProgress(tasksPath: string): { done: number; total: number; perPhase: PhaseProgress[] } {
  let raw: string;
  try {
    raw = readFileSync(tasksPath, 'utf8');
  } catch {
    return { done: 0, total: 0, perPhase: [] };
  }

  const perPhase: PhaseProgress[] = [];
  let currentPhase = 'General';
  let phaseDone = 0;
  let phaseTotal = 0;

  function flushPhase() {
    if (phaseTotal > 0) {
      perPhase.push({ phase: currentPhase, done: phaseDone, total: phaseTotal });
    }
  }

  for (const line of raw.split('\n')) {
    const phaseMatch = line.match(/^#+\s+(Phase\s+\S+.*)/i);
    if (phaseMatch) {
      if (phaseTotal > 0) flushPhase();
      currentPhase = phaseMatch[1]!.trim();
      phaseDone = 0;
      phaseTotal = 0;
      continue;
    }
    if (line.match(/^- \[x\]/i)) {
      phaseDone++;
      phaseTotal++;
    } else if (line.match(/^- \[ \]/)) {
      phaseTotal++;
    }
  }
  if (phaseTotal > 0) flushPhase();

  const totalDone = perPhase.reduce((sum, p) => sum + p.done, 0);
  const totalAll = perPhase.reduce((sum, p) => sum + p.total, 0);
  return { done: totalDone, total: totalAll, perPhase };
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
