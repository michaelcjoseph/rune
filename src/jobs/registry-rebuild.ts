/**
 * Cross-product registry rebuild — the "build" half the registry always lacked.
 *
 * `src/intent/registry.ts` defines the pure `buildRegistry` (sources → model) and
 * the `readRegistry`/`writeRegistry` persistence, but nothing ever scanned the
 * product repos to produce those sources, so `logs/registry.json` went stale and
 * the cockpit showed a frozen project list (docs/projects/bugs.md, item 1).
 *
 * This module is the effectful scanner that closes that gap: it reads
 * `policies/products.json` (via `readProductsConfig`), walks each product repo's
 * `docs/projects/` for lifecycle status (`index.md`) and task progress
 * (`tasks.md`), and writes a fresh registry. It is wired to run on daemon
 * startup (so the "Restart server" button refreshes the cockpit) and as a
 * nightly step (so status self-heals without a restart).
 *
 * Layer: lives in `src/jobs` (effectful orchestration) so it may depend on both
 * `src/intent/registry` (pure model) and the `readProductsConfig` reader in
 * `src/jobs/sandbox-runtime` without inverting the intent ← jobs direction.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';
import { parseTaskProgress } from '../utils/task-progress.js';
import { readProductsConfig } from './sandbox-runtime.js';
import {
  buildRegistry,
  writeRegistry,
  type ProductSource,
  type RegistrySources,
} from '../intent/registry.js';

const log = createLogger('registry-rebuild');

/**
 * Scan one product repo's `docs/projects/` for the task tally of every project,
 * keyed by project-dir slug. A missing projects dir (or a project without a
 * readable `tasks.md`, or a `tasks.md` with no checkboxes) simply yields no
 * entry for that slug — never an error.
 */
function scanProductTaskProgress(projectsDir: string): Record<string, { done: number; total: number }> {
  const out: Record<string, { done: number; total: number }> = {};
  if (!projectsDir) return out;
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return out; // no docs/projects/ in this repo
  }
  for (const slug of entries) {
    const dir = join(projectsDir, slug);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    let content: string;
    try {
      content = readFileSync(join(dir, 'tasks.md'), 'utf8');
    } catch {
      continue; // no tasks.md for this project
    }
    const { done, total } = parseTaskProgress(content);
    if (total > 0) out[slug] = { done, total };
  }
  return out;
}

/**
 * Scan every product in `policies/products.json` into `RegistrySources`. For
 * each product: read `<repo>/docs/projects/index.md` (lifecycle status) and walk
 * the project dirs for `tasks.md` tallies. A product repo that is absent on disk
 * or has no project docs yields a product with a null index (zero projects),
 * which `buildRegistry` already handles. `readProductsConfig` throws on a
 * missing/malformed `products.json` — callers decide whether that is fatal
 * (nightly logs it as a step error; startup tolerates it).
 */
export function scanRegistrySources(
  productsConfigPath: string = config.PRODUCTS_CONFIG_FILE,
): RegistrySources {
  const products = readProductsConfig(productsConfigPath);
  const sources: ProductSource[] = [];
  for (const [name, cfg] of Object.entries(products)) {
    const repoBacked = Boolean(cfg.repoPath) && existsSync(cfg.repoPath);
    const projectsDir = cfg.repoPath ? join(cfg.repoPath, 'docs', 'projects') : '';
    let projectsIndex: string | null = null;
    try {
      projectsIndex = readFileSync(join(projectsDir, 'index.md'), 'utf8');
    } catch {
      projectsIndex = null;
    }
    const taskProgress = scanProductTaskProgress(projectsDir);
    sources.push({
      name,
      ...(cfg.class ? { class: cfg.class } : {}),
      ...(cfg.scopePath ? { scopePath: cfg.scopePath } : {}),
      repoBacked,
      projectsIndex,
      taskProgress,
    });
  }
  return { products: sources };
}

/** Outcome of a rebuild — counts for the startup log line and the nightly summary. */
export interface RebuildResult {
  products: number;
  projects: number;
}

/**
 * Scan the product repos and write a fresh `logs/registry.json`. The single
 * entry point both the startup hook and the nightly step call. Returns the
 * product/project counts; throws only if scanning (missing products.json) or
 * the atomic write fails — callers handle that per their fault model.
 */
export function rebuildRegistry(
  productsConfigPath: string = config.PRODUCTS_CONFIG_FILE,
): RebuildResult {
  const sources = scanRegistrySources(productsConfigPath);
  const registry = buildRegistry(sources);
  writeRegistry(registry);
  const projects = registry.products.reduce((sum, p) => sum + p.projects.length, 0);
  log.info('registry rebuilt and persisted', { products: registry.products.length, projects });
  return { products: registry.products.length, projects };
}
