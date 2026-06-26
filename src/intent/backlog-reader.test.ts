import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Test suite for the backlog reader (09-expand-cockpit, Phase 1, written test-first).
 *
 * `backlog-reader.ts` is the filesystem + security layer over the pure parser. Its
 * `readBacklogs(registry, productsConfig, opts?)` walks every product in the registry, and
 * for each repo-backed product reads `<repoPath>/docs/projects/{bugs,ideas}.md`, parses
 * them, and rolls the result up per product. It enforces the spec's "Security / repo safety"
 * contract: canonicalize each `repoPath`, require it under `$WORKSPACE_ROOT`, and realpath
 * each backlog file so a symlink escaping `repoPath` is rejected rather than followed.
 *
 * Because the security checks are realpath/symlink-based, this suite uses real tmpdir
 * product repos rather than a mocked fs — the only honest way to exercise a symlink escape.
 *
 * This is the "test suite as deliverable" task: it stays RED (the module does not exist yet)
 * until the Phase 1 build task lands.
 */

import {
  readBacklogs,
  computeBacklogCounts,
  type ProductBacklog,
} from './backlog-reader.js';
import type { Registry } from './registry.js';
import type { ProductConfig } from '../jobs/sandbox-runtime.js';

// ---------------------------------------------------------------------------
// tmpdir scaffolding
// ---------------------------------------------------------------------------

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/** Make a fresh tmpdir and realpath it (macOS /var → /private/var parity). */
function makeRoot(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/** Scaffold `<root>/<name>/docs/projects/{bugs,ideas}.md` and return the repo path. */
function scaffoldRepo(
  root: string,
  name: string,
  files: { bugs?: string; ideas?: string },
): string {
  const repoPath = join(root, name);
  mkdirSync(join(repoPath, 'docs', 'projects'), { recursive: true });
  if (files.bugs !== undefined) {
    writeFileSync(join(repoPath, 'docs', 'projects', 'bugs.md'), files.bugs);
  }
  if (files.ideas !== undefined) {
    writeFileSync(join(repoPath, 'docs', 'projects', 'ideas.md'), files.ideas);
  }
  return repoPath;
}

function registryWith(products: { name: string; repoBacked: boolean }[]): Registry {
  return {
    version: 1,
    builtAt: '2026-06-03T00:00:00.000Z',
    products: products.map((p) => ({ name: p.name, repoBacked: p.repoBacked, projects: [] })),
  };
}

function configWith(entries: Record<string, string>): Record<string, ProductConfig> {
  const out: Record<string, ProductConfig> = {};
  for (const [name, repoPath] of Object.entries(entries)) {
    out[name] = { repoPath, baseBranch: 'main', credentialsFile: '', egressAllowlist: [] };
  }
  return out;
}

function byProduct(backlogs: ProductBacklog[], name: string): ProductBacklog {
  const match = backlogs.find((b) => b.product === name);
  if (!match) throw new Error(`no backlog for product ${name}`);
  return match;
}

function hasWarning(b: ProductBacklog, code: string): boolean {
  return b.fileWarnings.some((w) => w.code === code);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backlog-reader — registry roll-up', () => {
  it('reads and parses bugs + ideas for every repo-backed product', () => {
    const root = makeRoot('backlog-rollup-');
    scaffoldRepo(root, 'rune', {
      bugs: '- [ ] Cockpit shows wrong status\n- [x] Whoop date mismatch\n',
      ideas: '## User-authored\n- Some idea\n',
    });
    scaffoldRepo(root, 'aura', {
      bugs: '- [ ] Aura login bug\n',
      ideas: '## User-authored\n- Aura idea\n',
    });

    const result = readBacklogs(
      registryWith([
        { name: 'rune', repoBacked: true },
        { name: 'aura', repoBacked: true },
      ]),
      configWith({ rune: join(root, 'rune'), aura: join(root, 'aura') }),
      { workspaceRoot: root },
    );

    expect(result).toHaveLength(2);

    const rune = byProduct(result, 'rune');
    expect(rune.notRepoBacked).toBe(false);
    expect(rune.bugs.map((b) => b.text)).toEqual([
      'Cockpit shows wrong status',
      'Whoop date mismatch',
    ]);
    expect(rune.bugs[1]!.status).toBe('done');
    expect(rune.ideas.map((i) => i.text)).toEqual(['Some idea']);
    expect(rune.fileWarnings).toEqual([]);

    const aura = byProduct(result, 'aura');
    expect(aura.bugs.map((b) => b.text)).toEqual(['Aura login bug']);
    expect(aura.ideas.map((i) => i.text)).toEqual(['Aura idea']);
  });

  it('reports source.file as the repo-relative path, never the absolute host path', () => {
    const root = makeRoot('backlog-relpath-');
    scaffoldRepo(root, 'rune', { bugs: '- [ ] A bug\n' });

    const result = readBacklogs(
      registryWith([{ name: 'rune', repoBacked: true }]),
      configWith({ rune: join(root, 'rune') }),
      { workspaceRoot: root },
    );

    const bug = byProduct(result, 'rune').bugs[0]!;
    expect(bug.source.file).toBe('docs/projects/bugs.md');
    expect(bug.source.file).not.toContain(root);
  });
});

