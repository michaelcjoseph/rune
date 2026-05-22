import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * Test-first suite for test-plan.md §1 — product/project registry (08-intent-layer, Phase 1).
 *
 * Written BEFORE the registry implementation. `src/intent/registry.ts` currently ships as a
 * contract stub whose functions throw 'not implemented', so every test here is RED. That is
 * the intended, correct state: this is a "Tests (write first)" task — the suite goes green
 * when Phase 1's registry implementation tasks land. Do not implement the registry to make
 * these pass; that is a separate task.
 */

// --- Mocks (must precede the module import) ---

// vi.hoisted so mockLog exists before registry.ts's module-load `createLogger()` call.
const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/logger.js', () => ({ createLogger: () => mockLog }));

vi.mock('../config.js', () => ({
  default: { LOGS_DIR: '/test/logs', REGISTRY_FILE: '/test/logs/registry.json' },
  PROJECT_ROOT: '/test/jarvis',
}));

// vi.hoisted so the mocks exist before registry.ts's module-load `node:fs` import.
const { mockWriteFileSync, mockRenameSync, mockReadFileSync, mockMkdirSync } = vi.hoisted(() => ({
  mockWriteFileSync: vi.fn(),
  mockRenameSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
}));
vi.mock('node:fs', () => ({
  writeFileSync: mockWriteFileSync,
  renameSync: mockRenameSync,
  readFileSync: mockReadFileSync,
  mkdirSync: mockMkdirSync,
}));

import {
  buildRegistry,
  getAllProjects,
  writeRegistry,
  readRegistry,
  REGISTRY_FILE,
  type Registry,
  type RegistrySources,
} from './registry.js';

// --- Fixtures ---

/** Render a product repo's `docs/projects/index.md` table for the given rows. */
function indexMd(rows: Array<{ slug: string; status: string }>): string {
  const header = '| Project | Status | Summary |\n|---|---|---|';
  const body = rows
    .map((r) => `| [${r.slug}](${r.slug}/spec.md) | ${r.status} | A project. |`)
    .join('\n');
  return `# Projects\n\n${header}\n${body}\n`;
}

const JARVIS_INDEX = indexMd([
  { slug: '01-mvp', status: 'Done' },
  { slug: '07-spaced-repetition', status: 'In Progress' },
  { slug: '08-intent-layer', status: 'Planned' },
]);

const ASSAY_INDEX = indexMd([{ slug: '01-core', status: 'In Progress' }]);

