/**
 * Backlog reader — the filesystem + security layer over the pure parser (09-expand-cockpit,
 * Phase 1).
 *
 * `readBacklogs` walks every product in the registry and, for each repo-backed product, reads
 * `<repoPath>/docs/projects/{bugs,ideas}.md`, parses them, and rolls the result up per product.
 * It enforces the spec's "Security / repo safety" contract:
 *   - canonicalize each `repoPath` (realpath) and require it under `$WORKSPACE_ROOT`;
 *   - realpath each backlog file so a symlink escaping `repoPath` is rejected, not followed;
 *   - bound file size so a crafted product repo can't block the event loop;
 *   - parse with a repo-RELATIVE source path so no absolute host path ever reaches the API.
 *
 * A missing file is silent (a product simply may not have a backlog yet); an unreadable file
 * (EISDIR, EACCES — any non-ENOENT error) yields an empty list plus a file warning, and the
 * other file in the same product still reads. The contract is pinned by `backlog-reader.test.ts`.
 */

// Product-repo files are intentionally read with raw `fs` (not the `src/vault/files.ts`
// helpers): they live in product repos OUTSIDE the vault, and the security boundary here is
// realpath + `isContainedIn` containment, not the vault-root guard.
import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isContainedIn } from './sandbox.js';
import { parseBugs, parseIdeas, type BacklogItem, type FileWarning } from './backlog-parser.js';
import type { BacklogCounts } from './cockpit.js';
import type { Registry } from './registry.js';

/**
 * The only product-config field the reader needs. Declared here (rather than importing
 * `ProductConfig` from `src/jobs/sandbox-runtime.ts`) so the pure intent layer does not take an
 * upward dependency on the runtime layer — a `Record<string, ProductConfig>` is structurally
 * assignable to `Record<string, BacklogReaderConfig>`, so runtime callers pass their config as-is.
 */
export interface BacklogReaderConfig {
  /** Absolute path of the product's repo. */
  repoPath: string;
}

/** Per-product backlog roll-up — the shape the drawer API serves. */
export interface ProductBacklog {
  product: string;
  /** True when the product has no backing repo (nothing to read). */
  notRepoBacked: boolean;
  bugs: BacklogItem[];
  ideas: BacklogItem[];
  fileWarnings: FileWarning[];
}

export interface ReadBacklogsOpts {
  /**
   * Containment root every product repo must realpath-resolve under. The bare default
   * (`~/workspace`) is for tests; runtime callers (the webview `GET /api/backlog/:product`
   * route) should pass `config.WORKSPACE_DIR ?? join(homedir(), 'workspace')` so a configured
   * `WORKSPACE_DIR` is honored — the reader deliberately does not import `config` to keep the
   * intent layer free of the config dependency. A root that cannot be canonicalized fails
   * closed: every repo-backed product is rejected.
   *
   * Reads are synchronous; this is sound while product repos live on local SSD. If a repo
   * path can live under iCloud sync, the route handler should defer the call off the event
   * loop — a stalled `.icloud` placeholder read would block the whole process.
   */
  workspaceRoot?: string;
}

/** Repo-relative paths of the two backlog files. */
const BUGS_REL = 'docs/projects/bugs.md';
const IDEAS_REL = 'docs/projects/ideas.md';

/** Reject a single backlog file larger than this — a defense against a crafted repo whose
 *  huge single file would block the event loop in the synchronous read + parse. */
const MAX_BACKLOG_FILE_BYTES = 1_000_000;

function fileWarning(file: string, code: string, message: string): FileWarning {
  return { file, lineNumber: 0, code, message };
}

function shouldSurfaceFileWarning(warning: FileWarning): boolean {
  // Backlog files often carry nested markdown detail under a top-level item. The parser ignores
  // unsupported detail for item extraction, but surfacing every detail bullet as a cockpit warning
  // drowns out genuinely actionable file issues.
  return !(
    (warning.file === BUGS_REL || warning.file === IDEAS_REL) &&
    warning.code === 'over-indented'
  );
}

/**
 * Read and parse one backlog file under an already-canonicalized repo root. Returns the parsed
 * items and appends any file/parse warnings to `fileWarnings`. Missing file → silent empty;
 * symlink escape or read error → empty + a typed warning.
 */