describe('backlog-reader — product-local ids', () => {
  it('gives byte-identical bullets in different products the same id (route namespaces by product)', () => {
    const root = makeRoot('backlog-ids-');
    scaffoldRepo(root, 'rune', { bugs: '- [ ] Shared bug text\n' });
    scaffoldRepo(root, 'aura', { bugs: '- [ ] Shared bug text\n' });

    const result = readBacklogs(
      registryWith([
        { name: 'rune', repoBacked: true },
        { name: 'aura', repoBacked: true },
      ]),
      configWith({ rune: join(root, 'rune'), aura: join(root, 'aura') }),
      { workspaceRoot: root },
    );

    // Same repo-relative path + line + raw → same id string. Disambiguation is the API
    // route's `:product` segment, not the id (spec Data model + test-plan §2/§3).
    expect(byProduct(result, 'rune').bugs[0]!.id).toBe(byProduct(result, 'aura').bugs[0]!.id);
  });
});

describe('backlog-reader — non-repo-backed products', () => {
  it('flags a non-repo-backed product with notRepoBacked and an empty backlog', () => {
    const root = makeRoot('backlog-norepo-');

    const result = readBacklogs(
      registryWith([{ name: 'relay', repoBacked: false }]),
      configWith({}),
      { workspaceRoot: root },
    );

    const relay = byProduct(result, 'relay');
    expect(relay.notRepoBacked).toBe(true);
    expect(relay.bugs).toEqual([]);
    expect(relay.ideas).toEqual([]);
    expect(relay.fileWarnings).toEqual([]);
  });
});

describe('backlog-reader — missing and unreadable files', () => {
  it('returns an empty backlog with no warning when the files do not exist', () => {
    const root = makeRoot('backlog-missing-');
    // Repo dir exists (docs/projects scaffolded) but neither bugs.md nor ideas.md written.
    mkdirSync(join(root, 'rune', 'docs', 'projects'), { recursive: true });

    const result = readBacklogs(
      registryWith([{ name: 'rune', repoBacked: true }]),
      configWith({ rune: join(root, 'rune') }),
      { workspaceRoot: root },
    );

    const rune = byProduct(result, 'rune');
    expect(rune.bugs).toEqual([]);
    expect(rune.ideas).toEqual([]);
    expect(rune.fileWarnings).toEqual([]);
    expect(rune.notRepoBacked).toBe(false);
  });

  it('surfaces a file warning and an empty list when a backlog file is unreadable', () => {
    const root = makeRoot('backlog-unreadable-');
    const repoPath = join(root, 'rune');
    mkdirSync(join(repoPath, 'docs', 'projects'), { recursive: true });
    // A directory where bugs.md should be → readFileSync throws EISDIR.
    mkdirSync(join(repoPath, 'docs', 'projects', 'bugs.md'));
    writeFileSync(join(repoPath, 'docs', 'projects', 'ideas.md'), '## User-authored\n- ok idea\n');

    const result = readBacklogs(
      registryWith([{ name: 'rune', repoBacked: true }]),
      configWith({ rune: repoPath }),
      { workspaceRoot: root },
    );

    const rune = byProduct(result, 'rune');
    expect(rune.bugs).toEqual([]);
    // `unreadable-file` is the generic code for any non-ENOENT read error (EISDIR here,
    // but also EACCES etc.) — distinct from a simply-missing file, which is silent.
    expect(hasWarning(rune, 'unreadable-file')).toBe(true);
    // The other file still reads — one unreadable file does not poison the product.
    expect(rune.ideas.map((i) => i.text)).toEqual(['ok idea']);
  });
});

describe('backlog-reader — warning surfacing', () => {
  it('suppresses indented detail bullets while keeping actionable warnings', () => {
    const root = makeRoot('backlog-warning-noise-');
    scaffoldRepo(root, 'rune', {
      bugs: '- [ ] top bug\n  - detail bullet\n* wrong top-level bullet\n',
      ideas: '## User-authored\n- idea\n   - too deep\n> wrong top-level quote\n',
    });

    const result = readBacklogs(
      registryWith([{ name: 'rune', repoBacked: true }]),
      configWith({ rune: join(root, 'rune') }),
      { workspaceRoot: root },
    );

    const rune = byProduct(result, 'rune');
    expect(rune.bugs.map((b) => b.text)).toEqual(['top bug']);
    expect(rune.fileWarnings.map((w) => `${w.file}:${w.code}`)).toEqual([
      'docs/projects/bugs.md:star-bullet',
      'docs/projects/ideas.md:blockquote',
    ]);
  });
});

