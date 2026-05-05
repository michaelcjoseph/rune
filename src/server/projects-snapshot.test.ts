import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

// --- Mocks before any dynamic imports ---

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock node:fs entirely
const mockReadFileSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockStatSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
  readdirSync: mockReaddirSync,
  statSync: mockStatSync,
  existsSync: mockExistsSync,
}));

// --- Dynamic imports after mocks ---

const { getProjectSummaries } = await import('./projects-snapshot.js');

// --- Helpers ---

// We need to know the resolved PROJECTS_DIR. projects-snapshot.ts uses:
//   const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// i.e., projects-snapshot.ts is at src/server/, so PROJECT_ROOT is the repo root.
// We can't easily mock import.meta.url, so we derive the actual path:
const REPO_ROOT = join(new URL(import.meta.url).pathname, '..', '..', '..');
const PROJECTS_DIR = join(REPO_ROOT, 'docs', 'projects');
const INDEX_FILE = join(PROJECTS_DIR, 'index.md');

const INDEX_MD = `# Projects

| Project | Status | Description |
|---|---|---|
| [01-mvp](01-mvp/spec.md) | Done | Core server |
| [06-webview](06-webview/spec.md) | In Progress | Webview chat surface |
`;

const TASKS_MD_WITH_PHASES = `## Phase A

- [x] Task 1
- [x] Task 2
- [ ] Task 3

## Phase B

- [x] Task 4
- [ ] Task 5
- [ ] Task 6
`;

const TASKS_MD_NO_PHASES = `- [x] Done task
- [x] Another done
- [ ] Pending task
`;

function makeStatResult(isDir: boolean, mtimeMs = 1000): any {
  return { isDirectory: () => isDir, mtimeMs };
}

// --- Tests ---

