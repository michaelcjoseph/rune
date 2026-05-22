/**
 * Product/project registry — the uniform product → projects → lifecycle-status index.
 *
 * The registry is an *aggregating index*: the cockpit reads it, the intent layer writes
 * it. It does not own the underlying truth — product repos and vault product files do —
 * so it is always rebuildable. It holds durable **lifecycle status** (planned / active /
 * done) only; live **run-status** (running, blocked on Michael) lives in the supervision
 * layer and is surfaced to the cockpit separately.
 *
 * The contract is pinned by the test-first suite in `registry.test.ts` (test-plan.md §1).
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Product/project registry"), test-plan.md (§1)}.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('registry');

/** Current registry schema version. */
const REGISTRY_VERSION = 1;

/** Durable lifecycle status of a project. Never run-status (running / blocked). */
export type LifecycleStatus = 'planned' | 'active' | 'done';

/** A single project within a product. */
export interface RegistryProject {
  /** Project slug, e.g. `08-intent-layer`. */
  slug: string;
  /** Durable lifecycle status — derived from the product repo's project docs. */
  status: LifecycleStatus;
}

/** A product and the projects under it. */
export interface RegistryProduct {
  /** Product name, e.g. `jarvis`, `assay`. */
  name: string;
  /** Whether the product has a code repo (repo-backed products are executable). */
  repoBacked: boolean;
  /** Projects under this product; empty when the product has no project docs. */
  projects: RegistryProject[];
}

/** The aggregating index: every product, each with its projects and their status. */
export interface Registry {
  /** Schema version, for forward-compatible reads. */
  version: number;
  /** ISO-8601 timestamp of when this registry was built. */
  builtAt: string;
  /** Every product in the system. */
  products: RegistryProduct[];
}

/** Raw scanned input for a single product — one entry per product repo / vault product file. */
export interface ProductSource {
  name: string;
  repoBacked: boolean;
  /**
   * Raw text of the product repo's `docs/projects/index.md`, or `null` when the repo has
   * no project docs (or the product has no repo at all).
   */
  projectsIndex: string | null;
}

/** The complete set of scanned product sources — the input to a registry build. */
export interface RegistrySources {
  products: ProductSource[];
}

/** A project flattened with its owning product — the shape the cockpit query returns. */
export interface RegistryProjectRef extends RegistryProject {
  product: string;
}

/** Absolute path of the persisted registry file. */
export const REGISTRY_FILE = config.REGISTRY_FILE;

/** Normalize an `index.md` Status-column string to a canonical lifecycle status. */
function parseStatus(raw: string): LifecycleStatus {
  switch (raw.trim().toLowerCase()) {
    case 'done':
    case 'completed':
      return 'done';
    case 'in progress':
    case 'active':
      return 'active';
    default:
      // 'Planned', 'Specced', and any unrecognized status map to 'planned' — the
      // conservative default.
      return 'planned';
  }
}

/**
 * Parse the project rows of a repo's `docs/projects/index.md` into registry projects.
 *
 * Handles both observed table layouts: the link cell first (`| [slug](slug/) | Status |`)
 * and a leading index column (`| 01 | [Name](slug/) | Status | … |`). For each row it
 * finds the cell holding a `[text](href)` link, takes the slug from the first path
 * segment of the href, and reads the status from the cell immediately after it (expected
 * to be plain text). Header and separator rows (no link) are skipped.
 */
function parseProjects(projectsIndex: string | null): RegistryProject[] {
  if (!projectsIndex) return [];
  const projects: RegistryProject[] = [];
  for (const line of projectsIndex.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const linkIdx = cells.findIndex((cell) => /\[[^\]]+\]\([^)]+\)/.test(cell));
    if (linkIdx === -1) continue;
    const href = cells[linkIdx]!.match(/\]\(([^)]+)\)/)?.[1] ?? '';
    const slug = href.replace(/^\.?\//, '').split('/')[0]?.trim();
    // A real project slug — not an absolute URL (`https:`) or a traversal segment (`..`).
    if (!slug || slug.includes(':') || slug.startsWith('.')) continue;
    projects.push({ slug, status: parseStatus(cells[linkIdx + 1] ?? '') });
  }
  return projects;
}

/**
 * Build the registry model from scanned product sources. Deterministic: the same sources
 * always yield the same products/projects model (only `builtAt` varies). Logs the build
 * timing and the count of products/projects scanned.
 */
export function buildRegistry(sources: RegistrySources): Registry {
  const startedAt = Date.now();
  const products: RegistryProduct[] = sources.products.map((source) => ({
    name: source.name,
    repoBacked: source.repoBacked,
    projects: parseProjects(source.projectsIndex),
  }));
  const projectCount = products.reduce((sum, p) => sum + p.projects.length, 0);
  log.info('registry built', {
    products: products.length,
    projects: projectCount,
    durationMs: Date.now() - startedAt,
  });
  return { version: REGISTRY_VERSION, builtAt: new Date(startedAt).toISOString(), products };
}

/**
 * Flatten the registry into every project across every product — the single-call query
 * the cockpit consumes ("show me every project and its status").
 */
export function getAllProjects(registry: Registry): RegistryProjectRef[] {
  return registry.products.flatMap((product) =>
    product.projects.map((project) => ({ ...project, product: product.name })),
  );
}

/**
 * Persist the registry atomically: write a temp file, then rename it over the target, so
 * a concurrent reader never observes a torn write.
 */
export function writeRegistry(registry: Registry): void {
  mkdirSync(dirname(REGISTRY_FILE), { recursive: true });
  const tempPath = `${REGISTRY_FILE}.tmp`;
  writeFileSync(tempPath, JSON.stringify(registry, null, 2), 'utf8');
  renameSync(tempPath, REGISTRY_FILE);
}

/** Shape check: a parsed value carries the registry's required fields and product shape. */
function isRegistryShape(value: unknown): value is Registry {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r['version'] !== 'number' || typeof r['builtAt'] !== 'string' || !Array.isArray(r['products'])) {
    return false;
  }
  return r['products'].every((p) => {
    if (typeof p !== 'object' || p === null) return false;
    const product = p as Record<string, unknown>;
    return typeof product['name'] === 'string' && Array.isArray(product['projects']);
  });
}

/**
 * Read the persisted registry. Throws a clear error if the file is missing or malformed —
 * a corrupt registry is never silently treated as an empty model.
 */
export function readRegistry(): Registry {
  let raw: string;
  try {
    raw = readFileSync(REGISTRY_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`registry not yet built — ${REGISTRY_FILE} does not exist; run the registry builder first`);
    }
    throw new Error(`registry file is unreadable — ${REGISTRY_FILE}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`registry file is malformed — could not parse ${REGISTRY_FILE}: ${(err as Error).message}`);
  }
  if (!isRegistryShape(parsed)) {
    throw new Error(`registry file is malformed — ${REGISTRY_FILE} does not match the registry schema`);
  }
  return parsed;
}