/** Two repo-backed products plus one non-repo product (e.g. `family`). */
function sampleSources(): RegistrySources {
  return {
    products: [
      { name: 'jarvis', repoBacked: true, projectsIndex: JARVIS_INDEX },
      { name: 'assay', repoBacked: true, projectsIndex: ASSAY_INDEX },
      { name: 'family', repoBacked: false, projectsIndex: null },
    ],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('registry — aggregation (test-plan §1)', () => {
  it('returns every product and its projects in one query, across all sources', () => {
    const registry = buildRegistry(sampleSources());
    expect(registry.products.map((p) => p.name).sort()).toEqual(['assay', 'family', 'jarvis']);

    const all = getAllProjects(registry);
    // 3 jarvis projects + 1 assay project + 0 family projects.
    expect(all).toHaveLength(4);
    expect(all.filter((p) => p.product === 'jarvis')).toHaveLength(3);
    expect(all.filter((p) => p.product === 'assay')).toHaveLength(1);
    expect(all.filter((p) => p.product === 'family')).toHaveLength(0);
  });

  it('derives lifecycle status from the repo index Status column', () => {
    const registry = buildRegistry(sampleSources());
    const jarvis = registry.products.find((p) => p.name === 'jarvis')!;
    const bySlug = Object.fromEntries(jarvis.projects.map((p) => [p.slug, p.status]));
    expect(bySlug['01-mvp']).toBe('done'); // "Done"
    expect(bySlug['07-spaced-repetition']).toBe('active'); // "In Progress"
    expect(bySlug['08-intent-layer']).toBe('planned'); // "Planned"
  });

  it('is rebuildable — regenerating from the same sources yields an identical model', () => {
    const a = buildRegistry(sampleSources());
    const b = buildRegistry(sampleSources());
    // The products/projects model is identical; only `builtAt` metadata may differ.
    expect(b.products).toEqual(a.products);
  });

  it('surfaces a repo with no project docs as a product with zero projects, not an error', () => {
    const sources: RegistrySources = {
      products: [{ name: 'storytime', repoBacked: true, projectsIndex: null }],
    };
    let registry: Registry | undefined;
    expect(() => {
      registry = buildRegistry(sources);
    }).not.toThrow();
    const storytime = registry!.products.find((p) => p.name === 'storytime')!;
    expect(storytime.projects).toEqual([]);
  });

  it('carries lifecycle status only — never run-status', () => {
    const registry = buildRegistry(sampleSources());
    for (const project of getAllProjects(registry)) {
      expect(['planned', 'active', 'done']).toContain(project.status);
      // run-status (running / blocked) belongs to the supervision layer (§9), not here.
      expect(project).not.toHaveProperty('runStatus');
      expect(project).not.toHaveProperty('running');
      expect(project).not.toHaveProperty('blocked');
    }
  });

  it('logs build timing and the count of products/projects scanned', () => {
    buildRegistry(sampleSources());
    const buildLog = mockLog.info.mock.calls.find(
      (call) => typeof call[1] === 'object' && call[1] !== null && 'products' in call[1],
    );
    expect(buildLog).toBeDefined();
    expect(buildLog![1]).toMatchObject({ products: 3, projects: 4 });
    expect(buildLog![1]).toHaveProperty('durationMs');
  });
});

describe('registry — writes and corruption (test-plan §1)', () => {
  it('reflects a lifecycle-status change after the registry is next written', () => {
    // Round-trip mock: readFileSync returns whatever writeRegistry last persisted,
    // ignoring the path argument (writeRegistry writes a temp path, readRegistry reads
    // REGISTRY_FILE). The atomic-write test below independently pins the path contract.
    let persisted = '';
    mockWriteFileSync.mockImplementation((_path: string, content: string) => {
      persisted = content;
    });
    mockReadFileSync.mockImplementation(() => persisted);

    const before = buildRegistry({
      products: [
        { name: 'assay', repoBacked: true, projectsIndex: indexMd([{ slug: '01-core', status: 'In Progress' }]) },
      ],
    });
    writeRegistry(before);
    expect(readRegistry().products[0]!.projects[0]!.status).toBe('active');

    const after = buildRegistry({
      products: [
        { name: 'assay', repoBacked: true, projectsIndex: indexMd([{ slug: '01-core', status: 'Done' }]) },
      ],
    });
    writeRegistry(after);
    expect(readRegistry().products[0]!.projects[0]!.status).toBe('done');
  });

  it('writes atomically — temp file first, then rename, never a torn write', () => {
    const registry = buildRegistry(sampleSources());
    writeRegistry(registry);

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockRenameSync).toHaveBeenCalledTimes(1);

    const writtenPath = String(mockWriteFileSync.mock.calls[0]![0]);
    const [renameFrom, renameTo] = mockRenameSync.mock.calls[0]!.map(String);

    // The bytes land on a temp path, not the final file...
    expect(writtenPath).not.toBe(REGISTRY_FILE);
    expect(writtenPath).toBe(renameFrom);
    // ...then an atomic rename swaps it into place.
    expect(renameTo).toBe(REGISTRY_FILE);
    // writeFileSync must run before renameSync.
    expect(mockWriteFileSync.mock.invocationCallOrder[0]!).toBeLessThan(
      mockRenameSync.mock.invocationCallOrder[0]!,
    );
  });

  it('fails fast with a clear error on a malformed registry file — never a silent empty model', () => {
    // Two inputs are unparseable JSON; the third is valid JSON of the wrong shape — so
    // readRegistry must both (a) wrap a raw JSON.parse SyntaxError in a clear message,
    // and (b) shape-validate the parsed object, never silently returning a broken model.
    for (const corrupt of ['{ not valid json', '{"unexpected":"shape"}', '']) {
      mockReadFileSync.mockReturnValue(corrupt);
      // A clear error naming the corruption — never a deceptively-empty `{ products: [] }`.
      // A raw JSON.parse SyntaxError ("Unexpected end of JSON input") does NOT satisfy
      // this regex: the implementation must catch and rethrow with a clear message.
      expect(() => readRegistry()).toThrow(/malformed|corrupt|parse|unreadable/i);
    }
  });
});

describe('registry — cockpit query API (test-plan §1)', () => {
  it('getAllProjects flattens every project with its owning product name', () => {
    const all = getAllProjects(buildRegistry(sampleSources()));
    for (const project of all) {
      expect(typeof project.product).toBe('string');
      expect(typeof project.slug).toBe('string');
      expect(['planned', 'active', 'done']).toContain(project.status);
    }
    expect(all.some((p) => p.product === 'jarvis' && p.slug === '08-intent-layer')).toBe(true);
  });
});
