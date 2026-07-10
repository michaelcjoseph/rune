import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readProductsConfig } from './sandbox-runtime.js';

const PROJECTS_SUBDIR = join('docs', 'projects');

export type LiveProjectResolution =
  | { ok: true; projectDir: string }
  | { ok: false; reason: string };

/** Find a project under a repository root by exact or numeric-prefix slug. */
export function findWorkProjectDir(slug: string, repoRoot: string): string | null {
  const projectsDir = join(repoRoot, PROJECTS_SUBDIR);
  let names: string[];
  try {
    names = readdirSync(projectsDir) as string[];
  } catch {
    return null;
  }

  for (const name of names) {
    try {
      if (!statSync(join(projectsDir, name)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (name === slug || name.endsWith(`-${slug}`)) {
      return join(projectsDir, name);
    }
  }
  return null;
}

/**
 * Resolve a live project before a worktree exists. Product-scoped payloads use
 * that product's configured repository; legacy payloads retain Rune's root.
 * Project lifecycle metadata is always repository-root `docs/projects` data:
 * a product's optional `scopePath` does not relocate it.
 */
export function resolveLiveWorkProject(args: {
  projectSlug: string;
  product?: string;
  productsConfigPath: string;
  fallbackRoot: string;
}): LiveProjectResolution {
  let repoRoot = args.fallbackRoot;
  if (args.product !== undefined) {
    let products: ReturnType<typeof readProductsConfig>;
    try {
      products = readProductsConfig(args.productsConfigPath);
    } catch {
      return { ok: false, reason: 'products config unavailable' };
    }
    const product = products[args.product];
    if (!product?.repoPath) {
      return { ok: false, reason: `unknown product: ${args.product}` };
    }
    repoRoot = product.repoPath;
  }

  const projectDir = findWorkProjectDir(args.projectSlug, repoRoot);
  if (!projectDir) {
    return { ok: false, reason: `project not found: ${args.projectSlug}` };
  }
  return { ok: true, projectDir };
}
