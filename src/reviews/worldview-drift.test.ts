import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

vi.mock('../vault/files.js', () => ({
  readVaultFile: vi.fn(),
  listVaultFiles: vi.fn(),
}));

const { readVaultFile, listVaultFiles } = await import('../vault/files.js');
const { detectWorldviewDrift, formatDriftFlags } = await import('./worldview-drift.js');

const readMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;
const listMock = listVaultFiles as unknown as ReturnType<typeof vi.fn>;

describe('worldview-drift', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('detectWorldviewDrift', () => {
    it('flags a topic with a changelog entry in the date range that is cited by a project', () => {
      listMock.mockImplementation((dir: string) => {
        if (dir === 'world-view') return ['world-view/ai.md', 'world-view/world-view.md'];
        if (dir === 'projects') return ['projects/project-alpha.md', 'projects/project-beta.md'];
        return [];
      });
      readMock.mockImplementation((path: string) => {
        if (path === 'world-view/ai.md') {
          return `# AI thesis body

## Changelog

### [[2026_04_15]]
Revised world-models thesis to acknowledge pixel-prediction lead from Runway.

### [[2026_01_01]]
Old entry outside the range.`;
        }
        if (path === 'projects/project-alpha.md') {
          return 'Project Alpha cites [[ai]] in its thesis.';
        }
        if (path === 'projects/project-beta.md') {
          return 'No worldview references here.';
        }
        return null;
      });

      const flags = detectWorldviewDrift('2026_04_11', '2026_04_17');

      expect(flags).toHaveLength(1);
      expect(flags[0]).toMatchObject({
        topic: 'ai',
        changedOn: '2026_04_15',
        affectedProjects: ['projects/project-alpha.md'],
      });
      expect(flags[0]!.summary).toContain('pixel-prediction');
    });

    it('ignores changelog entries outside the date range', () => {
      listMock.mockImplementation((dir: string) => {
        if (dir === 'world-view') return ['world-view/ai.md'];
        if (dir === 'projects') return ['projects/project-alpha.md'];
        return [];
      });
      readMock.mockImplementation((path: string) => {
        if (path === 'world-view/ai.md') return '### [[2025_12_01]]\nOld change.';
        if (path === 'projects/project-alpha.md') return '[[ai]] reference';
        return null;
      });

      const flags = detectWorldviewDrift('2026_04_11', '2026_04_17');
      expect(flags).toHaveLength(0);
    });

    it('ignores worldview changes with no project citations', () => {
      listMock.mockImplementation((dir: string) => {
        if (dir === 'world-view') return ['world-view/demographics.md'];
        if (dir === 'projects') return ['projects/project-alpha.md'];
        return [];
      });
      readMock.mockImplementation((path: string) => {
        if (path === 'world-view/demographics.md') return '### [[2026_04_15]]\nDemographic shift.';
        if (path === 'projects/project-alpha.md') return 'No worldview links.';
        return null;
      });

      const flags = detectWorldviewDrift('2026_04_11', '2026_04_17');
      expect(flags).toHaveLength(0);
    });

    it('matches both [[topic]] and [[world-view/topic]] citation styles', () => {
      listMock.mockImplementation((dir: string) => {
        if (dir === 'world-view') return ['world-view/crypto.md'];
        if (dir === 'projects') return ['projects/project-beta.md', 'projects/project-alpha.md'];
        return [];
      });
      readMock.mockImplementation((path: string) => {
        if (path === 'world-view/crypto.md') return '### [[2026_04_12]]\nStablecoin thesis update.';
        if (path === 'projects/project-beta.md') return 'Project Beta references [[crypto]].';
        if (path === 'projects/project-alpha.md') return 'Project Alpha references [[world-view/crypto]].';
        return null;
      });

      const flags = detectWorldviewDrift('2026_04_11', '2026_04_17');
      expect(flags).toHaveLength(1);
      expect(flags[0]!.affectedProjects).toEqual(
        expect.arrayContaining(['projects/project-beta.md', 'projects/project-alpha.md']),
      );
    });

    it('skips the world-view/world-view.md index file', () => {
      listMock.mockImplementation((dir: string) => {
        if (dir === 'world-view') return ['world-view/world-view.md'];
        if (dir === 'projects') return ['projects/project-alpha.md'];
        return [];
      });
      readMock.mockImplementation((path: string) => {
        if (path === 'world-view/world-view.md') return '### [[2026_04_15]]\nIndex change.';
        if (path === 'projects/project-alpha.md') return '[[world-view]]';
        return null;
      });

      const flags = detectWorldviewDrift('2026_04_11', '2026_04_17');
      expect(flags).toHaveLength(0);
    });

    it('excludes archived projects from citation search', () => {
      listMock.mockImplementation((dir: string) => {
        if (dir === 'world-view') return ['world-view/ai.md'];
        if (dir === 'projects') return ['projects/archive/old.md', 'projects/project-alpha.md'];
        return [];
      });
      readMock.mockImplementation((path: string) => {
        if (path === 'world-view/ai.md') return '### [[2026_04_15]]\nAI thesis update.';
        if (path === 'projects/archive/old.md') return '[[ai]]';
        if (path === 'projects/project-alpha.md') return '[[ai]]';
        return null;
      });

      const flags = detectWorldviewDrift('2026_04_11', '2026_04_17');
      expect(flags[0]!.affectedProjects).toEqual(['projects/project-alpha.md']);
    });
  });

  describe('formatDriftFlags', () => {
    it('returns null for empty flags', () => {
      expect(formatDriftFlags([])).toBeNull();
    });

    it('formats flags with topic, date, and affected projects', () => {
      const out = formatDriftFlags([
        {
          topic: 'ai',
          changedOn: '2026_04_15',
          summary: 'World models thesis update.',
          affectedProjects: ['projects/project-alpha.md', 'projects/project-beta.md'],
        },
      ]);
      expect(out).toContain('[[world-view/ai]]');
      expect(out).toContain('[[2026_04_15]]');
      expect(out).toContain('projects/project-alpha.md');
      expect(out).toContain('projects/project-beta.md');
      expect(out).toContain('World models thesis update.');
    });
  });
});