describe('backlog-reader — computeBacklogCounts', () => {
  function backlog(over: Partial<ProductBacklog>): ProductBacklog {
    return { product: 'rune', notRepoBacked: false, bugs: [], ideas: [], fileWarnings: [], ...over };
  }

  it('tallies open/done for bugs and ideas and counts file warnings', () => {
    const root = makeRoot('backlog-counts-');
    scaffoldRepo(root, 'rune', {
      bugs: '- [ ] open bug\n- [x] done bug\n- [ ] another open\n',
      ideas: '## User-authored\n- open idea\n- promoted idea → 09-expand-cockpit\n\t- tab warning\n',
    });
    const [product] = readBacklogs(
      registryWith([{ name: 'rune', repoBacked: true }]),
      configWith({ rune: join(root, 'rune') }),
      { workspaceRoot: root },
    );
    const counts = computeBacklogCounts(product!);
    expect(counts.bugs).toEqual({ open: 2, done: 1 });
    expect(counts.ideas).toEqual({ open: 1, done: 1 }); // promoted idea is 'done'
    expect(counts.warnings).toBe(1); // the tab-indented line
  });

  it('returns zeroes for an empty backlog', () => {
    expect(computeBacklogCounts(backlog({}))).toEqual({
      bugs: { open: 0, done: 0 },
      ideas: { open: 0, done: 0 },
      warnings: 0,
    });
  });
});

describe('backlog-reader — security: symlink and path escape', () => {
  it('rejects a backlog file that symlinks outside the repo, surfacing a warning and reading nothing', () => {
    const root = makeRoot('backlog-symlink-');
    const repoPath = join(root, 'rune');
    mkdirSync(join(repoPath, 'docs', 'projects'), { recursive: true });

    // A secret outside the repo (but inside the workspace) that bugs.md points at.
    const secret = join(root, 'secret.md');
    writeFileSync(secret, '- [ ] exfiltrated content\n');
    symlinkSync(secret, join(repoPath, 'docs', 'projects', 'bugs.md'));

    const result = readBacklogs(
      registryWith([{ name: 'rune', repoBacked: true }]),
      configWith({ rune: repoPath }),
      { workspaceRoot: root },
    );

    const rune = byProduct(result, 'rune');
    expect(rune.bugs).toEqual([]);
    expect(hasWarning(rune, 'symlink-escape')).toBe(true);
    // The escaped content must never appear in the parsed output.
    expect(JSON.stringify(rune.bugs)).not.toContain('exfiltrated');
  });

  it('rejects a symlink whose target escapes the workspace entirely (guard is repoPath-containment, not workspace-level)', () => {
    // Pins that the symlink rejection fires from the repoPath-containment check, not a
    // looser workspace-level check: here the target is in a SEPARATE tmpdir outside the
    // workspace, so an implementation that only checked "escapes workspace" and one that
    // checked "escapes repoPath" would both reject — but the prior test (target inside the
    // workspace, outside the repo) only passes for the correct repoPath-containment guard.
    const workspaceRoot = makeRoot('backlog-symlink-ws-');
    const elsewhere = makeRoot('backlog-symlink-elsewhere-');
    const repoPath = join(workspaceRoot, 'rune');
    mkdirSync(join(repoPath, 'docs', 'projects'), { recursive: true });

    const target = join(elsewhere, 'secret.md');
    writeFileSync(target, '- [ ] exfiltrated content\n');
    symlinkSync(target, join(repoPath, 'docs', 'projects', 'bugs.md'));

    const result = readBacklogs(
      registryWith([{ name: 'rune', repoBacked: true }]),
      configWith({ rune: repoPath }),
      { workspaceRoot },
    );

    const rune = byProduct(result, 'rune');
    expect(rune.bugs).toEqual([]);
    expect(hasWarning(rune, 'symlink-escape')).toBe(true);
    expect(JSON.stringify(rune.bugs)).not.toContain('exfiltrated');
  });

  it('rejects a product whose repoPath lives outside $WORKSPACE_ROOT, reading nothing', () => {
    const workspaceRoot = makeRoot('backlog-ws-');
    const outsideRoot = makeRoot('backlog-outside-'); // a sibling tmpdir, NOT under workspaceRoot
    const repoPath = scaffoldRepo(outsideRoot, 'rune', { bugs: '- [ ] off-limits bug\n' });

    const result = readBacklogs(
      registryWith([{ name: 'rune', repoBacked: true }]),
      configWith({ rune: repoPath }),
      { workspaceRoot },
    );

    const rune = byProduct(result, 'rune');
    expect(rune.bugs).toEqual([]);
    expect(rune.ideas).toEqual([]);
    expect(hasWarning(rune, 'repo-outside-workspace')).toBe(true);
    // The out-of-bounds bug must never be read.
    expect(JSON.stringify(rune.bugs)).not.toContain('off-limits');
  });
});