function readOne(
  repoRoot: string,
  relFile: string,
  parse: (content: string, file: string) => { items: BacklogItem[]; fileWarnings: FileWarning[] },
  fileWarnings: FileWarning[],
): BacklogItem[] {
  const abs = join(repoRoot, relFile);

  let realFile: string;
  try {
    realFile = realpathSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // missing → silent
    fileWarnings.push(fileWarning(relFile, 'unreadable-file', `could not resolve ${relFile}`));
    return [];
  }

  // Symlink escape: the resolved target must stay inside the repo.
  if (!isContainedIn(repoRoot, realFile)) {
    fileWarnings.push(
      fileWarning(relFile, 'symlink-escape', `${relFile} resolves outside the product repo`),
    );
    return [];
  }

  // Open once and stat/read on the same fd, so the size check and the read see the same inode
  // (no stat→read TOCTOU window). `fstat().isFile()` also rejects directories and named pipes
  // before any blocking `read`, so a non-regular file at this path can't stall the event loop.
  let fd: number;
  try {
    fd = openSync(realFile, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // raced deletion → missing
    fileWarnings.push(fileWarning(relFile, 'unreadable-file', `could not open ${relFile}`));
    return [];
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      fileWarnings.push(fileWarning(relFile, 'unreadable-file', `${relFile} is not a regular file`));
      return [];
    }
    if (st.size > MAX_BACKLOG_FILE_BYTES) {
      fileWarnings.push(
        fileWarning(relFile, 'oversized-file', `${relFile} exceeds the size cap and was skipped`),
      );
      return [];
    }
    const parsed = parse(readFileSync(fd, 'utf8'), relFile);
    fileWarnings.push(...parsed.fileWarnings.filter(shouldSurfaceFileWarning));
    return parsed.items;
  } catch {
    fileWarnings.push(fileWarning(relFile, 'unreadable-file', `could not read ${relFile}`));
    return [];
  } finally {
    try {
      closeSync(fd);
    } catch {
      // fd already closed / invalid — nothing to do.
    }
  }
}

/**
 * Read every product's backlog. One `ProductBacklog` per registry product, in registry order.
 * Pure of side effects beyond reads; never throws on a per-product failure — a bad product
 * degrades to an empty backlog with a warning, the rest are unaffected.
 */
export function readBacklogs(
  registry: Registry,
  productsConfig: Record<string, BacklogReaderConfig>,
  opts?: ReadBacklogsOpts,
): ProductBacklog[] {
  const workspaceRoot = opts?.workspaceRoot ?? join(homedir(), 'workspace');
  // Both sides of the containment check must be realpath-canonicalized for the lexical
  // `isContainedIn` to be sound (e.g. macOS /var → /private/var). If the root can't be
  // canonicalized it's a misconfiguration — fail closed (reject every repo-backed product)
  // rather than fall back to a lexical path that could mis-compare against realpath'd repos.
  let canonicalRoot: string | null;
  try {
    canonicalRoot = realpathSync(workspaceRoot);
  } catch {
    canonicalRoot = null;
  }

  return registry.products.map((product) => {
    const result: ProductBacklog = {
      product: product.name,
      notRepoBacked: !product.repoBacked,
      bugs: [],
      ideas: [],
      fileWarnings: [],
    };

    if (!product.repoBacked) return result;

    const cfg = productsConfig[product.name];
    if (!cfg) {
      result.fileWarnings.push(
        fileWarning('', 'no-product-config', `no products.json entry for ${product.name}`),
      );
      return result;
    }

    let canonicalRepo: string;
    try {
      canonicalRepo = realpathSync(cfg.repoPath);
    } catch {
      result.fileWarnings.push(
        fileWarning('', 'repo-unresolvable', `repoPath for ${product.name} could not be resolved`),
      );
      return result;
    }

    if (canonicalRoot === null || !isContainedIn(canonicalRoot, canonicalRepo)) {
      result.fileWarnings.push(
        fileWarning('', 'repo-outside-workspace', `repoPath for ${product.name} is outside the workspace`),
      );
      return result;
    }

    result.bugs = readOne(canonicalRepo, BUGS_REL, parseBugs, result.fileWarnings);
    result.ideas = readOne(canonicalRepo, IDEAS_REL, parseIdeas, result.fileWarnings);
    return result;
  });
}

/**
 * Derive the cockpit's product-card `BacklogCounts` from a `ProductBacklog`: open/done tallies
 * for bugs and ideas, plus the file-level warning count (the drawer's "Format warnings" banner;
 * per-item `⚠` warnings are not counted here). Pure — the Phase 2 cockpit wiring calls this per
 * product and feeds the result to `buildCockpitView`.
 */
export function computeBacklogCounts(backlog: ProductBacklog): BacklogCounts {
  const tally = (items: BacklogItem[]) => ({
    open: items.filter((i) => i.status === 'open').length,
    done: items.filter((i) => i.status === 'done').length,
  });
  return { bugs: tally(backlog.bugs), ideas: tally(backlog.ideas), warnings: backlog.fileWarnings.length };
}
