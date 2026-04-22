import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

vi.mock('../vault/files.js', () => ({
  readVaultFile: vi.fn(),
  vaultFileExists: vi.fn(() => false),
}));

vi.mock('../ai/claude.js', () => ({
  askClaudeOneShot: vi.fn(),
}));

const { readVaultFile, vaultFileExists } = await import('../vault/files.js');
const { askClaudeOneShot } = await import('../ai/claude.js');
const {
  scanKBActivity,
  formatKBActivity,
  resolveCategory,
  resolveDirection,
  summarizeKBActivity,
  renderKBActivitySection,
  SUMMARIZER_THRESHOLD,
} = await import('./kb-activity.js');

const readMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;
const existsMock = vaultFileExists as unknown as ReturnType<typeof vi.fn>;
const askMock = askClaudeOneShot as unknown as ReturnType<typeof vi.fn>;

const SAMPLE_LOG = `# Knowledge Base Log

[2026-04-21 13:20] [INGEST] Smoke-test journal ingested — 3 entities + 1 concept.
  Sources: [[journals/smoke-test]], [[raw/journals/smoke-test]]
  Pages touched: [[watt-data]], [[relay]], [[do-things-that-dont-scale]], [[paul-graham]]

[2026-04-19 13:15] [INGEST] Skipped (duplicate) — world-view index file.
  Sources: [[world-view/world-view]], [[raw/notes/world-view]]
  Pages touched: (none)

[2026-04-15 21:00] [INGEST] Ingested Jose Maria Macedo's tweet thread.
  Sources: [[raw/articles/how-to-get-long-ai-macedo]]
  Pages touched: [[jose-maria-macedo]], [[ai-portfolio-construction]]

[2026-04-07 10:00] [INGEST] Outside the typical review window.
  Sources: [[raw/articles/old]]
  Pages touched: [[old-page]]
`;