describe('getProjectSummaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('reads index.md to get status by slug', () => {
    it('parses status from the index table for each directory slug', () => {
      // Two project directories
      mockReaddirSync.mockReturnValue(['01-mvp', '06-webview']);
      mockStatSync.mockImplementation((p: string) => {
        if (p.endsWith('01-mvp') || p.endsWith('06-webview')) {
          return makeStatResult(true);
        }
        return makeStatResult(false);
      });
      mockReadFileSync.mockImplementation((p: string) => {
        if (p === INDEX_FILE) return INDEX_MD;
        if (p.endsWith('spec.md')) return '# Spec';
        if (p.endsWith('tasks.md')) return TASKS_MD_NO_PHASES;
        return '';
      });
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('spec.md') || p.endsWith('tasks.md');
      });

      const summaries = getProjectSummaries();

      const mvp = summaries.find(s => s.slug === '01-mvp');
      const webview = summaries.find(s => s.slug === '06-webview');

      expect(mvp).toBeDefined();
      expect(mvp!.status).toBe('Done');

      expect(webview).toBeDefined();
      expect(webview!.status).toBe('In Progress');
    });

    it('uses "Unknown" status for slugs not found in the index', () => {
      mockReaddirSync.mockReturnValue(['99-unlisted']);
      mockStatSync.mockReturnValue(makeStatResult(true));
      mockReadFileSync.mockImplementation((p: string) => {
        if (p === INDEX_FILE) return INDEX_MD; // 99-unlisted not in index
        if (p.endsWith('spec.md')) return '# Spec';
        if (p.endsWith('tasks.md')) return '';
        return '';
      });
      mockExistsSync.mockImplementation((p: string) => p.endsWith('spec.md'));

      const summaries = getProjectSummaries();
      expect(summaries[0]!.status).toBe('Unknown');
    });
  });

  describe('counts tasks in tasks.md grouped by Phase headers', () => {
    it('counts done and total correctly across phases', () => {
      mockReaddirSync.mockReturnValue(['06-webview']);
      mockStatSync.mockReturnValue(makeStatResult(true));
      mockReadFileSync.mockImplementation((p: string) => {
        if (p === INDEX_FILE) return INDEX_MD;
        if (p.endsWith('spec.md')) return '# Spec';
        if (p.endsWith('tasks.md')) return TASKS_MD_WITH_PHASES;
        return '';
      });
      mockExistsSync.mockReturnValue(true);

      const summaries = getProjectSummaries();
      const s = summaries[0]!;

      // Phase A: 2 done of 3; Phase B: 1 done of 3 → total 3 done of 6
      expect(s.progress.done).toBe(3);
      expect(s.progress.total).toBe(6);
    });

    it('returns perPhase breakdown with correct phase names and counts', () => {
      mockReaddirSync.mockReturnValue(['06-webview']);
      mockStatSync.mockReturnValue(makeStatResult(true));
      mockReadFileSync.mockImplementation((p: string) => {
        if (p === INDEX_FILE) return INDEX_MD;
        if (p.endsWith('spec.md')) return '# Spec';
        if (p.endsWith('tasks.md')) return TASKS_MD_WITH_PHASES;
        return '';
      });
      mockExistsSync.mockReturnValue(true);

      const summaries = getProjectSummaries();
      const { perPhase } = summaries[0]!.progress;

      const phaseA = perPhase.find(p => p.phase.includes('Phase A'));
      const phaseB = perPhase.find(p => p.phase.includes('Phase B'));

      expect(phaseA).toBeDefined();
      expect(phaseA!.done).toBe(2);
      expect(phaseA!.total).toBe(3);

      expect(phaseB).toBeDefined();
      expect(phaseB!.done).toBe(1);
      expect(phaseB!.total).toBe(3);
    });
  });

  describe('skips non-directory entries in PROJECTS_DIR', () => {
    it('ignores files (e.g. index.md, bugs.md) in the projects dir', () => {
      mockReaddirSync.mockReturnValue(['index.md', 'bugs.md', '06-webview']);
      mockStatSync.mockImplementation((p: string) => {
        // Only 06-webview is a directory
        if (p.endsWith('06-webview')) return makeStatResult(true);
        return makeStatResult(false); // files
      });
      mockReadFileSync.mockImplementation((p: string) => {
        if (p === INDEX_FILE) return INDEX_MD;
        if (p.endsWith('spec.md')) return '# Spec';
        if (p.endsWith('tasks.md')) return '';
        return '';
      });
      mockExistsSync.mockImplementation((p: string) => p.endsWith('spec.md'));

      const summaries = getProjectSummaries();
      expect(summaries.every(s => s.slug === '06-webview')).toBe(true);
      // Specifically: index.md and bugs.md are NOT included
      expect(summaries.find(s => s.slug === 'index.md')).toBeUndefined();
      expect(summaries.find(s => s.slug === 'bugs.md')).toBeUndefined();
    });
  });

  describe('handles missing tasks.md gracefully', () => {
    it('returns progress 0/0 with empty perPhase when tasks.md is absent', () => {
      mockReaddirSync.mockReturnValue(['06-webview']);
      mockStatSync.mockReturnValue(makeStatResult(true));
      mockReadFileSync.mockImplementation((p: string) => {
        if (p === INDEX_FILE) return INDEX_MD;
        if (p.endsWith('spec.md')) return '# Spec';
        throw new Error('ENOENT'); // tasks.md not present
      });
      // existsSync: spec.md exists, tasks.md does not
      mockExistsSync.mockImplementation((p: string) => p.endsWith('spec.md'));

      const summaries = getProjectSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.progress.done).toBe(0);
      expect(summaries[0]!.progress.total).toBe(0);
      expect(summaries[0]!.progress.perPhase).toEqual([]);
    });
  });

  describe('skips projects without spec.md', () => {
    it('does not include a project dir that is missing spec.md', () => {
      mockReaddirSync.mockReturnValue(['no-spec-project', '06-webview']);
      mockStatSync.mockReturnValue(makeStatResult(true));
      mockReadFileSync.mockImplementation((p: string) => {
        if (p === INDEX_FILE) return INDEX_MD;
        if (p.includes('06-webview') && p.endsWith('spec.md')) return '# Spec';
        return '';
      });
      mockExistsSync.mockImplementation((p: string) => {
        // Only 06-webview has spec.md
        return p.includes('06-webview') && p.endsWith('spec.md');
      });

      const summaries = getProjectSummaries();
      expect(summaries.find(s => s.slug === 'no-spec-project')).toBeUndefined();
      expect(summaries.find(s => s.slug === '06-webview')).toBeDefined();
    });
  });

  describe('returns empty array when PROJECTS_DIR is unreadable', () => {
    it('returns [] when readdirSync throws', () => {
      mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT'); });

      const summaries = getProjectSummaries();
      expect(summaries).toEqual([]);
    });
  });

  describe('specPath format', () => {
    it('returns specPath relative to repo root (docs/projects/<slug>/spec.md)', () => {
      mockReaddirSync.mockReturnValue(['06-webview']);
      mockStatSync.mockReturnValue(makeStatResult(true));
      mockReadFileSync.mockImplementation((p: string) => {
        if (p === INDEX_FILE) return INDEX_MD;
        return '# Spec';
      });
      mockExistsSync.mockImplementation((p: string) => p.endsWith('spec.md'));

      const summaries = getProjectSummaries();
      expect(summaries[0]!.specPath).toBe(join('docs', 'projects', '06-webview', 'spec.md'));
    });
  });
});