describe('reviews/kb-activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsMock.mockReturnValue(false);
  });

  describe('scanKBActivity', () => {
    it('returns entries within the date window (inclusive)', () => {
      readMock.mockReturnValue(SAMPLE_LOG);
      const digest = scanKBActivity('2026-04-15', '2026-04-21');
      expect(digest.entries).toHaveLength(3);
      expect(digest.entries.map((e) => e.date)).toEqual([
        '2026-04-21',
        '2026-04-19',
        '2026-04-15',
      ]);
    });

    it('excludes entries outside the window', () => {
      readMock.mockReturnValue(SAMPLE_LOG);
      const digest = scanKBActivity('2026-04-18', '2026-04-22');
      expect(digest.entries.map((e) => e.date)).toEqual(['2026-04-21', '2026-04-19']);
    });

    it('captures sources and pages-touched wikilinks', () => {
      readMock.mockReturnValue(SAMPLE_LOG);
      const digest = scanKBActivity('2026-04-21', '2026-04-21');
      const entry = digest.entries[0]!;
      expect(entry.sources).toEqual(['journals/smoke-test', 'raw/journals/smoke-test']);
      expect(entry.pagesTouched).toEqual([
        'watt-data',
        'relay',
        'do-things-that-dont-scale',
        'paul-graham',
      ]);
    });

    it('captures the full anchor-line status as rawStatus', () => {
      readMock.mockReturnValue(SAMPLE_LOG);
      const digest = scanKBActivity('2026-04-21', '2026-04-21');
      expect(digest.entries[0]!.rawStatus).toBe(
        'Smoke-test journal ingested — 3 entities + 1 concept.',
      );
    });

    it('joins multi-line status prose before the first labeled line', () => {
      readMock.mockReturnValue(`# Log

[2026-04-20 09:00] [INGEST] First line of prose.
  Second line of prose, still status.
  Third line.
  Sources: [[raw/articles/long-entry]]
  Pages touched: [[page-x]]
`);
      const digest = scanKBActivity('2026-04-20', '2026-04-20');
      expect(digest.entries[0]!.rawStatus).toBe(
        'First line of prose. Second line of prose, still status. Third line.',
      );
    });

    it('treats `Pages touched: (none)` as an empty list (skipped entries pass through for now)', () => {
      readMock.mockReturnValue(SAMPLE_LOG);
      const digest = scanKBActivity('2026-04-19', '2026-04-19');
      const entry = digest.entries[0]!;
      expect(entry.rawStatus).toContain('Skipped');
      expect(entry.pagesTouched).toEqual([]);
    });

    it('returns an empty digest when the log is missing or empty', () => {
      readMock.mockReturnValue(null);
      const digest = scanKBActivity('2026-04-01', '2026-04-30');
      expect(digest.entries).toEqual([]);
      expect(digest.windowStart).toBe('2026-04-01');
      expect(digest.windowEnd).toBe('2026-04-30');
    });

    it('returns an empty digest when no entries fall in the window', () => {
      readMock.mockReturnValue(SAMPLE_LOG);
      const digest = scanKBActivity('2025-01-01', '2025-12-31');
      expect(digest.entries).toEqual([]);
    });

    it('ignores lines that are not INGEST anchors', () => {
      readMock.mockReturnValue(`# Knowledge Base Log

Random preamble text

[2026-04-21 13:20] [INGEST] Real entry.
  Pages touched: [[page-a]]

Some unrelated text
  Pages touched: [[should-not-match]]
`);
      const digest = scanKBActivity('2026-04-21', '2026-04-21');
      expect(digest.entries).toHaveLength(1);
      expect(digest.entries[0]!.pagesTouched).toEqual(['page-a']);
    });

    it('continues past a malformed anchor line in the middle of the log', () => {
      readMock.mockReturnValue(`# Log

[2026-04-21 13:20] [INGEST] Good entry A.
  Pages touched: [[page-a]]

[2026-04-21 BROKEN] [INGEST] not a valid timestamp — the anchor regex does not match
  Pages touched: [[should-not-appear]]

[2026-04-21 14:00] [INGEST] Good entry B.
  Pages touched: [[page-b]]
`);
      const digest = scanKBActivity('2026-04-21', '2026-04-21');
      expect(digest.entries).toHaveLength(2);
      expect(digest.entries.map((e) => e.rawStatus)).toEqual([
        'Good entry A.',
        'Good entry B.',
      ]);
      // The malformed entry's pages-touched line is swept into entry A's body
      // (acceptable — scan is conservative: malformed anchor = not an entry).
      expect(digest.entries[0]!.pagesTouched).toEqual(['page-a']);
      expect(digest.entries[1]!.pagesTouched).toEqual(['page-b']);
    });

    it('filters out non-INGEST operation entries (QUERY, LINT, COMPILE)', () => {
      readMock.mockReturnValue(`# Log

[2026-04-21 10:00] [QUERY] User asked about X.
  Sources: [[wiki/x]]

[2026-04-21 11:00] [INGEST] Real ingest.
  Pages touched: [[page-real]]

[2026-04-21 12:00] [LINT] Weekly lint report.
  Pages touched: [[page-lint-flagged]]

[2026-04-21 13:00] [COMPILE] Rebuilt index.
`);
      const digest = scanKBActivity('2026-04-21', '2026-04-21');
      expect(digest.entries).toHaveLength(1);
      expect(digest.entries[0]!.rawStatus).toBe('Real ingest.');
      expect(digest.entries[0]!.pagesTouched).toEqual(['page-real']);
    });

    it('handles entries without Sources or Pages touched lines', () => {
      readMock.mockReturnValue(`# Log

[2026-04-21 13:20] [INGEST] Minimal entry with no labels.
`);
      const digest = scanKBActivity('2026-04-21', '2026-04-21');
      expect(digest.entries).toHaveLength(1);
      expect(digest.entries[0]!.sources).toEqual([]);
      expect(digest.entries[0]!.pagesTouched).toEqual([]);
    });

    it('handles an anchor with empty status prose', () => {
      readMock.mockReturnValue(`# Log

[2026-04-21 13:20] [INGEST]
  Pages touched: [[page-a]]
`);
      const digest = scanKBActivity('2026-04-21', '2026-04-21');
      expect(digest.entries).toHaveLength(1);
      expect(digest.entries[0]!.rawStatus).toBe('');
      expect(digest.entries[0]!.pagesTouched).toEqual(['page-a']);
    });

    it('includes entries at both window boundaries (inclusive)', () => {
      readMock.mockReturnValue(`# Log

[2026-04-15 00:00] [INGEST] Start-of-window.
  Pages touched: [[p-start]]

[2026-04-21 23:59] [INGEST] End-of-window.
  Pages touched: [[p-end]]
`);
      const digest = scanKBActivity('2026-04-15', '2026-04-21');
      expect(digest.entries.map((e) => e.rawStatus)).toEqual([
        'Start-of-window.',
        'End-of-window.',
      ]);
    });

    it('strips piped display aliases from wikilinks (`[[slug|display]]` → `slug`)', () => {
      readMock.mockReturnValue(`# Log

[2026-04-21 13:20] [INGEST] Aliased wikilinks in sources and pages.
  Sources: [[journals/2026_04_21|April 21]], [[raw/articles/long-title|short]]
  Pages touched: [[paul-graham|Paul Graham]], [[watt-data]]
`);
      const digest = scanKBActivity('2026-04-21', '2026-04-21');
      expect(digest.entries[0]!.sources).toEqual([
        'journals/2026_04_21',
        'raw/articles/long-title',
      ]);
      expect(digest.entries[0]!.pagesTouched).toEqual(['paul-graham', 'watt-data']);
    });

    it('requires canonical Sources:/Pages touched: casing', () => {
      // Document the expected case-sensitivity: wiki-compiler's log format is
      // deterministic; lowercase variants are treated as status prose, not labels.
      readMock.mockReturnValue(`# Log

[2026-04-21 13:20] [INGEST] Entry with odd casing.
  sources: [[wrong-case]]
  pages touched: [[also-wrong]]
`);
      const digest = scanKBActivity('2026-04-21', '2026-04-21');
      expect(digest.entries[0]!.sources).toEqual([]);
      expect(digest.entries[0]!.pagesTouched).toEqual([]);
    });
  });

  describe('formatKBActivity', () => {
    // Helper: configure readMock to serve log.md and wiki frontmatter files together
    const setupLogAndFrontmatter = (log: string, frontmatter: Record<string, string>) => {
      readMock.mockImplementation((path: string) => {
        if (path === 'knowledge/log.md') return log;
        return frontmatter[path] ?? null;
      });
    };

    it('returns null for an empty digest', () => {
      const out = formatKBActivity({
        windowStart: '2026-04-01',
        windowEnd: '2026-04-07',
        entries: [],
      });
      expect(out).toBeNull();
    });

    it('groups ingested pages by category and direction', () => {
      setupLogAndFrontmatter(
        `[2026-04-21 13:20] [INGEST] Smoke-test journal.
  Pages touched: [[wiki/entities/alice]], [[wiki/entities/paul-graham]], [[wiki/concepts/do-things-that-dont-scale]]
`,
        {
          'knowledge/wiki/entities/alice.md': '---\ntype: entity\ncreated: 2026-04-21\nlast-verified: 2026-04-21\n---',
          'knowledge/wiki/entities/paul-graham.md': '---\ntype: entity\ncreated: 2026-04-15\nlast-verified: 2026-04-21\n---',
          'knowledge/wiki/concepts/do-things-that-dont-scale.md': '---\ntype: concept\ncreated: 2026-04-21\nlast-verified: 2026-04-21\n---',
        },
      );
      const digest = scanKBActivity('2026-04-15', '2026-04-21');
      const out = formatKBActivity(digest)!;
      expect(out).toContain('# KB Activity (1 ingested, 0 skipped, 2026-04-15 → 2026-04-21)');
      expect(out).toContain('**Entities** — 1 created ([[wiki/entities/alice]]), 1 updated ([[wiki/entities/paul-graham]])');
      expect(out).toContain('**Concepts** — 1 created ([[wiki/concepts/do-things-that-dont-scale]])');
    });

    it('omits the skip footer when all entries in the window were ingested', () => {
      setupLogAndFrontmatter(
        `[2026-04-15 21:00] [INGEST] Good entry.
  Pages touched: [[wiki/entities/alice]]
`,
        {
          'knowledge/wiki/entities/alice.md': '---\ncreated: 2026-04-15\nlast-verified: 2026-04-15\n---',
        },
      );
      const digest = scanKBActivity('2026-04-15', '2026-04-15');
      const out = formatKBActivity(digest)!;
      expect(out).toContain('# KB Activity (1 ingested, 0 skipped');
      expect(out).not.toContain('entries skipped');
      expect(out).not.toContain('entry skipped');
    });

    it('renders header + skip footer (but no category sections) when the window had only skips', () => {
      readMock.mockImplementation((path: string) =>
        path === 'knowledge/log.md'
          ? `[2026-04-19 13:15] [INGEST] Skipped (duplicate).
  Pages touched: (none)
`
          : null,
      );
      const digest = scanKBActivity('2026-04-19', '2026-04-19');
      const out = formatKBActivity(digest)!;
      expect(out).toContain('# KB Activity (0 ingested, 1 skipped');
      expect(out).toContain('_1 entry skipped');
      expect(out).not.toContain('**Entities**');
      expect(out).not.toContain('**Concepts**');
    });

    it('drops raw and other categories from category sections', () => {
      // `raw/journals/smoke-test` is raw (dropped); `index` is other (dropped); only `alice` (entity) shows.
      setupLogAndFrontmatter(
        `[2026-04-21 13:20] [INGEST] Mixed-category entry.
  Pages touched: [[raw/journals/smoke-test]], [[wiki/entities/alice]], [[index]]
`,
        {
          'knowledge/wiki/entities/alice.md': '---\ncreated: 2026-04-21\n---',
        },
      );
      const digest = scanKBActivity('2026-04-21', '2026-04-21');
      const out = formatKBActivity(digest)!;
      expect(out).toContain('**Entities** — 1 created ([[wiki/entities/alice]])');
      expect(out).not.toContain('[[raw/journals/smoke-test]]');
      expect(out).not.toContain('[[index]]');
    });

    it('deduplicates a slug seen across multiple entries and prefers `created` over `updated`', () => {
      // `alice` appears in two entries: 04-20 (would be 'updated') and 04-21 (would be 'created', matching created-date).
      // Created should win.
      setupLogAndFrontmatter(
        `[2026-04-20 10:00] [INGEST] First touch.
  Pages touched: [[wiki/entities/alice]]

[2026-04-21 13:20] [INGEST] Second touch.
  Pages touched: [[wiki/entities/alice]]
`,
        {
          'knowledge/wiki/entities/alice.md': '---\ncreated: 2026-04-21\n---',
        },
      );
      const digest = scanKBActivity('2026-04-20', '2026-04-21');
      const out = formatKBActivity(digest)!;
      expect(out).toContain('**Entities** — 1 created ([[wiki/entities/alice]])');
      expect(out).not.toContain('updated');
    });

    it('dedupes the same page referenced as both bare slug and prefixed path', () => {
      existsMock.mockImplementation(
        (p: string) => p === 'knowledge/wiki/entities/alice.md',
      );
      setupLogAndFrontmatter(
        `[2026-04-20 10:00] [INGEST] Bare slug form.
  Pages touched: [[alice]]

[2026-04-21 13:20] [INGEST] Prefixed form.
  Pages touched: [[wiki/entities/alice]]
`,
        {
          'knowledge/wiki/entities/alice.md': '---\ncreated: 2026-04-21\n---',
        },
      );
      const digest = scanKBActivity('2026-04-20', '2026-04-21');
      const out = formatKBActivity(digest)!;
      // The page should appear once in the output, not twice.
      const matches = out.match(/alice/g) ?? [];
      expect(matches.length).toBe(1);
    });

    it('renders entries in category order: entities → concepts → topics → comparisons', () => {
      setupLogAndFrontmatter(
        `[2026-04-21 13:20] [INGEST] Mixed categories.
  Pages touched: [[wiki/topics/crypto]], [[wiki/entities/alice]], [[wiki/concepts/scaling-laws]], [[wiki/comparisons/a-vs-b]]
`,
        {
          'knowledge/wiki/topics/crypto.md': '---\ncreated: 2026-04-21\n---',
          'knowledge/wiki/entities/alice.md': '---\ncreated: 2026-04-21\n---',
          'knowledge/wiki/concepts/scaling-laws.md': '---\ncreated: 2026-04-21\n---',
          'knowledge/wiki/comparisons/a-vs-b.md': '---\ncreated: 2026-04-21\n---',
        },
      );
      const digest = scanKBActivity('2026-04-21', '2026-04-21');
      const out = formatKBActivity(digest)!;
      const entitiesIdx = out.indexOf('**Entities**');
      const conceptsIdx = out.indexOf('**Concepts**');
      const topicsIdx = out.indexOf('**Topics**');
      const comparisonsIdx = out.indexOf('**Comparisons**');
      expect(entitiesIdx).toBeGreaterThan(-1);
      expect(conceptsIdx).toBeGreaterThan(entitiesIdx);
      expect(topicsIdx).toBeGreaterThan(conceptsIdx);
      expect(comparisonsIdx).toBeGreaterThan(topicsIdx);
    });
  });

  describe('resolveDirection', () => {
    beforeEach(() => {
      // Default: for prefixed `wiki/...` slugs, wikiPathForSlug doesn't need vaultFileExists;
      // for bare slugs, it does.
      existsMock.mockReturnValue(true);
    });

    it('returns `created` when the page frontmatter created date matches the ingest date', () => {
      readMock.mockImplementation((p: string) =>
        p === 'knowledge/wiki/entities/alice.md'
          ? '---\ntype: entity\ncreated: 2026-04-21\nlast-verified: 2026-04-21\n---'
          : null,
      );
      expect(resolveDirection('wiki/entities/alice', '2026-04-21')).toBe('created');
    });

    it('returns `updated` when the page created date differs from the ingest date', () => {
      readMock.mockImplementation((p: string) =>
        p === 'knowledge/wiki/entities/paul-graham.md'
          ? '---\ncreated: 2026-04-15\nlast-verified: 2026-04-21\n---'
          : null,
      );
      expect(resolveDirection('wiki/entities/paul-graham', '2026-04-21')).toBe('updated');
    });

    it('returns `updated` when the page file does not exist', () => {
      readMock.mockReturnValue(null);
      existsMock.mockReturnValue(false);
      expect(resolveDirection('nonexistent-slug', '2026-04-21')).toBe('updated');
    });

    it('returns `updated` when frontmatter is missing the created field', () => {
      readMock.mockImplementation((p: string) =>
        p === 'knowledge/wiki/entities/oldpage.md'
          ? '---\ntype: entity\nlast-verified: 2026-04-21\n---\n# Body'
          : null,
      );
      expect(resolveDirection('wiki/entities/oldpage', '2026-04-21')).toBe('updated');
    });

    it('resolves bare slugs via the wiki subdir probe', () => {
      existsMock.mockImplementation(
        (p: string) => p === 'knowledge/wiki/entities/alice.md',
      );
      readMock.mockImplementation((p: string) =>
        p === 'knowledge/wiki/entities/alice.md'
          ? '---\ncreated: 2026-04-21\n---'
          : null,
      );
      expect(resolveDirection('alice', '2026-04-21')).toBe('created');
    });

    it('tolerates extra whitespace after `created:`', () => {
      readMock.mockImplementation((p: string) =>
        p === 'knowledge/wiki/entities/alice.md'
          ? '---\ncreated:     2026-04-21\nlast-verified: 2026-04-21\n---'
          : null,
      );
      expect(resolveDirection('wiki/entities/alice', '2026-04-21')).toBe('created');
    });
  });

  describe('resolveCategory', () => {
    it('classifies prefixed raw/ slugs as raw', () => {
      expect(resolveCategory('raw/articles/foo')).toBe('raw');
      expect(resolveCategory('raw/journals/2026_04_21')).toBe('raw');
      expect(resolveCategory('raw/notes/bar')).toBe('raw');
    });

    it('classifies prefixed wiki/ slugs by subdir', () => {
      expect(resolveCategory('wiki/entities/alice')).toBe('entity');
      expect(resolveCategory('wiki/concepts/scaling-laws')).toBe('concept');
      expect(resolveCategory('wiki/topics/crypto')).toBe('topic');
      expect(resolveCategory('wiki/comparisons/a-vs-b')).toBe('comparison');
    });

    it('returns `other` for any other slash-containing path', () => {
      expect(resolveCategory('projects/relay')).toBe('other');
      expect(resolveCategory('world-view/ai')).toBe('other');
      expect(resolveCategory('journals/2026_04_21')).toBe('other');
    });

    it('probes the filesystem for bare slugs and returns the matching category', () => {
      existsMock.mockImplementation((p: string) => p === 'knowledge/wiki/entities/watt-data.md');
      expect(resolveCategory('watt-data')).toBe('entity');
    });

    it('classifies bare slugs that live under concepts/', () => {
      existsMock.mockImplementation(
        (p: string) => p === 'knowledge/wiki/concepts/do-things-that-dont-scale.md',
      );
      expect(resolveCategory('do-things-that-dont-scale')).toBe('concept');
    });

    it('returns `other` for bare slugs with no matching file in any wiki subdir', () => {
      existsMock.mockReturnValue(false);
      expect(resolveCategory('nonexistent-slug')).toBe('other');
    });

    it('returns `other` for an empty slug without probing the filesystem', () => {
      expect(resolveCategory('')).toBe('other');
      expect(existsMock).not.toHaveBeenCalled();
    });

    it('probes in declared order (entities first, then concepts, topics, comparisons)', () => {
      // If the slug exists in multiple subdirs (shouldn't happen in practice, but safe),
      // the probe order is deterministic.
      existsMock.mockImplementation((p: string) => {
        return (
          p === 'knowledge/wiki/concepts/shared-slug.md' ||
          p === 'knowledge/wiki/topics/shared-slug.md'
        );
      });
      expect(resolveCategory('shared-slug')).toBe('concept');
    });
  });

  describe('summarizeKBActivity', () => {
    const makeIngestedDigest = (count: number) => ({
      windowStart: '2026-01-01',
      windowEnd: '2026-04-21',
      entries: Array.from({ length: count }, (_, i) => ({
        date: '2026-04-15',
        time: '10:00',
        rawStatus: `entry ${i}`,
        sources: [`raw/articles/source-${i}`],
        pagesTouched: [`wiki/entities/page-${i}`],
      })),
    });

    it('returns null when the digest is empty', async () => {
      const out = await summarizeKBActivity({
        windowStart: '2026-04-01',
        windowEnd: '2026-04-07',
        entries: [],
      });
      expect(out).toBeNull();
      expect(askMock).not.toHaveBeenCalled();
    });

    it('calls askClaudeOneShot with a prompt that includes window + entry count + raw entries', async () => {
      askMock.mockResolvedValue({ text: '# KB Activity (summarized)\n- synthesis line', error: null });
      const digest = makeIngestedDigest(60);
      await summarizeKBActivity(digest);
      expect(askMock).toHaveBeenCalledTimes(1);
      const prompt = askMock.mock.calls[0]![0] as string;
      expect(prompt).toContain('Window: 2026-01-01 → 2026-04-21');
      expect(prompt).toContain('Ingested entries (60)');
      expect(prompt).toContain('wiki/entities/page-0');
      expect(prompt).toContain('wiki/entities/page-59');
    });

    it('returns null when the LLM fails', async () => {
      askMock.mockResolvedValue({ text: null, error: 'timeout' });
      const out = await summarizeKBActivity(makeIngestedDigest(60));
      expect(out).toBeNull();
    });

    it('returns null when the LLM returns empty text', async () => {
      askMock.mockResolvedValue({ text: '', error: null });
      const out = await summarizeKBActivity(makeIngestedDigest(60));
      expect(out).toBeNull();
    });
  });

  describe('renderKBActivitySection', () => {
    const makeIngestedDigest = (count: number) => ({
      windowStart: '2026-01-01',
      windowEnd: '2026-04-21',
      entries: Array.from({ length: count }, (_, i) => ({
        date: '2026-04-15',
        time: '10:00',
        rawStatus: `entry ${i}`,
        sources: [`raw/articles/source-${i}`],
        pagesTouched: [`wiki/entities/page-${i}`],
      })),
    });

    it('uses the synchronous formatter (no LLM) when below the threshold', async () => {
      // Make sure we're below the threshold
      const small = makeIngestedDigest(SUMMARIZER_THRESHOLD - 1);
      const out = await renderKBActivitySection(small);
      expect(askMock).not.toHaveBeenCalled();
      expect(out).toContain('# KB Activity (');
    });

    it('dispatches to the summarizer when at/above the threshold', async () => {
      askMock.mockResolvedValue({ text: '# KB Activity (summarized)\n- synthesized', error: null });
      const big = makeIngestedDigest(SUMMARIZER_THRESHOLD);
      const out = await renderKBActivitySection(big);
      expect(askMock).toHaveBeenCalledTimes(1);
      expect(out).toContain('# KB Activity (summarized)');
    });

    it('falls back to the synchronous formatter when the summarizer returns null', async () => {
      askMock.mockResolvedValue({ text: null, error: 'timeout' });
      const big = makeIngestedDigest(SUMMARIZER_THRESHOLD);
      const out = await renderKBActivitySection(big);
      expect(askMock).toHaveBeenCalledTimes(1);
      // Falls back to raw — header includes the unsummarized "# KB Activity (N ingested..."
      expect(out).toMatch(/# KB Activity \(\d+ ingested/);
    });

    it('returns null for an empty digest', async () => {
      const out = await renderKBActivitySection({
        windowStart: '2026-04-01',
        windowEnd: '2026-04-07',
        entries: [],
      });
      expect(out).toBeNull();
    });
  });
});
